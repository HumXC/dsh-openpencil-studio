export class StudioError extends Error {
    constructor(
        readonly code: string,
        message: string,
        readonly details: Record<string, unknown> = {},
    ) {
        super(message);
        this.name = "StudioError";
    }
}
export const errorResult = (error: unknown): Record<string, unknown> => {
    if (error instanceof StudioError) {
        const recovery =
            error.details.recovery ??
            (error.code === "VALIDATION_REQUIRED"
                ? "Apply the real node repair targets, then validate and save again."
                : error.code === "UNSAVED_USER_CHANGES"
                  ? "Ask the user to choose a disposition; use the current canvas revision with pencil_resolve_unsaved."
                  : error.code === "SAVE_CONFLICT" || error.code === "SOURCE_CHANGED"
                    ? "Compare the retained working copy with the source; explicitly reload only after choosing which work to retain."
                    : "Correct the reported condition on the existing document. If the host failed, preserve the checkpoint and reopen only after the host is healthy.");
        return {
            ...error.details,
            ok: false,
            stage: "error",
            code: error.code,
            error: error.message,
            recoverable: error.details.recoverable ?? true,
            recovery,
        };
    }
    return {
        ok: false,
        stage: "error",
        code: "HOST_FAILURE",
        error: error instanceof Error ? error.message : String(error),
        recoverable: true,
        recovery:
            "Inspect the host failure and retained checkpoint before reopening; no replacement document was generated.",
    };
};
export const record = (v: unknown): Record<string, unknown> | undefined =>
    v !== null && typeof v === "object" && !Array.isArray(v)
        ? (v as Record<string, unknown>)
        : undefined;
