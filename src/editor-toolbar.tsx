import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { observeEditorSidebar, toggleEditorSidebar } from "./editor-sidebar.js";
import type { EditorLocale } from "./vendor/client/editor-bridge.js";

interface StudioToolbarProps {
    title: string;
    path?: string;
    locale: EditorLocale;
    iframeRef: RefObject<HTMLIFrameElement>;
    ready: boolean;
    locked: boolean;
    children: ReactNode;
}

export function StudioToolbar({
    title,
    path,
    locale,
    iframeRef,
    ready,
    locked,
    children,
}: StudioToolbarProps) {
    const toolbarRef = useRef<HTMLDivElement>(null);
    const leftRef = useRef<HTMLDivElement>(null);
    const rightRef = useRef<HTMLDivElement>(null);
    const operationRef = useRef<AbortController>();
    const [open, setOpen] = useState<boolean>();
    const [pending, setPending] = useState(false);
    const [error, setError] = useState(false);
    const [titleWidth, setTitleWidth] = useState<number>();
    const zh = locale === "zh-CN";
    const label =
        open === false
            ? zh
                ? "展开左侧栏"
                : "Expand sidebar"
            : zh
              ? "收起左侧栏"
              : "Collapse sidebar";
    const failure = zh ? "无法切换左侧栏，请重试" : "Could not toggle sidebar; try again";

    useEffect(() => {
        const frame = iframeRef.current;
        setOpen(undefined);
        setError(false);
        if (!frame || !ready) {
            operationRef.current?.abort();
            operationRef.current = undefined;
            setPending(false);
            return;
        }
        return observeEditorSidebar(frame, setOpen);
    }, [iframeRef, ready]);
    useEffect(() => () => operationRef.current?.abort(), []);
    useEffect(() => {
        const root = toolbarRef.current,
            left = leftRef.current,
            right = rightRef.current;
        if (!root || !left || !right) return;
        const measure = () =>
            setTitleWidth(
                Math.max(
                    0,
                    root.clientWidth -
                        20 -
                        2 *
                            Math.max(
                                left.getBoundingClientRect().width,
                                right.getBoundingClientRect().width,
                            ) -
                        16,
                ),
            );
        measure();
        const observer = new ResizeObserver(measure);
        for (const target of [root, left, right]) observer.observe(target);
        return () => observer.disconnect();
    }, []);

    const toggle = async () => {
        const frame = iframeRef.current;
        if (!frame || !ready || locked || pending || open === undefined) return;
        const operation = new AbortController();
        operationRef.current?.abort();
        operationRef.current = operation;
        setPending(true);
        setError(false);
        try {
            await toggleEditorSidebar(frame, operation.signal);
        } catch {
            if (!operation.signal.aborted) setError(true);
        } finally {
            if (!operation.signal.aborted) setPending(false);
        }
    };

    return (
        <div
            ref={toolbarRef}
            className="dsh-openpencil-studio-toolbar"
            style={{
                position: "relative",
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                boxSizing: "border-box",
                height: 32,
                minHeight: 32,
                flex: "0 0 32px",
                padding: "3px 10px",
                gap: 6,
                borderBottom: "1px solid var(--border-soft)",
                background: "var(--surface-primary)",
            }}
        >
            <div ref={leftRef} style={{ display: "flex", alignItems: "center", flexShrink: 0 }}>
                <button
                    type="button"
                    aria-label={label}
                    title={error ? failure : label}
                    aria-expanded={open}
                    aria-busy={pending || undefined}
                    disabled={!ready || locked || pending || open === undefined}
                    onClick={() => void toggle()}
                    style={{
                        width: 24,
                        height: 24,
                        padding: 3,
                        display: "inline-flex",
                        alignItems: "center",
                        justifyContent: "center",
                    }}
                >
                    <svg
                        width="16"
                        height="16"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.6"
                        aria-hidden="true"
                        focusable="false"
                    >
                        <rect x="3" y="4" width="18" height="16" rx="2" />
                        <path d="M9 4v16" />
                        <path d={open === false ? "m13 9 3 3-3 3" : "m16 9-3 3 3 3"} />
                    </svg>
                </button>
                {error && (
                    <span
                        role="status"
                        style={{
                            position: "absolute",
                            left: 10,
                            top: 34,
                            zIndex: 2,
                            padding: "4px 8px",
                            borderRadius: 4,
                            background: "var(--surface-primary)",
                            color: "var(--error)",
                            fontSize: 12,
                        }}
                    >
                        {failure}
                    </span>
                )}
            </div>
            <strong
                title={path ?? title}
                style={{
                    position: "absolute",
                    left: "50%",
                    transform: "translateX(-50%)",
                    maxWidth: titleWidth ?? "40%",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                    fontSize: 13,
                    lineHeight: "18px",
                    color: "var(--text-primary)",
                }}
            >
                {title}
            </strong>
            <div
                ref={rightRef}
                style={{
                    display: "flex",
                    alignItems: "center",
                    gap: 6,
                    minWidth: 0,
                    maxWidth: "calc(100% - 36px)",
                    overflowX: "auto",
                    scrollbarWidth: "none",
                    whiteSpace: "nowrap",
                }}
            >
                {children}
            </div>
        </div>
    );
}
