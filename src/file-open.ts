import type { IncomingMessage, ServerResponse } from "node:http";
import type { Studio } from "./studio.js";
import { StudioError } from "./errors.js";
import { requireLocalRequest } from "./transport.js";

export const OPEN_ENDPOINT = "/_dsh/openpencil-studio/open";
type FileOpenHost = Pick<Studio, "origin" | "authorize" | "grantForDocument">;

function reply(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", "x-content-type-options": "nosniff" });
  res.end(JSON.stringify(value));
}

export async function grantForPath(studio: FileOpenHost, sessionId: string, path: string) {
  if (!path || path.includes("\0") || /^[a-z][a-z0-9+.-]*:/i.test(path) || !path.toLowerCase().endsWith(".op"))
    throw new StudioError("INVALID_PATH", "Expected a local .op file path");
  const sourcePath = await studio.authorize(path, sessionId, true);
  return studio.grantForDocument(sourcePath, "", { sessionId });
}

export async function handleOpen(studio: FileOpenHost, req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    requireLocalRequest(req, { allowedOrigin: studio.origin });
    if (req.method !== "POST") { reply(res, 405, { error: "Use POST" }); return; }
    if (req.headers["content-type"]?.split(";")[0] !== "application/json")
      throw new StudioError("INVALID_REQUEST", "Expected JSON");
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
      const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      size += bytes.length;
      if (size > 16384) throw new StudioError("INVALID_REQUEST", "Request too large");
      chunks.push(bytes);
    }
    const input: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new StudioError("INVALID_REQUEST", "Expected a file-open request");
    const { sessionId, path } = input as Record<string, unknown>;
    if (typeof sessionId !== "string" || !sessionId)
      throw new StudioError("SESSION_REQUIRED", "Expected sessionId");
    if (typeof path !== "string") throw new StudioError("INVALID_PATH", "Expected .op file path");
    reply(res, 200, { grant: await grantForPath(studio, sessionId, path) });
  } catch (error) {
    const code = error && typeof error === "object" && "code" in error ? String(error.code) : "INVALID_REQUEST";
    const missing = code === "ENOENT" || code === "ENOTDIR";
    reply(res, missing ? 404 : 400, { error: error instanceof Error ? error.message : String(error), code: missing ? "FILE_NOT_FOUND" : code });
  }
}
