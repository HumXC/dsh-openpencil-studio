import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { readFile } from "node:fs/promises";
import { StudioError } from "./errors.js";
export interface EditorRuntime {
    binary: string;
    webBundleDir: string;
    canvasKitDir: string;
    openPencilVersion: string;
    revision: string;
    source: string;
}
export interface Snapshot {
    documentJson: string;
    version: number;
}
let loaded:
    | Promise<{
          runtime: EditorRuntime;
          read: (base: string, token: string) => Promise<Snapshot>;
          restore: (base: string, token: string, snapshot: Snapshot) => Promise<number>;
      }>
    | undefined;
export function official() {
    return (loaded ??= load());
}
async function load() {
    const req = createRequire(import.meta.url);
    const root = dirname(req.resolve("@zseven-w/dsh-openpencil/package.json"));
    const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8")) as {
        version: string;
    };
    if (manifest.version !== "0.1.0-rc.13")
        throw new StudioError(
            "UNSUPPORTED_OFFICIAL_VERSION",
            "Studio requires @zseven-w/dsh-openpencil 0.1.0-rc.13",
            { actualVersion: manifest.version },
        );
    const runtime = (await import(pathToFileURL(join(root, "lib/editor-runtime.js")).href)) as {
        resolveEditorRuntime: (options: {
            env: Record<string, string>;
            chmod: () => void;
        }) => EditorRuntime;
    };
    const recovery = (await import(pathToFileURL(join(root, "lib/editor-recovery.js")).href)) as {
        readManagedDaemonDocument: (
            base: string,
            token: string,
            fetcher?: typeof fetch,
        ) => Promise<Snapshot>;
        restoreManagedDaemonDocument: (base: string, token: string, s: Snapshot) => Promise<number>;
    };
    return {
        runtime: runtime.resolveEditorRuntime({ env: {}, chmod: () => {} }),
        read: async (base: string, token: string): Promise<Snapshot> => {
            let response: Response | undefined;
            const fetcher: typeof fetch = async (...args) => {
                const r = await fetch(...args);
                response = r.clone();
                return r;
            };
            const snapshot = await recovery.readManagedDaemonDocument(base, token, fetcher);
            const state = (await response!.json()) as {
                activePageIndex?: number;
                preserveAuthoredGeometry?: boolean;
            };
            const document = JSON.parse(snapshot.documentJson);
            document.editorMeta = {
                ...document.editorMeta,
                activePageIndex: state.activePageIndex ?? 0,
                preserveAuthoredGeometry: state.preserveAuthoredGeometry ?? false,
            };
            return { ...snapshot, documentJson: JSON.stringify(document) };
        },
        restore: async (base: string, _token: string, snapshot: Snapshot) =>
            restoreAuthoredSnapshot(base, snapshot),
    };
}
export async function readManagedDaemonDocument(
    base: string,
    token: string,
    _fetcher?: typeof fetch,
    signal?: AbortSignal,
): Promise<Snapshot> {
    signal?.throwIfAborted();
    return (await official()).read(base, token);
}
/** Version-bound native document commit retaining explicit author geometry. Source .op files are untouched. */
export async function restoreAuthoredSnapshot(base: string, snapshot: Snapshot): Promise<number> {
    const origin = new URL(base);
    if (
        !["127.0.0.1", "localhost", "[::1]"].includes(origin.hostname) ||
        origin.protocol !== "http:"
    )
        throw new StudioError("INVALID_DAEMON", "Expected local native daemon");
    // Keep normal layout resolution enabled so technical diagnostics remain active.
    const document = JSON.parse(snapshot.documentJson);
    const response = await fetch(new URL("/api/mcp/document", origin), {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            document,
            baseVersion: snapshot.version,
            activePageIndex: document.editorMeta?.activePageIndex ?? 0,
            preserveAuthoredGeometry: false,
            sourceClientId: "dsh-openpencil-studio",
        }),
        signal: AbortSignal.timeout(5000),
    });
    const result = (await response.json()) as { ok?: boolean; version?: number };
    if (!response.ok || result.ok !== true || !Number.isSafeInteger(result.version))
        throw new StudioError("AUTHORED_COMMIT_FAILED", "Native authored snapshot commit failed", {
            status: response.status,
            diagnostic: result,
        });
    return result.version!;
}
