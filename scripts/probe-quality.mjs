import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Studio } from "../lib/studio.js";
const root = await mkdtemp(join(tmpdir(), "studio-quality-"));
const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
const file = join(root, "quality.op");
try {
    await studio.create(file, "quality");
    await studio.call(file, "quality", "batch_design", {
        script: 'const f=I(null,{type:"frame",name:"Technical probe",width:320,height:240,layout:"none",fill:[{type:"solid",color:"#FFFFFF"}]});I(f,{type:"text",name:"Text overflow",content:"Long text that cannot fit into this width",x:12,y:12,width:12,height:12,fontFamily:"Inter, system-ui, sans-serif",fontSize:20,fill:[{type:"solid",color:"#111827"}]});I(f,{type:"rectangle",name:"Outside child",x:310,y:220,width:120,height:90,fill:[{type:"solid",color:"#DDEEFF"}]});',
    });
    for (const name of ["lint_document", "get_design_quality"]) {
        const value = await studio.call(file, "quality", name, {});
        console.log(JSON.stringify({ name, result: value }));
    }
} finally {
    await studio.dispose();
}
