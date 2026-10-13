import { isDeepStrictEqual } from "node:util";
import { StudioError, record } from "./errors.js";
import type { ManagedEditorDaemon } from "./vendor/server/managed-editor-daemon.js";
import { NATIVE_CATALOG } from "./native-catalog.js";
import { GUIDANCE } from "./guidance.js";
import { batchArguments, prepareOperations } from "./script.js";
export interface NativeTool {
    name: string;
    inputSchema: Record<string, unknown>;
}
const exposed = new Set<string>(NATIVE_CATALOG.map((t) => t.name));
const OMIT = new Set([
    "open_document",
    "save_document",
    "spawn_agents",
    "ToolSearch",
    "get_design_prompt",
    "get_design_agent_prompt",
    "get_design_md",
    "set_design_md",
    "export_design_md",
    "design_skeleton",
    "design_content",
    "design_refine",
    "finalize_design",
    "run_design_agent",
    "codegen_plan",
    "codegen_submit_chunk",
    "codegen_assemble",
    "codegen_clean",
    "save_theme_preset",
    "load_theme_preset",
    "list_theme_presets",
    "import_html_url",
    "import_web_snapshot",
    "import_html",
    "import_svg",
    "paste_clipboard",
    "cut_selected",
    "copy_selected",
]);
export function isExposed(name: string) {
    return exposed.has(name) && !OMIT.has(name) && !name.startsWith("export_");
}
export function isRead(name: string) {
    return (
        name.startsWith("get_") ||
        name.startsWith("list_") ||
        name.startsWith("find_") ||
        name.startsWith("count_") ||
        [
            "batch_get",
            "read_nodes",
            "snapshot_layout",
            "lint_document",
            "conversion_status",
            "search_all_unique_properties",
        ].includes(name)
    );
}
const FILE_ARGUMENTS = new Set([
    "filePath",
    "sourcePath",
    "sourceFilePath",
    "source_file_path",
    "file_path",
    "outputPath",
    "outputDir",
    "directory",
]);
export function assertResourceUris(value: unknown, image = false) {
    if (Array.isArray(value)) {
        value.forEach((v) => assertResourceUris(v, image));
        return;
    }
    const obj = record(value);
    if (!obj) return;
    const visual = image || obj.type === "image";
    for (const [key, item] of Object.entries(obj)) {
        const asset =
            ["src", "imageUrl", "imagePath", "image"].includes(key) || (key === "url" && visual);
        if (asset && typeof item === "string" && !/^(https?:\/\/|data:)/i.test(item.trim()))
            throw new StudioError(
                "LOCAL_ASSET_UNSUPPORTED",
                "Use an HTTP(S) or data URI for images; native filesystem asset paths are not exposed",
                { field: key, committed: false },
            );
        assertResourceUris(item, key === "image" || key === "fill" || visual);
    }
}
export function assertNativeArguments(args: Record<string, unknown>) {
    const walk = (value: unknown, root = false) => {
        if (Array.isArray(value)) {
            value.forEach((v) => walk(v));
            return;
        }
        const obj = record(value);
        if (!obj) return;
        for (const [key, item] of Object.entries(obj)) {
            if (FILE_ARGUMENTS.has(key) || (root && key === "path"))
                throw new StudioError(
                    "PATH_ARGUMENT_FORBIDDEN",
                    "Native document paths are bound by Studio; remove " + key,
                    { field: key, committed: false },
                );
            walk(item);
        }
    };
    walk(args, true);
    assertResourceUris(args);
    // Only catalog fields that carry serialized structures are decoded. Text/content/value remain prose.
    for (const key of ["node_json", "variables"]) {
        if (typeof args[key] !== "string") continue;
        let payload: unknown;
        try {
            payload = JSON.parse(args[key]);
        } catch {
            throw new StudioError("INVALID_NATIVE_JSON", key + " must contain a JSON object", {
                field: key,
                committed: false,
            });
        }
        if (!record(payload))
            throw new StudioError("INVALID_NATIVE_JSON", key + " must contain a JSON object", {
                field: key,
                committed: false,
            });
        walk(payload);
        assertResourceUris(payload);
    }
    for (const key of ["script", "operations"] as const) {
        if (typeof args[key] !== "string") continue;
        const values = batchArguments(args[key], key === "script");
        walk(values);
        assertResourceUris(values);
    }
}
/** Shared preflight for Studio and direct RPC callers, before any creation script is evaluated. */
export function normalizeNativeArguments(
    name: string,
    args: Record<string, unknown>,
): Record<string, unknown> {
    const normalized = { ...args };
    const fail = (code: string, message: string, field?: string): never => {
        throw new StudioError(code, message, {
            committed: false,
            recoverable: true,
            ...(field ? { field } : {}),
        });
    };
    if (name === "batch_design") {
        if ("nodes_json" in normalized)
            fail(
                "INVALID_BATCH_INPUT",
                "Use one incremental script or operations; nodes_json is not supported",
            );
        for (const field of ["script", "operations"] as const) {
            const value = normalized[field];
            if (value === undefined || (typeof value === "string" && !value.trim()))
                delete normalized[field];
            else if (typeof value !== "string")
                fail("INVALID_BATCH_INPUT", field + " must be a string", field);
        }
        if (normalized.script !== undefined && normalized.operations !== undefined)
            fail("INVALID_BATCH_INPUT", "Use exactly one non-empty script or operations");
        if (typeof normalized.operations === "string") {
            normalized.operations = prepareOperations(normalized.operations);
            if (!normalized.operations) delete normalized.operations;
        }
        if (normalized.script === undefined && normalized.operations === undefined)
            fail("INVALID_BATCH_INPUT", "Batch requires a non-empty script or operations");
    }
    if (["insert_node", "update_node", "replace_node"].includes(name) && "data" in normalized) {
        const payload = record(normalized.data);
        if (!payload) fail("INVALID_NATIVE_DATA", "data must be a node object", "data");
        const data = { ...payload };
        const merge = (field: string, value: unknown, canon = (item: unknown): unknown => item) => {
            const incoming = canon(value);
            if (field in data && !isDeepStrictEqual(canon(data[field]), incoming))
                fail("ARGUMENT_CONFLICT", "Top-level and data values disagree for " + field, field);
            data[field] = incoming;
        };
        const numeric = (value: unknown): unknown =>
            typeof value === "string" &&
            /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim()) &&
            Number.isFinite(Number(value))
                ? Number(value)
                : value;
        for (const field of ["x", "y", "width", "height", "name"] as const) {
            if (normalized[field] === undefined) continue;
            merge(field, normalized[field], field === "name" ? undefined : numeric);
            delete normalized[field];
        }
        const kind = (value: unknown): unknown => (value === "rect" ? "rectangle" : value);
        if (normalized.kind !== undefined) {
            if ("kind" in data && !isDeepStrictEqual(kind(data.kind), kind(normalized.kind)))
                fail("ARGUMENT_CONFLICT", "Top-level kind and data.kind disagree", "kind");
            merge("type", normalized.kind, kind);
            delete normalized.kind;
            delete data.kind;
        }
        const solid = (value: unknown): unknown => {
            if (typeof value === "string") return [{ type: "solid", color: value }];
            const layer = record(value);
            if (
                layer &&
                typeof layer.color === "string" &&
                Object.keys(layer).every((key) => ["type", "color"].includes(key)) &&
                (layer.type === undefined || layer.type === "solid")
            )
                return [{ type: "solid", color: layer.color }];
            if (Array.isArray(value) && value.length === 1) return solid(value[0]);
            return value;
        };
        for (const [container, field] of [
            [normalized, "fill_hex"],
            [data, "fill_hex"],
            [data, "fillHex"],
        ] as const) {
            if (container[field] === undefined) continue;
            const color = container[field];
            if (
                typeof color !== "string" ||
                !/^#(?:[a-f\d]{3}|[a-f\d]{6}|[a-f\d]{8})$/i.test(color)
            )
                fail("INVALID_NATIVE_DATA", field + " must be #rgb/#rrggbb/#rrggbbaa", field);
            merge("fill", color, solid);
            delete container[field];
        }
        normalized.data = data;
    }
    return normalized;
}
export function neutralSchema(value: unknown): unknown {
    const walk = (input: unknown, root = false): unknown => {
        if (Array.isArray(input)) return input.map((v) => walk(v));
        const obj = record(input);
        if (!obj) return input;
        const result: Record<string, unknown> = {};
        for (const [key, item] of Object.entries(obj)) {
            if (["description", "title", "examples"].includes(key)) continue;
            if (key === "properties" && record(item)) {
                result[key] = Object.fromEntries(
                    Object.entries(record(item)!)
                        .filter(([name]) => !FILE_ARGUMENTS.has(name) && (!root || name !== "path"))
                        .map(([name, v]) => [name, walk(v)]),
                );
            } else if (key === "required" && Array.isArray(item))
                result[key] = item.filter(
                    (name) =>
                        typeof name !== "string" ||
                        (!FILE_ARGUMENTS.has(name) && (!root || name !== "path")),
                );
            else result[key] = walk(item);
        }
        return result;
    };
    return walk(value, true);
}
export const TECHNICAL_CATALOG = NATIVE_CATALOG.filter((t) => isExposed(t.name)).map((t) => {
    const inputSchema = neutralSchema(t.inputSchema) as Record<string, unknown>;
    if (t.name === "batch_design") {
        const fields = record(inputSchema.properties);
        if (fields) delete fields.nodes_json;
    }
    return { ...t, inputSchema };
});
export async function rpc(
    daemon: ManagedEditorDaemon,
    method: string,
    params: Record<string, unknown>,
    signal?: AbortSignal,
): Promise<unknown> {
    const response = await fetch(daemon.baseUrl + "/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
        signal: signal
            ? AbortSignal.any([signal, AbortSignal.timeout(60000)])
            : AbortSignal.timeout(60000),
    });
    if (!response.ok)
        throw new StudioError("NATIVE_TRANSPORT", "Native MCP returned HTTP " + response.status);
    const envelope = record(await response.json());
    if (envelope?.error) throw new StudioError("NATIVE_RPC", JSON.stringify(envelope.error));
    return envelope?.result;
}
export async function listNative(daemon: ManagedEditorDaemon) {
    const result = record(await rpc(daemon, "tools/list", {}));
    const available = new Set(
        (Array.isArray(result?.tools) ? result.tools : [])
            .map(record)
            .filter((x) => typeof x?.name === "string")
            .map((x) => String(x?.name)),
    );
    return TECHNICAL_CATALOG.filter((t) => available.has(t.name));
}
export function nativeValue(result: unknown): unknown {
    const r = record(result);
    const blocks = Array.isArray(r?.content) ? r.content : [];
    const texts = blocks
        .map(record)
        .filter((x) => x?.type === "text" && typeof x.text === "string")
        .map((x) => String(x?.text));
    if (texts.length === 1) {
        try {
            return JSON.parse(texts[0]!);
        } catch {
            /* Native prose stays explicit. */
        }
    }
    return { content: blocks };
}
export async function callNative(
    daemon: ManagedEditorDaemon,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
) {
    if (!isExposed(name))
        throw new StudioError(
            "UNSUPPORTED_NATIVE_TOOL",
            "This high-level or filesystem tool is not exposed; use Studio file operations.",
            { tool: name },
        );
    if (name === "get_guidelines") return { scope: "technical", guidance: GUIDANCE };
    args = normalizeNativeArguments(name, args);
    if (name === "batch_design" && typeof args.script === "string") {
        // Studio usually captures creation earlier; also protect direct callers of this RPC boundary.
        const { planCreation } = await import("./creation.js");
        args = { ...args, script: (await planCreation(args.script)).script };
        if (!args.script)
            throw new StudioError("INVALID_BATCH_INPUT", "Script must create at least one node", {
                committed: false,
                recoverable: true,
            });
    }
    assertNativeArguments(args);
    const result = await rpc(daemon, "tools/call", { name, arguments: args }, signal);
    const value = nativeValue(result);
    if (record(result)?.isError === true)
        throw new StudioError("NATIVE_OPERATION_FAILED", "Native operation failed", {
            diagnostic: value,
            recoverable: true,
        });
    const errors = record(value)?.errors;
    if (Array.isArray(errors) && errors.length)
        throw new StudioError(
            "SCRIPT_OR_PARAMETER_ERROR",
            "Native batch was rejected before commit",
            { errors, recoverable: true },
        );
    if (name === "get_design_quality") {
        const quality = record(value) ?? {};
        return {
            scope: "technical",
            geometryIssues: quality.geometryIssues ?? [],
            layoutIssues: quality.layoutIssues ?? [],
            advisory: {
                contrastIssues: quality.contrastIssues ?? [],
                iconIssues: quality.iconIssues ?? [],
                variableIssues: quality.variableIssues ?? [],
            },
        };
    }
    return value;
}
