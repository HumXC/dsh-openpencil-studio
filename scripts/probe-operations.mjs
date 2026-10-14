import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Studio } from "../lib/studio.js";
const root = await mkdtemp(join(tmpdir(), "studio-ops-"));
const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
const path = join(root, "test.op"),
    owner = "probe";
try {
    await studio.create(path, owner);
    await studio.call(path, owner, "batch_design", {
        script: 'const f=I(null,{type:"frame",width:320,height:200,fill:[{type:"solid",color:"#111111"}]});I(f,{type:"text",name:"Quiet",content:"Quiet",fontSize:19,width:280,height:32,fill:[{type:"solid",color:"#111111"}]});',
    });
    const e = await studio.entry(path, owner);
    await studio.call(path, owner, "batch_design", {
        operations: 'U("n2", {"name":"Renamed"})',
        postProcess: false,
    });
    console.log((await studio.snapshot(e)).documentJson);
} finally {
    await studio.dispose();
}
