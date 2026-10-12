import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute } from "node:path";
import { createServer } from "node:http";
import { makeAuthorizer, createTools } from "../lib/index.js";
import {
  assertNativeArguments,
  assertResourceUris,
  callNative,
} from "../lib/native.js";
import { handleStudio } from "../lib/http.js";
import { StudioError, errorResult } from "../lib/errors.js";

test("filesystem policy rejects unknown sessions, readonly writes and symlink escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-policy-"));
  const external = await mkdtemp(join(tmpdir(), "studio-external-"));
  const file = join(root, "file.op");
  const outside = join(external, "outside.op");
  await writeFile(file, "{}");
  await writeFile(outside, "{}");
  await symlink(outside, join(root, "escape.op"));
  await symlink(external, join(root, "escape-directory"));
  let mode = "workspace-write";
  const authorize = makeAuthorizer({
    sessions: { get: (id) => (id === "owner" ? { id } : undefined) },
    sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) },
    fs: {
      resolve: async (p, { cwd }) => (isAbsolute(p) ? p : join(cwd, p)),
      processPath: (p) => p,
    },
  });
  assert.equal(await authorize("file.op", "owner", false), file);
  await assert.rejects(
    authorize(file, "missing", false),
    (e) => e.code === "SESSION_NOT_FOUND",
  );
  await assert.rejects(
    authorize(join(root, "escape.op"), "owner", false),
    (e) => e.code === "OUTSIDE_WORKSPACE",
  );
  await assert.rejects(
    authorize(join(root, "escape-directory/new.op"), "owner", true, true),
    (e) => e.code === "OUTSIDE_WORKSPACE",
  );
  mode = "read-only";
  assert.equal(await authorize(file, "owner", false), file);
  await assert.rejects(
    authorize(file, "owner", true),
    (e) => e.code === "READ_ONLY",
  );
  mode = "danger-full-access";
  assert.equal(await authorize(outside, "owner", false), outside);
});
test("native parameters bind files, preserve geometry paths and do not mistake software routes for images", async () => {
  assert.throws(
    () => assertNativeArguments({ data: { filePath: "/tmp/other.op" } }),
    (e) => e.code === "PATH_ARGUMENT_FORBIDDEN",
  );
  assert.throws(
    () => assertResourceUris({ type: "image", url: "file:///tmp/private.png" }),
    (e) => e.code === "LOCAL_ASSET_UNSUPPORTED",
  );
  assert.doesNotThrow(() =>
    assertNativeArguments({
      data: { type: "path", path: "M0 0L20 20", url: "/settings" },
    }),
  );
  assert.doesNotThrow(() =>
    assertResourceUris({ type: "image", url: "data:image/png;base64,aQ==" }),
  );
  const result = await callNative({}, "get_guidelines", {});
  assert.equal(result.scope, "technical");
  assert.doesNotMatch(
    JSON.stringify(result),
    /Hero|Header|Footer|ecommerce-modern-light/,
  );
  for (const tool of createTools({})) {
    const fields = tool.parameters?.properties ?? {};
    assert.equal("sourcePath" in fields, false);
    assert.equal("directory" in fields, false);
  }
});
test("validation details cannot turn an error into success", () => {
  const r = errorResult(
    new StudioError("VALIDATION_REQUIRED", "Repair nodes", {
      ok: true,
      valid: false,
      repairTargets: [{ nodeId: "real" }],
    }),
  );
  assert.equal(r.ok, false);
  assert.equal(r.stage, "error");
  assert.equal(r.repairTargets[0].nodeId, "real");
});
test("HTTP controls reject foreign origins, editor owners and host headers before mutation", async () => {
  let calls = 0;
  const studio = {
    origin: "",
    authorize: async () => "/fixture.op",
    browser: () => ({
      entry: { path: "/fixture.op", owner: "owner" },
      browser: {},
    }),
    report: () => {
      calls++;
      return { ok: true };
    },
  };
  const server = createServer((req, res) => {
    void handleStudio(studio, req, res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  studio.origin = "http://127.0.0.1:" + server.address().port;
  try {
    const url = studio.origin + "/_dsh/openpencil-studio/editor/private/state";
    const body = {
      ownerSessionId: "other",
      state: {
        dirty: false,
        generation: 1,
        revision: 1,
        sequence: 1,
        phase: "ready",
      },
    };
    const post = (value, headers = {}) =>
      fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(value),
      });
    const foreign = await post(body, { origin: studio.origin });
    assert.equal((await foreign.json()).code, "SESSION_OWNERSHIP");
    const origin = await post(
      { ...body, ownerSessionId: "owner" },
      { origin: "https://foreign.example" },
    );
    assert.equal(origin.status, 400);
    assert.equal(calls, 0);
    const host = await post(
      { ...body, ownerSessionId: "owner" },
      { host: "foreign.example" },
    );
    assert.equal(host.status, 400);
    assert.equal(calls, 0);
    const good = await post(
      { ...body, ownerSessionId: "owner" },
      { origin: studio.origin },
    );
    assert.equal(good.status, 200);
    assert.equal(calls, 1);
  } finally {
    await new Promise((r) => server.close(r));
  }
});
