import { StudioError } from "./errors.js";

interface HistorySnapshot {
    documentJson: string;
    hash: string;
    bytes: number;
}

/** History for completed Studio document transactions, separate from canvas UI history. */
export class DocumentHistory {
    private past: HistorySnapshot[] = [];
    private future: HistorySnapshot[] = [];
    private currentHash?: string;
    constructor(
        readonly maxSteps = 32,
        readonly maxBytes = 32 * 1024 * 1024,
    ) {
        if (![maxSteps, maxBytes].every((limit) => Number.isSafeInteger(limit) && limit >= 0))
            throw new RangeError("History limits must be non-negative safe integers");
    }

    clear() {
        this.past = [];
        this.future = [];
        this.currentHash = undefined;
    }

    private align(hash: string) {
        if (this.currentHash !== undefined && this.currentHash !== hash) {
            this.past = [];
            this.future = [];
        }
        this.currentHash = hash;
    }

    depth(hash: string) {
        this.align(hash);
        return {
            past: this.past.length,
            future: this.future.length,
            scope: "agent-working-copy",
            retainedAcrossClose: false,
            maxSteps: this.maxSteps,
            maxBytes: this.maxBytes,
        };
    }

    private capture(documentJson: string, hash: string): HistorySnapshot {
        return { documentJson, hash, bytes: Buffer.byteLength(documentJson) };
    }

    private trim() {
        const bytes = () =>
            [...this.past, ...this.future].reduce((sum, entry) => sum + entry.bytes, 0);
        while (this.past.length + this.future.length > this.maxSteps || bytes() > this.maxBytes) {
            if (this.past.length) this.past.shift();
            else this.future.shift();
        }
    }

    record(before: string, beforeHash: string, afterHash: string) {
        this.align(beforeHash);
        if (beforeHash === afterHash) return;
        this.past.push(this.capture(before, beforeHash));
        this.future = [];
        this.currentHash = afterHash;
        this.trim();
    }

    target(direction: "undo" | "redo", hash: string): HistorySnapshot {
        this.align(hash);
        const stack = direction === "undo" ? this.past : this.future;
        const target = stack.at(-1);
        if (!target)
            throw new StudioError("HISTORY_EMPTY", `No Studio transaction to ${direction}`, {
                scope: "agent-working-copy",
                committed: false,
            });
        return target;
    }

    /** Called only after native restore and checkpoint persistence have succeeded. */
    complete(
        direction: "undo" | "redo",
        before: string,
        beforeHash: string,
        target: HistorySnapshot,
    ) {
        const source = direction === "undo" ? this.past : this.future;
        const destination = direction === "undo" ? this.future : this.past;
        if (this.currentHash !== beforeHash || source.at(-1) !== target)
            throw new StudioError(
                "HISTORY_CHANGED",
                "History changed during document transaction",
                { committed: false },
            );
        source.pop();
        destination.push(this.capture(before, beforeHash));
        this.currentHash = target.hash;
        this.trim();
    }
}
