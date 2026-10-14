import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Studio } from "../lib/studio.js";
import { authoredContent } from "../lib/document-content.js";

test("view metadata and serialization do not mark authored content dirty", () => {
    const a = {
        version: "1.0.0",
        children: [{ id: "n1", type: "text", content: "Original" }],
        editorMeta: { activePageIndex: 0 },
    };
    const b = {
        children: a.children,
        version: "1.0.0",
        editorMeta: { activePageIndex: 1, zoom: 2 },
    };
    assert.equal(authoredContent(JSON.stringify(a)), authoredContent(JSON.stringify(b)));
    b.children = [{ ...a.children[0], content: "Edited" }];
    assert.notEqual(authoredContent(JSON.stringify(a)), authoredContent(JSON.stringify(b)));
});

test("real native interleaved inserts restore properties using bindings rather than tree order", async () => {
    const root = await mkdtemp(join(tmpdir(), "studio-order-")),
        path = join(root, "order.op");
    const studio = new Studio(async (p) => p, join(root, "state"), "http://127.0.0.1:3080");
    try {
        await studio.create(path, "order-owner");
        await studio.call(path, "order-owner", "batch_design", {
            script: 'const a=I(null,{type:"frame",name:"Container",width:300,height:200,fill:[{type:"solid",color:"#FFFFFF"}]});I(null,{type:"ellipse",name:"Independent circle",x:340,width:60,height:60,fill:[{type:"solid",color:"#2563EB"}]});I(a,{type:"text",name:"Nested label",content:"Correct label",fontSize:23,width:220,height:32,fill:[{type:"solid",color:"#111111"}]});',
        });
        const doc = JSON.parse(
            await readFile((await studio.status(path, "order-owner")).checkpointPath, "utf8"),
        );
        assert.equal(doc.children[0].name, "Container");
        assert.equal(doc.children[0].type, "frame");
        assert.equal(doc.children[0].children[0].name, "Nested label");
        assert.equal(doc.children[0].children[0].content, "Correct label");
        assert.equal(doc.children[0].children[0].fontSize, 23);
        assert.equal(doc.children[1].type, "ellipse");
        assert.equal(doc.children[1].name, "Independent circle");
        assert.equal(doc.children[1].fill[0].color, "#2563EB");
    } finally {
        await studio.dispose();
    }
});
