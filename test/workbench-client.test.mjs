import { test } from "node:test";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { createElement, useEffect, act } from "react";
import { createRoot } from "react-dom/client";
import { apply } from "../lib/workbench/client.js";
import { getBridge, RUNTIME_EVENT } from "../lib/workbench/contracts.js";

// Migrated editor parking and close controls; Studio owns its existing 32px toolbar.
test("Studio toolbar and iframe survive conversation switches; close guards and HMR preserve ownership", async t => {
  const window = new Window({ url: "http://127.0.0.1:3080" });
  const keys = ["window", "document", "HTMLElement", "ResizeObserver", "Event", "IS_REACT_ACT_ENVIRONMENT", "fetch"];
  const originals = new Map(keys.map(key => [key, globalThis[key]]));
  t.after(async () => { await window.happyDOM.close(); for (const [key, value] of originals) { if (value === undefined) delete globalThis[key]; else globalThis[key] = value; } });
  for (const key of keys.slice(0, 5)) globalThis[key] = key === "window" ? window : window[key];
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  let fetches = 0;
  globalThis.fetch = async () => { fetches++; throw new Error("unexpected automatic open"); };
  window.HTMLElement.prototype.getBoundingClientRect = () => ({ left: 120, top: 64, width: 900, height: 650 });
  const views = [], disposers = [];
  let mounts = 0, unmounts = 0, closeCalls = 0, closeFailure = false, waitForClose = false, finishClose, lifecycleUpdate, recoveries = 0;
  const Editor = ({ grant, workbenchActions, onLifecycleState, onLifecycleController }) => {
    useEffect(() => {
      mounts++; lifecycleUpdate = onLifecycleState; onLifecycleState({ phase: "ready", dirty: false });
      onLifecycleController({ requestClose: async () => {
        closeCalls++;
        if (closeFailure) return false;
        if (waitForClose) await new Promise(resolve => { finishClose = resolve; });
        return true;
      }, captureRecovery: async () => { recoveries++; return true; }, retainServerSessionOnUnmount() {} });
      return () => { unmounts++; onLifecycleController(undefined); };
    }, []);
    return createElement("section", null,
      createElement("div", { className: "dsh-openpencil-studio-toolbar", style: { height: 32, minHeight: 32, padding: "0 10px", gap: 8 } },
        createElement("strong", null, grant.sourcePath.split("/").at(-1)), createElement("button", null, "保存"), workbenchActions),
      createElement("iframe", { title: "test editor", src: "about:blank" }));
  };
  const runtime = { Editor, key: (grant, session) => grant.sourcePath + session, preserve: async (state, controller) => { if (state.dirty) await controller.captureRecovery(); return "preserved"; }, locale: value => value,
    options: { subscribeTheme: () => () => {}, getColorScheme: () => "dark", subscribeLocale: () => () => {}, getLocale: () => "zh-CN" } };
  const bridge = getBridge(), originalRuntime = bridge.runtime;
  t.after(() => { if (originalRuntime) bridge.runtime = originalRuntime; else delete bridge.runtime; });
  bridge.runtime = runtime;
  const ctx = { inject: () => ({ dispose: async () => {} }), effect: fn => disposers.push(fn()),
    slots: { entries: () => [], subscribe: () => () => {}, inject: (_name, fn) => fn(), register: (_options, component) => { views.push(component); return () => {}; } } };
  await act(async () => { apply(ctx); });
  const View = views.at(-1), surface = document.createElement("main"); document.body.append(surface);
  const seatRoot = createRoot(surface), props = { sessionId: "s", completeViewRequest() {} };
  await act(async () => { seatRoot.render(createElement(View, props)); await bridge.handler.open({ grant: { sourcePath: "/test/a.op" }, sessionId: "s" }, true); });
  const iframe = document.querySelector("iframe"), parent = iframe.parentNode, parking = document.querySelector("[data-openpencil-studio-parking]");
  const button = label => [...document.querySelectorAll("button")].find(node => node.textContent === label);
  assert.equal(mounts, 1); assert.equal(parking.style.display, "flex");
  assert.equal(document.querySelector("strong").textContent, "a.op"); assert.ok(button("保存")); assert.ok(button("关闭"));
  assert.equal(window.getComputedStyle(document.querySelector(".dsh-openpencil-studio-toolbar")).height, "32px");
  assert.equal(document.querySelector("select"), null);
  await act(async () => { seatRoot.render(null); });
  assert.equal(parking.style.display, "none"); assert.equal(unmounts, 0);
  await act(async () => { seatRoot.render(createElement(View, { ...props, sessionId: "other" })); });
  assert.equal(parking.style.display, "none");
  await act(async () => { seatRoot.render(createElement(View, props)); });
  assert.equal(document.querySelector("iframe"), iframe); assert.equal(iframe.parentNode, parent); assert.equal(parking.style.display, "flex");
  await act(async () => { lifecycleUpdate({ phase: "saving", dirty: true }); });
  assert.equal(button("关闭").disabled, true);
  await act(async () => { button("关闭").click(); }); assert.equal(closeCalls, 0);
  await act(async () => { lifecycleUpdate({ phase: "ready", dirty: false }); }); assert.equal(button("关闭").disabled, false);
  closeFailure = true;
  await act(async () => { button("关闭").click(); }); assert.equal(closeCalls, 1); assert.equal(document.querySelector("iframe"), iframe);
  closeFailure = false; waitForClose = true;
  await act(async () => { button("关闭").click(); }); assert.equal(button("正在关闭…").disabled, true); assert.equal(closeCalls, 2);
  await act(async () => { finishClose(); });
  assert.equal(document.querySelector("iframe"), null); assert.equal(parking.style.display, "none"); assert.equal(unmounts, 1);
  await act(async () => { await bridge.handler.open({ grant: { sourcePath: "/test/a.op" }, sessionId: "s" }, false); });
  assert.equal(mounts, 2); assert.notEqual(document.querySelector("iframe"), iframe);
  await act(async () => { lifecycleUpdate({ phase: "ready", dirty: true }); await bridge.handler.dispose(); });
  assert.equal(recoveries, 1); assert.equal(unmounts, 2);
  // Runtime arrival can render the RecentDocuments view, but never opens a remembered file.
  delete bridge.runtime;
  await act(async () => { window.dispatchEvent(new Event(RUNTIME_EVENT)); });
  bridge.runtime = runtime;
  await act(async () => { window.dispatchEvent(new Event(RUNTIME_EVENT)); seatRoot.render(null); });
  await act(async () => { seatRoot.render(createElement(View, props)); });
  assert.equal(fetches, 0); assert.equal(mounts, 2); assert.equal(document.querySelector("iframe"), null);
  await act(async () => { for (const dispose of disposers.reverse()) await dispose(); seatRoot.unmount(); });
  assert.equal(document.querySelector("[data-openpencil-studio-parking]"), null); assert.equal(bridge.handler, undefined);
});
