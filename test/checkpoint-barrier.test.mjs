import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Studio, hash } from "../lib/studio.js";
import { StudioError } from "../lib/errors.js";

const saved = JSON.stringify({ version: "1.0.0", children: [] });
const edited = JSON.stringify({
    version: "1.0.0",
    children: [{ id: "n1", type: "frame", name: "未保存", width: 100, height: 100, children: [] }],
});
async function fixture() {
    const root = await mkdtemp(join(tmpdir(), "studio-flush-"));
    const source = join(root, "document.op");
    await writeFile(source, saved);
    const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
    const directory = join(studio.root, hash(source + "\0owner"));
    const entry = {
        path: source,
        owner: "owner",
        directory,
        backing: join(directory, "working/document.op"),
        baseline: hash(saved),
        documentBaseline: hash(saved),
        daemon: {},
        phase: "ready",
    };
    entry.browser = {
        id: "browser",
        daemon: { baseUrl: "http://127.0.0.1:1", token: "" },
        baseline: hash(saved),
        reportedAt: Date.now(),
        needsReload: false,
        state: { dirty: true, phase: "ready", revision: 7, generation: 1, sequence: 1 },
    };
    studio.entries.set(source, entry);
    studio.snapshot = async () => ({ documentJson: edited, version: 1 });
    return { studio, entry, source, directory };
}

test("browser checkpoint timeout does not veto tool/model barriers and retains the precise unsaved snapshot", async () => {
    const { studio, entry, source, directory } = await fixture();
    await studio.recovery("browser", edited);
    const latestPath = join(directory, "recovery/latest.json");
    const latest = await readFile(latestPath, "utf8");
    studio.command = async () => {
        throw new StudioError(
            "EDITOR_UNRESPONSIVE",
            "The editor did not acknowledge the command; no file change was authorized",
        );
    };
    let dispatched = 0;
    const barrier = async () => {
        await studio.flushOwner("owner");
        dispatched++;
    };
    await barrier();
    await barrier();
    assert.equal(dispatched, 2);
    assert.equal(await readFile(entry.backing, "utf8"), edited);
    assert.equal(await readFile(source, "utf8"), saved);
    assert.equal(await readFile(latestPath, "utf8"), latest);
    assert.equal(entry.browser.state.dirty, true);
    assert.equal(entry.checkpointWarning.latestCanvasSnapshotCaptured, false);
    assert.equal(entry.checkpointWarning.browserSnapshotRetained, true);
    await assert.rejects(
        studio.call(source, "owner", "delete_selected", {}),
        (e) => e.code === "UNSAVED_USER_CHANGES",
    );
});

test("a stale canvas is skipped without waiting for a command and a later success clears the warning", async () => {
    const { studio, entry } = await fixture();
    await studio.recovery("browser", edited);
    entry.browser.reportedAt = Date.now() - 6000;
    let commands = 0;
    studio.command = async () => {
        commands++;
        return entry.browser.state;
    };
    const result = await studio.flushOwner("owner");
    assert.equal(commands, 0);
    assert.equal(result.warnings.length, 1);
    entry.browser.reportedAt = Date.now();
    const recovered = await studio.flushOwner("owner");
    assert.equal(commands, 1);
    assert.deepEqual(recovered.warnings, []);
    assert.equal(entry.checkpointWarning, undefined);
    assert.equal(entry.browser.state.dirty, true);
});

test("unreachable browser with no precise snapshot retains the working copy and reports the missing latest canvas", async () => {
    const { studio, entry } = await fixture();
    entry.browser.reportedAt = 0;
    const result = await studio.flushOwner("owner");
    assert.equal(result.warnings[0].capture, "unavailable");
    assert.equal(result.warnings[0].browserSnapshotRetained, false);
    assert.equal(await readFile(entry.backing, "utf8"), edited);
    assert.equal(entry.browser.state.dirty, true);
});

test("precise recovery disk failure cannot be hidden by a client command failure and an older good snapshot", async () => {
    const { studio, entry, directory } = await fixture();
    await studio.recovery("browser", edited);
    const latestPath = join(directory, "recovery/latest.json");
    const before = await readFile(latestPath, "utf8");
    const diskError = Object.assign(new Error("Recovery storage is full"), { code: "ENOSPC" });
    studio.captureRecovery = async () => {
        throw diskError;
    };
    studio.command = async (browser) => {
        browser.command = { id: "checkpoint-disk-error", type: "checkpoint" };
        await assert.rejects(studio.recovery(browser.id, edited), (error) => error === diskError);
        delete browser.command;
        throw new StudioError("EDITOR_COMMAND_FAILED", "Recovery storage is full");
    };
    await assert.rejects(studio.flushOwner("owner"), (error) => error === diskError);
    assert.equal(await readFile(latestPath, "utf8"), before);
    assert.equal(entry.browser.state.dirty, true);
    assert.equal(entry.checkpointWarning, undefined);
    studio.command = async () => {
        throw new StudioError("EDITOR_UNRESPONSIVE", "disconnected");
    };
    assert.equal((await studio.flushOwner("owner")).warnings[0].capture, "retained");
});

test("working checkpoint and recovery metadata failures still reject the durability barrier", async () => {
    const { studio, entry, directory } = await fixture();
    await mkdir(entry.backing, { recursive: true });
    await assert.rejects(studio.flushOwner("owner"), (e) => e.code === "EISDIR");
    const second = await fixture();
    await mkdir(join(second.directory, "recovery"), { recursive: true });
    await writeFile(join(second.directory, "recovery/latest.json"), "{invalid");
    second.entry.browser.reportedAt = 0;
    await assert.rejects(
        second.studio.flushOwner("owner"),
        (e) => e.code === "RECOVERY_METADATA_INVALID",
    );
    assert.equal(second.entry.browser.state.dirty, true);
});

test("invalid precise canvas content warns repeatedly without replacing the last good snapshot", async () => {
    const { studio, entry, directory, source } = await fixture();
    const retained = await studio.recovery("browser", edited);
    const latestPath = join(directory, "recovery/latest.json");
    const before = await readFile(latestPath, "utf8");
    const badImage = JSON.stringify({
        version: "0.8.5",
        children: [{ id: "bad-image", type: "image", src: "op-image:missing" }],
    });
    for (const [text, code] of [
        [badImage, "INVALID_IMAGE_REFERENCE"],
        [badImage, "INVALID_IMAGE_REFERENCE"],
        ["{invalid", "INVALID_DOCUMENT_JSON"],
        ["{}", "INVALID_DOCUMENT"],
        [" ".repeat(16 * 1024 * 1024 + 1), "DOCUMENT_TOO_LARGE"],
        [
            JSON.stringify({
                version: "0.8.5",
                children: [{ id: "local", type: "image", src: "blob:private" }],
            }),
            "LOCAL_ASSET_UNSUPPORTED",
        ],
        [
            JSON.stringify({ version: "0.8.5", children: [], images: { bad: "op-image:bad" } }),
            "INVALID_IMAGE_TABLE",
        ],
    ]) {
        studio.command = async (browser) => {
            browser.command = { id: "invalid-content", type: "checkpoint" };
            await assert.rejects(studio.recovery(browser.id, text), (error) => error.code === code);
            delete browser.command;
            throw new StudioError("EDITOR_COMMAND_FAILED", "Generic client failure");
        };
        const result = await studio.flushOwner("owner");
        const warning = result.warnings[0];
        assert.equal(warning.code, "EDITOR_CHECKPOINT_INVALID");
        assert.equal(warning.diagnostic.code, code);
        assert.notEqual(warning.error, "Generic client failure");
        assert.equal(warning.capture, "retained");
        assert.equal(warning.latestCanvasSnapshotCaptured, false);
        assert.equal(warning.browserSnapshotRetained, true);
        assert.equal(warning.workingCheckpointRetained, true);
        assert.equal(entry.browser.state.dirty, true);
        assert.equal(entry.browser.checkpointFailure, undefined);
        assert.equal(await readFile(latestPath, "utf8"), before);
        assert.equal(await readFile(retained.path, "utf8"), edited);
        assert.equal(await readFile(entry.backing, "utf8"), edited);
        assert.equal(await readFile(source, "utf8"), saved);
    }
    studio.command = async (browser) => {
        browser.command = { id: "valid-again", type: "checkpoint" };
        await studio.recovery(browser.id, edited);
        delete browser.command;
    };
    assert.deepEqual((await studio.flushOwner("owner")).warnings, []);
    assert.equal(entry.checkpointWarning, undefined);
});

test("compact image snapshots pass the flush barrier and remain compact in precise recovery", async () => {
    const { studio, entry, directory } = await fixture();
    const payload = "data:image/png;base64," + "A".repeat(4096);
    const compact = JSON.stringify({
        version: "0.8.5",
        children: [{ id: "image", type: "image", src: "op-image:paint" }],
        images: { paint: payload },
    });
    studio.command = async (browser) => {
        browser.command = { id: "compact-image", type: "checkpoint" };
        await studio.recovery(browser.id, compact);
        delete browser.command;
    };
    assert.deepEqual((await studio.flushOwner("owner")).warnings, []);
    const latest = JSON.parse(await readFile(join(directory, "recovery/latest.json"), "utf8"));
    assert.equal(latest.precise, true);
    assert.equal((await studio.recoveryItem("browser", latest.id)).docJson, compact);
    assert.equal(entry.browser.state.dirty, true);
});

test("invalid content without a prior snapshot reports that the latest canvas is not backed up", async () => {
    const { studio, entry } = await fixture();
    studio.command = async (browser) => {
        browser.command = { id: "invalid-without-backup", type: "checkpoint" };
        await assert.rejects(
            studio.recovery(browser.id, "{}"),
            (error) => error.code === "INVALID_DOCUMENT",
        );
        delete browser.command;
        throw new StudioError("EDITOR_COMMAND_FAILED", "Generic client failure");
    };
    const {
        warnings: [warning],
    } = await studio.flushOwner("owner");
    assert.equal(warning.code, "EDITOR_CHECKPOINT_INVALID");
    assert.equal(warning.capture, "unavailable");
    assert.equal(warning.browserSnapshotRetained, false);
    assert.equal(warning.latestCanvasSnapshotCaptured, false);
    assert.equal(await readFile(entry.backing, "utf8"), edited);
    assert.equal(entry.browser.state.dirty, true);
});

test("recovery metadata failure during a precise callback is never downgraded to content failure", async () => {
    const { studio, directory } = await fixture();
    await studio.recovery("browser", edited);
    await writeFile(join(directory, "recovery/latest.json"), "{invalid");
    studio.command = async (browser) => {
        browser.command = { id: "corrupt-metadata", type: "checkpoint" };
        await assert.rejects(
            studio.recovery(browser.id, edited),
            (error) => error.code === "RECOVERY_METADATA_INVALID",
        );
        delete browser.command;
        throw new StudioError("EDITOR_COMMAND_FAILED", "Generic client failure");
    };
    await assert.rejects(
        studio.flushOwner("owner"),
        (error) => error.code === "RECOVERY_METADATA_INVALID",
    );
});
