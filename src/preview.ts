import { mkdir, mkdtemp, writeFile, realpath, rm } from "node:fs/promises";
import { join, resolve, dirname, basename } from "node:path";
import { official } from "./official.js";
import { StudioError, record } from "./errors.js";
import { rpc, callNative } from "./native.js";
import {
  startManagedEditorDaemon,
  stopManagedEditorDaemon,
} from "./vendor/server/managed-editor-daemon.js";
/** Remove only a verified direct preview child; retained checkpoints are separate. */
export async function removePreviewDirectory(directory: string, previewRoot: string) {
  const intended = resolve(directory), parent = resolve(previewRoot);
  if (dirname(intended) !== parent || !basename(intended).startsWith("preview-"))
    throw new StudioError("INVALID_PREVIEW_DIRECTORY", "Preview cleanup target is outside its owned directory");
  try {
    const [actual, actualParent] = await Promise.all([realpath(intended), realpath(parent)]);
    if (dirname(actual) !== actualParent || basename(actual) !== basename(intended))
      throw new StudioError("INVALID_PREVIEW_DIRECTORY", "Preview cleanup target changed on disk");
  } catch (error) {
    if (record(error)?.code === "ENOENT") return;
    throw error;
  }
  await rm(intended, { recursive: true, force: true });
}
/** Snapshot-only runtime: preview never changes the editor or working document. */
export async function renderPages(
  document: Record<string, unknown>,
  directory: string,
  allowOrigin: string,
  nodeId?: string,
) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = await mkdtemp(join(directory, "preview-"));
  const input = join(root, "snapshot.op");
  let daemon: Awaited<ReturnType<typeof startManagedEditorDaemon>> | undefined;
  let completed = false;
  const frames: {
    path: string;
    nodeId: string;
    pageId: string;
    name: string;
    width: number;
    height: number;
    bytes: number;
  }[] = [];
  try {
    await writeFile(input, JSON.stringify(document), { mode: 0o600 });
    daemon = await startManagedEditorDaemon((await official()).runtime, {
      sourcePath: input,
      allowOrigin,
    });
    const pages = Array.isArray(document.pages)
      ? document.pages
      : [{ id: "document", children: document.children }];
    for (const [index, raw] of pages.entries()) {
      const page = record(raw);
      if (!page) continue;
      const nodes = (Array.isArray(page.children) ? page.children : [])
        .map(record)
        .filter(
          (n): n is Record<string, unknown> =>
            !!n &&
            n.type === "frame" &&
            typeof n.id === "string" &&
            (!nodeId || n.id === nodeId),
        );
      if (!nodes.length) continue;
      if (Array.isArray(document.pages))
        await callNative(daemon, "set_active_page", { index: String(index) });
      for (const node of nodes) {
        const id = String(node.id);
        const result = record(
          await rpc(daemon, "tools/call", {
            name: "get_screenshot",
            arguments: { nodeId: id },
          }),
        );
        const blocks = Array.isArray(result?.content)
          ? result.content.map(record)
          : [];
        const image = blocks.find(
          (b) =>
            b?.type === "image" &&
            b.mimeType === "image/png" &&
            typeof b.data === "string",
        );
        if (result?.isError || !image)
          throw new StudioError(
            "PREVIEW_FAILED",
            "Native screenshot did not return a PNG",
            {
              nodeId: id,
              diagnostic: blocks.filter((b) => b?.type !== "image"),
              savedStateUnchanged: true,
            },
          );
        const bytes = Buffer.from(String(image.data), "base64");
        if (
          bytes.length < 24 ||
          bytes.toString("hex", 0, 8) !== "89504e470d0a1a0a"
        )
          throw new StudioError(
            "INVALID_PREVIEW",
            "Native screenshot is not a PNG",
            { nodeId: id, savedStateUnchanged: true },
          );
        const path = join(root, "page-" + index + "-" + frames.length + ".png");
        await writeFile(path, bytes, { mode: 0o600 });
        frames.push({
          path,
          nodeId: id,
          pageId: String(page.id ?? index),
          name: String(node.name ?? id),
          width: bytes.readUInt32BE(16),
          height: bytes.readUInt32BE(20),
          bytes: bytes.length,
        });
      }
    }
    if (!frames.length)
      throw new StudioError(
        "NO_ARTBOARD",
        "No matching top-level frame exists for preview",
        { savedStateUnchanged: true },
      );
    completed = true;
    return frames;
  } finally {
    try {
      if (daemon) await stopManagedEditorDaemon(daemon);
    } catch (error) {
      completed = false;
      throw error;
    } finally {
      if (!completed) await removePreviewDirectory(root, directory);
    }
  }
}
