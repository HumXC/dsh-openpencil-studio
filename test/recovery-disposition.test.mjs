import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { registerHooks } from "node:module";
import ts from "typescript";

// Load current sources without touching shared lib or requiring a live daemon.
const sourceRoot = new URL("../src/", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot.href) && specifier.startsWith(".") && specifier.endsWith(".js")) {
      for (const extension of [".ts", ".tsx"]) {
        const candidate = new URL(specifier.replace(/\.js$/, extension), context.parentURL);
        if (existsSync(candidate)) return nextResolve(candidate.href, context);
      }
    }
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url === new URL('official.ts', sourceRoot).href) return {
      format: 'module', shortCircuit: true,
      source: 'export async function official() { if (!globalThis.__studioRecoveryRuntime) throw new Error("Unexpected native runtime access"); return globalThis.__studioRecoveryRuntime; } export async function restoreAuthoredSnapshot() { throw new Error("Unexpected native restore access"); } export async function readManagedDaemonDocument() { throw new Error("Unexpected daemon recovery access"); }',
    };
    if (url.startsWith(sourceRoot.href) && /\.tsx?$/.test(url)) return {
      format: "module", shortCircuit: true,
      source: ts.transpileModule(readFileSync(new URL(url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, jsx: ts.JsxEmit.ReactJSX },
        fileName: new URL(url).pathname,
      }).outputText,
    };
    return nextLoad(url, context);
  },
});
const { Studio, hash, documentHash } = await import("../src/studio.ts");
const { captureEditorSelection } = await import("../src/vendor/client/editor-panel.tsx");
const { discardManagedEditorRecovery, captureManagedEditorRecovery, editorRecoveryCopy } =
  await import("../src/vendor/client/editor-recovery.ts");

const document = (name, editorMeta = {}) => JSON.stringify({
  version: "1.0.0", pages: [{ id: "page", name: "Page", children: [{ id: "node", type: "frame", name }] }], editorMeta,
});
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), "studio-recovery-disposition-"));
  assert.ok(root.startsWith(join(tmpdir(), "studio-recovery-disposition-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, "source.op"), backing = join(root, "working.op");
  const original = document("Original");
  await writeFile(path, original);
  await writeFile(backing, original);
  const b = { id: "editor", baseline: hash(original), daemon: {}, state: { revision: 1, generation: 1 }, needsReload: false };
  const e = { path, owner: "owner", directory: root, backing, baseline: hash(original), documentBaseline: documentHash(original), daemon: {}, browser: b, phase: "ready" };
  const studio = new Studio(async (p) => p, root, "http://127.0.0.1:3080");
  studio.entries.set(path, e);
  const latest = async () => JSON.parse(await readFile(join(root, "recovery", "latest.json"), "utf8"));
  const retained = async () => (await readdir(join(root, "recovery"))).filter((p) => p.endsWith(".op")).sort();
  return { studio, e, b, root, path, original, latest, retained };
}

test("dismissal persists across restart and identical recaptures while retaining every snapshot", async (t) => {
  const f = await fixture(t), draft = document("Unsaved", { activePageIndex: 0 });
  const first = await f.studio.recovery("editor", draft);
  await f.studio.recoveryItem("editor", first.recovery.id, true);
  assert.equal(await f.studio.recoverySummary(f.e), undefined);
  assert.equal(await readFile(first.path, "utf8"), draft);
  assert.equal((await f.latest()).id, first.recovery.id, "dismissal preserves the latest record too");
  assert.equal((await f.studio.recoveryItem("editor", first.recovery.id)).docJson, draft);
  const restarted = new Studio(async (p) => p, f.root, "http://127.0.0.1:3080");
  restarted.entries.set(f.path, f.e);
  assert.equal(await restarted.recoverySummary(f.e), undefined);
  const identical = await restarted.recovery("editor", JSON.stringify(JSON.parse(document("Unsaved", { zoom: 2 })), null, 2));
  assert.equal(identical.recovery, undefined, "view state and JSON formatting do not define authored versions");
  assert.notEqual((await f.latest()).id, first.recovery.id);
  const changed = await restarted.recovery("editor", document("New unsaved content"));
  assert.ok(changed.recovery, "new authored content prompts again");
  const earlier = await restarted.recovery("editor", draft);
  assert.equal(earlier.recovery, undefined, "a previously dismissed version stays dismissed after another version");
  assert.equal((await f.retained()).length, 4);
});

test("stale exact-id rejection cannot dismiss a newer recovery", async (t) => {
  const f = await fixture(t);
  const first = await f.studio.recovery("editor", document("First"));
  const [capture, stale] = await Promise.allSettled([
    f.studio.recovery("editor", document("Second")),
    f.studio.recoveryItem("editor", first.recovery.id, true),
  ]);
  assert.equal(capture.status, "fulfilled");
  assert.equal(stale.status, "rejected");
  assert.equal(stale.reason.code, "RECOVERY_NOT_FOUND");
  assert.equal((await f.studio.recoverySummary(f.e)).id, capture.value.recovery.id);
  assert.equal((await f.retained()).length, 2);
  await assert.rejects(f.studio.recoveryItem("editor", "../latest.json", true), (error) => error.code === "RECOVERY_NOT_FOUND");
});

test("successful source save retires equal authored recovery and preserves different recovery", async (t) => {
  const f = await fixture(t);
  const draft = document("Draft", { zoom: 1 });
  const captured = await f.studio.recovery("editor", draft);
  f.studio.lease = async () => undefined;
  f.studio.validation = async () => ({ valid: true, diagnostics: [] });
  f.studio.snapshot = async () => ({ documentJson: document("Draft", { zoom: 3 }), version: 2 });
  f.studio.metadata = async () => {};
  assert.equal((await f.studio.save(f.path, "owner")).saved, true);
  assert.equal((await f.latest()).retired, true);
  assert.equal(await f.studio.recoverySummary(f.e), undefined);
  assert.equal(await readFile(captured.path, "utf8"), draft);
  await writeFile(f.path, document("Externally changed"));
  f.e.baseline = hash(await readFile(f.path, "utf8"));
  f.b.baseline = f.e.baseline;
  assert.equal(await f.studio.recoverySummary(f.e), undefined, "saved retirement remains durable after external source changes");
  const different = await f.studio.recovery("editor", document("Other recovery"));
  f.studio.snapshot = async () => ({ documentJson: document("Saved content differs"), version: 3 });
  await f.studio.save(f.path, "owner");
  assert.equal((await f.latest()).retired, false);
  assert.equal((await f.studio.recoverySummary(f.e)).id, different.recovery.id);
  assert.equal((await f.retained()).length, 2);
});

test("browser source save retires matching recovery through the shared commit boundary", async (t) => {
  const f = await fixture(t), draft = document("Browser draft");
  const captured = await f.studio.recovery("editor", draft);
  f.studio.snapshot = async () => ({ documentJson: f.original, version: 1 });
  f.studio.validateCanvasDocument = async () => [];
  f.studio.metadata = async () => {};
  const restores = [];
  globalThis.__studioRecoveryRuntime = { restore: async (...args) => { restores.push(args); } };
  try {
    const result = await f.studio.saveBrowser("editor", draft, 1, 1);
    assert.equal(result.saved, true);
    assert.equal(restores.length, 1);
    assert.equal(await readFile(f.path, "utf8"), draft);
    assert.equal((await f.latest()).retired, true);
    assert.equal(await f.studio.recoverySummary(f.e), undefined);
    assert.equal(await readFile(captured.path, "utf8"), draft);
  } finally { delete globalThis.__studioRecoveryRuntime; }
});

test("source save conflict retains an unsaved recovery without retirement", async (t) => {
  const f = await fixture(t);
  const draft = document("Must survive conflict");
  const captured = await f.studio.recovery("editor", draft);
  f.studio.lease = async () => undefined;
  f.studio.validation = async () => ({ valid: true, diagnostics: [] });
  f.studio.snapshot = async () => ({ documentJson: draft, version: 2 });
  const external = document("External file");
  await writeFile(f.path, external);
  await assert.rejects(f.studio.save(f.path, "owner"), (error) => error.code === "SAVE_CONFLICT");
  assert.equal(await readFile(f.path, "utf8"), external);
  assert.equal((await f.latest()).retired, false);
  assert.equal((await f.studio.recoverySummary(f.e)).id, captured.recovery.id);
  assert.equal(await readFile(captured.path, "utf8"), draft);
});

test("legacy recovery records derive the dismissal version from their retained authored snapshot", async (t) => {
  const f = await fixture(t), draft = document("Legacy");
  const captured = await f.studio.recovery("editor", draft);
  const legacy = await f.latest();
  delete legacy.authoredHash;
  delete legacy.retired;
  await writeFile(join(f.root, "recovery", "latest.json"), JSON.stringify(legacy));
  await f.studio.recoveryItem("editor", captured.recovery.id, true);
  assert.equal((await f.studio.recovery("editor", document("Legacy", { zoom: 8 }))).recovery, undefined);
  assert.equal((await f.retained()).length, 2);
});

test("invalid dismissal metadata fails before replacing the pending record or deleting snapshots", async (t) => {
  const f = await fixture(t);
  const captured = await f.studio.recovery("editor", document("Keep me"));
  await writeFile(join(f.root, "recovery", "dismissed.json"), JSON.stringify({ version: 1, authoredHashes: ["invalid"] }));
  await assert.rejects(f.studio.recoveryItem("editor", captured.recovery.id, true), (error) => error.code === "RECOVERY_METADATA_INVALID");
  await assert.rejects(f.studio.recovery("editor", document("Do not replace the pending record")), (error) => error.code === "RECOVERY_METADATA_INVALID");
  assert.equal((await f.latest()).id, captured.recovery.id);
  assert.equal((await f.retained()).length, 1);
});

test("malformed recovery metadata cannot turn a source write into a reported save failure", async (t) => {
  const f = await fixture(t), draft = document("Pending save");
  const captured = await f.studio.recovery("editor", draft);
  f.studio.lease = async () => undefined;
  f.studio.validation = async () => ({ valid: true, diagnostics: [] });
  f.studio.snapshot = async () => ({ documentJson: draft, version: 2 });
  await writeFile(join(f.root, "recovery", "dismissed.json"), "invalid");
  await assert.rejects(f.studio.save(f.path, "owner"), error => error.code === "RECOVERY_METADATA_INVALID");
  assert.equal(await readFile(f.path, "utf8"), f.original);
  assert.equal(await readFile(f.e.backing, "utf8"), f.original);
  assert.equal(await readFile(captured.path, "utf8"), draft);
});

test("checkpoint callbacks work while the enclosing document queue is occupied", async (t) => {
  const f = await fixture(t);
  let timer;
  try {
    const result = await Promise.race([
      f.studio.serialEntry(f.e, async () => {
        f.b.command = { id: "checkpoint", type: "checkpoint" };
        try { return await f.studio.recovery("editor", document("Checkpoint")); }
        finally { delete f.b.command; }
      }),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("checkpoint queue deadlocked")), 1000); }),
    ]);
    assert.ok(result.recovery);
  } finally { clearTimeout(timer); }
});

test("DELETE helper dismisses the exact recovery and absent capture metadata is valid", async () => {
  const previousWindow = globalThis.window;
  globalThis.window = { location: { href: "http://127.0.0.1:3080/" } };
  try {
    const launch = { sessionId: "editor", recoveryUrl: "/api/studio/editor/recovery" };
    const recovery = { id: "A".repeat(43) };
    const calls = [];
    await discardManagedEditorRecovery(launch, recovery, async (url, options) => {
      calls.push({ url, options });
      return Response.json({ ok: true, ignored: true, snapshotRetained: true });
    });
    assert.equal(calls[0].url, "http://127.0.0.1:3080/api/studio/editor/recovery/" + recovery.id);
    assert.equal(calls[0].options.method, "DELETE");
    assert.deepEqual(JSON.parse(calls[0].options.body), { sessionId: "editor" });
    assert.equal(await captureManagedEditorRecovery(launch, async () => Response.json({ ok: true, retained: true })), undefined);
    assert.match(editorRecoveryCopy("zh-CN").available("demo.op"), /取消.*此版本.*仍保留/);
  } finally {
    if (previousWindow === undefined) delete globalThis.window;
    else globalThis.window = previousWindow;
  }
});

function selectionFixture() {
  const state = {
    version: { generation: 2, revision: 7 }, selectionRevision: 11, active: true,
    selection: { sourcePath: "/project/design.op", activePageId: "page", selectedIds: ["node"] },
    documentJson: document("Unsaved browser content"),
  };
  const options = {
    sourcePath: state.selection.sourcePath,
    version: () => state.version,
    selectionRevision: () => state.selectionRevision,
    isCurrent: () => state.active,
    selection: async () => structuredClone(state.selection),
    snapshot: async () => ({ docJson: state.documentJson, ...state.version }),
  };
  return { state, options };
}

test("selection capture returns full authoritative unsaved browser content without changing state", async () => {
  const { state, options } = selectionFixture();
  const before = structuredClone(state);
  const captured = await captureEditorSelection(options);
  assert.equal(captured.documentJson, state.documentJson);
  assert.deepEqual(captured.selectedIds, ["node"]);
  assert.equal(captured.revision, 7);
  assert.equal(captured.generation, 2);
  assert.ok(captured.capturedAt > 0);
  assert.deepEqual(state, before);
});

for (const [name, change] of [
  ["selected objects", (s) => { s.selection.selectedIds = ["other"]; }],
  ["active page", (s) => { s.selection.activePageId = "other-page"; }],
  ["revision", (s) => { s.version.revision++; }],
  ["generation", (s) => { s.version.generation++; }],
  ["selection changed and returned", (s) => { s.selectionRevision++; }],
  ["editor closed", (s) => { s.active = false; }],
]) test(`selection capture rejects ${name} changing across the snapshot await`, async () => {
  const { state, options } = selectionFixture();
  options.snapshot = async () => {
    const snapshot = { docJson: state.documentJson, ...state.version };
    change(state);
    return snapshot;
  };
  await assert.rejects(captureEditorSelection(options), /changed during reference capture/);
});

test("selection capture rejects an empty selection before requesting a document", async () => {
  const { state, options } = selectionFixture();
  state.selection.selectedIds = [];
  options.snapshot = async () => { throw new Error("must not snapshot an empty selection"); };
  await assert.rejects(captureEditorSelection(options), /Select an OpenPencil object/);
});

test("selection capture rejects snapshot versions inconsistent with the current browser", async () => {
  const { state, options } = selectionFixture();
  options.snapshot = async () => ({ docJson: state.documentJson, generation: 2, revision: 6 });
  await assert.rejects(captureEditorSelection(options), /changed during reference capture/);
});
