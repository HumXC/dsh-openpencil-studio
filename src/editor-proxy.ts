import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { ROUTE } from "./contracts.js";
import { StudioError } from "./errors.js";
import type { Studio } from "./studio.js";

const methods: Record<string, readonly string[]> = {
    "/api/mcp/document": ["GET", "POST"],
    "/api/mcp/version": ["GET"],
    "/api/mcp/events": ["GET"],
    "/api/mcp/selection": ["GET", "POST"],
    "/api/mcp/server": ["GET"],
    "/api/mcp/indicators": ["GET"],
    "/api/mcp/sync-reset": ["POST"],
    "/api/export/pdf": ["POST"],
    "/api/export/raster": ["POST"],
};

export function canvasPrefix(id: string): string {
    return `${ROUTE}/editor/${encodeURIComponent(id)}/canvas/`;
}

/** Only the managed canvas protocol and native bundle are exposed. */
export function canvasRequestPath(raw: string, method: string): string {
    let decoded: string;
    try {
        decoded = decodeURIComponent(raw);
    } catch {
        throw new StudioError("INVALID_PROXY_PATH", "Invalid editor resource path");
    }
    if (
        /[\\\0%?#:]/.test(decoded) ||
        decoded
            .split("/")
            .slice(1)
            .some((part) => part.startsWith(".") || !part)
    ) {
        if (decoded !== "/")
            throw new StudioError("INVALID_PROXY_PATH", "Invalid editor resource path");
    }
    const resource =
        decoded === "/" ||
        decoded === "/index.html" ||
        decoded.startsWith("/pkg/") ||
        decoded.startsWith("/canvaskit/") ||
        decoded === "/assets/iconify-catalog-brands.json";
    if (resource && (method === "GET" || method === "HEAD")) return decoded;
    if (methods[decoded]?.includes(method)) return decoded;
    throw new StudioError(
        "PROXY_ROUTE_UNSUPPORTED",
        "This route is not part of the managed editor protocol",
    );
}

/** Native WASM derives its API base from location.origin. Adapt those root
 * requests within this iframe before mounting; external URLs stay untouched. */
export function canvasBootstrap(prefix: string): string {
    return `(() => {
    const prefix = ${JSON.stringify(prefix)};
    const mapURL = value => {
      const url = new URL(String(value), location.href);
      if (url.origin === location.origin && (/^\\/(?:pkg|canvaskit|api)\\//.test(url.pathname) || url.pathname === '/assets/iconify-catalog-brands.json')) {
        url.pathname = prefix.slice(0, -1) + url.pathname;
      }
      return url.href;
    };
    const originalFetch = window.fetch;
    window.fetch = function(input, init) {
      const raw = input instanceof Request ? input.url : input;
      const mapped = mapURL(raw);
      return originalFetch.call(this, input instanceof Request && mapped !== input.url ? new Request(mapped, input) : input instanceof Request ? input : mapped, init);
    };
    const originalOpen = XMLHttpRequest.prototype.open;
    XMLHttpRequest.prototype.open = function(method, url, ...args) {
      return originalOpen.call(this, method, mapURL(url), ...args);
    };
    if (window.EventSource) {
      const OriginalEventSource = window.EventSource;
      window.EventSource = class extends OriginalEventSource {
        constructor(url, options) { super(mapURL(url), options); }
      };
    }
  })();`;
}

export function rewriteCanvasText(text: string, prefix: string, html: boolean): string {
    // CanvasKit creates a <script src> directly, so network wrappers alone
    // cannot adapt it. Rewrite root asset literals; relative module imports
    // and WASM's import.meta.url resolution already inherit the scoped path.
    const rewritten = text.replace(
        /(["'`])\/(pkg|canvaskit)\//g,
        (_match, quote: string, root: string) => `${quote}${prefix}${root}/`,
    );
    if (!html) return rewritten;
    if (!rewritten.includes("<head>"))
        throw new StudioError("NATIVE_HTML_UNSUPPORTED", "Native editor bootstrap markup changed");
    return rewritten.replace("<head>", `<head><script>${canvasBootstrap(prefix)}</script>`);
}

async function requestBody(req: IncomingMessage): Promise<ArrayBuffer> {
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of req) {
        const bytes = Buffer.from(chunk);
        size += bytes.length;
        if (size > 17 * 1024 * 1024) throw new StudioError("BODY_LIMIT", "Request exceeds 17 MiB");
        chunks.push(bytes);
    }
    return Uint8Array.from(Buffer.concat(chunks)).buffer;
}

export async function proxyCanvas(
    studio: Studio,
    id: string,
    req: IncomingMessage,
    res: ServerResponse,
): Promise<void> {
    const prefix = canvasPrefix(id);
    // Use the raw path here: URL's dot-segment normalization must not turn an
    // attempted escape into another permitted resource.
    const raw = (req.url ?? "").split("?")[0] ?? "";
    if (!raw.startsWith(prefix))
        throw new StudioError("INVALID_PROXY_PATH", "Invalid editor resource path");
    const path = canvasRequestPath("/" + raw.slice(prefix.length), req.method ?? "GET");
    const { entry, browser } = studio.browser(id);
    await studio.authorize(entry.path, entry.owner, req.method === "POST");
    const verifyBinding = () => {
        if (studio.browser(id).browser !== browser)
            throw new StudioError("EDITOR_NOT_FOUND", "Editor was closed; reopen the document");
        // Snapshot/save/reload commands may first push pending edits from WASM.
        // Allow that canvas-side synchronization while retaining the independent
        // Host document transaction lock.
        const snapshotPush =
            path === "/api/mcp/document" &&
            ["checkpoint", "save", "reload"].includes(browser.command?.type ?? "");
        if (
            req.method === "POST" &&
            (path === "/api/mcp/document" || path === "/api/mcp/sync-reset") &&
            (browser.toolLease || (!snapshotPush && (browser.lease || browser.command)))
        ) {
            throw new StudioError(
                "EDITOR_WRITE_LEASE",
                "The editor is locked for a document transaction; retry synchronization after it completes",
            );
        }
    };
    verifyBinding();
    const base = new URL(browser.daemon.baseUrl);
    if (
        base.protocol !== "http:" ||
        !["127.0.0.1", "localhost", "[::1]"].includes(base.hostname) ||
        base.username ||
        base.password
    )
        throw new StudioError("INVALID_DAEMON", "Expected a managed loopback editor");
    const target = new URL(path, base);
    const query = new URL(req.url ?? "/", "http://localhost").searchParams;
    // A canvas belongs to exactly one document; native tenant switching and
    // caller-provided credentials must not change that binding.
    query.delete("tenant");
    query.delete("token");
    target.search = query.toString();
    const headers = new Headers({
        "x-openpencil-token": browser.daemon.token,
        origin: studio.origin,
    });
    for (const name of ["content-type", "accept", "range"]) {
        const value = req.headers[name];
        if (typeof value === "string") headers.set(name, value);
    }
    const controller = new AbortController();
    const disconnect = () => controller.abort();
    req.once("aborted", disconnect);
    res.once("close", disconnect);
    const timeout = setTimeout(() => controller.abort(), 10000);
    try {
        const body = req.method === "POST" ? await requestBody(req) : undefined;
        verifyBinding();
        const upstream = await fetch(target, {
            method: req.method,
            headers,
            body,
            redirect: "manual",
            signal: controller.signal,
        });
        clearTimeout(timeout);
        if (upstream.status >= 300 && upstream.status < 400) {
            await upstream.body?.cancel();
            throw new StudioError(
                "PROXY_REDIRECT_REJECTED",
                "Native editor redirects are not supported",
            );
        }
        const type = upstream.headers.get("content-type") ?? "application/octet-stream";
        const responseHeaders: Record<string, string> = {
            "content-type": type,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
            "x-frame-options": "SAMEORIGIN",
            "referrer-policy": "same-origin",
        };
        for (const name of ["content-disposition", "content-range", "accept-ranges"]) {
            const value = upstream.headers.get(name);
            if (value) responseHeaders[name] = value;
        }
        if (req.method !== "HEAD" && (type.includes("text/html") || type.includes("javascript"))) {
            const text = rewriteCanvasText(
                await upstream.text(),
                prefix,
                type.includes("text/html"),
            );
            res.writeHead(upstream.status, responseHeaders);
            res.end(text);
        } else {
            res.writeHead(upstream.status, responseHeaders);
            res.flushHeaders();
            if (req.method === "HEAD" || !upstream.body) {
                await upstream.body?.cancel();
                res.end();
            } else
                await pipeline(
                    Readable.fromWeb(upstream.body as import("node:stream/web").ReadableStream),
                    res,
                    { signal: controller.signal },
                );
        }
    } catch (error) {
        if (res.headersSent) {
            res.destroy();
            return;
        }
        if (error instanceof StudioError) throw error;
        throw new StudioError(
            "NATIVE_PROXY_UNAVAILABLE",
            "The native editor connection is unavailable; reopen the document",
        );
    } finally {
        clearTimeout(timeout);
        req.off("aborted", disconnect);
        res.off("close", disconnect);
    }
}
