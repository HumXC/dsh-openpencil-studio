import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Studio, hash } from '../lib/studio.js';
import { stopManagedEditorDaemon } from '../lib/vendor/server/managed-editor-daemon.js';

const cleanState = (sequence, extra = {}) => ({ generation: 1, revision: 1, dirty: false, phase: 'ready', sequence, ...extra });
function reportFixture() {
  const studio = new Studio(async (path) => path, '/tmp/studio-offline-report-state', 'http://127.0.0.1:3080');
  const browser = { id: 'browser', baseline: 'original-source', reportedAt: 0, state: cleanState(0), needsReload: false };
  const entry = { path: '/tmp/studio-offline-report.op', owner: 'owner', baseline: 'new-source', browser };
  studio.entries.set(entry.path, entry);
  return { studio, entry, browser };
}

test('clean, stale, loading and broken editor never gate real working-copy edits, history, validation, save or reload', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-editor-offline-'));
  const path = join(root, 'document.op');
  const owner = 'owner';
  const studio = new Studio(async (p) => p, join(root, 'state'), 'http://127.0.0.1:3080');
  let browser;
  try {
    await studio.create(path, owner);
    await studio.call(path, owner, 'batch_design', { script: 'I(null,{type:"frame",name:"Before",width:200,height:100});' });
    await studio.save(path, owner);
    const grant = await studio.grantForDocument(path, '', { sessionId: owner });
    const launch = await studio.attach(grant.editor.launchUrl.split('/').at(-2), owner);
    browser = studio.entries.get(path).browser;
    await stopManagedEditorDaemon(browser.daemon);
    browser.reportedAt = 0;
    let commands = 0;
    studio.command = async () => { commands++; throw new Error('Tools attempted to contact the offline editor'); };
    let sequence = 0;
    for (const phase of ['loading', 'ready', 'error']) {
      studio.report(launch.sessionId, cleanState(++sequence, { phase }));
      await studio.call(path, owner, 'update_node', { nodeId: 'n1', data: { name: phase } });
      assert.equal((await studio.call(path, owner, 'get_node', { node_id: 'n1' })).native.name, phase);
      assert.equal(browser.toolLease, undefined);
    }
    assert.equal((await studio.validate(path, owner)).valid, true);
    await studio.call(path, owner, 'undo', {});
    assert.equal((await studio.call(path, owner, 'get_node', { node_id: 'n1' })).native.name, 'ready');
    await studio.call(path, owner, 'redo', {});
    const saved = await studio.save(path, owner);
    assert.equal(saved.saved, true);
    assert.equal(saved.editorNeedsReload, true);
    assert.equal(JSON.parse(await readFile(path, 'utf8')).children[0].name, 'error');
    assert.equal(browser.baseline === hash(await readFile(path, 'utf8')), false);
    assert.equal(browser.pendingSync.documentJson, await readFile(path, 'utf8'));
    const savedText = await readFile(path, 'utf8');
    studio.report(launch.sessionId, cleanState(++sequence, { dirty: true, revision: 5 }));
    await assert.rejects(studio.call(path, owner, 'update_node', { nodeId: 'n1', data: { name: 'Forbidden' } }), (e) => e.code === 'UNSAVED_USER_CHANGES');
    await assert.rejects(studio.save(path, owner), (e) => e.code === 'UNSAVED_USER_CHANGES');
    await assert.rejects(studio.reload(path, owner, true), (e) => e.code === 'UNSAVED_USER_CHANGES');
    assert.equal(await readFile(path, 'utf8'), savedText);
    browser.choice = { mode: 'edit-saved', revision: 5 }; // Already confirmed exact revision.
    await studio.call(path, owner, 'update_node', { nodeId: 'n1', data: { name: 'Authorized' } });
    await studio.save(path, owner);
    assert.equal(browser.state.dirty, true);
    const response = studio.report(launch.sessionId, cleanState(++sequence, { dirty: true, revision: 6 }));
    assert.equal(response.sync, undefined);
    await assert.rejects(studio.call(path, owner, 'update_node', { nodeId: 'n1', data: { name: 'Stale confirmation' } }), (e) => e.code === 'UNSAVED_USER_CHANGES');
    studio.report(launch.sessionId, cleanState(++sequence));
    const external = JSON.parse(await readFile(path, 'utf8'));
    external.children[0].name = 'External';
    await writeFile(path, JSON.stringify(external));
    await studio.reload(path, owner, true);
    assert.equal((await studio.call(path, owner, 'get_node', { node_id: 'n1' })).native.name, 'External');
    assert.equal(browser.needsReload, true);
    assert.equal(commands, 0);
  } finally {
    if (browser) browser.state.dirty = false;
    await studio.dispose();
  }
});

test('Host lease works without a canvas command and blocks interactive save until transaction finishes', async () => {
  const { studio, entry, browser } = reportFixture();
  studio.command = async () => { throw new Error('No browser commands are allowed'); };
  await studio.lease(entry);
  const response = studio.report(browser.id, cleanState(1));
  assert.equal(response.activeLease, browser.toolLease);
  assert.equal(response.command, null);
  await assert.rejects(studio.saveBrowser(browser.id, '{}', 1, 1), (e) => e.code === 'EDITOR_WRITE_LEASE');
  await studio.release(browser);
  assert.equal(browser.toolLease, undefined);
  assert.equal(studio.report(browser.id, cleanState(2)).activeLease, null);
});

test('only the latest clean refresh acknowledgement advances the canvas baseline', () => {
  const { studio, entry, browser } = reportFixture();
  studio.queueCanvasSync(entry, browser, 'first');
  const first = browser.pendingSync.id;
  entry.baseline = 'latest-source';
  studio.queueCanvasSync(entry, browser, 'latest');
  const latest = browser.pendingSync.id;
  let response = studio.report(browser.id, cleanState(1), undefined, undefined, first);
  assert.deepEqual(response.sync, { id: latest, documentJson: 'latest' });
  assert.equal(browser.baseline, 'original-source');
  studio.report(browser.id, cleanState(1), undefined, undefined, latest);
  assert.equal(browser.needsReload, true);
  response = studio.report(browser.id, cleanState(2, { dirty: true }), undefined, undefined, latest);
  assert.equal(response.sync, undefined);
  assert.equal(browser.pendingSync.id, latest);
  browser.toolLease = 'host-transaction';
  response = studio.report(browser.id, cleanState(3), undefined, undefined, latest);
  assert.equal(response.sync, undefined);
  assert.equal(response.activeLease, 'host-transaction');
  delete browser.toolLease;
  studio.report(browser.id, cleanState(4, { phase: 'loading' }), undefined, undefined, latest);
  assert.equal(browser.needsReload, true);
  response = studio.report(browser.id, cleanState(5), undefined, undefined, latest);
  assert.equal(response.sync, undefined);
  assert.equal(browser.pendingSync, undefined);
  assert.equal(browser.needsReload, false);
  assert.equal(browser.baseline, 'latest-source');
});

test('reported unsaved edits after a tool transaction retain pending refresh and invalidate consent', async () => {
  const { studio, entry, browser } = reportFixture();
  browser.choice = { mode: 'edit-saved', revision: 1 };
  await studio.lease(entry);
  studio.queueCanvasSync(entry, browser, 'agent-document');
  studio.report(browser.id, cleanState(1, { dirty: true, revision: 2 }));
  assert.equal(browser.choice, undefined);
  await studio.release(browser);
  await assert.rejects(studio.lease(entry), (e) => e.code === 'UNSAVED_USER_CHANGES');
  assert.equal(browser.pendingSync.documentJson, 'agent-document');
  assert.equal(browser.state.dirty, true);
});
