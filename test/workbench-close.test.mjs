import { test, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { StudioWorkbench } from "../lib/workbench/controller.js";
import { getBridge } from "../lib/workbench/contracts.js";
const request = (path, extras = {}) => ({ sessionId: "s", grant: { sourcePath: path, ...extras } });
beforeEach(() => {
    getBridge().runtime = { key: (g, s) => g.sourcePath + s };
});
test("cancelling unsaved confirmation prevents both replacement and controller close", async () => {
    let prompts = 0,
        closes = 0;
    const workbench = new StudioWorkbench(() => {
        prompts++;
        return false;
    });
    await workbench.open(request("a.op"), false);
    workbench.onState({ phase: "ready", dirty: true });
    workbench.onController({
        requestClose: async () => {
            closes++;
            return true;
        },
    });
    assert.equal(await workbench.open(request("b.op"), false), false);
    assert.equal(await workbench.close(), false);
    assert.equal(prompts, 2);
    assert.equal(closes, 0);
    assert.equal(workbench.getSnapshot().grant.sourcePath, "a.op");
});
test("confirmed dirty close reaches official controller; saving cannot be closed", async () => {
    let prompts = 0,
        closes = 0;
    const workbench = new StudioWorkbench(() => {
        prompts++;
        return true;
    });
    await workbench.open(request("a.op"), false);
    workbench.onController({
        requestClose: async () => {
            closes++;
            return true;
        },
    });
    workbench.onState({ phase: "saving", dirty: true });
    assert.equal(await workbench.open(request("b.op"), false), false);
    assert.equal(await workbench.close(), false);
    assert.equal(prompts, 0);
    assert.equal(closes, 0);
    workbench.onState({ phase: "ready", dirty: true });
    assert.equal(await workbench.open(request("b.op"), false), true);
    assert.equal(prompts, 1);
    assert.equal(closes, 1);
});
