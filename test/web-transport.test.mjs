import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir, networkInterfaces } from "node:os";
import { join } from "node:path";
import { requireLocalRequest } from "../lib/transport.js";
import { OPEN_ENDPOINT, handleOpen } from "../lib/file-open.js";
import { makeAuthorizer } from "../lib/index.js";
import { handleStudio } from "../lib/http.js";
import { Studio } from "../lib/studio.js";

const request = (
    host = "192.168.1.5:3080",
    origin = "http://192.168.1.5:3080",
    method = "POST",
) => ({
    method,
    socket: { remoteAddress: "192.168.1.120", localAddress: "192.168.1.5", localPort: 3080 },
    headers: { host, ...(origin === undefined ? {} : { origin }), "sec-fetch-site": "same-origin" },
});

test("Web transport accepts LAN and mapped IPv4 peers bound to the actual DSH listener", () => {
    assert.doesNotThrow(() => requireLocalRequest(request()));
    const mapped = request();
    mapped.socket.localAddress = "::ffff:192.168.1.5";
    assert.doesNotThrow(() => requireLocalRequest(mapped));
    const ipv6 = request("[fd12:abcd::5]:3080", "http://[fd12:abcd::5]:3080");
    ipv6.socket.localAddress = "fd12:abcd::5";
    assert.doesNotThrow(() => requireLocalRequest(ipv6));
});

test("Web transport rejects foreign authorities, ports, schemes, forged forwarding and cross-site requests", () => {
    const cases = [
        request("attacker.example:3080", "http://attacker.example:3080"),
        request("192.168.1.120:3080", "http://192.168.1.120:3080"),
        request("192.168.1.5:8080", "http://192.168.1.5:8080"),
        request("192.168.1.5:3080", "https://192.168.1.5:3080"),
        request("192.168.1.5:3080", "http://evil.example"),
        request("192.168.1.5:3080", "null"),
        request("192.168.1.5:3080/path"),
        request("user@192.168.1.5:3080"),
        request("192.168.1.5:3080?x=1"),
        request("192.168.1.5:3080", "http://192.168.1.5:3080/path"),
    ];
    cases.push({
        ...request("attacker.example:3080", "http://attacker.example:3080"),
        headers: {
            host: "attacker.example:3080",
            origin: "http://attacker.example:3080",
            "x-forwarded-host": "192.168.1.5:3080",
            "x-forwarded-for": "127.0.0.1",
        },
    });
    cases.push({ ...request(), headers: { ...request().headers, "sec-fetch-site": "cross-site" } });
    const missing = request();
    delete missing.headers.origin;
    cases.push(missing);
    for (const input of cases) assert.throws(() => requireLocalRequest(input));
});

test("Web transport requires Origin for mutations and permits only GET/HEAD reads without it", () => {
    for (const method of ["GET", "HEAD"]) {
        const input = request(undefined, undefined, method);
        delete input.headers.origin;
        assert.doesNotThrow(() => requireLocalRequest(input, { allowReadWithoutOrigin: true }));
        assert.throws(() => requireLocalRequest(input));
    }
    for (const method of ["POST", "DELETE", "PATCH"]) {
        const input = request(undefined, undefined, method);
        delete input.headers.origin;
        assert.throws(() => requireLocalRequest(input, { allowReadWithoutOrigin: true }));
    }
});

test("an explicit external origin supports a proxied Web authority and rejects unrelated origins", () => {
    const input = request("editor.example", "https://editor.example");
    assert.doesNotThrow(() =>
        requireLocalRequest(input, { allowedOrigin: "https://editor.example" }),
    );
    assert.throws(() => requireLocalRequest(input));
    assert.doesNotThrow(() =>
        requireLocalRequest(request("editor.example:443", "https://editor.example"), {
            allowedOrigin: "https://editor.example",
        }),
    );
    assert.throws(() =>
        requireLocalRequest(request("editor.example", "http://editor.example"), {
            allowedOrigin: "https://editor.example",
        }),
    );
    assert.throws(() =>
        requireLocalRequest(input, { allowedOrigin: "https://editor.example/path" }),
    );
});

test("actual LAN HTTP serves grants and native canvas assets and preserves state/open ownership guards", async (t) => {
    const address = Object.values(networkInterfaces())
        .flat()
        .find((ip) => ip?.family === "IPv4" && !ip.internal)?.address;
    if (!address) {
        t.skip("No LAN IPv4 interface available");
        return;
    }
    const root = await mkdtemp(join(tmpdir(), "studio-lan-"));
    const path = join(root, "局域网页面.op");
    const ctx = {
        sessions: { get: (id) => (id === "owner" ? { id } : undefined) },
        sandboxPolicy: { resolve: () => ({ mode: "workspace-write", workspaceRoot: root }) },
        fs: { resolve: async (p) => p, processPath: (p) => p },
    };
    const studio = new Studio(makeAuthorizer(ctx), join(root, "state"), "http://127.0.0.1:3080");
    let peer;
    const server = createServer((req, res) => {
        peer = req.socket.remoteAddress;
        if (req.url === OPEN_ENDPOINT) void handleOpen(studio, req, res);
        else void handleStudio(studio, req, res);
    });
    server.listen(0, address);
    await once(server, "listening");
    const origin = `http://${address}:${server.address().port}`;
    try {
        await studio.create(path, "owner");
        const grant = await studio.grantForDocument(path, "", { sessionId: "owner" });
        const document = await fetch(origin + grant.document.url);
        assert.equal(document.status, 200);
        assert.ok((await document.json()).version);
        assert.equal(peer, address);
        const launchResponse = await fetch(origin + grant.editor.launchUrl, {
            method: "POST",
            headers: { origin, "content-type": "application/json" },
            body: JSON.stringify({ sessionId: "owner" }),
        });
        assert.equal(launchResponse.status, 200);
        const launch = await launchResponse.json();
        const canvas = new URL(launch.iframeUrl, origin);
        const html = await fetch(canvas);
        assert.equal(html.status, 200);
        assert.ok((await html.text()).includes("XMLHttpRequest.prototype.open"));
        const base = new URL(".", canvas);
        for (const resource of [
            "pkg/op_host_web.js",
            "pkg/op_host_web_bg.wasm",
            "canvaskit/canvaskit.js",
            "api/mcp/document",
        ]) {
            const response = await fetch(new URL(resource, base));
            assert.equal(response.status, 200, resource);
            await response.body.cancel();
        }
        const stateUrl = `${origin}/_dsh/openpencil-studio/editor/${launch.sessionId}/state`;
        const state = {
            ownerSessionId: "owner",
            state: { dirty: false, phase: "ready", generation: 1, revision: 1, sequence: 1 },
        };
        const post = (value) =>
            fetch(stateUrl, {
                method: "POST",
                headers: { origin, "content-type": "application/json" },
                body: JSON.stringify(value),
            });
        assert.equal((await post(state)).status, 200);
        assert.equal(
            (await (await post({ ...state, ownerSessionId: "other" })).json()).code,
            "SESSION_OWNERSHIP",
        );
        const filePost = (sessionId) =>
            fetch(origin + OPEN_ENDPOINT, {
                method: "POST",
                headers: { origin, "content-type": "application/json" },
                body: JSON.stringify({ path, sessionId }),
            });
        const opened = await filePost("owner");
        assert.equal(opened.status, 200);
        assert.equal((await opened.json()).grant.sourcePath, path);
        const missing = await filePost("missing");
        assert.equal(missing.status, 400);
        assert.equal((await missing.json()).code, "SESSION_NOT_FOUND");
        const foreign = await fetch(canvas, { headers: { origin: "http://evil.example" } });
        assert.equal((await foreign.json()).code, "INVALID_ORIGIN");
    } finally {
        await studio.dispose();
        server.closeAllConnections();
        await new Promise((resolve) => server.close(resolve));
    }
});
