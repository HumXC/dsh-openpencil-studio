import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Studio } from "../lib/studio.js";
import { rpc } from "../lib/native.js";
const root = await mkdtemp(join(tmpdir(), "studio-preview-probe-")),
  file = join(root, "preview.op");
const studio = new Studio(
  async (p) => p,
  join(root, "state"),
  "http://127.0.0.1:3080",
);
try {
  await studio.create(file, "preview-probe");
  await studio.call(file, "preview-probe", "batch_design", {
    script:
      'const f=I(null,{type:"frame",name:"A",width:240,height:220,fill:[{type:"solid",color:"#CCCCCC"}]});',
  });
  const e = [...studio.entries.values()][0];
  const document = JSON.parse((await studio.snapshot(e)).documentJson);
  console.log("FRAME", document.children[0].id);
  const r = await rpc(e.daemon, "tools/call", {
    name: "get_screenshot",
    arguments: { nodeId: document.children[0].id },
  });
  console.log(
    JSON.stringify(
      r,
      (k, v) =>
        k === "data" && typeof v === "string"
          ? v.slice(0, 100) + " [" + v.length + " chars]"
          : v,
      null,
      2,
    ),
  );
  console.log({ root });
} finally {
  await studio.dispose();
}
