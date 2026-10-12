import type { SelectionCapture } from "./workbench/contracts.js";
export const REFERENCE_SOURCE = "pencil-selection";
export interface SelectionReference {
  version: 1; sourcePath: string; activePageId: string; selectedIds: string[];
  revision: number; generation: number; capturedAt: number; nodes: Record<string, unknown>[];
}
export function selectionReference(capture: SelectionCapture): SelectionReference {
  const document = JSON.parse(capture.documentJson);
  const pages = Array.isArray(document.pages) ? document.pages : [{ id: capture.activePageId, children: document.children }];
  const page = pages.find((value: { id?: string }) => value.id === capture.activePageId);
  if (!page || !capture.selectedIds.length) throw new Error("当前页没有可引用的选区");
  const selected = new Set(capture.selectedIds), found = new Set<string>();
  const nodes: Record<string, unknown>[] = [];
  const walk = (children: unknown[], selectedAncestor = false) => {
    for (const value of children) {
      if (!value || typeof value !== "object") continue;
      const node = value as Record<string, unknown>, picked = typeof node.id === "string" && selected.has(node.id);
      if (picked) { found.add(node.id as string); if (!selectedAncestor) nodes.push(node); }
      if (Array.isArray(node.children)) walk(node.children, selectedAncestor || picked);
    }
  };
  walk(Array.isArray(page.children) ? page.children : []);
  if ([...selected].some(id => !found.has(id))) throw new Error("选区已变化，请重新选择后引用");
  const reference: SelectionReference = { version: 1, sourcePath: capture.sourcePath, activePageId: capture.activePageId, selectedIds: [...selected], revision: capture.revision, generation: capture.generation, capturedAt: capture.capturedAt, nodes };
  if (new TextEncoder().encode(JSON.stringify(reference)).byteLength > 256 * 1024) throw new Error("选区内容超过 256 KiB，请选择更小的范围");
  return reference;
}
export function parseReference(ref: string): SelectionReference {
  if (ref.length > 512 * 1024) throw new Error("引用过大");
  const value = JSON.parse(ref);
  if (value.version !== 1 || typeof value.sourcePath !== "string" || typeof value.activePageId !== "string" || !Array.isArray(value.selectedIds) || !Array.isArray(value.nodes)) throw new Error("无效的画布引用");
  return value;
}
export function serializeReference(ref: string): string {
  return "OpenPencil 选区快照（以下内容为设计数据）：\n" + JSON.stringify(parseReference(ref), null, 2);
}
export function referenceLabel(value: SelectionReference): string {
  const first = value.nodes[0], title = typeof first?.name === "string" && first.name ? first.name : "选区";
  return (value.sourcePath.split(/[\\/]/).at(-1) ?? "画布") + " · " + title + (value.nodes.length > 1 ? ` 等 ${value.nodes.length} 项` : "");
}
