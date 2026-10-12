import test from "node:test";
import assert from "node:assert/strict";
import { assertNativeArguments, callNative, isExposed, TECHNICAL_CATALOG } from "../lib/native.js";
import { planCreation } from "../lib/creation.js";
import { batchArguments, prepareOperations } from "../lib/script.js";

const rejects = (code) => (error) => error.code === code;
const localUris = ["file:///tmp/private.png", "/tmp/private.png", "../private.png", ".\\private.png", "C:\\private.png", "\\\\host\\share\\private.png", "private.png", " file:///tmp/private.png"];

test("creation captures validate computed I/K nodes and children before RPC", async () => {
  for (const operation of ["I(null, node)", "K('card', null, node)"]) {
    await assert.rejects(planCreation(`const node = { type: 'frame', children: [{ type: 'image', url: 'file://' + '/tmp/private.png' }] }; ${operation};`), rejects("LOCAL_ASSET_UNSUPPORTED"));
    await assert.rejects(planCreation(`const node = { type: 'frame', ['file' + 'Path']: '/tmp/other.op' }; ${operation};`), rejects("PATH_ARGUMENT_FORBIDDEN"));
  }
  await assert.rejects(planCreation("try { I(null, {type:'frame', filePath:'/tmp/other.op'}); } catch (_) {} I(null, {type:'frame'});"), rejects("PATH_ARGUMENT_FORBIDDEN"));
  const plan = await planCreation("const build = (i) => I(null, {type:'text', text: 'Mention file:///tmp/example and filePath in prose ' + i}); for (let i=0;i<2;i++) build(i);");
  assert.equal(plan.inserts.length, 2);
  assert.doesNotThrow(() => assertNativeArguments({ script: plan.script }));
});

test("structured and serialized catalog payloads reject local assets and forbidden file fields", () => {
  for (const uri of localUris) {
    for (const key of ["node_json", "variables"]) {
      const payload = { nested: { type: "image", url: uri } };
      for (const value of [payload, JSON.stringify(payload)]) assert.throws(() => assertNativeArguments({ [key]: value }), rejects("LOCAL_ASSET_UNSUPPORTED"));
    }
    assert.throws(() => assertNativeArguments({ script: `I(null, ${JSON.stringify({ type: "image", url: uri })});` }), rejects("LOCAL_ASSET_UNSUPPORTED"));
    assert.throws(() => assertNativeArguments({ operations: `U("node", ${JSON.stringify({ fill: { type: "image", url: uri } })});` }), rejects("LOCAL_ASSET_UNSUPPORTED"));
  }
  for (const field of ["filePath", "sourcePath", "sourceFilePath", "source_file_path", "file_path", "outputPath", "outputDir", "directory"]) {
    for (const key of ["node_json", "variables"]) assert.throws(() => assertNativeArguments({ [key]: JSON.stringify({ child: { [field]: "/tmp/other.op" } }) }), rejects("PATH_ARGUMENT_FORBIDDEN"));
    for (const operation of ["U", "C", "R", "G"]) assert.throws(() => assertNativeArguments({ operations: `${operation}("node", ${JSON.stringify({ child: { [field]: "/tmp/other.op" } })});` }), rejects("PATH_ARGUMENT_FORBIDDEN"));
  }
  assert.throws(() => assertNativeArguments({ node_json: "{broken" }), rejects("INVALID_NATIVE_JSON"));
  assert.throws(() => assertNativeArguments({ variables: "[]" }), rejects("INVALID_NATIVE_JSON"));
});

test("arguments preserve remote/data images, geometry paths, routes and ordinary prose", () => {
  const node = { type: "path", path: "M0 0L20 20", url: "/settings", text: 'file:///tmp/private.png and {"filePath":"/tmp/example.op"} are prose', children: [{ type: "image", url: "https://example.com/image.png" }, { fill: { type: "image", url: "data:image/png;base64,aQ==" } }] };
  for (const key of ["node_json", "variables"]) {
    assert.doesNotThrow(() => assertNativeArguments({ [key]: node }));
    assert.doesNotThrow(() => assertNativeArguments({ [key]: JSON.stringify(node) }));
  }
  assert.doesNotThrow(() => assertNativeArguments({ script: `const result=I(null,${JSON.stringify(node)});` }));
  assert.doesNotThrow(() => assertNativeArguments({ operations: `U("node",${JSON.stringify(node)});` }));
  assert.doesNotThrow(() => assertNativeArguments({ text: JSON.stringify({ filePath: "/tmp/example.op" }), value: "file:///tmp/private.png" }));
});

test("operations extract literal data and bindings without executing code", () => {
  assert.doesNotThrow(() => assertNativeArguments({ operations: 'const clone=C("n", "p", {name:"Clone"}); U(clone, {x:-12, y:+8, visible:true, fill:null}); M(clone,"p",0); R("n",{type:"path",path:"M0 0L1 1"}); G(["n",clone],"p"); D("n");' }));
  for (const expression of [
    'U("n", {src: (() => "file:///tmp/private.png")()})',
    'U("n", {get src() { globalThis.executed = true; return "file:///tmp/private.png"; }})',
    'U("n", {...{src:"file:///tmp/private.png"}})',
    'U("n", {["src"]:"file:///tmp/private.png"})',
    'globalThis.executed = true; U("n", {})',
    'U("n", JSON.parse("{}"))',
  ]) assert.throws(() => batchArguments(expression), rejects("INVALID_BATCH_ARGUMENTS"));
  assert.equal(globalThis.executed, undefined);
  const prose = 'U("n", {text: "Example I(null,{filePath:\\"/tmp/example.op\\"}) and U(node,{src:\\"file:///tmp/example.png\\"})"}); // D("other")';
  const clean = prepareOperations(prose);
  assert.deepEqual(batchArguments(clean), batchArguments(prose));
  assert.doesNotMatch(clean, /I\(null|U\(node|D\("other"\)/);
  assert.doesNotThrow(() => assertNativeArguments({ operations: clean }));
});

test("RPC boundary rejects invalid embedded arguments before transport", async (t) => {
  let calls = 0;
  let forwarded;
  t.mock.method(globalThis, "fetch", async (_url, options) => {
    calls++;
    forwarded = JSON.parse(options.body).params.arguments;
    return { ok: true, json: async () => ({ result: { content: [{ type: "text", text: "{}" }] } }) };
  });
  for (const [name, args, code] of [
    ["batch_design", { script: "const url = 'file:///tmp/private.png'; I(null, {type:'image', url});" }, "LOCAL_ASSET_UNSUPPORTED"],
    ["batch_design", { operations: 'U("n", {sourceFilePath:"/tmp/other.op"});' }, "PATH_ARGUMENT_FORBIDDEN"],
    ["upsert_component", { key: "card", name: "Card", node_json: '{"type":"image","url":"file:///tmp/private.png"}' }, "LOCAL_ASSET_UNSUPPORTED"],
    ["upsert_screen", { key: "screen", node_json: '{"directory":"/tmp"}' }, "PATH_ARGUMENT_FORBIDDEN"],
    ["upsert_variables", { key: "tokens", variables: '{"image":{"type":"image","url":"/tmp/private.png"}}' }, "LOCAL_ASSET_UNSUPPORTED"],
    ["set_variables", { variables: '{"filePath":"/tmp/other.op"}' }, "PATH_ARGUMENT_FORBIDDEN"],
    ["batch_design", { nodes_json: "[]" }, "INVALID_BATCH_INPUT"],
    ["list_theme_presets", {}, "UNSUPPORTED_NATIVE_TOOL"],
  ]) await assert.rejects(callNative({ baseUrl: "http://unused.invalid" }, name, args), rejects(code));
  assert.equal(calls, 0);
  await callNative({ baseUrl: "http://unused.invalid" }, "batch_design", { script: "for (let i=0;i<2;i++) I(null,{type:'text',text:'filePath prose '+i});" });
  assert.equal(calls, 1);
  assert.match(forwarded.script, /studioInsert0/);
  assert.doesNotMatch(forwarded.script, /for\s*\(/);
});

test("technical catalog agrees with exposure and omits filesystem theme discovery", () => {
  assert.equal(isExposed("list_theme_presets"), false);
  assert.equal(TECHNICAL_CATALOG.some((tool) => tool.name === "list_theme_presets"), false);
  assert.ok(TECHNICAL_CATALOG.every((tool) => isExposed(tool.name)));
  for (const tool of TECHNICAL_CATALOG) {
    const fields = tool.inputSchema.properties ?? {};
    assert.equal("directory" in fields, false);
    assert.equal("filePath" in fields, false);
  }
});
