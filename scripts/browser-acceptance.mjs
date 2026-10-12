import { chromium } from "playwright-core";
import assert from "node:assert/strict";
const origin = process.argv[2],
  executablePath = process.env.STUDIO_CHROMIUM;
if (!origin || !executablePath)
  throw Error("Pass isolated fixture origin and STUDIO_CHROMIUM");
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage({
    viewport: { width: 1280, height: 1000 },
  });
  const state = async () =>
    await (await page.request.get(origin + "/test/state")).json();
  const command = async (data) =>
    await (await page.request.post(origin + "/test/command", { data })).json();
  await page.goto(origin);
  await page.getByRole("button", { name: "打开 / 编辑" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="lifecycle"]')?.textContent ===
      "ready false",
  );
  const fixture = await (
    await page.request.get(origin + "/test/fixture")
  ).json();
  const documentUrl = origin + fixture.grant.document.url;
  const original = await (await page.request.get(documentUrl)).json();
  const textId = original.children[0].children[0].id;
  await page.mouse.dblclick(540, 382, { delay: 120 });
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Edited from real browser", { delay: 45 });
  await page.mouse.click(800, 650);
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="lifecycle"]')?.textContent ===
      "ready true",
  );
  await page.waitForFunction(async () => {
    const s = await (await fetch("/test/state")).json();
    return s.editor.dirty;
  });
  const dirty = await state();
  assert.equal(dirty.editor.dirty, true);
  assert.ok(
    !JSON.stringify(
      await (await page.request.get(documentUrl)).json(),
    ).includes("Edited from real browser"),
  );
  await page.waitForFunction(async () => {
    const r = await (await fetch("/test/recovery")).json();
    return r.precise;
  });
  const blocked = await command({
    tool: "update_node",
    args: { nodeId: textId, data: { name: "Must not commit" } },
  });
  assert.equal(blocked.code, "UNSAVED_USER_CHANGES");
  const stale = await command({
    action: "resolve",
    choice: "save-user",
    revision: 0,
  });
  assert.equal(stale.code, "EDITOR_REVISION_CHANGED");
  const confirmed = await state();
  const cancelled = await command({
    action: "resolve",
    choice: "cancel",
    revision: confirmed.editor.revision,
  });
  assert.equal(cancelled.ok, true);
  assert.equal((await state()).editor.dirty, true);
  const saved = await command({
    action: "resolve",
    choice: "save-user",
    revision: (await state()).editor.revision,
  });
  assert.equal(saved.ok, true, JSON.stringify(saved));
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="lifecycle"]')?.textContent ===
      "ready false",
  );
  assert.ok(
    JSON.stringify(await (await page.request.get(documentUrl)).json()).includes(
      "Edited from real browser",
    ),
  );
  assert.equal((await state()).saved, true);
  await page.reload();
  await page.getByRole("button", { name: "打开 / 编辑" }).click();
  await page.waitForFunction(
    () =>
      document.querySelector('[data-testid="lifecycle"]')?.textContent ===
      "ready false",
  );
  await page.screenshot({ path: "/tmp/studio-final-browser.png" });
  console.log(
    JSON.stringify({
      ok: true,
      checks: [
        "workspace file-card open",
        "real mouse and keyboard edit",
        "dirty heartbeat",
        "precise automatic recovery",
        "mutation refusal",
        "stale revision refusal",
        "cancel preserves canvas",
        "save-user snapshots and persists",
        "saved working state synchronized",
        "reopen saved native document",
      ],
      origin,
    }),
  );
} finally {
  await browser.close();
}
