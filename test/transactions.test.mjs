import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, readdir, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Studio, atomicWrite, hash } from "../lib/studio.js";
import { removePreviewDirectory, renderPages } from "../lib/preview.js";

const documentJson = JSON.stringify({ version: "1.0.0", children: [] });
const deferred = () => {
    let resolve;
    const promise = new Promise((r) => {
        resolve = r;
    });
    return { promise, resolve };
};
const turn = () => new Promise((r) => setImmediate(r));
const stoppedDaemon = () => ({ child: { exitCode: 0, signalCode: null } });
async function fixture(owner = "owner") {
    const root = await mkdtemp(join(tmpdir(), "studio-transactions-"));
    const path = join(root, "document.op");
    await writeFile(path, documentJson);
    const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
    const directory = join(studio.root, hash(path + "\0" + owner));
    const entry = {
        path,
        owner,
        directory,
        backing: join(directory, "working/document.op"),
        baseline: hash(documentJson),
        documentBaseline: hash(documentJson),
        phase: "ready",
        daemon: stoppedDaemon(),
    };
    studio.entries.set(path, entry);
    studio.snapshot = async () => ({ documentJson, version: 1 });
    return { root, path, studio, entry, owner };
}

test("concurrent attachments share one browser daemon and failed launches release registration", async () => {
    const { studio, path, owner, entry } = await fixture();
    studio.grants.set("grant", { path, owner });
    let starts = 0;
    studio.start = async () => {
        starts++;
        await turn();
        return stoppedDaemon();
    };
    studio.launchResult = async (_e, b) => ({ sessionId: b.id });
    const results = await Promise.all([
        studio.attach("grant", owner),
        studio.attach("grant", owner),
    ]);
    assert.equal(starts, 1);
    assert.equal(results[0].sessionId, results[1].sessionId);
    await studio.closeBrowser(results[0].sessionId);
    studio.launchResult = async () => {
        throw new Error("launch failed");
    };
    await assert.rejects(studio.attach("grant", owner), /launch failed/);
    assert.equal(entry.browser, undefined);
    await studio.dispose();
});

test("validation, native reads and close wait for the document transaction", async () => {
    const { studio, path, owner } = await fixture();
    const gate = deferred(),
        entered = deferred();
    const held = studio.serial(path, async () => {
        entered.resolve();
        await gate.promise;
    });
    await entered.promise;
    let checked = false,
        read = false;
    studio.validation = async () => {
        checked = true;
        return { valid: true };
    };
    const validation = studio.validate(path, owner);
    const reading = studio.call(path, owner, "get_guidelines", {}).then(() => {
        read = true;
    });
    await turn();
    assert.equal(checked, false);
    assert.equal(read, false);
    gate.resolve();
    await Promise.all([held, validation, reading]);
    assert.equal(checked, true);
    assert.equal(read, true);
    const closing = studio.close(path, owner);
    const lateValidation = studio.validate(path, owner);
    await closing;
    await assert.rejects(lateValidation, (e) => e.code === "DOCUMENT_CLOSED");
    assert.equal(studio.entries.size, 0);
    await studio.dispose();
});

test("queued close checks the current dirty canvas after an earlier transaction finishes", async () => {
    const { studio, path, owner, entry } = await fixture();
    entry.browser = {
        id: "browser",
        daemon: stoppedDaemon(),
        state: { dirty: false, revision: 4 },
    };
    const gate = deferred(),
        entered = deferred();
    const held = studio.serial(path, async () => {
        entered.resolve();
        await gate.promise;
    });
    await entered.promise;
    const closing = studio.close(path, owner);
    await turn();
    entry.browser.state.dirty = true;
    gate.resolve();
    await held;
    await assert.rejects(
        closing,
        (e) => e.code === "UNSAVED_USER_CHANGES" && e.details.editorRevision === 4,
    );
    assert.equal(studio.entries.get(path), entry);
    entry.browser.state.dirty = false;
    await studio.dispose();
});

test("dispose attempts every owner and removes previews while retaining working checkpoints", async () => {
    const { studio, path, owner, entry } = await fixture("first");
    const secondPath = join(entry.directory, "second.op");
    const second = {
        ...entry,
        path: secondPath,
        owner: "second",
        directory: join(studio.root, hash(secondPath + "\0second")),
    };
    second.backing = join(second.directory, "working/document.op");
    studio.entries.set(secondPath, second);
    const previewRoot = join(entry.directory, "previews");
    const folder = join(previewRoot, "preview-owned");
    await mkdir(folder, { recursive: true });
    const image = join(folder, "page.png");
    await writeFile(image, "preview");
    studio.previews.set("preview", { path: image, sourcePath: path, owner });
    studio.grants.set("first-grant", { path, owner });
    studio.grants.set("second-grant", { path: secondPath, owner: "second" });
    const visited = [];
    studio.snapshot = async (e) => {
        visited.push(e.owner);
        if (e.owner === "first") throw new Error("checkpoint failure");
        return { documentJson, version: 1 };
    };
    await assert.rejects(
        studio.dispose(),
        (e) =>
            e.code === "STUDIO_CLEANUP_PARTIAL" &&
            e.details.diagnostics.some((d) => d.includes("Session registrations were released")),
    );
    assert.deepEqual(new Set(visited), new Set(["first", "second"]));
    assert.equal(studio.entries.size, 0);
    assert.equal(studio.grants.size, 0);
    assert.equal(studio.previews.size, 0);
    assert.deepEqual(await readdir(previewRoot), []);
    assert.equal(await readFile(second.backing, "utf8"), documentJson);
    await assert.rejects(studio.entry(path, owner), (e) => e.code === "SESSION_CLOSED");
});

test("owner cleanup joins an in-progress open and prevents its late daemon registration", async () => {
    const { studio, path, owner } = await fixture();
    studio.entries.delete(path);
    const started = deferred(),
        finishStart = deferred();
    let stopChecks = 0;
    const daemon = {
        child: {
            get exitCode() {
                stopChecks++;
                return 0;
            },
            signalCode: null,
        },
    };
    studio.start = async () => {
        started.resolve();
        await finishStart.promise;
        return daemon;
    };
    const opening = studio.entry(path, owner);
    const rejected = assert.rejects(opening, (e) => e.code === "SESSION_CLOSED");
    await started.promise;
    let ended = false;
    const ending = studio.endOwner(owner).then(() => {
        ended = true;
    });
    await turn();
    assert.equal(ended, false);
    finishStart.resolve();
    await Promise.all([rejected, ending]);
    assert.ok(stopChecks > 0);
    assert.equal(studio.entries.size, 0);
    await studio.dispose();
});

test("atomic write checks the conflict guard after preparing its temporary file", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-commit-"));
    const path = join(root, "source.op");
    await writeFile(path, "original");
    await assert.rejects(
        atomicWrite(path, "new", async () => {
            assert.equal((await readdir(root)).filter((p) => p.endsWith(".tmp")).length, 1);
            await writeFile(path, "external edit");
            throw new Error("save conflict");
        }),
        /save conflict/,
    );
    assert.equal(await readFile(path, "utf8"), "external edit");
    assert.deepEqual(await readdir(root), ["source.op"]);
});

test("preview cleanup rejects sibling and symlink targets without touching checkpoints", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-preview-cleanup-"));
    const previews = join(root, "previews"),
        checkpoint = join(root, "working");
    await mkdir(previews);
    await mkdir(checkpoint);
    await writeFile(join(checkpoint, "document.op"), "retained");
    await assert.rejects(
        removePreviewDirectory(checkpoint, previews),
        (e) => e.code === "INVALID_PREVIEW_DIRECTORY",
    );
    await symlink(checkpoint, join(previews, "preview-link"));
    await assert.rejects(
        removePreviewDirectory(join(previews, "preview-link"), previews),
        (e) => e.code === "INVALID_PREVIEW_DIRECTORY",
    );
    assert.equal(await readFile(join(checkpoint, "document.op"), "utf8"), "retained");
});

test("failed native preview removes its snapshot directory", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-preview-failure-"));
    await assert.rejects(
        renderPages(JSON.parse(documentJson), root, "http://127.0.0.1:3080"),
        (e) => e.code === "NO_ARTBOARD",
    );
    assert.deepEqual(await readdir(root), []);
});
