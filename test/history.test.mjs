import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DocumentHistory } from "../lib/history.js";
import { Studio, documentHash } from "../lib/studio.js";
import { restoreAuthoredSnapshot, official } from "../lib/official.js";

const doc = (value) => JSON.stringify({ version: "1.0.0", children: [], value });

test("history retains completed transactions, bounds memory and invalidates after external changes", () => {
  const history = new DocumentHistory(2, 1024);
  history.record(doc(0), "0", "1");
  history.record(doc(1), "1", "2");
  history.record(doc(2), "2", "3");
  assert.equal(history.depth("3").past, 2);
  const undo = history.target("undo", "3");
  assert.equal(undo.hash, "2");
  history.complete("undo", doc(3), "3", undo);
  assert.deepEqual([history.depth("2").past, history.depth("2").future], [1, 1]);
  const redo = history.target("redo", "2");
  history.complete("redo", doc(2), "2", redo);
  assert.equal(history.depth("3").past, 2);
  history.record(doc(3), "3", "3");
  assert.equal(history.depth("3").past, 2);
  assert.equal(history.depth("external").past, 0);
  assert.equal(history.depth("external").future, 0);
  assert.throws(() => history.target("undo", "external"), (e) => e.code === "HISTORY_EMPTY");
  const bounded = new DocumentHistory(32, 5);
  bounded.record(doc(0), "0", "1");
  assert.equal(bounded.depth("1").past, 0);
});

test("new document edits discard redo while a failed restore leaves its target available", () => {
  const history = new DocumentHistory();
  history.record(doc(0), "0", "1");
  const target = history.target("undo", "1");
  assert.equal(history.target("undo", "1"), target);
  assert.equal(history.depth("1").past, 1);
  history.complete("undo", doc(1), "1", target);
  history.record(doc(0), "0", "2");
  assert.equal(history.depth("2").future, 0);
  assert.equal(history.depth("2").past, 1);
});

test("real Studio mutations support undo, redo, failed-operation recovery and conflict protection", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-history-"));
  const path = join(root, "document.op"), owner = "history-test";
  const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
  const getNode = async (id) => (await studio.call(path, owner, "get_node", { node_id: id })).native;
  const depth = async () => (await studio.call(path, owner, "get_history_depth", {})).native;
  try {
    await studio.create(path, owner);
    await studio.call(path, owner, "batch_design", { script: 'I(null,{type:"frame",name:"测试画板",width:400,height:240,layout:"none"});' });
    const entry = studio.entries.get(path);
    const created = JSON.parse(await readFile(entry.backing, "utf8"));
    const id = created.children[0].id;
    assert.equal((await depth()).past, 1);
    await studio.call(path, owner, "update_node", { nodeId: id, name: "已修改" });
    assert.equal((await getNode(id)).name, "已修改");
    assert.equal((await depth()).past, 2);
    await studio.call(path, owner, "undo", {});
    assert.equal((await getNode(id)).name, "测试画板");
    assert.equal((await depth()).future, 1);
    await studio.call(path, owner, "redo", {});
    assert.equal((await getNode(id)).name, "已修改");
    const priorDepth = (await depth()).past;
    await assert.rejects(studio.call(path, owner, "set_node_text", { node_id: "missing", text: "不存在" }));
    assert.equal((await depth()).past, priorDepth);
    entry.browser = { id: "test-browser", state: { dirty: true, revision: 7 } };
    await assert.rejects(studio.call(path, owner, "undo", {}), (e) => e.code === "UNSAVED_USER_CHANGES");
    delete entry.browser;
    assert.equal((await depth()).past, priorDepth);
    await studio.call(path, owner, "undo", {});
    await studio.call(path, owner, "update_node", { nodeId: id, name: "新的修改" });
    assert.equal((await depth()).future, 0);
    await assert.rejects(studio.call(path, owner, "redo", {}), (e) => e.code === "HISTORY_EMPTY");
    await studio.save(path, owner);
    await studio.call(path, owner, "update_node", { nodeId: id, name: "尚未保存" });
    const restored = await studio.call(path, owner, "undo", {});
    assert.equal(restored.saved, true);
    assert.equal((await getNode(id)).name, "新的修改");
    const current = await (await official()).read(entry.daemon.baseUrl, entry.daemon.token);
    const external = JSON.parse(current.documentJson);
    external.children[0].name = "外部变更";
    await restoreAuthoredSnapshot(entry.daemon.baseUrl, { documentJson: JSON.stringify(external), version: current.version });
    assert.equal((await depth()).past, 0);
    await assert.rejects(studio.call(path, owner, "undo", {}), (e) => e.code === "HISTORY_EMPTY");
    await studio.reload(path, owner, true);
    assert.equal((await getNode(id)).name, "新的修改");
    assert.equal((await depth()).past, 0);
    assert.equal(documentHash(await readFile(entry.backing, "utf8")), entry.documentBaseline);
    await studio.close(path, owner);
    await studio.status(path, owner);
    assert.equal((await depth()).past, 0);
  } finally {
    await studio.dispose();
  }
});
