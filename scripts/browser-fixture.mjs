import { createServer } from "node:http";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { build } from "tsdown";
import { Studio } from "../lib/studio.js";
import { handleStudio } from "../lib/http.js";
const root = await mkdtemp(join(tmpdir(), "studio-browser-")),
    owner = "isolated-browser-test",
    file = join(root, "software.op");
let studio, grant;
const server = createServer(async (req, res) => {
    try {
        if (req.url?.startsWith("/_dsh/openpencil-studio"))
            return await handleStudio(studio, req, res);
        if (req.url === "/test/fixture") {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify({ owner, grant }));
        }
        if (req.url === "/test/state") {
            res.setHeader("content-type", "application/json");
            return res.end(JSON.stringify(await studio.status(file, owner)));
        }
        if (req.url === "/test/stop" && req.method === "POST") {
            await studio.dispose();
            res.end("stopped");
            server.close(() => process.exit(0));
            return;
        }
        if (req.url === "/test/command" && req.method === "POST") {
            const chunks = [];
            for await (const chunk of req) chunks.push(chunk);
            const input = JSON.parse(Buffer.concat(chunks).toString());
            res.setHeader("content-type", "application/json");
            try {
                const result =
                    input.action === "resolve"
                        ? await studio.resolveUnsaved(file, owner, input.choice, input.revision)
                        : await studio.call(file, owner, input.tool, input.args ?? {});
                res.end(JSON.stringify({ ok: true, result }));
            } catch (error) {
                res.end(
                    JSON.stringify({
                        ok: false,
                        code: error.code,
                        details: error.details,
                        message: error.message,
                    }),
                );
            }
            return;
        }
        if (req.url === "/test/recovery") {
            const entry = studio.entries.get(file),
                nativeId = entry.browser?.id;
            res.setHeader("content-type", "application/json");
            res.end(JSON.stringify(nativeId ? await studio.recovery(nativeId) : {}));
            return;
        }
        if (req.url === "/client.js") {
            res.setHeader("content-type", "text/javascript");
            return res.end(await readFile(join(root, "web/client.js")));
        }
        res.setHeader("content-type", "text/html");
        res.end(
            '<!doctype html><meta charset="utf-8"><style>body{margin:16px;font-family:sans-serif}iframe{width:100%;height:100%}</style><div id="root"></div><script type="module" src="/client.js"></script>',
        );
    } catch (e) {
        res.statusCode = 500;
        res.end(String(e));
    }
});
await new Promise((r) => server.listen(0, "127.0.0.1", r));
const origin = "http://127.0.0.1:" + server.address().port;
studio = new Studio(async (p) => p, join(root, "state"), origin);
await studio.create(file, owner);
await studio.call(file, owner, "batch_design", {
    script: 'const frame=I(null,{type:"frame",name:"Browser integration",width:800,height:600,layout:"vertical",padding:24,fill:[{type:"solid",color:"#FFFFFF"}]});I(frame,{type:"text",name:"Editable text",content:"OpenPencil Studio",fontFamily:"Inter, system-ui, sans-serif",fontSize:28,width:400,height:48,fill:[{type:"solid",color:"#111827"}]});',
});
await studio.save(file, owner);
grant = await studio.grantForDocument(file, "", { sessionId: owner });
await build({
    config: false,
    entry: {
        client: join(dirname(fileURLToPath(import.meta.url)), "fixtures/client.tsx"),
    },
    outDir: join(root, "web"),
    platform: "browser",
    target: "es2022",
    format: "esm",
    dts: false,
    sourcemap: false,
    deps: { alwaysBundle: [/.*/] },
});
await writeFile(join(root, "fixture.json"), JSON.stringify({ origin, file, root }));
console.log(JSON.stringify({ ready: true, origin, file, root }));
const close = async () => {
    await studio.dispose();
    server.close();
    process.exit(0);
};
process.once("SIGTERM", close);
process.once("SIGINT", close);
