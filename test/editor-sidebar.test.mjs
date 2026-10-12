import test from 'node:test';
import assert from 'node:assert/strict';
import { editorSidebarOpen, observeEditorSidebar, toggleEditorSidebar } from '../lib/editor-sidebar.js';

// Narrow native DOM/event ports. These checks exercise command forwarding and
// acknowledgement; they do not render or stand in for browser visual acceptance.
function nativeFixture() {
  const observers = new Set(), events = [], timers = new Map(), listeners = new Map();
  let open = true, ready = true, changeOnPress = true, timerId = 0;
  class Observer {
    constructor(callback) { this.callback = callback; }
    observe() { observers.add(this); }
    disconnect() { observers.delete(this); }
  }
  class MouseEvent {
    constructor(type, options) { this.type = type; Object.assign(this, options); }
  }
  const repaint = () => { for (const observer of [...observers]) observer.callback(); };
  const mirror = { querySelector: selector => selector.includes('5000') ? (ready ? {} : null) : (open ? {} : null) };
  const canvas = {
    tagName: 'CANVAS', getBoundingClientRect: () => ({left: 0, top: -40, width: 900, height: 700}),
    dispatchEvent(event) {
      events.push(event);
      if (event.type === 'mousedown' && changeOnPress) {
        open = !open;
        queueMicrotask(repaint);
      }
      return true;
    },
  };
  const document = { getElementById: id => id === 'op' ? canvas : mirror, body: {} };
  document.defaultView = {
    MutationObserver: Observer, MouseEvent,
    setTimeout: callback => { timers.set(++timerId, callback); return timerId; },
    clearTimeout: id => timers.delete(id),
  };
  const frame = {
    contentDocument: document,
    addEventListener(type, callback) { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type).add(callback); },
    removeEventListener(type, callback) { listeners.get(type)?.delete(callback); },
  };
  return {
    frame, events, observers, timers, repaint,
    setReady(value) { ready = value; }, setOpen(value) { open = value; },
    ignorePress() { changeOnPress = false; },
    timeout() { for (const callback of [...timers.values()]) callback(); },
    reload() { for (const callback of [...listeners.get('load') ?? []]) callback(); },
  };
}

test('sidebar readiness and open state come from native accessibility regions', () => {
  const native = nativeFixture();
  assert.equal(editorSidebarOpen(native.frame), true);
  native.setOpen(false);
  assert.equal(editorSidebarOpen(native.frame), false);
  native.setReady(false);
  assert.equal(editorSidebarOpen(native.frame), undefined);
  assert.equal(editorSidebarOpen({get contentDocument() {throw Error('cross origin');}}), undefined);
});

test('button forwards a press and release at the verified native hit target, including the clipped bar', async () => {
  const native = nativeFixture();
  assert.equal(await toggleEditorSidebar(native.frame), false);
  assert.equal(editorSidebarOpen(native.frame), false);
  assert.equal(await toggleEditorSidebar(native.frame), true);
  assert.deepEqual(native.events.map(event => [event.type,event.offsetX,event.offsetY,event.button,event.buttons]), [
    ['mousedown',26,22,0,1],['mouseup',26,22,0,0],['mousedown',26,22,0,1],['mouseup',26,22,0,0],
  ]);
  assert.equal(native.events[0].clientY, -18);
  assert.equal(native.events[0].bubbles, true);
  assert.equal(native.observers.size, 0);
  assert.equal(native.timers.size, 0);
});

test('native ignoring the action never produces an optimistic success', async () => {
  const native = nativeFixture(); native.ignorePress();
  const action = toggleEditorSidebar(native.frame);
  const rejected = assert.rejects(action, /Native sidebar did not change/);
  native.timeout(); await rejected;
  assert.equal(editorSidebarOpen(native.frame), true);
  assert.equal(native.observers.size, 0);
  assert.equal(native.timers.size, 0);
});

test('abort and iframe reload cancel pending actions and release their observers', async () => {
  for (const reload of [false,true]) {
    const native = nativeFixture(); native.ignorePress();
    const controller = new AbortController();
    const action = toggleEditorSidebar(native.frame, controller.signal);
    const rejected = assert.rejects(action, reload ? /Editor changed/ : /cancelled/);
    if (reload) native.reload(); else controller.abort();
    await rejected;
    assert.equal(native.observers.size, 0); assert.equal(native.timers.size, 0);
  }
});

test('observer follows actual sidebar changes and reconnects after reload', () => {
  const native = nativeFixture(), values = [];
  const stop = observeEditorSidebar(native.frame, value => values.push(value));
  native.repaint(); native.setOpen(false); native.repaint(); native.repaint();
  native.setReady(false); native.reload(); native.setReady(true); native.repaint();
  assert.deepEqual(values, [true,false,undefined,false]);
  stop(); native.setOpen(true); native.repaint();
  assert.deepEqual(values, [true,false,undefined,false]);
  assert.equal(native.observers.size, 0);
});

test('unready and already cancelled frames never receive native events', async () => {
  const native = nativeFixture(); native.setReady(false);
  await assert.rejects(toggleEditorSidebar(native.frame), /not ready/);
  native.setReady(true);
  const controller = new AbortController(); controller.abort();
  await assert.rejects(toggleEditorSidebar(native.frame, controller.signal), /cancelled/);
  assert.equal(native.events.length, 0);
});
