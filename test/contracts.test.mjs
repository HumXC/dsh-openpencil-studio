import test from "node:test";
import assert from "node:assert/strict";
import { prepareScript } from "../lib/script.js";
import {
    technicalDiagnostics,
    nativeDiagnostics,
    nativeQualityDiagnostics,
} from "../lib/validation.js";
import { withControlSemantics } from "../lib/semantics.js";
import { createTools } from "../lib/index.js";
import { GUIDANCE } from "../lib/guidance.js";
test("script rejects ambiguous edit-helper names before commit, accepts descriptive helpers", () => {
    assert.throws(
        () => prepareScript("function C(){ return 1; }"),
        (e) => e.code === "RESERVED_SCRIPT_NAME",
    );
    assert.throws(
        () => prepareScript("const ="),
        (e) => e.code === "SCRIPT_SYNTAX",
    );
    assert.doesNotThrow(() =>
        prepareScript(
            'function makeCard(p){ return I(p,{type:"frame",name:"C() label"}); } makeCard(null);',
        ),
    );
});
test("visible labels do not supply control semantics; persistent associations and real references do", () => {
    const doc = {
        version: "1.0.0",
        children: [
            { id: "title", type: "text", content: "Search" },
            { id: "input", type: "text_input", placeholder: "Search" },
        ],
    };
    assert.equal(
        technicalDiagnostics(doc).some((d) => d.code === "CONTROL_LABEL"),
        true,
    );
    doc.variables = withControlSemantics(doc, "input", { labelledBy: ["title"] });
    assert.equal(technicalDiagnostics(doc).length, 0);
    assert.throws(
        () => withControlSemantics(doc, "input", { labelledBy: ["missing"] }),
        (error) => error.code === "INVALID_LABEL_REFERENCE",
    );
    // A document imported from elsewhere still needs a diagnostic for bad references.
    doc.variables["studio/accessibility"].value = JSON.stringify({
        schemaVersion: 1,
        controls: { input: { labelledBy: ["missing"] } },
    });
    const d = technicalDiagnostics(doc)[0];
    assert.equal(d.code, "INVALID_LABEL_REFERENCE");
    assert.equal(d.repair.tool, "pencil_control_semantics");
    assert.equal(d.nodeId, "input");
});
test("intentional icon rotation and visual contrast are advisory; fake __remove patches are not emitted", () => {
    const d = nativeDiagnostics({
        issues: [
            {
                nodeId: "icon",
                category: "unexpected-rotation",
                property: "rotation",
                suggestedValue: 0,
            },
            {
                nodeId: "wrapper",
                category: "redundant-wrapper",
                property: "__remove",
                suggestedValue: true,
            },
            {
                nodeId: "text",
                category: "text-overflow",
                property: "height",
                suggestedValue: "fit_content",
            },
        ],
    });
    assert.equal(d[0].blocking, false);
    assert.equal(d[1].patch, undefined);
    assert.equal(d[2].blocking, true);
    assert.deepEqual(d[2].patch, { height: "fit_content" });
});
test("registered schemas, descriptions and system guidance contain no page recipes or fixed generation contract", () => {
    const tools = createTools({});
    for (const name of [
        "pencil_create",
        "pencil_save",
        "pencil_batch_design",
        "pencil_update_node",
        "pencil_undo",
        "pencil_get_style_guide",
    ])
        assert.ok(
            tools.some((tool) => tool.name === name),
            name,
        );
    assert.ok(tools.every((t) => t.name.startsWith("pencil_")));
    const text =
        JSON.stringify(
            tools.map((t) => ({
                name: t.name,
                description: t.description,
                parameters: t.parameters,
            })),
        ) + GUIDANCE;
    assert.equal(text.includes("Header/Hero/Footer"), false);
    assert.doesNotMatch(
        text,
        /gray loveseat|1120px|ecommerce-modern-light|exactly two|exactly three/i,
    );
    assert.ok(tools.some((t) => t.name === "pencil_get_style_guide"));
    assert.ok(!tools.some((t) => /pipeline_begin|design_agent|finalize_design/.test(t.name)));
});
test("native geometry diagnostics offer verified existing IDs and concrete repairs without inventing targets", () => {
    const doc = {
        version: "1.0.0",
        children: [
            { id: "board", type: "frame", height: 240 },
            { id: "symbol", type: "frame", role: "icon" },
        ],
    };
    const d = nativeQualityDiagnostics(doc, {
        geometryIssues: [
            "Board (board): declared 240px tall but resolved 310px",
            "Unknown (missing): geometry issue",
            "Symbol (symbol): declared 24px tall but resolved 26px",
        ],
    });
    assert.equal(d[0].nodeId, "board");
    assert.equal(d[0].blocking, true);
    assert.deepEqual(d[0].repair.data, { height: 310 });
    assert.equal(d[1].nodeId, undefined);
    assert.equal(d[1].blocking, false);
    assert.equal(d[2].blocking, false);
});
