import { mkdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { EditorRuntime } from "../../official.js";
/** Private settings for this document runtime; never touches active profile settings. */
export async function managedEditorProcessOptions(
    runtime: EditorRuntime,
    sourcePath: string,
    allowOrigin: string,
) {
    const configRoot = join(dirname(sourcePath), "settings");
    await mkdir(configRoot, { recursive: true, mode: 0o700 });
    return {
        args: [
            "--serve-web",
            "--managed",
            "--port",
            "0",
            "--file",
            sourcePath,
            "--allow-origin",
            allowOrigin,
            "--config-root",
            configRoot,
        ],
        env: {
            ...process.env,
            OPENPENCIL_WEB_BUNDLE_DIR: runtime.webBundleDir,
            OPENPENCIL_CANVASKIT_DIR: runtime.canvasKitDir,
        },
    };
}
