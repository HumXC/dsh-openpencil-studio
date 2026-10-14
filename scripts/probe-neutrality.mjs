import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Studio } from "../lib/studio.js";
const root = await mkdtemp(join(tmpdir(), "studio-neutrality-"));
const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
const path = join(root, "test.op"),
    owner = "probe";
try {
    await studio.create(path, owner);
    const r = await studio.call(path, owner, "batch_design", {
        script: 'const f=I(null,{type:"frame",width:320,height:200,fill:[{type:"solid",color:"#111111"}]});I(f,{type:"text",name:"Quiet",content:"Quiet",fontSize:19,width:280,height:32,fill:[{type:"solid",color:"#111111"}]});',
    });
    console.log("batch", r.native);
    const e = await studio.entry(path, owner);
    const log = async (stage) => {
        const s = await studio.snapshot(e);
        const d = JSON.parse(s.documentJson);
        console.log(stage, JSON.stringify(d.children[0].children[0]));
        return { s, d };
    };
    let { s, d } = await log("after batch");
    const id = d.children[0].children[0].id;
    await studio.call(path, owner, "update_node", {
        nodeId: id,
        data: { fill: [{ type: "solid", color: "#111111" }], height: 32 },
        postProcess: false,
    });
    ({ s, d } = await log("after update"));
    d.children[0].children[0].fill = [{ type: "solid", color: "#111111" }];
    d.children[0].children[0].height = 32;
    const resp = await fetch(e.daemon.baseUrl + "/api/mcp/document", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
            document: d,
            baseVersion: s.version,
            preserveAuthoredGeometry: true,
        }),
    });
    console.log("preserve", resp.status, await resp.text());
    await log("after preserve");
    await studio.call(path, owner, "update_node", {
        nodeId: id,
        data: { name: "Renamed" },
        postProcess: false,
    });
    await log("after unrelated update");
} finally {
    await studio.dispose();
}
