import type { Context } from "@deepseek-ai/cordis";
import { useState, useSyncExternalStore } from "react";
import { apply as applyWorkbench } from "./workbench/client.js";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type {} from "@deepseek-ai/dsh-client-ui-theme/client";
import type {} from "@deepseek-ai/dsh-client-locale/client";
import type { ToolCallViewProps } from "@deepseek-ai/dsh-client-ui-tool/client";
import { getBridge, RUNTIME_EVENT, type Runtime, type EditorProps } from "./workbench/contracts.js";
import { ManagedOpenPencilEditor } from "./vendor/client/editor-panel.js";
import type { PresentationGrant } from "./contracts.js";
import { RecentDocumentsView, recentRequest, recentStyle } from "./recent-view.js";
import {
    REFERENCE_SOURCE,
    selectionReference,
    serializeReference,
    referenceLabel,
} from "./reference.js";
import {
    subscribeOpenPencilSelection,
    getOpenPencilSelectionSnapshot,
} from "./vendor/client/selection-store.js";
export const name = "dsh-openpencil-studio";
export const inject = ["slots", "theme", "locale"];
const editorKey = (grant: Record<string, unknown>, owner: string) =>
    owner +
    "\n" +
    String(grant.sourcePath ?? (grant.document as { path?: string } | undefined)?.path ?? "");
export function StudioEditor(props: EditorProps) {
    const selection = useSyncExternalStore(
        (fn) => subscribeOpenPencilSelection(props.sessionId, fn),
        () => getOpenPencilSelectionSnapshot(props.sessionId),
    );
    const [referencing, setReferencing] = useState(false),
        [referenceError, setReferenceError] = useState<string>();
    const count =
        selection.selection && selection.selection.sourcePath === props.grant.sourcePath
            ? selection.selection.selectedIds.length
            : 0;
    const reference = async () => {
        setReferencing(true);
        setReferenceError(undefined);
        try {
            await props.onReferenceSelection?.();
        } catch (error) {
            setReferenceError(error instanceof Error ? error.message : String(error));
        } finally {
            setReferencing(false);
        }
    };
    return (
        <div style={{ display: "flex", flex: 1, minHeight: 0, flexDirection: "column" }}>
            {referenceError && (
                <div
                    role="alert"
                    style={{ padding: "6px 12px", color: "var(--dsw-alias-state-error-primary)" }}
                >
                    {referenceError}
                </div>
            )}
            <ManagedOpenPencilEditor
                {...props}
                grant={props.grant as PresentationGrant}
                workbenchActions={
                    <>
                        {count > 0 && props.onReferenceSelection && (
                            <button
                                type="button"
                                disabled={referencing}
                                onClick={() => void reference()}
                            >
                                {referencing ? "正在引用…" : `引用选区（${count}）`}
                            </button>
                        )}
                        {props.workbenchActions}
                    </>
                }
                colorScheme={props.colorScheme === "dark" ? "dark" : "light"}
                locale={props.locale === "zh" ? "zh-CN" : "en-US"}
            />
        </div>
    );
}
export function StudioCard({ block, sessionId }: ToolCallViewProps) {
    const [error, setError] = useState<string>();
    const envelope = (block as { meta?: Record<string, unknown> }).meta?.["$openpencilStudio"] as
        { grant?: PresentationGrant } | undefined;
    const grant = envelope?.grant;
    if (!grant) return null;
    const open = async () => {
        try {
            const host = getBridge().handler;
            if (!host) throw new Error("OpenPencil Studio workbench is not ready");
            if (
                !(await host.open(
                    {
                        grant: grant as unknown as Record<string, unknown>,
                        sessionId: String(sessionId),
                    },
                    false,
                ))
            )
                throw new Error("Editor switch was cancelled");
        } catch (e) {
            setError(e instanceof Error ? e.message : String(e));
        }
    };
    return (
        <div
            style={{
                border: "1px solid var(--ui-border)",
                borderRadius: 8,
                padding: 12,
                display: "grid",
                gap: 10,
            }}
        >
            <strong>OpenPencil · {grant.sourcePath?.split("/").at(-1)}</strong>
            <div style={{ display: "flex", gap: 12 }}>
                <button type="button" onClick={() => void open()}>
                    打开 / 编辑
                </button>
                {grant.document && (
                    <a href={grant.document.url} download={grant.document.path?.split("/").at(-1)}>
                        下载 .op
                    </a>
                )}
            </div>
            {grant.images?.map((frame, i) => (
                <figure key={i} style={{ margin: 0 }}>
                    <figcaption>{frame.name}</figcaption>
                    <img
                        alt={frame.name}
                        src={frame.previewUrl}
                        style={{ maxWidth: "100%", maxHeight: 420, objectFit: "contain" }}
                    />
                </figure>
            ))}
            {error && <div role="alert">{error}</div>}
        </div>
    );
}
export function apply(ctx: Context) {
    const bridge = getBridge();
    if (bridge.runtime)
        throw new Error(
            "An OpenPencil editor runtime is already registered; disable the old plugin first",
        );
    applyWorkbench(ctx);
    let referenceReady = false;
    void ctx.inject(["inputTriggers"], (scope) =>
        scope.effect(() => {
            const registry = scope.get("inputTriggers") as unknown as {
                registerSource(source: {
                    trigger: "@";
                    name: string;
                    candidates(): Promise<never[]>;
                    onPick(): undefined;
                    codec: {
                        clipboardText(ref: string): string;
                        serialize(ref: string, signal: AbortSignal): Promise<string>;
                    };
                }): () => void;
            };
            const dispose = registry.registerSource({
                trigger: "@",
                name: REFERENCE_SOURCE,
                candidates: async () => [],
                onPick: () => undefined,
                codec: {
                    clipboardText: serializeReference,
                    serialize: async (ref, signal) => {
                        signal.throwIfAborted();
                        return serializeReference(ref);
                    },
                },
            });
            referenceReady = true;
            return () => {
                referenceReady = false;
                dispose();
            };
        }),
    );
    const runtime: Runtime = {
        Editor: StudioEditor,
        EmptyView: RecentDocumentsView,
        onOpened: async (request) => {
            if (request.grant.sourcePath)
                await recentRequest(request.sessionId, "touch", request.grant.sourcePath);
        },
        reference: async (capture, sessionId, span) => {
            if (!referenceReady) throw new Error("引用服务尚未就绪，请重新加载插件后重试");
            const sessions = ctx.get("sessions") as unknown as {
                scope(id: string): Context | undefined;
            };
            const scope = sessions?.scope(sessionId);
            if (!scope) throw new Error("当前对话会话不可用");
            const value = selectionReference(capture),
                ref = JSON.stringify(value);
            const accepted = (
                scope as unknown as {
                    bail(subject: Context, name: string, value: unknown): unknown;
                }
            ).bail(scope, "slash/input-insert-reference", {
                span,
                reference: {
                    source: REFERENCE_SOURCE,
                    ref,
                    label: referenceLabel(value),
                    appearance: "file",
                    clipboardText: serializeReference(ref),
                },
            });
            if (accepted !== true) throw new Error("输入框已变化或正在提交，请重新点击引用选区");
        },
        options: {
            subscribeTheme: (notify) => ctx.on("theme/change", notify),
            getColorScheme: () => ctx.theme.getTheme().active.colorScheme,
            subscribeLocale: (notify) => ctx.on("locale/change", notify),
            getLocale: () => ctx.locale.getLocale().active,
        },
        key: editorKey,
        locale: (l) => (l === "zh" ? "zh" : "en"),
        preserve: async (state, controller) => {
            if (
                state.phase === "saving" &&
                (await controller.awaitExistingSave().catch(() => false))
            )
                return "saved";
            if (!state.dirty) return "clean";
            if (await controller.captureRecovery().catch(() => false)) return "recovered";
            controller.retainServerSessionOnUnmount();
            return "retained";
        },
    };
    ctx.effect(() => {
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-openpencil-studio";
        style.textContent =
            `.dsh-openpencil-studio-toolbar button {
      box-sizing: border-box; flex-shrink: 0; height: 24px; min-height: 24px; padding: 0 8px;
      border: 1px solid var(--dsw-alias-border-l2); border-radius: 6px;
      background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary);
      font-family: inherit; font-size: 12px; font-weight: 500; line-height: 22px;
      cursor: pointer; white-space: nowrap;
    }
    .dsh-openpencil-studio-toolbar button:disabled { opacity: .5; cursor: default; }
    .dsh-openpencil-studio-toolbar button:focus-visible {
      outline: 2px solid var(--dsw-alias-label-secondary); outline-offset: 2px;
    }` + recentStyle;
        document.head.append(style);
        bridge.runtime = runtime;
        window.dispatchEvent(new Event(RUNTIME_EVENT));
        return async () => {
            if (bridge.runtime === runtime) {
                await bridge.handler?.dispose();
                if (bridge.runtime === runtime) delete bridge.runtime;
            }
            style.remove();
            window.dispatchEvent(new Event(RUNTIME_EVENT));
        };
    });
    for (const key of ["pencil_create", "pencil_open", "pencil_save", "pencil_preview"])
        ctx.slots.inject("tool.call.toolview", () =>
            ctx.slots.register({ name: "tool.call.toolview", key }, StudioCard),
        );
}
