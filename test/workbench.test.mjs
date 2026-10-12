import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StudioWorkbench } from "../lib/workbench/controller.js";
import { getBridge, isOpPath } from "../lib/workbench/contracts.js";
const request = (path, extras = {}) => ({ sessionId: "session-a", grant: { sourcePath: path, ...extras } });
const controller = (close = async () => true) => ({ requestClose: close, awaitExistingSave: async () => false, captureRecovery: async () => true, retainServerSessionOnUnmount() {} });
beforeEach(() => { getBridge().runtime = { key: (g,s) => s + g.sourcePath, preserve: async (state, c) => state.dirty ? (await c.captureRecovery() ? "recovered" : "unrecovered") : "clean" }; });
test("background opening preserves Chat; explicit opening activates the top tab", async () => {
  const workbench = new StudioWorkbench(), navigations = [];
  workbench.navigators.set("session-a", (...args) => navigations.push(args));
  assert.equal(await workbench.open(request("a.op"), true), true); assert.deepEqual(navigations, []);
  assert.equal(await workbench.open(request("a.op"), false), true);
  assert.deepEqual(navigations, [["openpencil-studio", "a.op"]]); assert.equal(workbench.getSnapshot().automatic, false);
});
test("automatic requests cannot replace another document or another session", async () => {
  const workbench = new StudioWorkbench(); await workbench.open(request("a.op"), false); workbench.onController(controller());
  assert.equal(await workbench.open(request("b.op"), true), false);
  assert.equal(await workbench.open({ ...request("a.op"), sessionId: "session-b" }, true), false);
  assert.equal(workbench.getSnapshot().grant.sourcePath, "a.op");
});
test("failed close keeps current editor and queues replacements", async () => {
  const workbench = new StudioWorkbench(); await workbench.open(request("a.op"), false);
  let closes = 0; workbench.onController(controller(async () => { closes++; return false; }));
  assert.deepEqual(await Promise.all([workbench.open(request("b.op"), false), workbench.open(request("c.op"), false)]), [false,false]);
  assert.equal(closes, 2); assert.equal(workbench.getSnapshot().grant.sourcePath, "a.op");
});
test("HMR recovery preserves unsaved data and permits a later runtime", async () => {
  const workbench = new StudioWorkbench(); await workbench.open(request("a.op"), false);
  let recoveries = 0; workbench.onController({...controller(),captureRecovery:async()=>{recoveries++;return true;}});
  workbench.onState({phase:"ready",dirty:true}); await workbench.release();
  assert.equal(recoveries, 1); assert.equal(workbench.getSnapshot(), undefined);
  assert.equal(await workbench.open(request("b.op"), false), true);
  await workbench.dispose(); assert.equal(await workbench.open(request("c.op"), false), false);
});
test(".op routing accepts local paths and leaves URLs and other files alone", () => {
  for (const path of ["design.op", "/tmp/设计稿.OP"]) assert.equal(isOpPath(path), true);
  for (const path of ["https://example.com/design.op", "file:///tmp/a.op", "a.op.txt", "a.op\0"]) assert.equal(isOpPath(path), false);
});

test("HMR release uses the owning runtime after its bridge registration disappears", async () => {
  const workbench = new StudioWorkbench(); await workbench.open(request("a.op"), false);
  let recoveries = 0;
  workbench.onController({ ...controller(), captureRecovery: async () => { recoveries++; return true; } });
  workbench.onState({ phase: "ready", dirty: true });
  delete getBridge().runtime;
  await workbench.release();
  assert.equal(recoveries, 1); assert.equal(workbench.getSnapshot(), undefined);
});

test("failed old recency bookkeeping cannot report against a newly opened document", async () => {
  let rejectOpened;
  getBridge().runtime.onOpened = () => new Promise((_resolve, reject) => { rejectOpened = reject; });
  const workbench = new StudioWorkbench(); await workbench.open(request("a.op"), false);
  workbench.onState({ phase: "ready", dirty: false }); workbench.onController(controller());
  await workbench.open(request("b.op"), false);
  rejectOpened(new Error("old metadata failed")); await Promise.resolve();
  assert.equal(workbench.getNotice(), undefined); assert.equal(workbench.getSnapshot().grant.sourcePath, "b.op");
});
