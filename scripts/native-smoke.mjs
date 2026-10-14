import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Studio } from "../lib/studio.js";
const root = await mkdtemp(join(tmpdir(), "openpencil-studio-native-"));
const file = join(root, "software.op"),
    owner = "isolated-session";
const authorize = async (path, session) => {
    assert.equal(session, owner);
    const absolute = resolve(root, path);
    assert.ok(absolute.startsWith(root + "/"));
    return absolute;
};
let studio = new Studio(authorize, join(root, "state"), "http://127.0.0.1:3080");
const results = [];
let main, menu, modal, input;
try {
    await studio.create(file, owner);
    results.push("create");
    await assert.rejects(studio.create(file, owner), (e) => e.code === "FILE_EXISTS");
    const first = await studio.call(file, owner, "batch_design", {
        script: String.raw`const screen=I(null,{type:"frame",name:"Task software",x:0,y:0,width:1024,height:720,layout:"none",fill:[{type:"solid",color:"#F4F5F7"}]});
I(screen,{type:"text",name:"Screen title",content:"Task workspace",x:32,y:32,width:500,height:"fit_content",fontFamily:"Inter",fontSize:28,fontWeight:600,fill:[{type:"solid",color:"#172B4D"}]});
const input=I(screen,{type:"text_input",name:"Task search",x:32,y:92,width:320,height:48,placeholder:"Search tasks",fill:[{type:"solid",color:"#FFFFFF"}]});
function makeCard(parent,name,y){const card=I(parent,{type:"frame",name:name,x:32,y,width:960,height:96,layout:"vertical",padding:20,gap:8,fill:[{type:"solid",color:"#FFFFFF"}]});I(card,{type:"text",content:name,width:"fill_container",height:"fit_content",fontFamily:"Inter",fontSize:18,fill:[{type:"solid",color:"#172B4D"}]});return card;}
makeCard(screen,"Review release checklist",168);makeCard(screen,"Prepare software demonstration",280);
const menu=I(null,{type:"frame",name:"Task context menu",x:1080,y:0,width:240,height:220,layout:"vertical",gap:12,padding:20,fill:[{type:"solid",color:"#FFFFFF"}]});
I(menu,{type:"text",content:"Open task",width:"fill_container",height:"fit_content",fontFamily:"Inter",fontSize:16,fill:[{type:"solid",color:"#172B4D"}]});
I(menu,{type:"text",content:"Move to completed",width:"fill_container",height:"fit_content",fontFamily:"Inter",fontSize:16,fill:[{type:"solid",color:"#172B4D"}]});`,
        postProcess: false,
    });
    assert.equal(first.ok, true);
    const doc = JSON.parse(await readFile(studio.entries.get(file).backing, "utf8"));
    main = doc.children.find((n) => n.name === "Task software").id;
    menu = doc.children.find((n) => n.name === "Task context menu").id;
    input = doc.children[0].children.find((n) => n.name === "Task search").id;
    results.push("incremental-create-two-artboards");
    await assert.rejects(
        studio.call(file, owner, "batch_design", {
            script: "function C(){ return 1; } C();",
        }),
        (e) => e.code === "RESERVED_SCRIPT_NAME" && e.details.committed === false,
    );
    await assert.rejects(
        studio.call(file, owner, "batch_design", {
            script: "const = I(null, {});",
        }),
        (e) => e.code === "SCRIPT_SYNTAX",
    );
    const second = await studio.call(file, owner, "batch_design", {
        script: String.raw`const modal=I(null,{type:"frame",name:"Task detail dialog",x:1400,y:0,width:420,height:300,layout:"vertical",padding:24,gap:20,fill:[{type:"solid",color:"#FFFFFF"}]});I(modal,{type:"text",content:"Task details",width:"fill_container",height:"fit_content",fontFamily:"Inter",fontSize:24,fill:[{type:"solid",color:"#172B4D"}]});I(modal,{type:"text",content:"Review the implementation before release.",width:"fill_container",height:"fit_content",fontFamily:"Inter",fontSize:16,fill:[{type:"solid",color:"#42526E"}]});const icon=I(modal,{type:"frame",name:"Composed geometry icon",width:48,height:48,layout:"none"});I(icon,{type:"rectangle",x:16,y:14,width:16,height:16,rotation:45,fill:[{type:"solid",color:"#42526E"}]});`,
        postProcess: false,
    });
    assert.equal(second.ok, true);
    results.push("recover-and-add-third-artboard");
    const validation = await studio.validate(file, owner);
    assert.ok(validation.diagnostics.some((d) => d.code === "CONTROL_LABEL" && d.nodeId === input));
    await assert.rejects(studio.save(file, owner), (e) => e.code === "VALIDATION_REQUIRED");
    await studio.controlSemantics(file, owner, input, { label: "Search tasks" });
    const corrected = await studio.validate(file, owner);
    assert.equal(corrected.valid, true, JSON.stringify(corrected.diagnostics));
    results.push("diagnose-and-repair-control-label");
    const saved = await studio.save(file, owner);
    assert.equal(saved.saved, true);
    const persisted = JSON.parse(await readFile(file, "utf8"));
    assert.equal(persisted.children.length, 3);
    modal = persisted.children.find((n) => n.name === "Task detail dialog").id;
    results.push("validated-persistent-save");
    const preview = await studio.preview(file, owner);
    assert.equal(preview.frames.length, 3);
    assert.deepEqual(
        preview.frames.map((f) => [f.width, f.height]),
        [
            [1024, 720],
            [240, 220],
            [420, 300],
        ],
    );
    results.push("three-independent-native-previews");
    await studio.close(file, owner);
    assert.equal(studio.entries.size, 0);
    await studio.status(file, owner);
    await studio.call(file, owner, "update_node", {
        nodeId: main,
        name: "Reopened software",
        postProcess: false,
    });
    await studio.save(file, owner);
    assert.equal(JSON.parse(await readFile(file, "utf8")).children[0].name, "Reopened software");
    results.push("close-reopen-and-edit");
    await studio.call(file, owner, "update_node", {
        nodeId: modal,
        name: "Retained unsaved dialog",
        postProcess: false,
    });
    await studio.dispose();
    studio = new Studio(authorize, join(root, "state"), "http://127.0.0.1:3080");
    const recovered = await studio.status(file, owner);
    assert.equal(recovered.saved, false);
    await studio.save(file, owner);
    assert.equal(
        JSON.parse(await readFile(file, "utf8")).children[2].name,
        "Retained unsaved dialog",
    );
    results.push("restart-checkpoint-retention");
    await writeFile(
        file,
        JSON.stringify({
            ...JSON.parse(await readFile(file, "utf8")),
            externalChange: true,
        }),
    );
    await assert.rejects(studio.save(file, owner), (e) => e.code === "SAVE_CONFLICT");
    await studio.reload(file, owner, true);
    await studio.save(file, owner);
    results.push("source-hash-conflict-and-explicit-reload");
    if (process.argv[2]) {
        const directory = resolve(process.argv[2]);
        await mkdir(directory, { recursive: true });
        await copyFile(file, join(directory, "software.op"));
        const finalPreview = await studio.preview(file, owner);
        for (const [index, frame] of finalPreview.frames.entries())
            await copyFile(
                frame.path,
                join(
                    directory,
                    ["preview-main.png", "preview-menu.png", "preview-dialog.png"][index],
                ),
            );
        results.push("export-validated-native-example-and-artboard-previews");
    }
    console.log(
        JSON.stringify({ ok: true, root, file, results, previews: preview.frames }, null, 2),
    );
} finally {
    await studio.dispose();
    console.log(
        JSON.stringify({
            cleanup: "all-studio-daemons-stopped",
            remaining: studio.entries.size,
            root,
        }),
    );
}
