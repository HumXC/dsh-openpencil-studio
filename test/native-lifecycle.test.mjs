import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Studio } from "../lib/studio.js";

test("real native geometry repair covers inactive pages; canvas failure and retained recovery remain usable", async () => {
  const root = await mkdtemp(join(tmpdir(), "studio-lifecycle-"));
  const path = join(root, "software.op");
  const owner = "lifecycle-owner";
  const studio = new Studio(
    async (p) => p,
    join(root, "state"),
    "http://127.0.0.1:3080",
  );
  let timer;
  try {
    await studio.create(path, owner);
    await studio.call(path, owner, "batch_design", {
      script:
        'const f=I(null,{type:"frame",name:"Small board",width:320,height:80,layout:"vertical",padding:12,fill:[{type:"solid",color:"#111111"}]});I(f,{type:"rectangle",name:"Oversized content",width:200,height:140});I(f,{type:"text",name:"Intentional low contrast",content:"Quiet",fontSize:19,width:280,height:32,fill:[{type:"solid",color:"#111111"}]});',
    });
    let validation = await studio.validate(path, owner);
    assert.equal(validation.valid, false);
    await assert.rejects(
      studio.save(path, owner),
      (e) => e.code === "VALIDATION_REQUIRED",
    );
    for (const t of validation.repairTargets.filter((t) => t.blocking)) {
      assert.ok(t.patch);
      await studio.call(path, owner, "update_node", {
        nodeId: t.nodeId,
        data: t.patch,
      });
    }
    await studio.save(path, owner);
    let doc = JSON.parse(await readFile(path, "utf8"));
    const quiet = doc.children[0].children.find(
      (n) => n.name === "Intentional low contrast",
    );
    assert.equal(quiet.fontSize, 19);
    assert.ok(JSON.stringify(quiet).includes("#111111"));
    await studio.call(path, owner, "add_page", {
      name: "Second page",
      children: [],
    });
    await studio.call(path, owner, "set_active_page", { index: "1" });
    await studio.call(path, owner, "batch_design", {
      script:
        'const f=I(null,{type:"frame",name:"Second board",width:400,height:120,layout:"vertical"});I(f,{type:"rectangle",name:"Long content",width:180,height:260});',
    });
    await studio.call(path, owner, "set_active_page", { index: "0" });
    validation = await studio.validate(path, owner);
    assert.equal(validation.valid, false);
    const target = validation.repairTargets.find((t) => t.blocking && t.patch);
    assert.ok(target);
    await studio.call(path, owner, "set_active_page", { index: "1" });
    await studio.call(path, owner, "update_node", {
      nodeId: target.nodeId,
      data: target.patch,
    });
    await studio.save(path, owner);
    const preview = await studio.preview(path, owner);
    assert.equal(preview.frames.length, 2);
    const grant = await studio.grantForDocument(path, "", { sessionId: owner });
    const launch = await studio.attach(
      grant.editor.launchUrl.split("/").at(-2),
      owner,
    );
    const b = [...studio.entries.values()][0].browser;
    let seq = 1;
    let state = {
      dirty: true,
      generation: 1,
      revision: 1,
      sequence: seq,
      phase: "ready",
    };
    studio.report(launch.sessionId, state);
    doc = JSON.parse(await readFile(path, "utf8"));
    const board = doc.pages[1].children[0];
    board.name = "Retained user canvas";
    board.children.push({
      id: "user-overflow",
      type: "rectangle",
      width: 100,
      height: 40,
      y: 900,
      x: 0,
    });
    const broken = JSON.stringify(doc);
    await assert.rejects(
      studio.saveBrowser(launch.sessionId, broken, 1, 1),
      (e) =>
        e.code === "VALIDATION_REQUIRED" &&
        e.details.repairTargets.some((t) => t.nodeId),
    );
    let saving = false;
    timer = setInterval(() => {
      const c = b.command;
      if (!c) return;
      if (c.type === "save") {
        if (saving) return;
        saving = true;
        void studio.saveBrowser(launch.sessionId, broken, 1, 1).catch(() => {});
        return;
      }
      state = {
        ...state,
        sequence: ++seq,
        leaseId: c.type === "release" ? undefined : c.id,
      };
      studio.report(launch.sessionId, state, c.id);
    }, 5);
    await assert.rejects(
      studio.resolveUnsaved(path, owner, "save-user", 1),
      (e) =>
        e.code === "VALIDATION_REQUIRED" && e.details.diagnostics.length > 0,
    );
    assert.equal(b.lease, undefined);
    assert.equal(b.state.dirty, true);
    clearInterval(timer);
    timer = undefined;
    const captured = await studio.recovery(launch.sessionId, broken);
    assert.equal(captured.precise, true);
    assert.equal(
      (await studio.recoveryItem(launch.sessionId, captured.recovery.id))
        .docJson,
      broken,
    );
    await studio.closeBrowser(launch.sessionId);
    const reopened = await studio.attach(
      grant.editor.launchUrl.split("/").at(-2),
      owner,
    );
    assert.equal(reopened.recovery.id, captured.recovery.id);
    await studio.recoveryItem(reopened.sessionId, captured.recovery.id, true);
    const fallback = await studio.recovery(reopened.sessionId);
    assert.equal(fallback.recovery, undefined);
    assert.equal((await studio.recoveryItem(reopened.sessionId, captured.recovery.id)).docJson, broken);
    await studio.closeBrowser(reopened.sessionId);
    await studio.call(path, owner, "update_node", {
      nodeId: target.nodeId,
      data: { name: "Retained agent work" },
    });
    await studio.endOwner(owner);
    assert.equal(studio.entries.size, 0);
    assert.equal(studio.grants.size, 0);
    await studio.entry(path, owner);
    assert.equal((await studio.status(path, owner)).saved, false);
    const nodes = await studio.call(path, owner, "batch_get", {});
    assert.ok(JSON.stringify(nodes).includes("Retained agent work"));
  } finally {
    if (timer) clearInterval(timer);
    await studio.dispose();
  }
});
