import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, writeFile, symlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { makeAuthorizer } from "../lib/index.js";
import { grantForPath } from "../lib/file-open.js";

test("file navigation uses Studio authorization before producing an editor grant", async () => {
    const prefix = join(tmpdir(), "studio-file-open-");
    const root = await mkdtemp(prefix),
        outside = await mkdtemp(prefix);
    let mode = "workspace-write",
        calls = 0;
    const authorize = makeAuthorizer({
        sessions: { get: (id) => (id === "s" ? { id } : undefined) },
        sandboxPolicy: { resolve: () => ({ mode, workspaceRoot: root }) },
        fs: { resolve: async (path, { cwd }) => resolve(cwd, path), processPath: (path) => path },
    });
    const studio = {
        authorize,
        grantForDocument: async (path, text, owner) => {
            assert.equal(text, "");
            assert.deepEqual(owner, { sessionId: "s" });
            calls++;
            return { sourcePath: path };
        },
    };
    try {
        await writeFile(join(root, "valid.op"), "{}");
        await writeFile(join(outside, "outside.op"), "{}");
        await symlink(join(outside, "outside.op"), join(root, "link.op"));
        assert.equal(
            (await grantForPath(studio, "s", "valid.op")).sourcePath,
            join(root, "valid.op"),
        );
        await assert.rejects(grantForPath(studio, "missing", "valid.op"), {
            code: "SESSION_NOT_FOUND",
        });
        await assert.rejects(grantForPath(studio, "s", "link.op"), /outside/);
        assert.equal(calls, 1);
        mode = "read-only";
        await assert.rejects(grantForPath(studio, "s", "valid.op"), { code: "READ_ONLY" });
        assert.equal(calls, 1);
        mode = "danger-full-access";
        assert.equal(
            (await grantForPath(studio, "s", join(outside, "outside.op"))).sourcePath,
            join(outside, "outside.op"),
        );
        assert.equal(calls, 2);
    } finally {
        for (const path of [root, outside]) {
            assert.equal(resolve(path), path);
            assert.ok(path.startsWith(prefix));
            await rm(path, { recursive: true, force: true });
        }
    }
});

test("file navigation refuses remote, NUL and non-document paths before authorization", async () => {
    let calls = 0;
    const studio = {
        authorize: async (path) => {
            calls++;
            return path;
        },
        grantForDocument: async () => {
            throw Error("must not grant");
        },
    };
    for (const path of ["", "https://example.com/a.op", "file:///tmp/a.op", "a.op\0", "a.txt"])
        await assert.rejects(grantForPath(studio, "s", path), { code: "INVALID_PATH" });
    assert.equal(calls, 0);
});
