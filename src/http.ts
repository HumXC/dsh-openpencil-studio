import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";
import { ROUTE, type StudioSnapshot } from "./contracts.js";
import { Studio } from "./studio.js";
import { StudioError, errorResult, record } from "./errors.js";
import type { RecentDocuments } from "./recent.js";
import { proxyCanvas } from "./editor-proxy.js";
import { requireLocalRequest, WebRequestError } from "./transport.js";
function local(studio: Studio, req: IncomingMessage) {
  try {
    requireLocalRequest(req, { allowedOrigin: studio.origin, allowReadWithoutOrigin: true });
  } catch (error) {
    if (error instanceof WebRequestError) throw new StudioError(error.code, error.message);
    throw error;
  }
}
async function body(req: IncomingMessage) {
  if (req.headers["content-type"]?.split(";")[0] !== "application/json")
    throw new StudioError("EXPECTED_JSON", "Expected JSON");
  let length = 0;
  const chunks: Buffer[] = [];
  for await (const chunk of req) {
    const b = Buffer.from(chunk);
    length += b.length;
    if (length > 17 * 1024 * 1024)
      throw new StudioError("BODY_LIMIT", "Request exceeds 17 MiB");
    chunks.push(b);
  }
  const v = record(JSON.parse(Buffer.concat(chunks).toString("utf8")));
  if (!v) throw new StudioError("EXPECTED_OBJECT", "Expected JSON object");
  return v;
}
function reply(res: ServerResponse, status: number, value: unknown) {
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  res.end(JSON.stringify(value));
}
function snapshot(raw: unknown): StudioSnapshot {
  const s = record(raw);
  if (
    !s ||
    typeof s.dirty !== "boolean" ||
    typeof s.phase !== "string" ||
    ![s.generation, s.revision, s.sequence].every(
      (x) => Number.isSafeInteger(x) && Number(x) >= 0,
    )
  )
    throw new StudioError("INVALID_EDITOR_STATE", "Invalid editor state");
  return s as unknown as StudioSnapshot;
}
export async function handleStudio(
  studio: Studio,
  req: IncomingMessage,
  res: ServerResponse,
  recent?: RecentDocuments,
) {
  try {
    local(studio, req);
    const route = new URL(req.url ?? "/", "http://localhost").pathname.slice(
      ROUTE.length,
    );
    const parts = route.split("/").filter(Boolean);
    if (parts[0] === "recent" && req.method === "POST" && recent) {
      const input = await body(req), owner = input.sessionId;
      if (typeof owner !== "string") throw new StudioError("SESSION_REQUIRED", "Recent documents require a session");
      const result = input.action === "list" ? await recent.list(owner)
        : input.action === "remove" && typeof input.path === "string" ? await recent.remove(owner, input.path)
        : input.action === "touch" && typeof input.path === "string" ? await recent.touch(owner, input.path)
        : (() => { throw new StudioError("INVALID_ARGUMENT", "Invalid recent documents action"); })();
      reply(res, 200, result); return;
    }
    if (parts[0] === "preview" && req.method === "GET") {
      const image = studio.previews.get(parts[1] ?? "");
      if (!image)
        throw new StudioError(
          "INVALID_PREVIEW_GRANT",
          "Preview is unavailable",
        );
      await studio.authorize(image.sourcePath, image.owner, false);
      const bytes = await readFile(image.path);
      res.writeHead(200, {
        "content-type": "image/png",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      });
      res.end(bytes);
      return;
    }
    if (parts[0] === "grant") {
      const id = parts[1] ?? "";
      const grant = studio.grants.get(id);
      if (!grant)
        throw new StudioError(
          "INVALID_GRANT",
          "Document grant is not available",
        );
      if (parts[2] === "document" && req.method === "GET") {
        await studio.authorize(grant.path, grant.owner, false);
        const text = await readFile(grant.path, "utf8");
        res.writeHead(200, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        res.end(text);
        return;
      }
      if (parts[2] === "launch" && req.method === "POST") {
        const input = await body(req);
        if (input.sessionId !== grant.owner)
          throw new StudioError(
            "SESSION_OWNERSHIP",
            "This grant belongs to a different session",
          );
        reply(res, 200, await studio.attach(id, grant.owner));
        return;
      }
    }
    if (parts[0] === "editor") {
      const id = parts[1] ?? "",
        operation = parts[2];
      if (operation === "canvas") {
        await proxyCanvas(studio, id, req, res);
        return;
      }
      const { entry, browser } = studio.browser(id);
      await studio.authorize(
        entry.path,
        entry.owner,
        operation !== "selection",
      );
      if (operation === "selection" && req.method === "GET") {
        const selection = await studio.browserSelection(id);
        reply(res, 200, {
          selection,
          sourcePath: entry.path,
          source: "user-canvas",
          unsaved: browser.state.dirty,
          generation: browser.state.generation,
          revision: browser.state.revision,
        });
        return;
      }
      const input = await body(req);
      if (operation === "state" && req.method === "POST") {
        if (input.ownerSessionId !== entry.owner)
          throw new StudioError(
            "SESSION_OWNERSHIP",
            "Editor state belongs to another session",
          );
        reply(
          res,
          200,
          studio.report(
            id,
            snapshot(input.state),
            typeof input.ack === "string" ? input.ack : undefined,
            record(input.failedCommand) &&
              typeof record(input.failedCommand)?.id === "string" &&
              typeof record(input.failedCommand)?.message === "string"
              ? {
                  id: String(record(input.failedCommand)?.id),
                  message: String(record(input.failedCommand)?.message).slice(
                    0,
                    4096,
                  ),
                }
                : undefined,
            typeof input.syncAck === "string" ? input.syncAck : undefined,
          ),
        );
        return;
      }
      if (operation === "save" && req.method === "POST") {
        if (input.sessionId !== id || typeof input.docJson !== "string")
          throw new StudioError("INVALID_SAVE", "Invalid canvas save request");
        reply(
          res,
          200,
          await studio.saveBrowser(
            id,
            input.docJson,
            Number(input.generation),
            Number(input.revision),
          ),
        );
        return;
      }
      if (operation === "reload" && req.method === "POST") {
        if (input.ownerSessionId !== entry.owner)
          throw new StudioError(
            "SESSION_OWNERSHIP",
            "Editor reload belongs to another session",
          );
        reply(
          res,
          200,
          await studio.reloadBrowser(
            id,
            Number(input.generation),
            Number(input.revision),
          ),
        );
        return;
      }
      if (
        operation === "recovery" &&
        parts[3] &&
        (req.method === "POST" || req.method === "DELETE")
      ) {
        if (input.sessionId !== id)
          throw new StudioError(
            "SESSION_OWNERSHIP",
            "Recovery belongs to another editor session",
          );
        reply(
          res,
          200,
          await studio.recoveryItem(id, parts[3], req.method === "DELETE"),
        );
        return;
      }
      if (operation === "recovery" && req.method === "POST") {
        reply(
          res,
          200,
          await studio.recovery(
            id,
            typeof input.docJson === "string" ? input.docJson : undefined,
          ),
        );
        return;
      }
      if (operation === "close" && req.method === "DELETE") {
        if (input.sessionId !== id)
          throw new StudioError("SESSION_OWNERSHIP", "Invalid editor session");
        if (input.dirty === true) {
          await studio.recovery(id);
        }
        reply(res, 200, await studio.closeBrowser(id));
        return;
      }
    }
    reply(res, 404, { error: "Studio endpoint not found" });
  } catch (error) {
    reply(res, 400, errorResult(error));
  }
}
