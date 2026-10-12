import test from "node:test";
import assert from "node:assert/strict";
import { Context } from "@deepseek-ai/cordis";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as entry from "../lib/index.js";

test("real Cordis entry owns Studio tools, file navigation routes and releases ownership", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-entry-"));
  const ctx = new Context();
  const tools = new Map(),
    routes = new Set(),
    sections = new Set();
  ctx.provide("fs", {
    resolve: async (p, { cwd }) => resolve(cwd, p),
    processPath: (p) => p,
  });
  ctx.provide("sessions", {
    get: (id) => (id === "entry-owner" ? { id } : undefined),
  });
  ctx.provide("sandboxPolicy", {
    resolve: () => ({ mode: "workspace-write", workspaceRoot: root }),
  });
  ctx.provide("tools", {
    register: (tool) => {
      tools.set(tool.name, tool);
      return () => tools.delete(tool.name);
    },
  });
  ctx.provide("webServer", {
    port: 3080,
    register: (route) => {
      routes.add(route);
      return () => routes.delete(route);
    },
  });
  ctx.provide("systemPrompt", {
    section: (section) => {
      sections.add(section);
      return () => sections.delete(section);
    },
  });
  let fiber;
  try {
    fiber = await ctx.plugin(entry, { stateDirectory: join(root, "state") });
    await new Promise(setImmediate);
    assert.ok(tools.size > 100);
    assert.ok([...tools.keys()].every((n) => n.startsWith("pencil_")));
    assert.equal(ctx.get("openpencilStudioHost").version, 1);
    assert.equal(ctx.get("openpencilWorkspaceHost"), undefined);
    assert.equal(routes.size, 2);
    assert.ok([...routes].some(route => route.kind === "exact" && route.path === "/_dsh/openpencil-studio/open"));
    assert.ok([...routes].some(route => route.kind === "prefix" && route.path === "/_dsh/openpencil-studio"));
    assert.equal(sections.size, 1);
    assert.doesNotMatch([...sections][0].text(), /Header|Hero|Footer/);
    const created = await tools
      .get("pencil_create")
      .execute(
        { path: join(root, "entry.op") },
        { agent: { id: "entry-owner" }, signal: new AbortController().signal },
      );
    assert.equal(created.ok, true, JSON.stringify(created));
    await fiber.dispose();
    fiber = undefined;
    assert.equal(tools.size, 0);
    assert.equal(routes.size, 0);
    assert.equal(sections.size, 0);
    assert.equal(ctx.get("openpencilStudioHost"), undefined);
    ctx.provide("openpencilStudioHost", { version: 1 });
    await assert.rejects(
      async () =>
        await ctx.plugin(entry, { stateDirectory: join(root, "conflict") }),
      (e) => e.code === "HOST_CONFLICT",
    );
  } finally {
    if (fiber) await fiber.dispose();
    await ctx.fiber.dispose();
  }
});
