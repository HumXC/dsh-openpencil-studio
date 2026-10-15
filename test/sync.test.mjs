import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Studio } from "../lib/studio.js";
test("dirty revision authorization, active lease retention, canvas save synchronization and owner isolation", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-sync-test-")),
        file = join(root, "software.op"),
        owner = "sync-owner";
    const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
    let timer;
    try {
        await studio.create(file, owner);
        await studio.call(file, owner, "batch_design", {
            script: 'const f=I(null,{type:"frame",name:"Original",width:200,height:100});',
        });
        await studio.save(file, owner);
        const grant = await studio.grantForDocument(file, "", { sessionId: owner });
        const id = grant.editor.launchUrl.split("/").at(-2),
            launch = await studio.attach(id, owner);
        const b = [...studio.entries.values()][0].browser;
        let seq = 0,
            revision = 4;
        let state = {
            generation: 1,
            revision,
            dirty: true,
            phase: "ready",
            sequence: ++seq,
        };
        studio.report(launch.sessionId, state);
        await assert.rejects(
            studio.entry(file, "other-owner"),
            (e) => e.code === "SESSION_OWNERSHIP",
        );
        await assert.rejects(
            studio.call(file, owner, "update_node", {
                nodeId: "n1",
                data: { name: "Forbidden" },
            }),
            (e) => e.code === "UNSAVED_USER_CHANGES",
        );
        timer = setInterval(() => {
            const command = b.command;
            if (!command) return;
            state = {
                ...state,
                sequence: ++seq,
                ...(command.type === "lease" ? { leaseId: command.id } : {}),
                ...(command.type === "release" ? { leaseId: undefined } : {}),
            };
            studio.report(launch.sessionId, state, command.id);
        }, 5);
        await assert.rejects(
            studio.resolveUnsaved(file, owner, "edit-saved", revision - 1),
            (e) => e.code === "EDITOR_REVISION_CHANGED",
        );
        await studio.resolveUnsaved(file, owner, "edit-saved", revision);
        await studio.call(file, owner, "update_node", {
            nodeId: "n1",
            data: { name: "Authorized" },
        });
        assert.equal(b.state.dirty, true);
        await studio.save(file, owner);
        assert.equal(b.needsReload, true);
        const lease = studio.command(b, "lease");
        await lease;
        const response = studio.report(launch.sessionId, {
            ...state,
            sequence: ++seq,
        });
        assert.equal(response.activeLease, b.lease);
        await assert.rejects(
            studio.saveBrowser(launch.sessionId, await readFile(file, "utf8"), 1, revision),
            (e) => e.code === "EDITOR_WRITE_LEASE",
        );
        await studio.release(b);
        state = { ...state, revision: ++revision, sequence: ++seq };
        studio.report(launch.sessionId, state);
        await assert.rejects(
            studio.call(file, owner, "update_node", {
                nodeId: "n1",
                data: { name: "Needs new confirmation" },
            }),
            (e) => e.code === "UNSAVED_USER_CHANGES",
        );
        clearInterval(timer);
        timer = undefined;
        b.state = { ...b.state, dirty: false };
        await studio.close(file, owner);
        assert.equal(studio.entries.size, 0);
        await studio.entry(file, owner);
        const again = await studio.grantForDocument(file, "", { sessionId: owner });
        const opened = await studio.attach(again.editor.launchUrl.split("/").at(-2), owner);
        const doc = await readFile(file, "utf8");
        studio.report(opened.sessionId, {
            generation: 1,
            revision: 1,
            sequence: 1,
            dirty: true,
            phase: "ready",
        });
        const serialized = JSON.stringify(JSON.parse(doc), null, 2).replace(
            '"width": 200',
            '"width": 200.0',
        );
        await studio.saveBrowser(opened.sessionId, serialized, 1, 1);
        assert.equal((await studio.status(file, owner)).sourceChanged, false);
        assert.equal((await studio.status(file, owner)).saved, true);
    } finally {
        if (timer) clearInterval(timer);
        await studio.dispose();
    }
});

// Keep native save cases in one worker so they do not add another concurrent daemon.
test("real native compact images survive open, precise recovery, browser save and reopen", async (t) => {
    // A valid image above the native serializer's externalization threshold.
    const svg =
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><rect width="32" height="32" fill="#1264a3"/><!--' +
        " ".repeat(4096) +
        "--></svg>";
    const payload = "data:image/svg+xml;base64," + Buffer.from(svg).toString("base64");
    const compact = JSON.stringify({
        version: "0.8.5",
        children: [
            {
                id: "board",
                type: "frame",
                name: "Original",
                width: 128,
                height: 128,
                fill: [{ type: "image", url: "op-image:paint" }],
                children: [
                    { id: "bitmap", type: "image", src: "op-image:paint", width: 32, height: 32 },
                ],
            },
        ],
        images: { paint: payload },
    });
    const root = await mkdtemp(join(tmpdir(), "studio-native-images-"));
    const path = join(root, "images.op");
    const owner = "native-image-owner";
    await writeFile(path, compact);
    const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
    t.after(() => studio.dispose());
    assert.equal(
        (await studio.status(path, owner)).saved,
        true,
        "native inline representation equals compact source",
    );
    const entry = studio.entries.get(path);
    const live = JSON.parse((await studio.snapshot(entry)).documentJson);
    assert.equal(live.children[0].fill[0].url, payload);
    assert.equal(live.children[0].children[0].src, payload);

    const grant = await studio.grantForDocument(path, "", { sessionId: owner });
    const launch = await studio.attach(grant.editor.launchUrl.split("/").at(-2), owner);
    studio.report(launch.sessionId, {
        generation: 1,
        revision: 1,
        sequence: 1,
        dirty: true,
        phase: "ready",
    });
    const draft = JSON.parse(compact);
    draft.children[0].name = "Canvas edited";
    const snapshot = JSON.stringify(draft);
    const recovery = await studio.recovery(launch.sessionId, snapshot);
    assert.equal(recovery.precise, true);
    assert.equal(
        (await studio.recoveryItem(launch.sessionId, recovery.recovery.id)).docJson,
        snapshot,
    );

    assert.equal((await studio.saveBrowser(launch.sessionId, snapshot, 1, 1)).saved, true);
    const persisted = JSON.parse(await readFile(path, "utf8"));
    assert.equal(persisted.children[0].fill[0].url, "op-image:paint");
    assert.equal(persisted.children[0].children[0].src, "op-image:paint");
    assert.equal(persisted.images.paint, payload);
    assert.equal((await studio.status(path, owner)).saved, true);
    const latest = JSON.parse(
        await readFile(join(entry.directory, "recovery/latest.json"), "utf8"),
    );
    assert.equal(latest.retired, true, "saving equivalent content retires the recovery");

    studio.report(launch.sessionId, {
        generation: 1,
        revision: 1,
        sequence: 2,
        dirty: false,
        phase: "ready",
    });
    await studio.closeBrowser(launch.sessionId);
    await studio.close(path, owner);
    assert.equal((await studio.status(path, owner)).saved, true);
    const reopened = JSON.parse((await studio.snapshot(studio.entries.get(path))).documentJson);
    assert.equal(reopened.children[0].name, "Canvas edited");
    assert.equal(reopened.children[0].fill[0].url, payload);
    assert.equal(reopened.children[0].children[0].src, payload);
});
