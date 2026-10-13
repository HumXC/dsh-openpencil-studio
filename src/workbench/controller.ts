import {
    getBridge,
    VIEW_ID,
    type EditorRequest,
    type InputSpan,
    type Lifecycle,
    type LifecycleController,
    type Runtime,
    type WorkbenchHandler,
} from "./contracts.js";

/** One editor survives conversation view switches; all replacements are serialized. */
export class StudioWorkbench implements WorkbenchHandler {
    private current: EditorRequest | undefined;
    private currentRuntime: Runtime | undefined;
    private state: Lifecycle = { phase: "launching", dirty: false };
    private controller: LifecycleController | undefined;
    private readonly listeners = new Set<() => void>();
    private queue: Promise<unknown> = Promise.resolve();
    private stopped = false;
    private closing = false;
    private releasePromise: Promise<void> | undefined;
    private readonly opened = new WeakSet<EditorRequest>();
    private notice: { sessionId: string; message: string } | undefined;
    readonly navigators = new Map<string, (view: string, focus: string) => void>();
    readonly inputs = new Map<string, { captureInsertion(): InputSpan }>();

    constructor(
        private readonly confirmDiscard: () => boolean = () =>
            globalThis.confirm(
                "当前画布有未保存的修改，确定关闭吗？取消后可返回原文件继续编辑或保存。",
            ),
    ) {}

    async referenceSelection(): Promise<void> {
        const request = this.current,
            runtime = this.currentRuntime,
            controller = this.controller;
        const input = request && this.inputs.get(request.sessionId);
        if (!request || !runtime?.reference || !controller?.captureSelection || !input)
            throw new Error("对话输入框或选区尚未就绪，请稍后重试");
        const span = input.captureInsertion();
        const capture = await controller.captureSelection();
        if (this.current !== request || capture.sourcePath !== request.grant.sourcePath)
            throw new Error("编辑文件已切换，请重新选择引用内容");
        await runtime.reference(capture, request.sessionId, span);
        if (this.current === request) this.navigators.get(request.sessionId)?.("chat", "composer");
    }

    readonly getNotice = () => this.notice;
    readonly getSnapshot = (): EditorRequest | undefined => this.current;
    readonly getLifecycle = (): Lifecycle => this.state;
    report(sessionId: string, message: string): void {
        this.notice = { sessionId, message };
        this.emit();
        this.navigators.get(sessionId)?.(VIEW_ID, "error");
    }
    clearNotice(): void {
        this.notice = undefined;
        this.emit();
    }
    readonly subscribe = (fn: () => void): (() => void) => {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    };
    private notifyOpened(request: EditorRequest): void {
        if (this.opened.has(request)) return;
        this.opened.add(request);
        void this.currentRuntime?.onOpened?.(request).catch((error) => {
            if (this.current !== request) return;
            this.notice = {
                sessionId: request.sessionId,
                message: error instanceof Error ? error.message : String(error),
            };
            this.emit();
        });
    }
    readonly onState = (state: Lifecycle): void => {
        if (state.phase === "ready" && this.current) this.notifyOpened(this.current);
        if (this.state.phase === state.phase && this.state.dirty === state.dirty) return;
        this.state = state;
        this.emit();
    };
    readonly onController = (value: LifecycleController | undefined): void => {
        this.controller = value;
    };
    private emit(): void {
        for (const fn of this.listeners) fn();
    }
    private enqueue<T>(action: () => Promise<T>): Promise<T> {
        const result = this.queue.then(action);
        this.queue = result.catch(() => undefined);
        return result;
    }
    private canClose(): boolean {
        return this.state.phase !== "saving" && (!this.state.dirty || this.confirmDiscard());
    }
    private focus(request: EditorRequest): void {
        this.navigators.get(request.sessionId)?.(VIEW_ID, request.grant.sourcePath ?? "editor");
    }
    open(request: EditorRequest, automatic: boolean, signal?: AbortSignal): Promise<boolean> {
        return this.enqueue(async () => {
            const runtime = getBridge().runtime;
            if (signal?.aborted || this.stopped || this.closing || !runtime) return false;
            const old = this.current;
            if (
                old &&
                runtime.key(old.grant, old.sessionId) ===
                    runtime.key(request.grant, request.sessionId)
            ) {
                if (!automatic) {
                    this.current = { ...old, automatic: false };
                    if (this.state.phase === "ready") this.notifyOpened(this.current);
                    this.emit();
                    this.focus(request);
                }
                return true;
            }
            if (old) {
                if (automatic || !this.canClose()) return false;
                // An editor still launching cannot be discarded by a later request.
                if (!this.controller || !(await this.controller.requestClose().catch(() => false)))
                    return false;
                // A cancelled navigation must not reopen its stale file after close.
                if (signal?.aborted) {
                    this.clearEditor();
                    return false;
                }
            }
            this.controller = undefined;
            this.state = { phase: "launching", dirty: false };
            this.current = { ...request, automatic };
            this.currentRuntime = runtime;
            this.emit();
            if (!automatic) this.focus(request);
            return true;
        });
    }
    close(): Promise<boolean> {
        return this.enqueue(async () => {
            if (!this.current) return true;
            if (
                !this.canClose() ||
                !this.controller ||
                !(await this.controller.requestClose().catch(() => false))
            )
                return false;
            this.clearEditor();
            return true;
        });
    }
    private clearEditor(): void {
        this.current = undefined;
        this.currentRuntime = undefined;
        this.controller = undefined;
        this.emit();
    }
    /** Preserve the owning runtime even if its HMR cleanup already cleared the bridge. */
    release(): Promise<void> {
        if (this.releasePromise) return this.releasePromise;
        this.closing = true;
        this.releasePromise = (async () => {
            await this.queue;
            try {
                if (this.controller)
                    await this.currentRuntime?.preserve(this.state, this.controller);
                this.clearEditor();
            } finally {
                this.closing = false;
                this.releasePromise = undefined;
            }
        })();
        return this.releasePromise;
    }
    async dispose(): Promise<void> {
        if (this.stopped) return;
        this.stopped = true;
        await this.release();
        this.listeners.clear();
        this.navigators.clear();
        this.inputs.clear();
    }
}
