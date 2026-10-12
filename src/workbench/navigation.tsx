import { createElement, useCallback, useEffect, type ComponentType } from "react";
import type { StoredEntry } from "@deepseek-ai/dsh-client-ui-slots";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import { isOpPath, type Grant, OPEN_ENDPOINT } from "./contracts.js";
import type { StudioWorkbench } from "./controller.js";

type Props = Record<string, unknown>;
type OpenFile = (path: string, options?: unknown) => Promise<void>;
export class DocumentOpenError extends Error {
  constructor(message: string, readonly code?: string) { super(message); }
}
export async function loadDocument(sessionId: string, path: string, signal?: AbortSignal): Promise<Grant> {
  const response = await fetch(OPEN_ENDPOINT, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, path }), ...(signal ? { signal } : {}) });
  const value = await response.json() as { grant?: Grant; error?: string; code?: string };
  signal?.throwIfAborted();
  if (!response.ok || !value.grant) throw new DocumentOpenError(value.error ?? "无法打开 OpenPencil 文件", value.code);
  return value.grant;
}
export async function openDocument(workbench: StudioWorkbench, sessionId: string, path: string, signal?: AbortSignal): Promise<void> {
  const grant = await loadDocument(sessionId, path, signal);
  if (!await workbench.open({ sessionId, grant }, false, signal)) throw new Error("请先完成当前编辑器的保存或关闭操作");
}
/** Decorate the public component face without replacing slot ownership or cached injection. */
export function registerNavigation(ctx: Pick<Context, "slots">, workbench: StudioWorkbench): () => void {
  type Decoration = { original: unknown; wrapped: ComponentType<Props> };
  const releases: (() => void)[] = [];
  for (const name of ["conversation.session", "conversation.view"] as const) {
    const decorated = new Map<StoredEntry, Decoration>();
    let stopped = false;
    const invalidate = (): void => {
      const register = ctx.slots.register as unknown as (options: Record<string, unknown>, component: ComponentType<Props>) => () => void;
      const release = register.call(ctx.slots, { name, priority: Number.MIN_SAFE_INTEGER, ...(name === "conversation.view" ? { id: "openpencil-studio:refresh" } : {}) }, () => null);
      release();
    };
    const sync = (): void => {
      if (stopped) return;
      const entries = ctx.slots.entries(name).filter(entry => name !== "conversation.view" || entry.options.id === "chat");
      let changed = false;
      for (const [entry, decoration] of decorated) {
        if (!entries.includes(entry) || entry.component !== decoration.wrapped) {
          if (entry.component === decoration.wrapped) entry.component = decoration.original;
          decorated.delete(entry);
        }
      }
      for (const entry of entries) {
        if (decorated.has(entry)) continue;
        const original = entry.component;
        const Original = original as ComponentType<Props>;
        function Wrapped(props: Props) {
          const sessionId = props.sessionId as string;
          const openView = props.openView as (view: string, focus: string) => void;
          useEffect(() => {
            if (name !== "conversation.session" || typeof openView !== "function") return;
            workbench.navigators.set(sessionId, openView);
            const input = props.inputActions as { captureInsertion(): { start: number; end: number; draftRev: number } } | undefined;
            if (input) workbench.inputs.set(sessionId, input);
            return () => {
              if (workbench.navigators.get(sessionId) === openView) workbench.navigators.delete(sessionId);
              if (workbench.inputs.get(sessionId) === input) workbench.inputs.delete(sessionId);
            };
          }, [sessionId, openView, props.inputActions]);
          const originalOpen = props.openFile as OpenFile;
          const openFile = useCallback<OpenFile>((path, options) => isOpPath(path)
            ? openDocument(workbench, sessionId, path).catch(error => { workbench.report(sessionId, error instanceof Error ? error.message : String(error)); })
            : originalOpen(path, options), [sessionId, originalOpen]);
          return createElement(Original, name === "conversation.view" ? { ...props, openFile } : props);
        }
        entry.component = Wrapped;
        decorated.set(entry, { original, wrapped: Wrapped }); changed = true;
      }
      if (changed) invalidate();
    };
    releases.push(ctx.slots.subscribe(name, sync)); sync();
    releases.push(() => {
      stopped = true;
      for (const [entry, decoration] of decorated) if (entry.component === decoration.wrapped) entry.component = decoration.original;
      decorated.clear();
      if (ctx.slots.entries(name).length) invalidate();
    });
  }
  return () => { for (const release of releases.reverse()) release(); };
}
