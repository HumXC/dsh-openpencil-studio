import { authoredContent } from "./document-content.js";

export interface CanvasSync {
    id: string;
    documentJson: string;
}
export interface CanvasSyncState {
    current: boolean;
    baseline: string | undefined;
    generation: number;
    revision: number;
    comparison: number;
    phase: string;
    dirty: boolean;
    pending: boolean;
    recovered: boolean;
    activeLease: boolean;
    command: boolean;
}
export interface CanvasSnapshot {
    docJson: string;
    generation: number;
    revision: number;
}
export function canRefreshCanvas(state: CanvasSyncState): boolean {
    return (
        state.current &&
        state.baseline !== undefined &&
        state.phase === "ready" &&
        !state.dirty &&
        !state.pending &&
        !state.recovered &&
        !state.activeLease &&
        !state.command
    );
}

/** A local canvas transaction; the Host never waits for this work or its acknowledgement. */
export async function refreshCleanCanvas(
    sync: CanvasSync,
    hooks: {
        state: () => CanvasSyncState;
        lock: (value: boolean) => void;
        snapshot: () => Promise<CanvasSnapshot>;
        reload: (text: string) => Promise<void>;
        baseline: (content: string) => void;
        dirty: () => void;
    },
): Promise<"deferred" | "dirty" | "applied" | "obsolete"> {
    const initial = hooks.state();
    if (!canRefreshCanvas(initial)) return "deferred";
    const sameVersion = (
        a: { generation: number; revision: number },
        b: { generation: number; revision: number },
    ) => a.generation === b.generation && a.revision === b.revision;
    const sameComparison = (state: CanvasSyncState) =>
        state.current && state.comparison === initial.comparison;
    let reloading = false;
    hooks.lock(true);
    try {
        const before = hooks.state();
        if (
            !canRefreshCanvas(before) ||
            !sameComparison(before) ||
            before.baseline !== initial.baseline ||
            !sameVersion(before, initial)
        )
            return "deferred";
        const snapshot = await hooks.snapshot();
        const fresh = hooks.state();
        if (!sameComparison(fresh)) return "obsolete";
        if (
            !canRefreshCanvas(fresh) ||
            fresh.baseline !== initial.baseline ||
            !sameVersion(snapshot, before) ||
            !sameVersion(snapshot, fresh)
        )
            return "deferred";
        if (authoredContent(snapshot.docJson) !== initial.baseline) {
            hooks.dirty();
            return "dirty";
        }
        const content = authoredContent(sync.documentJson);
        reloading = true;
        await hooks.reload(sync.documentJson);
        const opened = hooks.state();
        if (!sameComparison(opened)) return "obsolete";
        // Install the known authored baseline before any later dirty comparison resumes.
        hooks.baseline(content);
        const confirmed = await hooks.snapshot();
        const final = hooks.state();
        if (!sameComparison(final)) return "obsolete";
        if (!sameVersion(confirmed, final)) return "deferred";
        if (authoredContent(confirmed.docJson) !== content) {
            hooks.dirty();
            return "dirty";
        }
        if (!canRefreshCanvas(final) || !sameVersion(confirmed, opened)) return "deferred";
        return "applied";
    } catch (error) {
        // A bridge failure is not evidence of an authored edit. Preserve the last known
        // dirty state; where a fresh snapshot is available, distinguish real edits
        // from either the original canvas or a partially applied Host refresh.
        if (reloading && sameComparison(hooks.state())) {
            try {
                const snapshot = await hooks.snapshot();
                const final = hooks.state();
                if (sameComparison(final) && sameVersion(snapshot, final)) {
                    const actual = authoredContent(snapshot.docJson);
                    if (
                        actual === initial.baseline ||
                        actual === authoredContent(sync.documentJson)
                    )
                        hooks.baseline(actual);
                    else hooks.dirty();
                }
            } catch {
                /* Keep the last confirmed dirty state and surface the original failure. */
            }
        }
        throw error;
    } finally {
        hooks.lock(false);
    }
}
