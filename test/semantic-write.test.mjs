import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Source hooks keep this regression independent of both built lib and loaded Host.
const sourceRoot = new URL("../src/", import.meta.url);
registerHooks({
  resolve(specifier, context, nextResolve) {
    if (context.parentURL?.startsWith(sourceRoot.href) &&
        specifier.startsWith(".") && specifier.endsWith(".js"))
      return nextResolve(new URL(specifier.replace(/\.js$/, ".ts"), context.parentURL).href, context);
    return nextResolve(specifier, context);
  },
  load(url, context, nextLoad) {
    if (url.startsWith(sourceRoot.href) && url.endsWith(".ts"))
      return {
        format: "module", shortCircuit: true,
        source: stripTypeScriptTypes(readFileSync(new URL(url), "utf8"), {
          mode: "transform", sourceUrl: url,
        }),
      };
    return nextLoad(url, context);
  },
});
const { SEMANTICS_VARIABLE, controlSemantics, withControlSemantics } =
  await import("../src/semantics.ts");
const { technicalDiagnostics } = await import("../src/validation.ts");
const { Studio } = await import("../src/studio.ts");
const rawMetadata = (controls) => ({
  [SEMANTICS_VARIABLE]: {
    type: "string", value: JSON.stringify({ schemaVersion: 1, controls }),
  },
});
const fixture = () => ({
  version: "1.0.0",
  variables: rawMetadata({ input: { label: "Original" }, other: { label: "Other" } }),
  pages: [
    { children: [
      { id: "input", type: "text_input" },
      { id: "title", type: "text", content: "Search" },
      { id: "other", type: "text_input", label: "Other" },
      { id: "shape", type: "rectangle", content: "Fake text" },
      { id: "empty", type: "text", content: " \n" },
      { id: "bad-styled", type: "text", content: [{ text: "Search" }, { text: 12 }] },
      { id: "styled", type: "text", content: [{ text: " " }, { text: "Search", fontWeight: 700 }] },
      { id: "hidden", type: "text", content: "Search", visible: false },
      { id: "hidden-parent", type: "frame", visible: false, children: [
        { id: "hidden-child", type: "text", content: "Search" },
      ] },
      { id: "control-container", type: "group", children: [
        { id: "nested-control", type: "text_input", label: "Nested" },
      ] },
      { id: "visible-container", type: "frame", children: [
        { id: "hidden-sibling", type: "text", content: "Hidden", visible: false },
        { id: "visible-child", type: "text", content: "Search" },
      ] },
    ] },
    { children: [{ id: "foreign", type: "text", content: "Foreign page label" }] },
  ],
});
function writeBoundary(doc) {
  const writes = [];
  const boundary = {
    async entry() { return {}; },
    async serialEntry(_entry, work) { return work(); },
    async snapshot() { return { documentJson: JSON.stringify(doc), version: 17 }; },
    async call(...args) {
      writes.push(args);
      doc.variables = args[3].variables;
      return { ok: true };
    },
  };
  return {
    writes,
    write: (patch, nodeId = "input") =>
      Studio.prototype.controlSemantics.call(boundary, "fixture.op", "owner", nodeId, patch),
  };
}
const invalidReference = (reference) => (error) =>
  error.code === "INVALID_LABEL_REFERENCE" && error.details.nodeId === "input" &&
  error.details.property === "labelledBy" && error.details.reference === reference &&
  error.details.referenceIndex === 1 && error.details.committed === false;

for (const [description, reference] of [
  ["self reference", "input"],
  ["missing reference", "missing"],
  ["another control", "other"],
  ["non-text reference", "shape"],
  ["blank text", "empty"],
  ["malformed styled text", "bad-styled"],
  ["hidden text", "hidden"],
  ["hidden ancestor", "hidden-child"],
  ["container containing only a control", "control-container"],
  ["cross-page reference", "foreign"],
]) {
  for (const label of [undefined, "Search"]) {
    test(`writer rejects ${description}${label ? " with a fallback label" : ""} before mutation`, async () => {
      const doc = fixture();
      const before = structuredClone(doc);
      const patch = { ...(label ? { label } : {}), labelledBy: ["title", reference] };
      assert.throws(() => withControlSemantics(doc, "input", patch), invalidReference(reference));
      assert.deepEqual(doc, before);
      const boundary = writeBoundary(doc);
      await assert.rejects(boundary.write(patch), invalidReference(reference));
      assert.equal(boundary.writes.length, 0, "no set_variables call may occur on failure");
      assert.deepEqual(doc, before);
    });
  }
}

test("control cycles remain invalid even when old metadata and a fallback label exist", async () => {
  const doc = fixture();
  doc.variables = rawMetadata({
    input: { labelledBy: ["other"] }, other: { labelledBy: ["input"] },
  });
  const before = structuredClone(doc);
  const boundary = writeBoundary(doc);
  await assert.rejects(boundary.write({ label: "Search", labelledBy: ["title", "other"] }),
    invalidReference("other"));
  assert.equal(boundary.writes.length, 0);
  assert.deepEqual(doc, before);
  assert.equal(technicalDiagnostics(doc).filter((issue) => issue.code === "INVALID_LABEL_REFERENCE").length, 2);
});

test("label-only repairs clear stale references without revalidating unrelated old associations", async () => {
  const doc = fixture();
  doc.variables = rawMetadata({
    input: { labelledBy: ["input", "missing", "foreign"] },
    other: { labelledBy: ["other"] },
  });
  const boundary = writeBoundary(doc);
  await boundary.write({ label: " Repaired " });
  assert.equal(boundary.writes.length, 1);
  assert.equal(boundary.writes[0][2], "set_variables");
  assert.equal(boundary.writes[0].at(-1), 17);
  assert.deepEqual(controlSemantics(doc), {
    input: { label: "Repaired" }, other: { labelledBy: ["other"] },
  });
  const issues = technicalDiagnostics(doc).filter((issue) => issue.code === "INVALID_LABEL_REFERENCE");
  assert.deepEqual(issues.map((issue) => issue.nodeId), ["other"]);
});

test("same-page forward text, styled text and partly visible containers round-trip through the write boundary", async () => {
  const doc = fixture();
  const boundary = writeBoundary(doc);
  const references = ["title", "styled", "visible-container"];
  await boundary.write({ labelledBy: references });
  assert.equal(boundary.writes.length, 1);
  assert.deepEqual(controlSemantics(doc).input, { labelledBy: references });
  assert.deepEqual(technicalDiagnostics(doc), []);
});

test("hidden controls can have valid labels but cannot bypass reference checks", async () => {
  const doc = fixture();
  doc.pages[0].children[0].visible = false;
  const boundary = writeBoundary(doc);
  await assert.rejects(boundary.write({ label: "Search", labelledBy: ["title", "input"] }),
    invalidReference("input"));
  assert.equal(boundary.writes.length, 0);
  await boundary.write({ labelledBy: ["title"] });
  assert.equal(boundary.writes.length, 1);
  assert.deepEqual(technicalDiagnostics(doc), []);
});
