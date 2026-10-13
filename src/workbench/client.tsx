import { useLayoutEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import type { Context } from "@deepseek-ai/cordis";
import type {} from "@deepseek-ai/dsh-client-ui-renderer/client";
import type { ConvViewProps } from "@deepseek-ai/dsh-client-ui-conversation/client";
import type {} from "@deepseek-ai/dsh-client-ui-session/client";
import { getBridge, RUNTIME_EVENT, VIEW_ID } from "./contracts.js";
import { StudioWorkbench } from "./controller.js";
import { registerNavigation, openDocument } from "./navigation.js";
import { registerSidebarPreview } from "./sidebar-preview.js";

export function apply(ctx: Pick<Context, "effect" | "slots" | "inject">): void {
    ctx.effect(() => {
        const bridge = getBridge(),
            workbench = new StudioWorkbench();
        const subscribeRuntime = (fn: () => void): (() => void) => {
            window.addEventListener(RUNTIME_EVENT, fn);
            return () => window.removeEventListener(RUNTIME_EVENT, fn);
        };
        // Keep the editor root mounted while conversation tabs exchange the visible seat.
        const parking = document.createElement("div"),
            mount = document.createElement("div");
        parking.dataset.openpencilStudioParking = "true";
        Object.assign(parking.style, { position: "fixed", display: "none", zIndex: "10" });
        mount.className = "dsh-openpencil-studio-editor";
        parking.append(mount);
        document.body.append(parking);
        const root = createRoot(mount);
        let seat: HTMLElement | null = null;
        const position = (): void => {
            const request = workbench.getSnapshot();
            const rect = seat?.getBoundingClientRect();
            const active =
                !!request &&
                seat?.dataset.sessionId === request.sessionId &&
                rect &&
                rect.width > 0 &&
                rect.height > 0;
            Object.assign(
                parking.style,
                active
                    ? {
                          display: "flex",
                          left: rect.left + "px",
                          top: rect.top + "px",
                          width: rect.width + "px",
                          height: rect.height + "px",
                      }
                    : { display: "none" },
            );
        };
        const observer = new ResizeObserver(position);
        const attachSeat = (element: HTMLElement | null): void => {
            observer.disconnect();
            seat = element;
            if (element) observer.observe(element);
            position();
        };
        window.addEventListener("resize", position);
        window.addEventListener("scroll", position, true);
        function Editor() {
            const request = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot);
            const runtime = bridge.runtime;
            if (!runtime || !request) return null;
            return <EditorWithRuntime key={runtime.key(request.grant, request.sessionId)} />;
        }
        function EditorWithRuntime() {
            const request = workbench.getSnapshot()!,
                runtime = bridge.runtime!,
                options = runtime.options;
            const colorScheme = useSyncExternalStore(
                options.subscribeTheme,
                options.getColorScheme,
            );
            const locale = useSyncExternalStore(options.subscribeLocale, options.getLocale);
            const lifecycle = useSyncExternalStore(workbench.subscribe, workbench.getLifecycle);
            const [closing, setClosing] = useState(false);
            const close = async (): Promise<void> => {
                setClosing(true);
                try {
                    await workbench.close();
                } catch (error) {
                    workbench.report(
                        request.sessionId,
                        error instanceof Error ? error.message : String(error),
                    );
                } finally {
                    setClosing(false);
                }
            };
            const Component = runtime.Editor;
            return (
                <Component
                    grant={request.grant}
                    sessionId={request.sessionId}
                    colorScheme={colorScheme}
                    locale={runtime.locale(locale)}
                    allowTakeover={request.automatic !== true}
                    onLifecycleState={workbench.onState}
                    onLifecycleController={workbench.onController}
                    onReferenceSelection={() => workbench.referenceSelection()}
                    workbenchActions={
                        <button
                            type="button"
                            className="dsh-openpencil-studio-action"
                            disabled={closing || lifecycle.phase === "saving"}
                            title={
                                lifecycle.phase === "saving"
                                    ? "请等待保存完成"
                                    : "关闭画布并释放编辑会话"
                            }
                            onClick={() => {
                                void close();
                            }}
                        >
                            {closing ? "正在关闭…" : "关闭"}
                        </button>
                    }
                />
            );
        }
        function View(props: ConvViewProps) {
            const runtime = useSyncExternalStore(subscribeRuntime, () => bridge.runtime);
            const request = useSyncExternalStore(workbench.subscribe, workbench.getSnapshot);
            const notice = useSyncExternalStore(workbench.subscribe, workbench.getNotice);
            useLayoutEffect(() => {
                if (props.viewRequest?.view === VIEW_ID) props.completeViewRequest();
            }, [props.viewRequest, props.completeViewRequest]);
            useLayoutEffect(position, [props.sessionId, request, notice]);
            const active = request?.sessionId === props.sessionId ? request : undefined;
            return (
                <section className="dsh-openpencil-studio-view" data-openpencil-studio="true">
                    {notice && notice.sessionId === props.sessionId && (
                        <div role="alert">
                            {notice.message}
                            <button type="button" onClick={() => workbench.clearNotice()}>
                                关闭提示
                            </button>
                        </div>
                    )}
                    <div
                        className="dsh-openpencil-studio-seat"
                        data-session-id={props.sessionId}
                        ref={attachSeat}
                    />
                    {!active &&
                        (runtime?.EmptyView ? (
                            <runtime.EmptyView
                                key={props.sessionId}
                                sessionId={props.sessionId}
                                open={(path) => openDocument(workbench, props.sessionId, path)}
                            />
                        ) : (
                            <div className="dsh-openpencil-studio-empty">
                                点击聊天中的 .op 文件链接或卡片的“编辑画布”，即可在这里继续编辑。
                                {request ? "另一个会话的文件仍保留在编辑器中。" : ""}
                            </div>
                        ))}
                </section>
            );
        }
        const refresh = (): void => {
            position();
            root.render(<Editor />);
        };
        const disposeStore = workbench.subscribe(position);
        const handler = {
            open: (request: Parameters<StudioWorkbench["open"]>[0], automatic: boolean) =>
                workbench.open(request, automatic),
            dispose: () => workbench.release(),
        };
        bridge.handler = handler;
        const disposeNavigation = registerNavigation(ctx, workbench);
        const disposeSidebar = registerSidebarPreview(ctx, workbench);
        const disposeView = ctx.slots.inject("conversation.view", () =>
            ctx.slots.register(
                { name: "conversation.view", id: VIEW_ID, label: "OpenPencil", order: 25 },
                View,
            ),
        );
        const style = document.createElement("style");
        style.dataset.plugin = "dsh-openpencil-studio-workbench";
        style.textContent = workbenchStyle;
        document.head.append(style);
        window.addEventListener(RUNTIME_EVENT, refresh);
        refresh();
        return async () => {
            await disposeSidebar();
            await workbench.dispose();
            if (bridge.handler === handler) delete bridge.handler;
            window.removeEventListener(RUNTIME_EVENT, refresh);
            window.removeEventListener("resize", position);
            window.removeEventListener("scroll", position, true);
            observer.disconnect();
            disposeNavigation();
            disposeView();
            disposeStore();
            root.unmount();
            mount.remove();
            parking.remove();
            style.remove();
        };
    }, "OpenPencil Studio conversation workbench");
}
const workbenchStyle = `
.dsh-openpencil-studio-view { position:relative; height:100%; min-height:460px; display:flex; flex-direction:column; max-width:none; }
.dsh-openpencil-studio-seat { flex:1; min-height:0; display:flex; }
.dsh-openpencil-studio-editor { flex:1; min-width:0; height:100%; display:flex; flex-direction:column; }
.dsh-openpencil-studio-editor > * { flex:1; min-height:0; }
.dsh-openpencil-studio-editor iframe { flex:1; width:100%; min-height:380px; }
.dsh-openpencil-studio-empty { position:absolute; top:32px; left:32px; right:32px; opacity:.8; pointer-events:none; }
[data-conversation-scroll]:has(.dsh-openpencil-studio-view) > [data-composer-seat]:not(:has([data-approval-key], [data-question-key], [data-plan-review-key])) { display:none; }
`;
