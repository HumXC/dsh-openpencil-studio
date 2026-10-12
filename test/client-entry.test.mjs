import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { act } from "react";

test("Studio client owns its workbench without a separate workspace module", async () => {
  const window = new Window({ url: "http://127.0.0.1:3080" });
  const names = ["window", "document", "navigator", "HTMLElement", "ResizeObserver", "Event", "IS_REACT_ACT_ENVIRONMENT"];
  const previous = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  names.forEach(name => Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? window : name === "IS_REACT_ACT_ENVIRONMENT" ? true : window[name] }));
  const require = createRequire(import.meta.url), modules = [], registrations = [], cleanup = [];
  window.__ModuleLoader__ = { load({ id, factory }) { modules.push(id); window.studio = factory(name => {
    assert.ok(name === "react" || name.startsWith("react/" ) || name.startsWith("react-dom/"), `Unexpected external dependency: ${name}`);
    return require(name);
  }); } };
  const ctx = {
    theme: { getSnapshot: () => "light", subscribe: () => () => {} },
    locale: { getSnapshot: () => "zh-CN", subscribe: () => () => {} },
    effect(fn) { cleanup.push(fn()); },
    inject() { return { dispose() {} }; },
    slots: {
      subscribe() { return () => {}; },
      entries() { return []; },
      inject(_name, fn) { return fn(); },
      register(entry) { registrations.push(entry); return () => {}; },
    },
  };
  try {
    runInNewContext(await readFile(new URL("../lib/client.js", import.meta.url), "utf8"), { window, globalThis: window, document: window.document, Event: window.Event, ResizeObserver: window.ResizeObserver, console, setTimeout, clearTimeout });
    await act(async () => window.studio.apply(ctx));
    assert.deepEqual(modules, ["dsh-openpencil-studio"]);
    assert.ok(window.__DSH_OPENPENCIL_STUDIO_V1__.handler);
    assert.ok(window.__DSH_OPENPENCIL_STUDIO_V1__.runtime);
    assert.equal(window.__DSH_OPENPENCIL_WORKSPACE_V1__, undefined);
    assert.equal(registrations.filter(entry => entry.name === "conversation.view" && entry.label === "OpenPencil").length, 1);
    assert.equal(window.document.querySelectorAll("[data-openpencil-studio-parking]").length, 1);
  } finally {
    await act(async () => {
      for (const fn of cleanup.reverse()) if (typeof fn === "function") await fn();
    });
    await window.happyDOM.close();
    names.forEach((name, i) => previous[i] ? Object.defineProperty(globalThis, name, previous[i]) : delete globalThis[name]);
  }
});
