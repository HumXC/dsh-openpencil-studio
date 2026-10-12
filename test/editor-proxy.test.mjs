import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { runInNewContext } from 'node:vm';
import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { createRequire } from 'node:module';
import { handleStudio } from '../lib/http.js';
import { Studio } from '../lib/studio.js';
import { canvasBootstrap, canvasPrefix, canvasRequestPath } from '../lib/editor-proxy.js';
import { editorOrigin, editorMessageFrom } from '../lib/vendor/client/editor-bridge.js';

async function listen(handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  return { server, origin: `http://127.0.0.1:${server.address().port}` };
}
async function close(server) {
  server.closeAllConnections();
  await new Promise(resolve => server.close(resolve));
}
const prefix = canvasPrefix('browser');

test('canvas path policy rejects traversal, file/settings routes, arbitrary targets and method changes', () => {
  for (const path of ['/pkg/../private', '/pkg/%2e%2e/private', '/pkg/%252e%252e/private', '/pkg/..%2fprivate', '/pkg/a%5cb', '/pkg/a//b', '/pkg/.secret', '/pkg/http:evil', '/pkg/a%00b', '/api/file/save', '/api/file/open-recent', '/api/settings/credentials', '/mcp', '//evil.test/x']) {
    assert.throws(() => canvasRequestPath(path, 'GET'), path);
  }
  assert.throws(() => canvasRequestPath('/pkg/file.js', 'POST'));
  assert.throws(() => canvasRequestPath('/api/mcp/server', 'POST'));
  assert.equal(canvasRequestPath('/pkg/snippets/runtime/src/bridge.js', 'GET'), '/pkg/snippets/runtime/src/bridge.js');
  assert.equal(canvasRequestPath('/api/mcp/document', 'POST'), '/api/mcp/document');
});

test('iframe bootstrap maps fetch strings, URL and Request, XHR and SSE while preserving external requests', async () => {
  const calls = [];
  const window = { fetch: async (...args) => { calls.push(args); return new Response('ok'); } };
  class XHR { open(...args) { calls.push(args); } }
  class ES { static OPEN = 1; constructor(url, options) { this.url = url; this.options = options; } }
  window.EventSource = ES;
  const location = new URL(`http://127.0.0.1:3080${prefix}?embed=vscode`);
  runInNewContext(canvasBootstrap(prefix), { window, location, URL, Request, XMLHttpRequest: XHR });
  await window.fetch('/api/mcp/document?revision=2', { method: 'POST', body: 'kept' });
  assert.equal(calls[0][0], `http://127.0.0.1:3080${prefix}api/mcp/document?revision=2`);
  assert.equal(calls[0][1].body, 'kept');
  await window.fetch(new URL('https://cdn.example/font.ttf'));
  assert.equal(calls[1][0], 'https://cdn.example/font.ttf');
  await window.fetch(new Request('http://127.0.0.1:3080/api/mcp/document', { method: 'POST', body: 'payload', headers: { 'x-test': 'retained' } }));
  assert.equal(calls[2][0].url, `http://127.0.0.1:3080${prefix}api/mcp/document`);
  assert.equal(await calls[2][0].text(), 'payload');
  assert.equal(calls[2][0].headers.get('x-test'), 'retained');
  new XHR().open('GET', '/api/mcp/version', true);
  assert.equal(calls[3][1], `http://127.0.0.1:3080${prefix}api/mcp/version`);
  const events = new window.EventSource('/api/mcp/events?token=native', { withCredentials: false });
  assert.equal(events.url, `http://127.0.0.1:3080${prefix}api/mcp/events?token=native`);
  assert.equal(window.EventSource.OPEN, 1);
  await window.fetch(`${prefix}pkg/entry.js`);
  assert.equal(calls[4][0], `http://127.0.0.1:3080${prefix}pkg/entry.js`);
});

test('vendor regeneration retains the proxy navigation and same-origin bridge contract', async () => {
  const root = dirname(createRequire(import.meta.url).resolve('@zseven-w/dsh-openpencil/package.json'));
  const {patchEditor, patchBridge} = await import('../scripts/editor-patches.mjs');
  const panel = patchEditor(await readFile(join(root,'src/client/editor-panel.tsx'),'utf8'));
  assert.ok(panel.includes('new URL(launch.iframeUrl, window.location.href)'));
  assert.ok(panel.includes('editorOrigin(iframeUrl.href)'));
  assert.ok(panel.includes('editorIframeUrlWithTheme(iframeUrl.href, colorSchemeRef.current)'));
  assert.ok(panel.includes("import { StudioToolbar } from '../../editor-toolbar.js'"));
  assert.ok(panel.includes('<StudioToolbar title={title} path={documentGrant.path} locale={locale} iframeRef={iframeRef}'));
  assert.ok(panel.includes("ready={phase === 'ready'} locked={studio.locked || liveDraft}>"));
  const toolbar = panel.match(/<StudioToolbar[^]*?<\/StudioToolbar>/)?.[0];
  assert.ok(toolbar.includes('{studio.actions}'));
  assert.ok(toolbar.includes('{workbenchActions}'));
  assert.ok(toolbar.includes('void save()'));
  assert.ok(panel.includes("transform: 'translateY(-40px)'"));
  const bridge = patchBridge(await readFile(join(root,'src/client/editor-bridge.ts'),'utf8'));
  const current = await readFile(new URL('../src/vendor/client/editor-bridge.ts',import.meta.url),'utf8');
  const originFunction = text => text.match(/^export function editorOrigin[^]*?^}/m)?.[0];
  assert.equal(originFunction(bridge), originFunction(current));
});

test('same-origin bridge still rejects a different iframe or a forged origin', () => {
  const base = 'http://127.0.0.1:3080/chat';
  assert.equal(editorOrigin(prefix, base), 'http://127.0.0.1:3080');
  assert.throws(() => editorOrigin('http://127.0.0.1:9999/', base));
  const frame = {};
  const event = { source: frame, origin: 'http://127.0.0.1:3080', data: JSON.stringify({ type: 'op-bridge/listening' }) };
  assert.equal(editorMessageFrom(event, frame, event.origin).type, 'op-bridge/listening');
  assert.equal(editorMessageFrom({ ...event, source: {} }, frame, event.origin), undefined);
  assert.equal(editorMessageFrom({ ...event, origin: 'http://evil.test' }, frame, event.origin), undefined);
});

test('proxy serves rewritten native assets and binary data, binds credentials and cancels streaming events', async () => {
  const requests = [], sockets = new Set();
  const upstream = await listen(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    requests.push({ path: url.pathname, query: url.search, headers: req.headers });
    if (url.pathname === '/') { res.setHeader('content-type', 'text/html'); res.end('<html><head></head><script type="module">import("/pkg/op_host_web.js")</script></html>'); }
    else if (url.pathname.endsWith('.js')) { res.setHeader('content-type', 'text/javascript'); res.end("import './snippets/a.js'; const resource='/canvaskit/canvaskit.js'; const wasm=new URL('native.wasm',import.meta.url);"); }
    else if (url.pathname.endsWith('.wasm')) { res.setHeader('content-type', 'application/wasm'); res.end(Buffer.from([0, 97, 115, 109])); }
    else if (url.pathname.endsWith('/events')) {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      sockets.add(res); res.on('close', () => sockets.delete(res));
      res.write('event: document\ndata: {"version":2}\n\n');
    } else if (url.pathname.endsWith('/version')) { res.writeHead(302, { location: 'http://evil.test' }); res.end(); }
    else {
      let body = ''; for await (const chunk of req) body += chunk;
      res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ body, ok: true }));
    }
  });
  let allowed = true, authorizations = 0;
  const studio = new Studio(async p => { authorizations++; if (!allowed) throw new Error('permission revoked'); return p; }, '/unused', upstream.origin);
  studio.entries.set('/bound.op', { path: '/bound.op', owner: 'owner', browser: { id: 'browser', daemon: { baseUrl: upstream.origin, token: 'private-native-token' } } });
  const host = await listen((req, res) => void handleStudio(studio, req, res));
  const headers = { origin: host.origin };
  try {
    const html = await (await fetch(host.origin + prefix + '?embed=vscode')).text();
    assert.ok(html.includes('XMLHttpRequest.prototype.open'));
    assert.ok(html.includes(`import("${prefix}pkg/op_host_web.js")`));
    const js = await (await fetch(host.origin + prefix + 'pkg/op_host_web.js')).text();
    assert.ok(js.includes(`'${prefix}canvaskit/canvaskit.js'`));
    assert.ok(js.includes("import './snippets/a.js'"));
    const wasm = await fetch(host.origin + prefix + 'pkg/op_host_web_bg.wasm');
    assert.equal(wasm.headers.get('content-type'), 'application/wasm');
    assert.deepEqual(Buffer.from(await wasm.arrayBuffer()), Buffer.from([0,97,115,109]));
    const posted = await fetch(host.origin + prefix + 'api/mcp/document?tenant=another&token=spoof&v=2', { method: 'POST', headers: { ...headers, 'content-type': 'application/json', 'x-openpencil-token': 'spoof', cookie: 'DSH=private', authorization: 'Bearer private' }, body: '{"document":{}}' });
    assert.equal((await posted.json()).body, '{"document":{}}');
    const native = requests.at(-1);
    assert.equal(native.query, '?v=2');
    assert.equal(native.headers['x-openpencil-token'], 'private-native-token');
    assert.equal(native.headers.cookie, undefined);
    assert.equal(native.headers.authorization, undefined);
    const browser = studio.browser('browser').browser;
    browser.toolLease = 'host-transaction';
    const requestCount = requests.length;
    const locked = await fetch(host.origin + prefix + 'api/mcp/document', { method:'POST', headers, body:'{}' });
    assert.equal((await locked.json()).code, 'EDITOR_WRITE_LEASE');
    assert.equal(requests.length, requestCount);
    delete browser.toolLease;
    for (const type of ['checkpoint','save','reload']) {
      browser.command = {id:'command',type};
      browser.lease = 'canvas-command-lease';
      assert.equal((await fetch(host.origin + prefix + 'api/mcp/document', {method:'POST',headers,body:'{}'})).status, 200, type);
      browser.toolLease = 'host-transaction';
      assert.equal((await (await fetch(host.origin + prefix + 'api/mcp/document', {method:'POST',headers,body:'{}'})).json()).code, 'EDITOR_WRITE_LEASE');
      delete browser.toolLease;
    }
    browser.command = {id:'lock-input',type:'lease'};
    assert.equal((await (await fetch(host.origin + prefix + 'api/mcp/document', {method:'POST',headers,body:'{}'})).json()).code, 'EDITOR_WRITE_LEASE');
    delete browser.command;
    delete browser.lease;
    assert.equal((await fetch(host.origin + prefix + 'api/mcp/document', { method: 'POST', headers: { origin: 'http://evil.test' } })).status, 400);
    const count = requests.length;
    assert.equal((await fetch(host.origin + prefix + 'api/file/open-recent', { method: 'POST', headers })).status, 400);
    assert.equal(requests.length, count);
    const redirect = await fetch(host.origin + prefix + 'api/mcp/version');
    assert.equal(redirect.status, 400);
    assert.equal((await redirect.json()).code, 'PROXY_REDIRECT_REJECTED');
    const events = await fetch(host.origin + prefix + 'api/mcp/events');
    assert.equal(events.headers.get('content-type'), 'text/event-stream');
    const reader = events.body.getReader();
    const first = await reader.read();
    assert.ok(new TextDecoder().decode(first.value).includes('"version":2'));
    const ended = once([...sockets][0], 'close');
    await reader.cancel();
    await ended;
    assert.equal(sockets.size, 0);
    allowed = false;
    assert.equal((await fetch(host.origin + prefix + 'pkg/op_host_web.js')).status, 400);
    allowed = true; studio.entries.clear();
    const closed = await fetch(host.origin + prefix);
    assert.equal((await closed.json()).code, 'EDITOR_NOT_FOUND');
    assert.ok(authorizations >= 7);
  } finally { await close(host.server); await close(upstream.server); }
});

test('real pinned native editor works through the proxy for HTML, modules, WASM, document, selection and event stream', async () => {
  const root = await mkdtemp(join(tmpdir(), 'studio-native-proxy-'));
  const path = join(root, '中文代理.op');
  const studio = new Studio(async p => p, join(root,'state'), 'http://127.0.0.1:3080');
  const host = await listen((req, res) => void handleStudio(studio, req, res));
  try {
    await studio.create(path, 'owner');
    await studio.call(path, 'owner', 'insert_node', {data:{type:'frame',name:'代理测试',width:320,height:180,children:[]}});
    await studio.save(path, 'owner');
    const sourceBefore = await readFile(path, 'utf8');
    const grant = await studio.grantForDocument(path, '', { sessionId: 'owner' });
    const launch = await studio.attach(grant.editor.launchUrl.split('/').at(-2), 'owner');
    assert.ok(launch.iframeUrl.startsWith(canvasPrefix(launch.sessionId)));
    assert.ok(!launch.iframeUrl.includes('http:'));
    const url = new URL(launch.iframeUrl, host.origin);
    const html = await (await fetch(url)).text();
    assert.ok(html.includes(`${canvasPrefix(launch.sessionId)}pkg/op_host_web.js`));
    const base = host.origin + canvasPrefix(launch.sessionId);
    const js = await fetch(base + 'pkg/op_host_web.js');
    assert.equal(js.status, 200);
    const entry = await js.text();
    const snippets = [...entry.matchAll(/from ['"]\.\/(snippets\/[^'"]+)['"]/g)].map(m => m[1]);
    assert.ok(snippets.length > 0);
    for (const snippet of snippets) {
      const resource = await fetch(base + 'pkg/' + snippet);
      assert.equal(resource.status, 200, snippet);
      const text = await resource.text();
      if (snippet.endsWith('op_ck_bridge.js')) assert.ok(text.includes(`${canvasPrefix(launch.sessionId)}canvaskit/canvaskit.js`));
    }
    for (const resource of ['pkg/op_host_web_bg.wasm','canvaskit/canvaskit.js','canvaskit/canvaskit.wasm','pkg/assets/fonts/Inter-VF.ttf','assets/iconify-catalog-brands.json']) {
      const response = await fetch(base + resource);
      assert.equal(response.status, 200, resource);
      if (resource.endsWith('.wasm')) assert.equal(response.headers.get('content-type'), 'application/wasm');
      await response.body.cancel();
    }
    const snapshot = await (await fetch(base + 'api/mcp/document')).json();
    assert.ok(snapshot.document);
    const changed = JSON.parse(JSON.stringify(snapshot.document).replace('代理测试', '代理修改'));
    const browser = studio.browser(launch.sessionId).browser;
    browser.command = {id:'pending-snapshot-push',type:'checkpoint'};
    const synchronized = await fetch(base + 'api/mcp/document', {
      method:'POST', headers:{origin:host.origin, 'content-type':'application/json'},
      body:JSON.stringify({document:changed,baseVersion:snapshot.version,activePageIndex:0,preserveAuthoredGeometry:false,sourceClientId:'proxy-test'}),
    });
    assert.equal(synchronized.status, 200, await synchronized.text());
    delete browser.command;
    const readBack = await (await fetch(base + 'api/mcp/document')).json();
    assert.ok(JSON.stringify(readBack.document).includes('代理修改'));
    assert.equal(await readFile(path, 'utf8'), sourceBefore);
    studio.report(launch.sessionId, {dirty:true,phase:'ready',generation:1,revision:1,sequence:1});
    await assert.rejects(studio.call(path, 'owner', 'update_node', {nodeId:'n1',name:'不得覆盖用户画布'}), error => error.code === 'UNSAVED_USER_CHANGES');
    const selection = await fetch(base + 'api/mcp/selection', { method:'POST', headers:{origin:host.origin,'content-type':'application/json'}, body:JSON.stringify({selectedIds:['n1'],activePageId:snapshot.document.pages?.[0]?.id}) });
    assert.equal(selection.status, 200);
    assert.deepEqual((await (await fetch(base + 'api/mcp/selection')).json()).selectedIds, ['n1']);
    const events = await fetch(base + 'api/mcp/events', { signal: AbortSignal.timeout(5000) });
    assert.equal(events.status, 200);
    assert.ok(events.headers.get('content-type').includes('text/event-stream'));
    await events.body.cancel();
    await studio.closeBrowser(launch.sessionId);
    assert.equal((await (await fetch(url)).json()).code, 'EDITOR_NOT_FOUND');
  } finally { await studio.dispose(); await close(host.server); }
});
