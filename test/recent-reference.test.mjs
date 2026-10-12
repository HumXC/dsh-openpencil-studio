import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, realpath, readFile, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { RecentDocuments } from '../lib/recent.js';
import { createTools } from '../lib/index.js';
import { selectionReference, serializeReference, referenceLabel } from '../lib/reference.js';
import { Workspace } from '../../dsh-openpencil-workspace/lib/workspace.js';
import { getBridge } from '../../dsh-openpencil-workspace/lib/contracts.js';
async function fixture(t) {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'pencil-recent-test-')));
  assert.ok(root.startsWith(await realpath(tmpdir()) + '/pencil-recent-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let writable = true;
  const recent = new RecentDocuments(async () => ({ root, writable }), async path => realpath(resolve(root, path)));
  for (const file of ['a.op', 'b.op']) await writeFile(join(root, file), '{}');
  return { root, recent, readonly() { writable = false; } };
}
test('workspace recents persist, deduplicate aliases, reorder and remove only metadata', async t => {
  const {root, recent} = await fixture(t);
  assert.deepEqual((await recent.list('owner')).items, []);
  await symlink(join(root, 'a.op'), join(root, 'alias.op'));
  await Promise.all([recent.touch('owner', 'a.op'), recent.touch('owner', 'b.op')]);
  assert.deepEqual((await recent.list('owner')).items.map(item => item.path).sort(), [join(root,'a.op'), join(root,'b.op')]);
  // Concurrent authorization may finish in either order; an explicit subsequent
  // open must become newest, and parallel writes must retain both records.
  await recent.touch('owner', 'b.op');
  assert.deepEqual((await recent.list('owner')).items.map(item => item.path), [join(root,'b.op'), join(root,'a.op')]);
  await recent.touch('owner', 'alias.op');
  assert.deepEqual((await recent.list('owner')).items.map(item => item.path), [join(root,'a.op'), join(root,'b.op')]);
  const persisted = JSON.parse(await readFile(join(root,'.dsh/openpencil/recent.json'),'utf8'));
  assert.equal(persisted.version, 1); assert.equal(persisted.items.length, 2);
  const restarted = new RecentDocuments(async () => ({root, writable:true}), async path => realpath(resolve(root,path)));
  await restarted.remove('owner', 'a.op');
  assert.equal(await readFile(join(root,'a.op'),'utf8'), '{}');
  await rm(join(root,'b.op')); // Removed/missing files remain removable from history.
  assert.equal((await restarted.remove('owner','b.op')).removed, true);
  assert.deepEqual((await recent.list('owner')).items, []);
});
test('recent list cannot mutate readonly metadata or overwrite malformed history', async t => {
  const f = await fixture(t); await f.recent.touch('owner','a.op'); f.readonly();
  await assert.rejects(f.recent.touch('owner','b.op'), error => error.code === 'READ_ONLY');
  await assert.rejects(f.recent.remove('owner','a.op'), error => error.code === 'READ_ONLY');
  await writeFile(join(f.root,'.dsh/openpencil/recent.json'),'not-json');
  await assert.rejects(f.recent.list('owner'), error => error.code === 'INVALID_RECENT_FILE');
  assert.equal(await readFile(join(f.root,'.dsh/openpencil/recent.json'),'utf8'),'not-json');
});
test('model tools and UI storage operation share recent results, with pencil prefix only', async t => {
  const {root, recent} = await fixture(t);
  const tools = createTools({status: async path => ({ok:true,path:resolve(root,path)}), grantForDocument: async path => ({sourcePath:path})}, recent);
  assert.ok(tools.every(tool => tool.name.startsWith('pencil_')));
  const exec = {agent:{id:'owner'},signal:new AbortController().signal};
  await tools.find(tool => tool.name === 'pencil_open').execute({path:'a.op'}, exec);
  const list = await tools.find(tool => tool.name === 'pencil_recent').execute({action:'list'},exec);
  assert.equal(list.items[0].path,join(root,'a.op'));
  const removed = await tools.find(tool => tool.name === 'pencil_recent').execute({action:'remove',path:'a.op'},exec);
  assert.equal(removed.removed,true); assert.deepEqual((await recent.list('owner')).items,[]);
});
function capture() {
  return {sourcePath:'/workspace/中文.op',activePageId:'page',selectedIds:['frame','label'],revision:4,generation:2,capturedAt:123,documentJson:JSON.stringify({pages:[{id:'page',children:[{id:'frame',name:'统计卡片',type:'frame',children:[{id:'label',type:'text',content:'未保存内容'}]},{id:'unselected',content:'不应引用'}]}]})};
}
test('selection reference freezes complete unsaved subtree, deduplicates children and survives serialization', () => {
  const original = capture(), value = selectionReference(original);
  assert.equal(value.nodes.length,1); assert.equal(value.nodes[0].children[0].content,'未保存内容');
  original.documentJson='{}';
  const ref=JSON.stringify(value), serialized=serializeReference(ref);
  assert.ok(serialized.includes('未保存内容')); assert.ok(!serialized.includes('不应引用'));
  assert.ok(referenceLabel(value).includes('统计卡片')); assert.ok(serialized.includes('"revision": 4'));
  assert.throws(() => selectionReference({...capture(),selectedIds:['missing']}), /选区已变化/);
  const huge=capture(); huge.documentJson=huge.documentJson.replace('未保存内容','x'.repeat(270000));
  assert.throws(() => selectionReference(huge), /256 KiB/);
});
test('reference captures composer guard before snapshot, inserts then navigates, never submits', async () => {
  const bridge=getBridge(), old=bridge.runtime, calls=[];
  bridge.runtime={key: grant=>grant.sourcePath,successor:()=>false,preserve:async()=>'',reference:async(value,id,span)=>calls.push(['insert',value.revision,id,span.draftRev])};
  const workspace=new Workspace(()=>true);
  try {
    await workspace.open({sessionId:'s',grant:{sourcePath:'/workspace/中文.op'}},false);
    workspace.inputs.set('s',{captureInsertion:()=>{calls.push(['span']);return{start:0,end:0,draftRev:5};}});
    workspace.navigators.set('s',(view,focus)=>calls.push(['navigate',view,focus]));
    workspace.onController({captureSelection:async()=>{calls.push(['snapshot']);return capture();},requestClose:async()=>true,captureRecovery:async()=>true});
    await workspace.referenceSelection();
    assert.deepEqual(calls,[['span'],['snapshot'],['insert',4,'s',5],['navigate','chat','composer']]);
  } finally { await workspace.dispose(); bridge.runtime=old; }
});
test('recent metadata rejects symlink escapes and accepts uppercase OP filenames', async t => {
  const f=await fixture(t), outside=await fixture(t);
  await symlink(outside.root,join(f.root,'.dsh'));
  await assert.rejects(f.recent.touch('owner','a.op'),error=>error.code==='INVALID_RECENT_DIRECTORY');
  await rm(join(f.root,'.dsh')); // The exact fixture-owned symlink, never its target.
  await writeFile(join(f.root,'UPPER.OP'),'{}'); await f.recent.touch('owner','UPPER.OP');
  const metadata=join(f.root,'.dsh/openpencil/recent.json');
  await rm(metadata); await symlink(join(outside.root,'a.op'),metadata);
  await assert.rejects(f.recent.list('owner'),error=>error.code==='INVALID_RECENT_FILE');
  await assert.rejects(f.recent.touch('owner','a.op'),error=>error.code==='INVALID_RECENT_FILE');
  assert.equal(await readFile(join(outside.root,'a.op'),'utf8'),'{}');
});
test('a successful open stays successful when recent metadata cannot be written',async t=>{
  const f=await fixture(t); f.readonly();
  const tools=createTools({status:async()=>({ok:true,path:join(f.root,'a.op')}),grantForDocument:async()=>({})},f.recent);
  const result=await tools.find(tool=>tool.name==='pencil_open').execute({path:'a.op'},{agent:{id:'owner'},signal:new AbortController().signal});
  assert.equal(result.ok,true); assert.match(result.recentWarning,/cannot update recent/); assert.ok(result.presentationId);
});
test('reference rejects switched files and failed insertion without navigating',async()=>{
  const bridge=getBridge(),old=bridge.runtime; let inserted=0,navigated=0;
  bridge.runtime={key:grant=>grant.sourcePath,successor:()=>false,preserve:async()=>'',reference:async()=>{inserted++;throw new Error('draft changed');}};
  const workspace=new Workspace(()=>true);
  try{
    await workspace.open({sessionId:'s',grant:{sourcePath:'/workspace/中文.op'}},false);
    workspace.inputs.set('s',{captureInsertion:()=>({start:0,end:0,draftRev:3})});
    workspace.navigators.set('s',()=>navigated++);
    workspace.onController({captureSelection:async()=>({...capture(),sourcePath:'/workspace/other.op'})});
    await assert.rejects(workspace.referenceSelection(),/编辑文件已切换/); assert.equal(inserted,0);
    workspace.onController({captureSelection:async()=>capture()});
    await assert.rejects(workspace.referenceSelection(),/draft changed/); assert.equal(inserted,1); assert.equal(navigated,0);
    workspace.onController({captureSelection:async()=>{await workspace.open({sessionId:'s',grant:{sourcePath:'/workspace/中文.op'}},false);return capture();}});
    await assert.rejects(workspace.referenceSelection(),/编辑文件已切换/); assert.equal(inserted,1);
  }finally{await workspace.dispose();bridge.runtime=old;}
});
test('only completed opens update recency and an explicit revisit updates it again', async () => {
  const bridge = getBridge(), old = bridge.runtime, opened = [];
  bridge.runtime = { key: grant => grant.sourcePath, successor: () => false, preserve: async () => '', onOpened: async request => { opened.push(request.grant.sourcePath); } };
  const workspace = new Workspace(() => true);
  try {
    const request = { sessionId: 's', grant: { sourcePath: '/workspace/中文.op' } };
    await workspace.open(request, false);
    assert.deepEqual(opened, []);
    workspace.onState({ phase: 'ready', dirty: false });
    workspace.onState({ phase: 'saving', dirty: true });
    workspace.onState({ phase: 'ready', dirty: false });
    assert.deepEqual(opened, ['/workspace/中文.op']);
    await workspace.open(request, false);
    assert.deepEqual(opened, ['/workspace/中文.op', '/workspace/中文.op']);
  } finally { await workspace.dispose(); bridge.runtime = old; }
});
