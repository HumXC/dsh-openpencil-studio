import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Studio } from "../lib/studio.js";
import { official } from "../lib/official.js";
const root = await mkdtemp(join(tmpdir(), "studio-semantics-"));
const file = join(root, "probe.op");
const studio = new Studio(
  async (p) => resolve(root, p),
  join(root, "state"),
  "http://127.0.0.1:3080",
);
try {
  await studio.create(file, "probe");
  console.log(
    await studio.call(file, "probe", "batch_design", {
      script:
        'const frame=I(null,{type:"frame",width:300,height:200});I(frame,{type:"text_input",name:"Probe",width:240,height:48,label:"label",ariaLabel:"aria",accessibleLabel:"accessible",accessibility:{label:"nested"},metadata:{label:"metadata"},role:"textbox",secure:true});',
      postProcess: false,
    }),
  );
  const e = studio.entries.get(file),
    api = await official();
  console.log(
    "before",
    JSON.parse((await api.read(e.daemon.baseUrl, e.daemon.token)).documentJson),
  );
  console.log(
    await studio.call(file, "probe", "set_variables", {
      variables: {
        "studio/accessibility": {
          type: "string",
          value: '{"schema":1,"controls":{"n2":{"label":"Search"}}}',
        },
      },
    }),
  );
  console.log(
    "after",
    JSON.parse((await api.read(e.daemon.baseUrl, e.daemon.token)).documentJson),
  );
  console.log("root", root);
} finally {
  await studio.dispose();
}
