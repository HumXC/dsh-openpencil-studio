import { record, StudioError } from "./errors.js";
export const SEMANTICS_VARIABLE = "studio/accessibility";
export interface ControlSemantics {
  label?: string;
  labelledBy?: string[];
}
export interface SemanticPage {
  roots: unknown[];
  nodes: Map<string, Record<string, unknown>>;
  invisibleIds: Set<string>;
}
const controlTypes = new Set([
  "text_input", "text_area", "select", "checkbox", "switch",
]);
export function semanticPages(document: Record<string, unknown>): SemanticPage[] {
  const roots: unknown[][] = Array.isArray(document.pages)
    ? document.pages.map((raw) => {
        const page = record(raw);
        return Array.isArray(page?.children) ? page.children : [];
      })
    : [Array.isArray(document.children) ? document.children : []];
  return roots.map((children) => {
    const page: SemanticPage = {
      roots: children,
      nodes: new Map(),
      invisibleIds: new Set(),
    };
    const collect = (raw: unknown, ancestorInvisible = false) => {
      const node = record(raw);
      if (!node) return;
      const invisible = ancestorInvisible || node.visible === false;
      if (typeof node.id === "string") {
        page.nodes.set(node.id, node);
        if (invisible) page.invisibleIds.add(node.id);
      }
      for (const child of Array.isArray(node.children) ? node.children : [])
        collect(child, invisible);
    };
    children.forEach((raw) => collect(raw));
    return page;
  });
}
// Both readers and writers resolve only visible native text on the same page.
// Controls cannot provide labels through their names, placeholders or semantics.
export function invalidLabelReferenceReason(
  controlId: string,
  reference: string,
  page: SemanticPage,
): string | undefined {
  if (reference === controlId) return "references the control itself";
  const target = page.nodes.get(reference);
  if (!target) return "does not identify a node on the same page";
  const readableText = (node: Record<string, unknown>): boolean => {
    if (
      node.id === controlId ||
      controlTypes.has(String(node.type)) ||
      node.visible === false ||
      (typeof node.id === "string" && page.invisibleIds.has(node.id))
    ) return false;
    if (node.type === "text") {
      if (typeof node.content === "string") return Boolean(node.content.trim());
      // Native TextContent also accepts StyledTextSegment[] with required text.
      if (!Array.isArray(node.content)) return false;
      let meaningful = false;
      for (const raw of node.content) {
        const segment = record(raw);
        if (typeof segment?.text !== "string") return false;
        meaningful ||= Boolean(segment.text.trim());
      }
      return meaningful;
    }
    if (node.type !== "frame" && node.type !== "group") return false;
    return (Array.isArray(node.children) ? node.children : []).some((raw) => {
      const child = record(raw);
      return child ? readableText(child) : false;
    });
  };
  return readableText(target)
    ? undefined
    : "does not provide meaningful visible native text content";
}
function validatedControlSemantics(raw: unknown, nodeId: string): ControlSemantics {
  const control = record(raw);
  if (typeof nodeId !== "string" || !nodeId.trim() || !control)
    throw new StudioError(
      "INVALID_SEMANTIC_METADATA",
      "Invalid control semantics",
      { nodeId },
    );
  if (control.label !== undefined && typeof control.label !== "string")
    throw new StudioError(
      "INVALID_SEMANTIC_METADATA",
      "Accessible label must be a string",
      { nodeId, property: "label" },
    );
  if (control.labelledBy !== undefined) {
    if (!Array.isArray(control.labelledBy))
      throw new StudioError(
        "INVALID_SEMANTIC_METADATA",
        "Label-node references must be an array of non-blank strings",
        { nodeId, property: "labelledBy" },
      );
    for (const [referenceIndex, reference] of control.labelledBy.entries())
      if (typeof reference !== "string" || !reference.trim())
        throw new StudioError(
          "INVALID_SEMANTIC_METADATA",
          "Label-node references must be non-blank strings",
          { nodeId, property: "labelledBy", referenceIndex, reference },
        );
  }
  return control as ControlSemantics;
}
export function controlSemantics(
  document: Record<string, unknown>,
): Record<string, ControlSemantics> {
  const variable = record(record(document.variables)?.[SEMANTICS_VARIABLE]);
  if (!variable) return {};
  if (variable.type !== "string" || typeof variable.value !== "string")
    throw new StudioError(
      "INVALID_SEMANTIC_METADATA",
      "The Studio accessibility variable must be a string",
    );
  let value: unknown;
  try {
    value = JSON.parse(variable.value);
  } catch {
    throw new StudioError(
      "INVALID_SEMANTIC_METADATA",
      "Studio accessibility metadata is not JSON",
    );
  }
  const data = record(value),
    controls = record(data?.controls);
  if (data?.schemaVersion !== 1 || !controls)
    throw new StudioError(
      "INVALID_SEMANTIC_METADATA",
      "Unsupported Studio accessibility metadata",
    );
  for (const [id, raw] of Object.entries(controls))
    validatedControlSemantics(raw, id);
  return controls as Record<string, ControlSemantics>;
}
export function withControlSemantics(
  document: Record<string, unknown>,
  nodeId: string,
  patch: ControlSemantics,
) {
  const validated = validatedControlSemantics(patch, nodeId);
  const label = validated.label?.trim(),
    labelledBy = validated.labelledBy;
  if (!label && !labelledBy?.length)
    throw new StudioError(
      "CONTROL_LABEL_REQUIRED",
      "Provide a non-empty accessible label or label-node references",
      { nodeId },
    );
  const page = semanticPages(document).find((candidate) => candidate.nodes.has(nodeId));
  const node = page?.nodes.get(nodeId);
  if (!page || !node || !controlTypes.has(String(node.type)))
    throw new StudioError("CONTROL_NODE_REQUIRED", "Expected a real control node ID", { nodeId });
  for (const [referenceIndex, reference] of (labelledBy ?? []).entries()) {
    const reason = invalidLabelReferenceReason(nodeId, reference, page);
    if (reason)
      throw new StudioError(
        "INVALID_LABEL_REFERENCE",
        `Accessible label reference ${JSON.stringify(reference)} ${reason}. Use pencil_control_semantics to replace the reference or supply a label.`,
        { nodeId, property: "labelledBy", referenceIndex, reference, committed: false },
      );
  }
  // Replace one valid entry, allowing label-only repairs to clear stale references.
  // Parse the entire prior value so malformed metadata is never silently discarded.
  const controls = {
    ...controlSemantics(document),
    [nodeId]: {
      ...(label ? { label } : {}),
      ...(labelledBy?.length ? { labelledBy: [...labelledBy] } : {}),
    },
  };
  return {
    ...record(document.variables),
    [SEMANTICS_VARIABLE]: {
      type: "string",
      value: JSON.stringify({ schemaVersion: 1, controls }),
    },
  };
}
