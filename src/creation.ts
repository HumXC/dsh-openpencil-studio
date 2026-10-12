import { getQuickJS } from "quickjs-emscripten";
import { randomUUID } from "node:crypto";
import { StudioError, record } from "./errors.js";
import { prepareScript } from "./script.js";
import { assertNativeArguments } from "./native.js";
export interface InsertIntent { kind: "I" | "K"; parent: string | null; node: Record<string, unknown>; kit?: string; binding: string }
export interface CreationPlan { script: string; inserts: InsertIntent[] }
/** Capture values in a bounded sandbox, never in Node eval. Native I/K still create every actual node. */
export async function planCreation(source: string): Promise<CreationPlan> {
  if (Buffer.byteLength(source) > 262144) throw new StudioError("SCRIPT_LIMIT", "Script exceeds 256 KiB", { committed: false });
  const clean = prepareScript(source), module = await getQuickJS(), runtime = module.newRuntime();
  runtime.setMemoryLimit(67108864); runtime.setMaxStackSize(1024 * 1024);
  const deadline = Date.now() + 2000; runtime.setInterruptHandler(() => Date.now() > deadline);
  const context = runtime.newContext(), inserts: InsertIntent[] = [], prefix = "studio-binding-" + randomUUID() + "-";
  let captureError: unknown;
  try {
    for (const kind of ["I", "K"] as const) {
      const fn = context.newFunction(kind, (...args) => {
        try {
          if (inserts.length >= 4096) throw new StudioError("INSERT_LIMIT", "At most 4096 insertions per batch", { committed: false });
          const values = args.map(arg => context.dump(arg)), offset = kind === "K" ? 1 : 0;
          const parent = values[offset] ?? null, node = record(values[offset + 1]) ?? (kind === "K" ? {} : undefined);
          if ((parent !== null && typeof parent !== "string") || !node) throw new StudioError("INVALID_INSERT", "Insertion needs an opaque parent ID or null and a node object", { committed: false });
          if ("id" in node) throw new StudioError("NODE_ID_FORBIDDEN", "Native insertions allocate IDs; omit id", { committed: false });
          const captured = JSON.parse(JSON.stringify(node)) as Record<string, unknown>;
          assertNativeArguments({ data: captured });
          const binding = prefix + inserts.length;
          inserts.push({ kind, parent, node: captured, ...(kind === "K" ? { kit: String(values[0]) } : {}), binding });
          if (Buffer.byteLength(JSON.stringify(inserts)) > 8388608) throw new StudioError("INSERT_DATA_LIMIT", "Recorded insertions exceed 8 MiB", { committed: false });
          return context.newString(binding);
        } catch (error) { captureError = error; return { error: context.newError(String(error)) }; }
      });
      context.setProp(context.global, kind, fn); fn.dispose();
    }
    const result = context.evalCode(clean, "studio-creation.js");
    if (result.error) { const error = context.dump(result.error); result.error.dispose(); throw captureError ?? new StudioError("SCRIPT_EXECUTION", "Script did not commit", { diagnostic: error, committed: false, recoverable: true }); }
    result.value.dispose();
    // A script can catch a host callback error; invalid captures must still abort the whole batch.
    if (captureError) throw captureError;
    const bindings = new Map<string, string>();
    const script = inserts.map((intent, i) => {
      const parent = intent.parent === null ? "null" : bindings.get(intent.parent) ?? JSON.stringify(intent.parent);
      const binding = "studioInsert" + i; bindings.set(intent.binding, binding);
      return "const " + binding + "=" + intent.kind + "(" + (intent.kind === "K" ? JSON.stringify(intent.kit) + "," : "") + parent + "," + JSON.stringify(intent.node) + ");";
    }).join("\n");
    if (Buffer.byteLength(script) > 262144) throw new StudioError("SCRIPT_LIMIT", "Expanded native batch exceeds 256 KiB; split the batch", { committed: false });
    return { script: prepareScript(script), inserts };
  } finally { context.dispose(); runtime.dispose(); }
}
/** Restore author-specified, native-supported fields; retain native IDs, types and newly inserted children. */
export function preserveCreation(before: Record<string, unknown>, after: Record<string, unknown>, plan: CreationPlan, result: unknown): boolean {
  const old = new Map<string, Record<string, unknown>>(), nodes = new Map<string, Record<string, unknown>>();
  const index = (raw: unknown, target: Map<string, Record<string, unknown>>) => {
    const n = record(raw); if (!n) return; if (typeof n.id === "string") target.set(n.id, n);
    for (const key of ["pages", "children"]) if (Array.isArray(n[key])) for (const child of n[key] as unknown[]) index(child, target);
  };
  index(before, old); index(after, nodes);
  const original = JSON.stringify(after);
  const patch = (node: Record<string, unknown>, authored: Record<string, unknown>) => {
    for (const [key, value] of Object.entries(authored)) if (!["id", "type", "children"].includes(key) && key in node) node[key] = value;
  };
  for (const [id, n] of old) if (nodes.has(id)) patch(nodes.get(id)!, n);
  const results = record(result)?.results;
  if (!Array.isArray(results) || results.length !== plan.inserts.length) throw new StudioError("INSERT_RESULT_INVALID", "Native insertion results do not match the captured batch", { recoverable: true });
  const bound = new Map<string, string>();
  for (const item of results) {
    const row = record(item);
    if (typeof row?.binding !== "string" || typeof row.nodeId !== "string" || bound.has(row.binding) || !nodes.has(row.nodeId)) throw new StudioError("INSERT_RESULT_INVALID", "Native insertion result has no unique binding and existing node ID", { recoverable: true });
    bound.set(row.binding, row.nodeId);
  }
  for (let i = 0; i < plan.inserts.length; i++) {
    // Native results follow tree order; bN refers to the Nth I/K call, irrespective of result order.
    const id = bound.get("b" + i);
    if (!id) throw new StudioError("INSERT_RESULT_INVALID", "Native insertion result is missing binding b" + i, { recoverable: true });
    const restore = (native: Record<string, unknown>, authored: Record<string, unknown>) => {
      patch(native, authored);
      if (Array.isArray(native.children) && Array.isArray(authored.children)) authored.children.forEach((child, at) => { const n = record((native.children as unknown[])[at]), a = record(child); if (n && a) restore(n, a); });
    };
    restore(nodes.get(id)!, plan.inserts[i]!.node);
  }
  return JSON.stringify(after) !== original;
}
