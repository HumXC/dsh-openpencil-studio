import { record, StudioError } from "./errors.js";
import {
    controlSemantics,
    invalidLabelReferenceReason,
    semanticPages,
    type SemanticPage,
} from "./semantics.js";
import { assertDocumentResourceUris } from "./document-images.js";
export interface Diagnostic {
    source: "studio" | "native";
    code: string;
    severity: "error" | "warning" | "info";
    blocking: boolean;
    nodeId?: string;
    property?: string;
    message: string;
    patch?: Record<string, unknown>;
    repair:
        | {
              tool: "pencil_update_node" | "pencil_control_semantics";
              nodeId: string;
              data?: Record<string, unknown>;
          }
        | { tool: "pencil_batch_design"; reason: string };
}
export function parseDocument(text: string): Record<string, unknown> {
    if (Buffer.byteLength(text) > 16 * 1024 * 1024)
        throw new StudioError("DOCUMENT_TOO_LARGE", "Document exceeds 16 MiB");
    let doc: unknown;
    try {
        doc = JSON.parse(text);
    } catch (error) {
        throw new StudioError("INVALID_DOCUMENT_JSON", String(error));
    }
    const value = record(doc);
    if (
        !value ||
        typeof value.version !== "string" ||
        (!Array.isArray(value.children) && !Array.isArray(value.pages))
    )
        throw new StudioError(
            "INVALID_DOCUMENT",
            "Expected native document version and children or pages",
        );
    assertDocumentResourceUris(value);
    return value;
}
export function technicalDiagnostics(doc: Record<string, unknown>): Diagnostic[] {
    const issues: Diagnostic[] = [];
    const ids = new Set<string>();
    const semantics = controlSemantics(doc);
    const controlTypes = new Set(["text_input", "text_area", "select", "checkbox", "switch"]);
    const pages = semanticPages(doc);
    const validReference = (node: Record<string, unknown>, ref: string, page: SemanticPage) =>
        invalidLabelReferenceReason(String(node.id), ref, page) === undefined;
    const add = (
        node: Record<string, unknown>,
        code: string,
        message: string,
        property?: string,
        patch?: Record<string, unknown>,
        blocking = true,
    ) => {
        const nodeId = typeof node.id === "string" ? node.id : undefined;
        issues.push({
            source: "studio",
            code,
            severity: blocking ? "error" : "warning",
            blocking,
            ...(nodeId ? { nodeId } : {}),
            ...(property ? { property } : {}),
            message,
            ...(patch ? { patch } : {}),
            repair: nodeId
                ? {
                      tool:
                          code === "CONTROL_LABEL" || code === "INVALID_LABEL_REFERENCE"
                              ? "pencil_control_semantics"
                              : "pencil_update_node",
                      nodeId,
                      ...(patch ? { data: patch } : {}),
                  }
                : {
                      tool: "pencil_batch_design",
                      reason: "Inspect the document and correct the invalid node in an edit batch.",
                  },
        });
    };
    const walk = (raw: unknown, page: SemanticPage) => {
        const node = record(raw);
        if (!node) {
            issues.push({
                source: "studio",
                code: "INVALID_NODE",
                severity: "error",
                blocking: true,
                message: "A node is not an object",
                repair: {
                    tool: "pencil_batch_design",
                    reason: "Replace the invalid node.",
                },
            });
            return;
        }
        if (typeof node.id !== "string" || !node.id)
            add(node, "MISSING_ID", "Node has no native ID");
        else if (ids.has(node.id)) add(node, "DUPLICATE_ID", "Node ID is repeated");
        else ids.add(node.id);
        if (typeof node.type !== "string" || !node.type)
            add(node, "MISSING_TYPE", "Node type is missing");
        for (const key of ["x", "y", "width", "height"]) {
            const val = node[key];
            if (
                typeof val === "number" &&
                (!Number.isFinite(val) || ((key === "width" || key === "height") && val < 0))
            )
                add(node, "INVALID_GEOMETRY", "Invalid " + key, key);
        }
        const children = Array.isArray(node.children) ? node.children : [];
        if (
            children.length &&
            [
                "text",
                "text_input",
                "text_area",
                "select",
                "checkbox",
                "switch",
                "icon_font",
                "image",
            ].includes(String(node.type))
        )
            add(node, "LEAF_CHILDREN", "Leaf node cannot contain children", "children");
        for (const ref of semantics[String(node.id)]?.labelledBy ?? []) {
            const reason = invalidLabelReferenceReason(String(node.id), ref, page);
            if (!reason) continue;
            add(
                node,
                "INVALID_LABEL_REFERENCE",
                `Accessible label reference ${JSON.stringify(ref)} ${reason}. Use pencil_control_semantics to replace the reference or supply a label.`,
                "labelledBy",
            );
        }
        if (controlTypes.has(String(node.type))) {
            const data = semantics[String(node.id)];
            const label = [data?.label, node.label, node.ariaLabel, node.accessibleLabel].some(
                (v) => typeof v === "string" && v.trim(),
            );
            const references = data?.labelledBy ?? [];
            const reference = references.some((ref) => validReference(node, ref, page));
            if (!label && !reference)
                add(
                    node,
                    "CONTROL_LABEL",
                    "A neighboring visible text or placeholder is not an accessible label. Use pencil_control_semantics with a label or label-node references.",
                    "label",
                );
            if (node.type === "text_input" && node.inputType === "password" && node.secure !== true)
                add(node, "PASSWORD_SEMANTICS", "Password input must be secure", "secure", {
                    secure: true,
                });
        }
        for (const c of children) walk(c, page);
    };
    for (const page of pages) for (const root of page.roots) walk(root, page);
    return issues;
}
const BLOCKING = new Set([
    "text-overflow",
    "layout-overflow",
    "invalid-node",
    "missing-node-id",
    "duplicate-node-id",
    "leaf-children",
    "control-label",
    "invisible-text",
]);
export function nativeDiagnostics(value: unknown): Diagnostic[] {
    const data = record(value);
    const issues = Array.isArray(data?.issues) ? data.issues : [];
    return issues.map((raw) => {
        const i = record(raw) ?? {};
        const nodeId = typeof i.nodeId === "string" ? i.nodeId : undefined;
        const code = String(i.category ?? i.code ?? "native-lint");
        const property = typeof i.property === "string" ? i.property : undefined;
        const patch =
            property &&
            !property.startsWith("__") &&
            i.suggestedValue !== undefined &&
            i.suggestedValue !== null
                ? { [property]: i.suggestedValue }
                : undefined;
        return {
            source: "native",
            code,
            severity: i.severity === "error" ? "error" : i.severity === "info" ? "info" : "warning",
            blocking: BLOCKING.has(code),
            ...(nodeId ? { nodeId } : {}),
            ...(property ? { property } : {}),
            message: String(i.reason ?? i.message ?? code),
            ...(patch ? { patch } : {}),
            repair: nodeId
                ? {
                      tool: "pencil_update_node",
                      nodeId,
                      ...(patch ? { data: patch } : {}),
                  }
                : {
                      tool: "pencil_batch_design",
                      reason: "Inspect native lint detail and correct the reported document field.",
                  },
        };
    });
}
export function nativeQualityDiagnostics(
    doc: Record<string, unknown>,
    value: unknown,
): Diagnostic[] {
    const nodes = new Map<string, Record<string, unknown>>();
    const visit = (v: unknown) => {
        const n = record(v);
        if (!n) return;
        if (typeof n.id === "string") nodes.set(n.id, n);
        if (Array.isArray(n.children)) n.children.forEach(visit);
    };
    if (Array.isArray(doc.pages))
        for (const p of doc.pages) {
            const page = record(p);
            if (Array.isArray(page?.children)) page.children.forEach(visit);
        }
    else if (Array.isArray(doc.children)) doc.children.forEach(visit);
    const quality = record(value) ?? {};
    const diagnostics: Diagnostic[] = [];
    for (const category of ["geometryIssues", "layoutIssues"]) {
        const items = Array.isArray(quality[category]) ? (quality[category] as unknown[]) : [];
        for (const raw of items) {
            const item = record(raw);
            const message =
                typeof raw === "string"
                    ? raw
                    : String(item?.reason ?? item?.message ?? JSON.stringify(raw));
            const candidates =
                typeof item?.nodeId === "string"
                    ? [item.nodeId]
                    : [...message.matchAll(new RegExp("[(]([^)]+)[)]", "g"))].map((m) => m[1]!);
            const nodeId = candidates.find((id) => nodes.has(id));
            const node = nodeId ? nodes.get(nodeId) : undefined;
            const deliberateIcon = ["icon", "icon-button"].includes(String(node?.role));
            const size = message.match(/resolved ([0-9.]+)px/);
            const property = message.includes("tall")
                ? "height"
                : message.includes("wide")
                  ? "width"
                  : undefined;
            const patch =
                category === "geometryIssues" &&
                property &&
                size &&
                Number.isFinite(Number(size[1]))
                    ? { [property]: Number(size[1]) }
                    : undefined;
            diagnostics.push({
                source: "native",
                code: category === "geometryIssues" ? "geometry-overflow" : "layout-error",
                severity: nodeId && !deliberateIcon ? "error" : "warning",
                blocking: !!nodeId && !deliberateIcon,
                message,
                ...(nodeId ? { nodeId } : {}),
                ...(property ? { property } : {}),
                ...(patch ? { patch } : {}),
                repair: nodeId
                    ? {
                          tool: "pencil_update_node",
                          nodeId,
                          ...(patch ? { data: patch } : {}),
                      }
                    : {
                          tool: "pencil_batch_design",
                          reason: "Inspect native layout detail and identify the affected existing node before editing.",
                      },
            });
        }
    }
    return diagnostics;
}
