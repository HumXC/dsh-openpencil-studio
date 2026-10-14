import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Studio } from "../lib/studio.js";
const root = await mkdtemp(join(tmpdir(), "studio-flags-"));
const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
const path = join(root, "test.op"),
    owner = "probe";
try {
    await studio.create(path, owner);
    const e = await studio.entry(path, owner);
    const s = await studio.snapshot(e);
    console.log(
        await (
            await fetch(e.daemon.baseUrl + "/api/mcp/document", {
                method: "POST",
                headers: { "content-type": "application/json" },
                body: JSON.stringify({
                    document: JSON.parse(s.documentJson),
                    baseVersion: s.version,
                    preserveAuthoredGeometry: true,
                }),
            })
        ).text(),
    );
    for (const [name, prelude] of [
        ["flag", ""],
        [
            "wrapped",
            "const originalInsert=I; I=function(parent,node){return originalInsert(parent,node)}; ",
        ],
    ]) {
        try {
            const r = await studio.call(path, owner, "batch_design", {
                preserveAuthoredGeometry: true,
                postProcess: false,
                script:
                    prelude +
                    'const f=I(null,{type:"frame",width:320,height:200,fill:[{type:"solid",color:"#111111"}]});I(f,{type:"text",name:"Quiet",content:"Quiet",fontSize:19,width:280,height:32,fill:[{type:"solid",color:"#111111"}]});',
            });
            console.log(name, r.native, (await studio.snapshot(e)).documentJson);
        } catch (error) {
            console.log(name, String(error));
        }
    }
} finally {
    await studio.dispose();
}
