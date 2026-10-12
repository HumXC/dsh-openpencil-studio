import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { registerHooks, stripTypeScriptTypes } from "node:module";

// Load current source in memory; these tests never build or write shared lib.
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

const control = (id = "input", extra = {}) => ({ id, type: "text_input", ...extra });
const text = (id = "title", content = "Search") => ({ id, type: "text", content });
const documentWith = (...children) => ({ version: "1.0.0", children });
const associate = (doc, nodeId, patch) => {
  doc.variables = withControlSemantics(doc, nodeId, patch);
  return doc;
};
const rawMetadata = (controls) => ({
  [SEMANTICS_VARIABLE]: {
    type: "string",
    value: JSON.stringify({ schemaVersion: 1, controls }),
  },
});
// Inject existing metadata directly so reader regressions do not rely on the writer
// accepting an invalid new reference.
const existingAssociation = (doc, nodeId, patch) => {
  doc.variables = { ...doc.variables, ...rawMetadata({
    ...controlSemantics(doc), [nodeId]: patch,
  }) };
  return doc;
};
const invalidReferences = (doc) =>
  technicalDiagnostics(doc).filter((issue) => issue.code === "INVALID_LABEL_REFERENCE");

for (const [description, patch, property] of [
  ["empty reference", { labelledBy: [""] }, "labelledBy"],
  ["whitespace reference", { labelledBy: [" \n\t"] }, "labelledBy"],
  ["numeric reference", { labelledBy: [12] }, "labelledBy"],
  ["null reference", { labelledBy: [null] }, "labelledBy"],
  ["non-array references", { labelledBy: "title" }, "labelledBy"],
  ["numeric label", { label: 12 }, "label"],
  ["null label", { label: null }, "label"],
]) {
  test(`semantic reader and writer reject ${description} without mutating the document`, () => {
    const doc = documentWith(control(), text());
    doc.variables = rawMetadata({ input: { label: "Original" } });
    const before = structuredClone(doc);
    assert.throws(
      () => withControlSemantics(doc, "input", patch),
      (error) => error.code === "INVALID_SEMANTIC_METADATA" &&
        error.details.nodeId === "input" && error.details.property === property,
    );
    assert.deepEqual(doc, before);
    const malformed = { ...doc, variables: rawMetadata({ input: patch }) };
    assert.throws(
      () => controlSemantics(malformed),
      (error) => error.code === "INVALID_SEMANTIC_METADATA" &&
        error.details.nodeId === "input" && error.details.property === property,
    );
  });
}

test("an invalid reference is rejected even when a valid label is also supplied", () => {
  const doc = documentWith(control());
  assert.throws(
    () => withControlSemantics(doc, "input", { label: "Search", labelledBy: [""] }),
    (error) => error.code === "INVALID_SEMANTIC_METADATA" &&
      error.details.referenceIndex === 0 && error.details.reference === "",
  );
  assert.equal(doc.variables, undefined);
});

test("empty semantic patches require a label and do not mutate the document", () => {
  for (const patch of [{}, { label: " \n" }, { labelledBy: [] }]) {
    const doc = documentWith(control());
    const before = structuredClone(doc);
    assert.throws(
      () => withControlSemantics(doc, "input", patch),
      (error) => error.code === "CONTROL_LABEL_REQUIRED",
    );
    assert.deepEqual(doc, before);
  }
});

test("valid semantics round-trip and label-only repairs clear stale references", () => {
  const doc = documentWith(control(), control("other"), text());
  associate(doc, "other", { label: "Other input" });
  associate(doc, "input", { label: " Search ", labelledBy: ["title"] });
  assert.deepEqual(controlSemantics(doc).input, { label: "Search", labelledBy: ["title"] });
  existingAssociation(doc, "input", { labelledBy: ["missing"] });
  assert.equal(invalidReferences(doc).length, 1);
  associate(doc, "input", { label: " Repaired search " });
  assert.deepEqual(controlSemantics(doc), {
    input: { label: "Repaired search" }, other: { label: "Other input" },
  });
  assert.equal(technicalDiagnostics(doc).length, 0);
});

test("malformed prior metadata stays visible rather than being discarded by a repair", () => {
  const doc = documentWith(control());
  doc.variables = rawMetadata({ input: { labelledBy: [""] } });
  const before = structuredClone(doc);
  assert.throws(
    () => withControlSemantics(doc, "input", { label: "Replacement" }),
    (error) => error.code === "INVALID_SEMANTIC_METADATA",
  );
  assert.deepEqual(doc, before);
});

for (const [description, target] of [
  ["empty frame", { id: "target", type: "frame", name: "Search" }],
  ["non-text node with fake content", { id: "target", type: "rectangle", content: "Search" }],
  ["empty text", text("target", "")],
  ["whitespace text", text("target", " \n\t")],
  ["empty styled text", text("target", [])],
  ["whitespace styled text", text("target", [{ text: " " }, { text: "\n\t" }])],
  ["styled text without required run text", text("target", [{ content: "Search" }])],
  ["styled text with a malformed run", text("target", [{ text: "Search" }, { text: 12 }])],
  ["text name without native content", { id: "target", type: "text", name: "Search" }],
  ["text with an unsupported text property", { id: "target", type: "text", text: "Search" }],
  ["another control with its own label", control("target", { label: "Search" })],
  ["frame containing only a control", {
    id: "target", type: "frame", children: [control("nested", { label: "Search" })],
  }],
]) {
  test(`references to ${description} do not supply effective labels`, () => {
    const doc = existingAssociation(documentWith(control(), target), "input", { labelledBy: ["target"] });
    const issues = technicalDiagnostics(doc);
    const invalid = issues.find((issue) => issue.code === "INVALID_LABEL_REFERENCE");
    assert.equal(invalid.nodeId, "input");
    assert.equal(invalid.property, "labelledBy");
    assert.match(invalid.message, /"target"/);
    assert.equal(invalid.repair.tool, "pencil_control_semantics");
    assert.equal(invalid.repair.nodeId, "input");
    assert.equal(invalid.blocking, true);
    assert.ok(issues.some((issue) => issue.nodeId === "input" && issue.code === "CONTROL_LABEL"));
  });
}

test("self references identify the exact control and reference", () => {
  const doc = existingAssociation(documentWith(control()), "input", { labelledBy: ["input"] });
  const [issue] = invalidReferences(doc);
  assert.equal(issue.nodeId, "input");
  assert.match(issue.message, /"input".*itself/);
  assert.equal(issue.repair.tool, "pencil_control_semantics");
  assert.ok(technicalDiagnostics(doc).some((d) => d.code === "CONTROL_LABEL"));
});

test("cyclic control references terminate and neither control gains a label", () => {
  const doc = documentWith(control("first"), control("second"));
  existingAssociation(doc, "first", { labelledBy: ["second"] });
  existingAssociation(doc, "second", { labelledBy: ["first"] });
  const issues = technicalDiagnostics(doc);
  assert.deepEqual(invalidReferences(doc).map((issue) => issue.nodeId), ["first", "second"]);
  assert.equal(issues.filter((issue) => issue.code === "CONTROL_LABEL").length, 2);
});

test("missing and cross-page references fail, while same-page forward references work", () => {
  const doc = {
    version: "1.0.0",
    pages: [
      { id: "first-page", children: [control("first"), text("local")] },
      { id: "second-page", children: [text("foreign")] },
    ],
  };
  existingAssociation(doc, "first", { labelledBy: ["foreign", "missing"] });
  const issues = invalidReferences(doc);
  assert.equal(issues.length, 2);
  assert.ok(issues.every((issue) => issue.nodeId === "first" &&
    issue.repair.tool === "pencil_control_semantics" && /same page/.test(issue.message)));
  assert.match(issues[0].message, /"foreign"/);
  assert.match(issues[1].message, /"missing"/);
  associate(doc, "first", { labelledBy: ["local"] });
  assert.deepEqual(technicalDiagnostics(doc), []);
});

test("readable native text and nested text containers are valid label targets", () => {
  for (const target of [
    text("target", " Search \n"),
    text("target", [{ text: " " }, { text: "Search", fontWeight: 700 }]),
    { id: "target", type: "frame", children: [text("child")] },
    { id: "target", type: "frame", children: [text("child", [{ text: "Search" }])] },
    { id: "target", type: "group", children: [
      { id: "nested", type: "frame", children: [text("child")] },
    ] },
  ]) {
    const doc = associate(documentWith(control(), target), "input", { labelledBy: ["target"] });
    assert.deepEqual(technicalDiagnostics(doc), []);
  }
});

test("valid fallback labels do not hide invalid references and repairs can clear them", () => {
  const doc = existingAssociation(documentWith(control(), text()), "input", {
    label: "Search", labelledBy: ["title", "missing"],
  });
  assert.equal(invalidReferences(doc).length, 1);
  assert.equal(technicalDiagnostics(doc).some((issue) => issue.code === "CONTROL_LABEL"), false);
  associate(doc, "input", { label: "Search" });
  assert.deepEqual(technicalDiagnostics(doc), []);
});

for (const [description, target] of [
  ["hidden text", { ...text("target"), visible: false }],
  ["text below a hidden ancestor", {
    id: "hidden", type: "frame", visible: false, children: [text("target")],
  }],
  ["container with only hidden text", {
    id: "target", type: "group", children: [{ ...text("child"), visible: false }],
  }],
]) {
  test(`reader rejects ${description} even with a fallback label`, () => {
    const doc = existingAssociation(documentWith(control(), target), "input", {
      label: "Search", labelledBy: ["target"],
    });
    assert.equal(invalidReferences(doc).length, 1);
    assert.match(invalidReferences(doc)[0].message, /visible native text/);
    assert.equal(technicalDiagnostics(doc).some((issue) => issue.code === "CONTROL_LABEL"), false);
  });
}

test("hidden controls still receive the existing semantic checks", () => {
  const doc = existingAssociation(documentWith(control("input", { visible: false })), "input", {
    labelledBy: ["input"],
  });
  assert.equal(invalidReferences(doc).length, 1);
  assert.ok(technicalDiagnostics(doc).some((issue) => issue.code === "CONTROL_LABEL"));
  associate(doc, "input", { label: "Search" });
  assert.deepEqual(technicalDiagnostics(doc), []);
});
