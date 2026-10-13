import { parse } from "acorn";
import { StudioError } from "./errors.js";
const RESERVED = new Set(["U", "C", "D", "M", "R", "G"]);
/** Parse first; reject reserved helper names without changing the document. Comments and string data cannot trigger the upstream operation scan. */
export function prepareScript(source: string): string {
    const comments: import("acorn").Comment[] = [];
    let ast: unknown;
    try {
        ast = parse(source, { ecmaVersion: 2024, onComment: comments });
    } catch (error) {
        throw new StudioError("SCRIPT_SYNTAX", String(error), {
            recoverable: true,
            committed: false,
        });
    }
    const edits: { start: number; end: number; text: string }[] = comments.map((c) => ({
        ...c,
        text: source.slice(c.start, c.end).replace(/[^\r\n]/g, " "),
    }));
    const visit = (raw: unknown) => {
        if (!raw || typeof raw !== "object") return;
        const n = raw as Record<string, unknown>;
        if (
            (n.type === "FunctionDeclaration" ||
                n.type === "ClassDeclaration" ||
                n.type === "VariableDeclarator") &&
            n.id &&
            typeof n.id === "object"
        ) {
            const id = n.id as { name?: string };
            if (id.name && RESERVED.has(id.name))
                throw new StudioError(
                    "RESERVED_SCRIPT_NAME",
                    "Native edit operations reserve " +
                        id.name +
                        ". Rename this helper, for example makeCard; the script has not executed.",
                    { recoverable: true, committed: false, identifier: id.name },
                );
        }
        if (n.type === "CallExpression" && n.callee && typeof n.callee === "object") {
            const callee = n.callee as { type?: string; name?: string };
            if (callee.type === "Identifier" && callee.name && RESERVED.has(callee.name))
                throw new StudioError(
                    "EDIT_OPERATION_IN_SCRIPT",
                    "Use operations for " +
                        callee.name +
                        "; QuickJS script accepts I/K creation primitives.",
                    { recoverable: true, committed: false },
                );
        }
        if (n.type === "Literal" && typeof n.value === "string")
            edits.push({
                start: Number(n.start),
                end: Number(n.end),
                text: JSON.stringify(n.value).replace(
                    /[UCDMRG](?=\s*[(])/g,
                    (c) => "\\u00" + c.charCodeAt(0).toString(16),
                ),
            });
        for (const [key, value] of Object.entries(n)) {
            if (key === "start" || key === "end") continue;
            if (Array.isArray(value)) for (const item of value) visit(item);
            else if (value && typeof value === "object") visit(value);
        }
    };
    visit(ast);
    let text = source;
    for (const e of edits.sort((a, b) => b.start - a.start))
        text = text.slice(0, e.start) + e.text + text.slice(e.end);
    return text;
}

/** Extract native batch data without evaluating expressions, getters or arbitrary calls. */
export function batchArguments(source: string, creation = false): unknown[] {
    const invalid = (message: string): never => {
        throw new StudioError("INVALID_BATCH_ARGUMENTS", message, {
            recoverable: true,
            committed: false,
        });
    };
    if (Buffer.byteLength(source) > 262144) invalid("Batch exceeds 256 KiB");
    let ast: import("acorn").Node;
    try {
        ast = parse(source, { ecmaVersion: 2024 });
    } catch (error) {
        throw new StudioError("SCRIPT_SYNTAX", String(error), {
            recoverable: true,
            committed: false,
        });
    }
    const node = (value: unknown): Record<string, unknown> => {
        if (!value || typeof value !== "object")
            return invalid("Expected a native batch expression");
        return value as Record<string, unknown>;
    };
    const literal = (raw: unknown): unknown => {
        const n = node(raw);
        if (
            n.type === "Literal" &&
            (n.value === null || ["string", "number", "boolean"].includes(typeof n.value))
        ) {
            if (typeof n.value === "number" && !Number.isFinite(n.value))
                invalid("Batch numbers must be finite");
            return n.value;
        }
        if (n.type === "UnaryExpression" && ["-", "+"].includes(String(n.operator))) {
            const value = literal(n.argument);
            if (typeof value === "number") return n.operator === "-" ? -value : value;
        }
        // Native operation bindings can identify nodes inside arrays as well as standalone arguments.
        if (n.type === "Identifier") return String(n.name);
        if (n.type === "ArrayExpression") return (n.elements as unknown[]).map(literal);
        if (n.type === "ObjectExpression") {
            const entries = (n.properties as unknown[]).map((rawProperty) => {
                const property = node(rawProperty),
                    key = node(property.key);
                if (
                    property.type !== "Property" ||
                    property.kind !== "init" ||
                    property.method ||
                    property.shorthand ||
                    property.computed
                )
                    return invalid(
                        "Batch objects require literal properties; methods, spreads and computed keys are unsupported",
                    );
                const name = key.type === "Identifier" ? key.name : literal(key);
                if (typeof name !== "string" && typeof name !== "number")
                    return invalid("Invalid batch property name");
                return [String(name), literal(property.value)] as const;
            });
            return Object.fromEntries(entries);
        }
        return invalid(
            "Batch arguments must be literal data; use script for computed I/K creation",
        );
    };
    const values: unknown[] = [];
    const capture = (raw: unknown) => {
        let call = node(raw);
        if (
            call.type === "AssignmentExpression" &&
            call.operator === "=" &&
            node(call.left).type === "Identifier"
        )
            call = node(call.right);
        const callee = node(call.callee);
        if (
            call.type !== "CallExpression" ||
            call.optional ||
            callee.type !== "Identifier" ||
            !(creation ? ["I", "K"] : [...RESERVED]).includes(String(callee.name))
        )
            invalid(
                creation
                    ? "Expected captured I/K creation calls"
                    : "Operations accept only U/D/M/C/R/G calls",
            );
        for (const argument of call.arguments as unknown[]) {
            // Native bindings identify nodes and parents; they cannot supply object payloads.
            if (node(argument).type === "Identifier") values.push(String(node(argument).name));
            else values.push(literal(argument));
        }
    };
    for (const raw of node(ast).body as unknown[]) {
        const statement = node(raw);
        if (statement.type === "EmptyStatement") continue;
        if (statement.type === "ExpressionStatement") capture(statement.expression);
        else if (statement.type === "VariableDeclaration") {
            for (const rawDeclaration of statement.declarations as unknown[]) {
                const declaration = node(rawDeclaration);
                if (node(declaration.id).type !== "Identifier")
                    invalid("Batch bindings require simple names");
                capture(declaration.init);
            }
        } else invalid("Batch accepts only native calls and their bindings");
    }
    return values;
}

/** Canonicalize literal operations to one native DSL call per line; comments stay prose. */
export function prepareOperations(source: string): string {
    batchArguments(source);
    const ast = parse(source, { ecmaVersion: 2024 }) as unknown as {
        body: Record<string, unknown>[];
    };
    const node = (value: unknown) => value as Record<string, unknown>;
    const literal = (raw: unknown): unknown => {
        const n = node(raw);
        if (n.type === "Literal") return n.value;
        if (n.type === "Identifier") return n.name;
        if (n.type === "UnaryExpression") {
            const value = literal(n.argument) as number;
            return n.operator === "-" ? -value : value;
        }
        if (n.type === "ArrayExpression") return (n.elements as unknown[]).map(literal);
        return Object.fromEntries(
            (n.properties as unknown[]).map((rawProperty) => {
                const property = node(rawProperty),
                    key = node(property.key);
                return [
                    key.type === "Identifier" ? String(key.name) : String(literal(key)),
                    literal(property.value),
                ];
            }),
        );
    };
    const encode = (value: unknown) =>
        JSON.stringify(value).replace(
            /[IKUCDMRG](?=\s*[(])/g,
            (c) => "\\u00" + c.charCodeAt(0).toString(16),
        );
    const lines: string[] = [];
    const copyBindings = new Set<string>();
    const capture = (raw: unknown, binding?: string) => {
        let call = node(raw);
        if (call.type === "AssignmentExpression") {
            binding = String(node(call.left).name);
            call = node(call.right);
        }
        const operation = String(node(call.callee).name);
        const rawArguments = call.arguments as unknown[];
        const moved = rawArguments[0] === undefined ? undefined : node(rawArguments[0]);
        const parent = rawArguments[1] === undefined ? undefined : node(rawArguments[1]);
        if (
            operation === "M" &&
            moved?.type === "Identifier" &&
            copyBindings.has(String(moved.name)) &&
            parent?.type === "Literal" &&
            parent.value === null
        )
            throw new StudioError(
                "UNSUPPORTED_NATIVE_BATCH",
                "The pinned native runtime can remove existing roots when a C binding is moved to root in the same batch. Submit copy and move separately, using the returned node ID.",
                { recoverable: true, committed: false },
            );
        if (binding) {
            copyBindings.delete(binding);
            if (operation === "C") copyBindings.add(binding);
        }
        if (binding && (!/^\w+$/.test(binding) || ["U", "D"].includes(operation)))
            throw new StudioError(
                "INVALID_BATCH_ARGUMENTS",
                "Native bindings support C/R/G/M and ASCII word names",
                { recoverable: true, committed: false },
            );
        const args = (call.arguments as unknown[]).map((rawArgument) => {
            const argument = node(rawArgument);
            return argument.type === "Identifier"
                ? String(argument.name)
                : encode(literal(argument));
        });
        lines.push((binding ? binding + "=" : "") + operation + "(" + args.join(",") + ")");
    };
    for (const statement of ast.body) {
        if (statement.type === "ExpressionStatement") capture(statement.expression);
        else if (statement.type === "VariableDeclaration") {
            for (const rawDeclaration of statement.declarations as unknown[]) {
                const declaration = node(rawDeclaration);
                capture(declaration.init, String(node(declaration.id).name));
            }
        }
    }
    return lines.join("\n");
}
