import test from "node:test";
import assert from "node:assert/strict";
import { registerHooks, stripTypeScriptTypes } from "node:module";
import { readFileSync, existsSync } from "node:fs";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

// Exercise current sources without replacing the shared lib build.
const sourceRoot = new URL("../src/", import.meta.url).href;
registerHooks({
  resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(sourceRoot) && specifier.startsWith(".") && specifier.endsWith(".js")) {
      const url = new URL(specifier.slice(0, -3) + ".ts", context.parentURL);
      if (existsSync(url)) return { url: url.href, shortCircuit: true };
    }
    return next(specifier, context);
  },
  load(url, context, next) {
    if (url.startsWith(sourceRoot) && url.endsWith(".ts")) return { format: "module", source: stripTypeScriptTypes(readFileSync(fileURLToPath(url), "utf8"), { mode: "transform", sourceUrl: url }), shortCircuit: true };
    return next(url, context);
  },
});
const { normalizeNativeArguments, assertNativeArguments, callNative, rpc, nativeValue, TECHNICAL_CATALOG, isExposed } = await import("../src/native.ts");
const { prepareOperations, batchArguments } = await import("../src/script.ts");
const rejects = code => error => error.code === code && error.details.committed === false;

test("batch preflight removes empty selectors and rejects dual or empty input before creation", async () => {
  assert.deepEqual(normalizeNativeArguments("batch_design", { script: "", operations: 'U("n",{name:"ok"});' }), { operations: 'U("n",{"name":"ok"})' });
  assert.deepEqual(normalizeNativeArguments("batch_design", { script: 'I(null,{type:"frame"});', operations: " \n " }), { script: 'I(null,{type:"frame"});' });
  for (const args of [{}, { script: "", operations: "" }, { operations: "// only prose U()\n;" }, { script: 1 }, { script: 'throw new Error("must not execute")', operations: 'D("n")' }]) {
    assert.throws(() => normalizeNativeArguments("batch_design", args), rejects("INVALID_BATCH_INPUT"));
    await assert.rejects(callNative({ baseUrl: "http://unused.invalid" }, "batch_design", args), rejects("INVALID_BATCH_INPUT"));
  }
});

test("operations serialize all native opcodes into separate lines while preserving safe literals", () => {
  const source = 'const clone=C("n","p",{name:"Copy"}), moved=M(clone,"p",0); U(moved,{x:-12,y:+8,visible:true,fill:null,text:"U(node) and I(parent)"});R("n",{type:"path",path:"M0 0L1 1"});G("n","image","prompt");D(clone); // D("other")';
  const clean = prepareOperations(source);
  assert.equal(clean.split("\n").length, 6);
  assert.match(clean, /^clone=C\(/);
  assert.match(clean, /\nmoved=M\(/);
  assert.doesNotMatch(clean, /;|const |D\("other"\)|U\(node\)|I\(parent\)/);
  assert.deepEqual(batchArguments(clean), batchArguments(source));
  assert.equal(prepareOperations(clean), clean);
  for (const source of ['U("n",{get src(){throw 1}})', 'U("n",{...{x:1}})', 'U("n",JSON.parse("{}"))', 'U("n",{["x"]:1})', 'bound=U("n",{})']) assert.throws(() => prepareOperations(source), rejects("INVALID_BATCH_ARGUMENTS"));
});

test("mixed node fields merge equal values and reject disagreement without mutating input", () => {
  for (const name of ["insert_node", "update_node", "replace_node"]) {
    const args = { nodeId: "n", x: "12", width: "200", name: "Card", fill_hex: "#abcdef", pageId: "page", postProcess: false, data: { x: 12, name: "Card", opacity: 0.8 } };
    const before = structuredClone(args), normalized = normalizeNativeArguments(name, args);
    assert.deepEqual(normalized.data, { x: 12, width: 200, name: "Card", opacity: 0.8, fill: [{ type: "solid", color: "#abcdef" }] });
    assert.equal(normalized.pageId, "page");
    assert.equal(normalized.nodeId, "n");
    assert.equal("x" in normalized, false);
    assert.deepEqual(args, before);
    assert.deepEqual(normalizeNativeArguments(name, normalized), normalized);
    for (const conflict of [{ x: "13", data: { x: 12 } }, { name: "A", data: { name: "B" } }, { kind: "frame", data: { type: "text" } }, { fill_hex: "#fff", data: { fill: "#000" } }]) assert.throws(() => normalizeNativeArguments(name, conflict), rejects("ARGUMENT_CONFLICT"));
    assert.throws(() => normalizeNativeArguments(name, { data: [] }), rejects("INVALID_NATIVE_DATA"));
    assert.deepEqual(normalizeNativeArguments(name, { x: " +.5 ", width: "2e2", data: { x: 0.5, width: 200 } }).data, { x: 0.5, width: 200 });
  }
  assert.deepEqual(normalizeNativeArguments("insert_node", { kind: "rect", data: { type: "rectangle", fillHex: "#fff" } }).data, { type: "rectangle", fill: [{ type: "solid", color: "#fff" }] });
});

test("normalization keeps resource and path guards while preserving prose", () => {
  for (const args of [{ x: "2", data: { sourceFilePath: "/tmp/other.op" } }, { fill_hex: "#fff", data: { children: [{ type: "image", src: "file:///tmp/private.png" }] } }]) {
    assert.throws(() => assertNativeArguments(normalizeNativeArguments("insert_node", args)), error => ["PATH_ARGUMENT_FORBIDDEN", "LOCAL_ASSET_UNSUPPORTED"].includes(error.code));
  }
  assert.throws(() => assertNativeArguments(normalizeNativeArguments("batch_design", { script: "", operations: 'U("n",{src:"/tmp/private.png"});' })), rejects("LOCAL_ASSET_UNSUPPORTED"));
  assert.doesNotThrow(() => assertNativeArguments(normalizeNativeArguments("batch_design", { operations: 'U("n",{text:"file:///tmp/example.png and U(node)",path:"M0 0L1 1"});' })));
});

test("catalog removes native kit shortcuts that discovery lists but dispatch cannot call", () => {
  assert.equal(isExposed("insert_btn_primary"), false);
  assert.equal(isExposed("insert_shadcn_btn_primary"), false);
  assert.deepEqual(TECHNICAL_CATALOG.filter(tool => tool.name.startsWith("insert_")).map(tool => tool.name), ["insert_node"]);
  assert.equal(isExposed("list_ui_kits"), true);
});

test("unsafe copy binding and root move combinations fail before RPC", async () => {
  for (const operations of [
    'clone=C("n1",null,{name:"Clone"});M(clone,null,0);',
    'const clone=C("n1",null,{}), moved=M(clone,null,0);',
    'clone=C("n1","parent",{}); U("n1",{name:"Pending"}); M(clone,null,2);',
  ]) {
    assert.throws(() => normalizeNativeArguments("batch_design", { operations }), rejects("UNSUPPORTED_NATIVE_BATCH"));
    await assert.rejects(callNative({ baseUrl: "http://unused.invalid" }, "batch_design", { operations }), rejects("UNSUPPORTED_NATIVE_BATCH"));
  }
  assert.doesNotThrow(() => prepareOperations('clone=C("n1",null,{});M(clone,"parent",0);'));
  assert.doesNotThrow(() => prepareOperations('M("n2",null,0);'));
});

test("real isolated native instance applies normalized operations and mixed node fields", async () => {
  const { official } = await import("../lib/official.js");
  const { startManagedEditorDaemon, stopManagedEditorDaemon } = await import("../lib/vendor/server/managed-editor-daemon.js");
  const root = await mkdtemp(join(tmpdir(), "studio-native-adapter-"));
  const sourcePath = join(root, "regression.op");
  await writeFile(sourcePath, JSON.stringify({ version: "1.0.0", children: [] }));
  const implementation = await official();
  let daemon;
  const document = async () => JSON.parse((await implementation.read(daemon.baseUrl, daemon.token)).documentJson);
  const roots = doc => doc.children ?? doc.pages[0].children;
  try {
    daemon = await startManagedEditorDaemon(implementation.runtime, { sourcePath, allowOrigin: "http://127.0.0.1:3080" });
    const listing = await rpc(daemon, "tools/list", {});
    const broken = listing.tools.filter(tool => tool.name.startsWith("insert_") && tool.name !== "insert_node");
    assert.equal(broken.length, 37);
    for (const tool of broken) {
      const response = await rpc(daemon, "tools/call", { name: tool.name, arguments: {} });
      assert.equal(response.isError, true, tool.name);
      assert.match(JSON.stringify(nativeValue(response)), /unknown tool/, tool.name);
    }
    await callNative(daemon, "insert_node", { kind: "frame", name: "Merged", x: "12", y: "24", width: "300", height: "160", fill_hex: "#abcdef", data: { type: "frame", children: [], opacity: 0.8 } });
    let node = roots(await document()).find(node => node.name === "Merged");
    assert.ok(node);
    assert.equal(node.x, 12);
    assert.equal(node.width, 300);
    assert.equal(node.opacity, 0.8);
    assert.equal(node.fill[0].color, "#abcdef");
    const id = node.id;
    await callNative(daemon, "update_node", { nodeId: id, x: "32", width: "340", fill_hex: "#112233", data: { opacity: 0.6 } });
    node = roots(await document()).find(node => node.id === id);
    assert.equal(node.x, 32);
    assert.equal(node.width, 340);
    assert.equal(node.opacity, 0.6);
    assert.equal(node.fill[0].color, "#112233");
    const before = await document();
    await assert.rejects(callNative(daemon, "update_node", { nodeId: id, x: "99", data: { x: 32 } }), rejects("ARGUMENT_CONFLICT"));
    assert.deepEqual(await document(), before);
    const operations = `U(${JSON.stringify(id)}, {name:'Renamed'}); U(${JSON.stringify(id)}, {x:44});`;
    await callNative(daemon, "batch_design", { script: "", operations, postProcess: false });
    node = roots(await document()).find(node => node.id === id);
    assert.equal(node.name, "Renamed");
    assert.equal(node.x, 44);
    await callNative(daemon, "replace_node", { nodeId: id, kind: "frame", name: "Final", x: "7", width: "240", height: "120", fill_hex: "#445566", data: { type: "frame", y: 9, children: [], opacity: 0.4 } });
    node = roots(await document()).find(node => node.name === "Final");
    assert.equal(node.x, 7);
    assert.equal(node.y, 9);
    assert.equal(node.width, 240);
    assert.equal(node.opacity, 0.4);
    assert.equal(node.fill[0].color, "#445566");
    const originalId = node.id;
    const beforeCopy = await document();
    await assert.rejects(callNative(daemon, "batch_design", {
      operations: `clone=C(${JSON.stringify(originalId)},null,{name:'Clone'}); M(clone,null,0);`,
    }), rejects("UNSUPPORTED_NATIVE_BATCH"));
    assert.deepEqual(await document(), beforeCopy);
    await callNative(daemon, "batch_design", { operations: `clone=C(${JSON.stringify(originalId)},null,{name:'Clone'});` });
    const clonedRoots = roots(await document());
    const cloneId = clonedRoots.find(node => node.name === "Clone").id;
    assert.ok(clonedRoots.some(node => node.id === originalId), JSON.stringify({ stage: "copy", roots: clonedRoots.map(node => [node.id,node.name]) }));
    await callNative(daemon, "batch_design", { operations: `M(${JSON.stringify(cloneId)},null,0);` });
    assert.ok(roots(await document()).some(node => node.id === originalId), JSON.stringify({ stage: "move", roots: roots(await document()).map(node => [node.id,node.name]) }));
    await callNative(daemon, "batch_design", { operations: `replacement=R(${JSON.stringify(cloneId)},{type:'frame',name:'Replacement',width:80,height:60,children:[]});` });
    const replacementId = roots(await document()).find(node => node.name === "Replacement").id;
    await callNative(daemon, "batch_design", { operations: `D(${JSON.stringify(replacementId)});` });
    assert.equal(roots(await document()).filter(node => ["Clone", "Replacement"].includes(node.name)).length, 0);
    console.log(JSON.stringify({ nativeVersion: implementation.runtime.openPencilVersion, revision: implementation.runtime.revision, unavailableKitShortcuts: broken.length, verified: ["insert_node", "update_node", "replace_node", "U", "C", "M", "R", "D"] }));
  } finally {
    if (daemon) await stopManagedEditorDaemon(daemon);
    // The root was allocated here, never supplied by a user.
    assert.ok(root.startsWith(join(tmpdir(), "studio-native-adapter-")));
    await rm(root, { recursive: true, force: true });
  }
});
