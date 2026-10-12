import { createRequire } from "node:module";
import { patchEditor, patchBridge } from "./editor-patches.mjs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { dirname, resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createHash } from "node:crypto";
const here = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const root =
  process.argv[2] ??
  dirname(
    createRequire(import.meta.url).resolve(
      "@zseven-w/dsh-openpencil/package.json",
    ),
  );
const pkg = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
if (pkg.version !== "0.1.0-rc.13")
  throw Error("Unsupported official package version: " + pkg.version);
const names = [
  "client/editor-panel.tsx",
  "client/editor-bridge.ts",
  "client/editor-successor.ts",
  "client/selection-store.ts",
  "client/selection-polling.ts",
  "client/editor-recovery.ts",
  "managed-editor-daemon.ts",
];
const manifest = [];
for (const name of names) {
  const bytes = await readFile(join(root, "src", name));
  let text = bytes.toString("utf8");
  const target = name.startsWith("client/")
    ? "src/vendor/" + name
    : "src/vendor/server/" + name;
  text = text
    .replaceAll("from './index.js'", "from '../../contracts.js'")
    .replaceAll("dsh-openpencil:", "dsh-openpencil-studio:")
    .replaceAll("dsh-openpencil/recovery/", "openpencil-studio/recovery/");
  if (name === "client/editor-panel.tsx") text = patchEditor(text);
  if (name === "client/editor-bridge.ts") text = patchBridge(text);
  await mkdir(dirname(join(here, target)), { recursive: true });
  await writeFile(join(here, target), text);
  manifest.push({
    source: "@zseven-w/dsh-openpencil/src/" + name,
    target,
    sha256: createHash("sha256").update(bytes).digest("hex"),
  });
}
await writeFile(
  join(here, "vendor-manifest.json"),
  JSON.stringify(
    {
      package: pkg.name,
      version: pkg.version,
      license: pkg.license,
      files: manifest,
    },
    null,
    2,
  ) + "\n",
);
console.log(
  "Vendored " +
    manifest.length +
    " narrow host/protocol modules; no official apply or design controller.",
);
