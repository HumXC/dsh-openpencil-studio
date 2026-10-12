import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Studio, hash } from '../lib/studio.js';
import { StudioError } from '../lib/errors.js';

const saved = JSON.stringify({ version: '1.0.0', children: [] });
const edited = JSON.stringify({ version: '1.0.0', children: [{ id: 'n1', type: 'frame', name: '未保存', width: 100, height: 100, children: [] }] });
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'studio-flush-'));
  const source = join(root, 'document.op');
  await writeFile(source, saved);
  const studio = new Studio(async p => p, join(root, 'state'), 'http://127.0.0.1:3080');
  const directory = join(studio.root, hash(source + '\0owner'));
  const entry = { path: source, owner: 'owner', directory, backing: join(directory, 'working/document.op'), baseline: hash(saved), documentBaseline: hash(saved), daemon: {}, phase: 'ready' };
  entry.browser = { id: 'browser', daemon: { baseUrl: 'http://127.0.0.1:1', token: '' }, baseline: hash(saved), reportedAt: Date.now(), needsReload: false, state: { dirty: true, phase: 'ready', revision: 7, generation: 1, sequence: 1 } };
  studio.entries.set(source, entry);
  studio.snapshot = async () => ({ documentJson: edited, version: 1 });
  return { studio, entry, source, directory };
}

test('browser checkpoint timeout does not veto tool/model barriers and retains the precise unsaved snapshot', async () => {
  const { studio, entry, source, directory } = await fixture();
  await studio.recovery('browser', edited);
  const latestPath = join(directory, 'recovery/latest.json');
  const latest = await readFile(latestPath, 'utf8');
  studio.command = async () => { throw new StudioError('EDITOR_UNRESPONSIVE', 'The editor did not acknowledge the command; no file change was authorized'); };
  let dispatched = 0;
  const barrier = async () => { await studio.flushOwner('owner'); dispatched++; };
  await barrier();
  await barrier();
  assert.equal(dispatched, 2);
  assert.equal(await readFile(entry.backing, 'utf8'), edited);
  assert.equal(await readFile(source, 'utf8'), saved);
  assert.equal(await readFile(latestPath, 'utf8'), latest);
  assert.equal(entry.browser.state.dirty, true);
  assert.equal(entry.checkpointWarning.latestCanvasSnapshotCaptured, false);
  assert.equal(entry.checkpointWarning.browserSnapshotRetained, true);
  await assert.rejects(studio.call(source, 'owner', 'delete_selected', {}), e => e.code === 'UNSAVED_USER_CHANGES');
});

test('a stale canvas is skipped without waiting for a command and a later success clears the warning', async () => {
  const { studio, entry } = await fixture();
  await studio.recovery('browser', edited);
  entry.browser.reportedAt = Date.now() - 6000;
  let commands = 0;
  studio.command = async () => { commands++; return entry.browser.state; };
  const result = await studio.flushOwner('owner');
  assert.equal(commands, 0);
  assert.equal(result.warnings.length, 1);
  entry.browser.reportedAt = Date.now();
  const recovered = await studio.flushOwner('owner');
  assert.equal(commands, 1);
  assert.deepEqual(recovered.warnings, []);
  assert.equal(entry.checkpointWarning, undefined);
  assert.equal(entry.browser.state.dirty, true);
});

test('unreachable browser with no precise snapshot retains the working copy and reports the missing latest canvas', async () => {
  const { studio, entry } = await fixture();
  entry.browser.reportedAt = 0;
  const result = await studio.flushOwner('owner');
  assert.equal(result.warnings[0].capture, 'unavailable');
  assert.equal(result.warnings[0].browserSnapshotRetained, false);
  assert.equal(await readFile(entry.backing, 'utf8'), edited);
  assert.equal(entry.browser.state.dirty, true);
});

test('precise recovery disk failure cannot be hidden by a client command failure and an older good snapshot', async () => {
  const {studio, entry, directory} = await fixture();
  await studio.recovery('browser', edited);
  const latestPath = join(directory,'recovery/latest.json');
  const before = await readFile(latestPath,'utf8');
  const diskError = Object.assign(new Error('Recovery storage is full'), {code:'ENOSPC'});
  studio.captureRecovery = async () => { throw diskError; };
  studio.command = async browser => {
    browser.command = {id:'checkpoint-disk-error',type:'checkpoint'};
    await assert.rejects(studio.recovery(browser.id, edited), error => error === diskError);
    delete browser.command;
    throw new StudioError('EDITOR_COMMAND_FAILED','Recovery storage is full');
  };
  await assert.rejects(studio.flushOwner('owner'), error => error === diskError);
  assert.equal(await readFile(latestPath,'utf8'), before);
  assert.equal(entry.browser.state.dirty, true);
  assert.equal(entry.checkpointWarning, undefined);
  studio.command = async () => {throw new StudioError('EDITOR_UNRESPONSIVE','disconnected');};
  assert.equal((await studio.flushOwner('owner')).warnings[0].capture,'retained');
});

test('working checkpoint and recovery metadata failures still reject the durability barrier', async () => {
  const { studio, entry, directory } = await fixture();
  await mkdir(entry.backing, { recursive: true });
  await assert.rejects(studio.flushOwner('owner'), e => e.code === 'EISDIR');
  const second = await fixture();
  await mkdir(join(second.directory, 'recovery'), { recursive: true });
  await writeFile(join(second.directory, 'recovery/latest.json'), '{invalid');
  second.entry.browser.reportedAt = 0;
  await assert.rejects(second.studio.flushOwner('owner'), e => e.code === 'RECOVERY_METADATA_INVALID');
  assert.equal(second.entry.browser.state.dirty, true);
});
