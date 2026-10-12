import type { IncomingMessage } from "node:http";

export class WebRequestError extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}

/** Bind browser requests to the DSH listener or a configured external origin. */
export function requireLocalRequest(req: IncomingMessage, options: { allowedOrigin?: string; allowReadWithoutOrigin?: boolean } = {}): void {
  const fail = (code: string, message: string): never => { throw new WebRequestError(code, message); };
  let host: URL, configured: URL | undefined;
  try {
    if (typeof req.headers.host !== "string") return fail("INVALID_HOST", "Missing request host");
    const protocol = "encrypted" in req.socket && req.socket.encrypted === true ? "https:" : "http:";
    host = new URL(protocol + "//" + req.headers.host);
    if (host.username || host.password || host.pathname !== "/" || host.search || host.hash)
      return fail("INVALID_HOST", "Invalid request host");
    if (options.allowedOrigin) {
      configured = new URL(options.allowedOrigin);
      if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password || configured.pathname !== "/" || configured.search || configured.hash)
        return fail("INVALID_HOST", "Invalid configured Web origin");
      const external = new URL(configured.protocol + "//" + req.headers.host);
      if (external.origin === configured.origin) host = external;
    }
  } catch (error) {
    if (error instanceof WebRequestError) throw error;
    return fail("INVALID_HOST", "Invalid request host");
  }
  const protocol = host.protocol;
  const requestOrigin = host.origin;
  const localAddress = req.socket.localAddress?.replace(/^::ffff:(?=\d+\.)/i, "");
  const localHosts = new Set(["127.0.0.1", "localhost", "[::1]"]);
  if (localAddress && !["0.0.0.0", "::"].includes(localAddress)) {
    const socketHost = localAddress.includes(":") ? "[" + localAddress + "]" : localAddress;
    localHosts.add(new URL("http://" + socketHost).hostname);
  }
  const port = Number(host.port || (protocol === "https:" ? 443 : 80));
  if (!(localHosts.has(host.hostname) && port === req.socket.localPort) && configured?.origin !== requestOrigin)
    return fail("INVALID_HOST", "Request host does not match the DSH Web listener");
  const origin = req.headers.origin;
  if (origin) {
    let parsed: URL;
    try { parsed = new URL(origin); }
    catch { return fail("INVALID_ORIGIN", "Invalid request origin"); }
    if (parsed.origin !== requestOrigin || parsed.username || parsed.password || parsed.pathname !== "/" || parsed.search || parsed.hash)
      return fail("INVALID_ORIGIN", "Cross-origin request rejected");
  } else if (!(options.allowReadWithoutOrigin && ["GET", "HEAD"].includes(req.method ?? ""))) {
    return fail("INVALID_ORIGIN", "Mutation requires a same-origin browser request");
  }
  if (req.headers["sec-fetch-site"] && req.headers["sec-fetch-site"] !== "same-origin")
    return fail("CROSS_SITE", "Cross-site request rejected");
}
