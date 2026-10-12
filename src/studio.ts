import { createHash, randomUUID, randomBytes } from "node:crypto";
import {
  readFile,
  writeFile,
  mkdir,
  rename,
  link,
  unlink,
} from "node:fs/promises";
import { join, dirname, basename } from "node:path";
import { official, restoreAuthoredSnapshot } from "./official.js";
import type { Snapshot } from "./official.js";
import {
  startManagedEditorDaemon,
  stopManagedEditorDaemon,
} from "./vendor/server/managed-editor-daemon.js";
import type { ManagedEditorDaemon } from "./vendor/server/managed-editor-daemon.js";
import { callNative, listNative, isRead, normalizeNativeArguments } from "./native.js";
import { planCreation, preserveCreation, type CreationPlan } from "./creation.js";
import { DocumentHistory } from "./history.js";
import { renderPages, removePreviewDirectory } from "./preview.js";
import {
  nativeDiagnostics,
  nativeQualityDiagnostics,
  parseDocument,
  technicalDiagnostics,
} from "./validation.js";
import { StudioError, record } from "./errors.js";
import { withControlSemantics, type ControlSemantics } from "./semantics.js";
import type { StudioSnapshot, PresentationGrant } from "./contracts.js";
import { ROUTE } from "./contracts.js";
import { canvasPrefix } from "./editor-proxy.js";
export type Authorize = (
  path: string,
  sessionId: string,
  write: boolean,
  create?: boolean,
) => Promise<string>;
export const hash = (text: string) =>
  createHash("sha256").update(text).digest("hex");
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([k, v]) => [k, canonical(v)]),
    );
  return value;
}
export const documentHash = (text: string) => {
  const document = JSON.parse(text);
  delete document.editorMeta; // View state is persisted but does not change authored content.
  return hash(JSON.stringify(canonical(document)));
};
export async function atomicWrite(
  path: string,
  text: string,
  beforeRename?: () => Promise<void>,
) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const tmp = path + "." + randomUUID() + ".tmp";
  await writeFile(tmp, text, { mode: 0o600, flag: "wx" });
  try {
    await beforeRename?.();
    await rename(tmp, path);
  } catch (e) {
    await unlink(tmp).catch(() => {});
    throw e;
  }
}
interface BrowserState {
  id: string;
  daemon: ManagedEditorDaemon;
  baseline: string;
  state: StudioSnapshot;
  reportedAt: number;
  command?: Command;
  commandFailure?: unknown;
  checkpointFailure?: { commandId: string; error: unknown };
  lease?: string;
  toolLease?: string;
  pendingSync?: { id: string; documentJson: string; sourceHash: string };
  choice?: { revision: number; mode: "edit-saved" };
  needsReload: boolean;
}
export interface Command {
  id: string;
  type: "lease" | "release" | "save" | "reload" | "checkpoint";
  documentJson?: string;
  revision?: number;
}
interface Entry {
  path: string;
  owner: string;
  directory: string;
  backing: string;
  baseline: string;
  documentBaseline: string;
  daemon: ManagedEditorDaemon;
  browser?: BrowserState;
  phase: "ready" | "editing" | "saved" | "error";
  lastError?: Record<string, unknown>;
  history?: DocumentHistory;
  checkpointWarning?: Record<string, unknown>;
}
export class Studio {
  readonly version = 1 as const;
  readonly entries = new Map<string, Entry>();
  readonly grants = new Map<string, { path: string; owner: string }>();
  readonly previews = new Map<
    string,
    { path: string; sourcePath: string; owner: string }
  >();
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly ownerEpochs = new Map<string, number>();
  private readonly endingOwners = new Map<string, Promise<unknown>>();
  private readonly openingEntries = new Map<string, Set<Promise<unknown>>>();
  private disposed = false;
  constructor(
    readonly authorize: Authorize,
    readonly root: string,
    readonly origin: string,
  ) {}
  private async serial<T>(key: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(run);
    this.queues.set(key, current);
    try {
      return await current;
    } finally {
      if (this.queues.get(key) === current) this.queues.delete(key);
    }
  }
  private assertOwnerAvailable(owner: string, epoch?: number) {
    if (this.disposed || this.endingOwners.has(owner) ||
        (epoch !== undefined && epoch !== (this.ownerEpochs.get(owner) ?? 0)))
      throw new StudioError("SESSION_CLOSED", "Session cleanup started; reopen in an active session", { recoverable: true });
  }
  private serialEntry<T>(e: Entry, run: () => Promise<T>): Promise<T> {
    return this.serial(e.path, async () => {
      if (this.entries.get(e.path) !== e)
        throw new StudioError("DOCUMENT_CLOSED", "Document was closed; reopen it before retrying", { recoverable: true });
      return run();
    });
  }
  private async start(path: string) {
    return startManagedEditorDaemon((await official()).runtime, {
      sourcePath: path,
      allowOrigin: this.origin,
    });
  }
  async entry(path: string, owner: string, write = false) {
    this.assertOwnerAvailable(owner);
    const epoch = this.ownerEpochs.get(owner) ?? 0;
    this.ownerEpochs.set(owner, epoch);
    const resolved = await this.authorize(path, owner, write);
    this.assertOwnerAvailable(owner, epoch);
    let e = this.entries.get(resolved);
    if (e) {
      if (e.owner !== owner)
        throw new StudioError(
          "SESSION_OWNERSHIP",
          "This document is active in another session",
        );
      return e;
    }
    const opening = this.serial("open:" + resolved, async () => {
      this.assertOwnerAvailable(owner, epoch);
      e = this.entries.get(resolved);
      if (e) {
        if (e.owner !== owner)
          throw new StudioError(
            "SESSION_OWNERSHIP",
            "This document is active in another session",
          );
        return e;
      }
      const source = await readFile(resolved, "utf8");
      parseDocument(source);
      const directory = join(this.root, hash(resolved + "\0" + owner));
      const backing = join(directory, "working", "document.op");
      await mkdir(dirname(backing), { recursive: true, mode: 0o700 });
      let baseline = hash(source);
      let documentBaseline = documentHash(source);
      try {
        const metadata = record(
          JSON.parse(await readFile(join(directory, "metadata.json"), "utf8")),
        );
        const saved = await readFile(backing, "utf8");
        parseDocument(saved);
        if (typeof metadata?.baseline === "string") {
          baseline = metadata.baseline;
          if (typeof metadata.documentBaseline === "string")
            documentBaseline = metadata.documentBaseline;
        } else
          throw new StudioError(
            "CHECKPOINT_METADATA_INVALID",
            "Retained checkpoint metadata has no source baseline; existing work was preserved",
            { checkpointPath: backing },
          );
      } catch (error) {
        if (record(error)?.code !== "ENOENT") throw error;
        try {
          parseDocument(await readFile(backing, "utf8"));
        } catch (backingError) {
          if (record(backingError)?.code !== "ENOENT") throw backingError;
          await atomicWrite(backing, source);
        }
      }
      const daemon = await this.start(backing);
      const opened: Entry = {
        path: resolved,
        owner,
        directory,
        backing,
        baseline,
        documentBaseline,
        daemon,
        phase: "ready",
      };
      try {
        this.assertOwnerAvailable(owner, epoch);
        await this.metadata(opened);
        this.assertOwnerAvailable(owner, epoch);
        this.entries.set(resolved, opened);
        return opened;
      } catch (error) {
        await stopManagedEditorDaemon(daemon);
        throw error;
      }
    });
    const pending = this.openingEntries.get(owner) ?? new Set<Promise<unknown>>();
    this.openingEntries.set(owner, pending);
    pending.add(opening);
    try {
      return await opening;
    } finally {
      pending.delete(opening);
      if (!pending.size) this.openingEntries.delete(owner);
    }
  }
  private async metadata(e: Entry) {
    await atomicWrite(
      join(e.directory, "metadata.json"),
      JSON.stringify({
        sourcePath: e.path,
        owner: e.owner,
        baseline: e.baseline,
        documentBaseline: e.documentBaseline,
        phase: e.phase,
        updatedAt: Date.now(),
        ...(e.lastError ? { lastError: e.lastError } : {}),
      }),
    );
  }
  private async snapshot(e: Entry): Promise<Snapshot> {
    return (await official()).read(e.daemon.baseUrl, e.daemon.token);
  }
  async create(path: string, owner: string) {
    const resolved = await this.authorize(path, owner, true, true);
    return this.serial(resolved, async () => {
      const empty = JSON.stringify({ version: "1.0.0", children: [] });
      const tmp = join(dirname(resolved), ".studio-" + randomUUID() + ".op");
      await writeFile(tmp, empty, { flag: "wx", mode: 0o600 });
      try {
        await link(tmp, resolved);
      } catch (error) {
        if (record(error)?.code === "EEXIST")
          throw new StudioError(
            "FILE_EXISTS",
            "Existing documents are never overwritten by create",
          );
        throw error;
      } finally {
        await unlink(tmp).catch(() => {});
      }
      return {
        ok: true,
        path: resolved,
        saved: true,
        editable: true,
        stage: "saved",
        next: "Edit incrementally using native tools; validate and save your changes.",
      };
    });
  }
  async status(path: string, owner: string) {
    const e = await this.entry(path, owner);
    return this.serialEntry(e, async () => {
    const snap = await this.snapshot(e);
    const source = await readFile(e.path, "utf8");
    return {
      ok: true,
      path: e.path,
      ownerSession: owner,
      stage: e.phase,
      saved:
        hash(source) === e.baseline &&
        documentHash(snap.documentJson) === e.documentBaseline,
      sourceChanged: hash(source) !== e.baseline,
      workingVersion: snap.version,
      checkpointPath: e.backing,
      editor: e.browser
        ? {
            attached: true,
            dirty: e.browser.state.dirty,
            phase: e.browser.state.phase,
            revision: e.browser.state.revision,
            generation: e.browser.state.generation,
            stateFresh: Date.now() - e.browser.reportedAt < 5000,
            needsReload: e.browser.needsReload,
            selection: e.browser.state.selection ?? null,
            ...(e.checkpointWarning ? { checkpointWarning: e.checkpointWarning } : {}),
          }
        : { attached: false },
      recovery: { automaticExpiry: false, checkpointRetained: true },
    };
    });
  }
  async catalog(path: string, owner: string) {
    const e = await this.entry(path, owner);
    return this.serialEntry(e, async () => ({
      ok: true,
      tools: await listNative(e.daemon),
      limits: {
        scriptBytes: 262144,
        inserts: 4096,
        scriptTimeMs: 2000,
        scriptMemoryBytes: 67108864,
      },
      nodeFields:
        "Native node objects use type, name, width, height, layout, children through insertion bindings, fill arrays, stroke objects, and node-specific control fields. Query list_node_kinds and inspect existing nodes.",
    }));
  }
  private dirtyError(b: BrowserState): StudioError {
    return new StudioError(
      "UNSAVED_USER_CHANGES",
      "Ask the user how to handle their unsaved canvas before editing this file",
      {
        editorRevision: b.state.revision,
        generation: b.state.generation,
        choices: ["save-user", "discard-user", "edit-saved", "cancel"],
        recoverable: true,
      },
    );
  }
  private async command(
    b: BrowserState,
    type: Command["type"],
    extra: Omit<Partial<Command>, "id" | "type"> = {},
  ): Promise<StudioSnapshot> {
    if (b.command)
      throw new StudioError(
        "EDITOR_BUSY",
        "An editor command is already pending",
      );
    const command: Command = { id: randomUUID(), type, ...extra };
    delete b.commandFailure;
    b.command = command;
    const deadline = Date.now() + 10000;
    try {
      while (Date.now() < deadline) {
        if (b.commandFailure) throw b.commandFailure;
        if (!b.command) {
          if (b.state.leaseId !== command.id && type !== "release")
            throw new StudioError(
              "EDITOR_COMMAND_FAILED",
              "Editor rejected the command",
              { command: type },
            );
          return b.state;
        }
        await new Promise((r) => setTimeout(r, 40));
      }
      throw new StudioError(
        "EDITOR_UNRESPONSIVE",
        "The editor did not acknowledge the command; no file change was authorized",
        { recoverable: true },
      );
    } catch (error) {
      if (type === "lease") delete b.lease;
      throw error;
    } finally {
      if (b.command?.id === command.id) delete b.command;
    }
  }
  private async lease(e: Entry): Promise<BrowserState | undefined> {
    const b = e.browser;
    if (!b) return;
    if (b.state.dirty && !(b.choice?.mode === "edit-saved" && b.choice.revision === b.state.revision))
      throw this.dirtyError(b);
    // Tool transactions only lock Host writes. A clean or disconnected canvas
    // must never be required to acknowledge work on the independent copy.
    b.toolLease = randomUUID();
    return b;
  }
  private queueCanvasSync(e: Entry, b: BrowserState, documentJson: string) {
    b.pendingSync = { id: randomUUID(), documentJson, sourceHash: e.baseline };
    b.needsReload = true;
  }
  private async release(b: BrowserState) {
    if (b.toolLease) {
      delete b.toolLease;
      return;
    }
    delete b.lease;
    try {
      await this.command(b, "release");
    } catch {
      /* Heartbeats unlock only after the host clears its lease. */
    }
  }
  async call(
    path: string,
    owner: string,
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    expectedWorkingVersion?: number,
  ) {
    args = normalizeNativeArguments(name, args);
    let creation: CreationPlan | undefined;
    if (name === "batch_design" && typeof args.script === "string") {
      creation = await planCreation(args.script);
      args = { ...args, script: creation.script };
    }
    const e = await this.entry(path, owner, !isRead(name));
    return this.serialEntry(e, async () => {
      const history = e.history ??= new DocumentHistory();
      if (isRead(name)) {
        const native = name === "get_history_depth"
          ? history.depth(documentHash((await this.snapshot(e)).documentJson))
          : name === "get_selection" && e.browser
            ? await this.browserSelection(e.browser.id)
            : await callNative(e.daemon, name, args, signal);
        return {
          ok: true,
          path: e.path,
          native,
          ...(name === "get_selection"
            ? {
                selectionSource: e.browser ? "user-canvas" : "agent-working-copy",
                selectionIsEditAuthorization: false,
                unsaved: e.browser?.state.dirty ?? false,
              }
            : {}),
        };
      }
      await this.authorize(e.path, owner, true);
      const browser = await this.lease(e);
      let before: Snapshot | undefined;
      try {
        before = await this.snapshot(e);
        if (
          expectedWorkingVersion !== undefined &&
          before.version !== expectedWorkingVersion
        )
          throw new StudioError(
            "WORKING_VERSION_CHANGED",
            "Working document changed; read it before retrying",
            { recoverable: true, committed: false },
          );
        if (hash(await readFile(e.path, "utf8")) !== e.baseline)
          throw new StudioError(
            "SOURCE_CHANGED",
            "The saved file changed; use pencil_reload after reviewing the conflict",
            { recoverable: true },
          );
        let historyTarget: ReturnType<DocumentHistory["target"]> | undefined;
        let value: unknown;
        if (name === "undo" || name === "redo") {
          historyTarget = history.target(name, documentHash(before.documentJson));
          const document = parseDocument(historyTarget.documentJson);
          document.editorMeta = parseDocument(before.documentJson).editorMeta;
          await restoreAuthoredSnapshot(e.daemon.baseUrl, {
            documentJson: JSON.stringify(document), version: before.version,
          });
          value = { [name === "undo" ? "undone" : "redone"]: true, scope: "agent-working-copy" };
        } else {
          value = await callNative(
            e.daemon,
            name,
            {
              ...args,
              ...(name === "batch_design"
                ? { postProcess: args.postProcess ?? false }
                : {}),
            },
            signal,
          );
        }
        let after = await this.snapshot(e);
        const authored = parseDocument(after.documentJson);
        if (creation && preserveCreation(parseDocument(before.documentJson), authored, creation, value)) {
          await restoreAuthoredSnapshot(e.daemon.baseUrl, { documentJson: JSON.stringify(authored), version: after.version });
          after = await this.snapshot(e);
          parseDocument(after.documentJson);
        }
        const beforeHash = documentHash(before.documentJson);
        const afterHash = documentHash(after.documentJson);
        if (historyTarget && afterHash !== historyTarget.hash)
          throw new StudioError("HISTORY_RESTORE_MISMATCH", "Native restore changed the requested history document", { committed: false });
        await atomicWrite(e.backing, after.documentJson);
        e.phase = "editing";
        delete e.lastError;
        await this.metadata(e);
        if (historyTarget && (name === "undo" || name === "redo"))
          history.complete(name, before.documentJson, beforeHash, historyTarget);
        else history.record(before.documentJson, beforeHash, afterHash);
        if (browser && afterHash !== beforeHash) this.queueCanvasSync(e, browser, after.documentJson);
        return {
          ok: true,
          path: e.path,
          native: value,
          saved: afterHash === e.documentBaseline,
          workingVersion: after.version,
          stage: "editing",
          next: "Continue editing or run pencil_validate, then pencil_save to persist this document.",
        };
      } catch (error) {
        const current = await this.snapshot(e).catch(() => undefined);
        if (
          before &&
          current &&
          hash(current.documentJson) !== hash(before.documentJson)
        ) {
          try {
            await (
              await official()
            ).restore(e.daemon.baseUrl, e.daemon.token, {
              documentJson: before.documentJson,
              version: current.version,
            });
          } catch (rollback) {
            e.phase = "error";
            e.lastError = {
              error: String(error),
              rollbackError: String(rollback),
              checkpointRetained: true,
            };
            await this.metadata(e);
            throw new StudioError(
              "HOST_RECOVERY_REQUIRED",
              "Native recovery failed; the last committed checkpoint is retained",
              e.lastError,
            );
          }
        }
        throw error;
      } finally {
        if (browser) await this.release(browser);
      }
    });
  }
  async controlSemantics(
    path: string,
    owner: string,
    nodeId: string,
    semantics: ControlSemantics,
  ) {
    const e = await this.entry(path, owner, true);
    const snap = await this.serialEntry(e, () => this.snapshot(e));
    const doc = parseDocument(snap.documentJson);
    const roots = Array.isArray(doc.pages)
      ? doc.pages.flatMap((p) =>
          Array.isArray(record(p)?.children)
            ? (record(p)?.children as unknown[])
            : [],
        )
      : Array.isArray(doc.children)
        ? doc.children
        : [];
    const find = (nodes: unknown[]): Record<string, unknown> | undefined => {
      for (const raw of nodes) {
        const n = record(raw);
        if (!n) continue;
        if (n.id === nodeId) return n;
        const nested = find(Array.isArray(n.children) ? n.children : []);
        if (nested) return nested;
      }
      return undefined;
    };
    const node = find(roots);
    if (
      !node ||
      !["text_input", "text_area", "select", "checkbox", "switch"].includes(
        String(node.type),
      )
    )
      throw new StudioError(
        "CONTROL_NODE_REQUIRED",
        "Expected a real control node ID",
        { nodeId },
      );
    return this.call(
      path,
      owner,
      "set_variables",
      {
        variables: withControlSemantics(doc, nodeId, semantics),
        replace: true,
      },
      undefined,
      snap.version,
    );
  }
  async validate(path: string, owner: string) {
    const e = await this.entry(path, owner);
    return this.serialEntry(e, () => this.validation(e));
  }
  async preview(path: string, owner: string, nodeId?: string) {
    const e = await this.entry(path, owner);
    return this.serialEntry(e, async () => {
    const snap = await this.snapshot(e);
    const frames = await renderPages(
      parseDocument(snap.documentJson),
      join(e.directory, "previews"),
      this.origin,
      nodeId,
    );
    return {
      ok: true,
      path: e.path,
      saved: documentHash(snap.documentJson) === e.documentBaseline,
      renderer: "openpencil-native",
      frames: frames.map((frame) => {
        const id = randomUUID();
        this.previews.set(id, { path: frame.path, sourcePath: e.path, owner });
        return { ...frame, previewId: id };
      }),
    };
    });
  }
  async reloadBrowser(id: string, generation: number, revision: number) {
    const { entry: e } = this.browser(id);
    return this.serialEntry(e, async () => {
    const b = this.browser(id).browser;
    if (b.state.generation !== generation || b.state.revision !== revision)
      throw new StudioError(
        "EDITOR_REVISION_CHANGED",
        "Canvas changed after reload confirmation",
      );
    await this.command(b, "lease");
    try {
      if (b.state.generation !== generation || b.state.revision !== revision)
        throw new StudioError(
          "EDITOR_REVISION_CHANGED",
          "Canvas changed after reload confirmation",
        );
      const text = await readFile(e.path, "utf8");
      await this.command(b, "reload", { documentJson: text, revision });
      await this.syncBrowser(e, b, text);
      delete b.choice;
      return { ok: true, reloaded: true };
    } finally {
      await this.release(b);
    }
    });
  }
  private async documentDiagnostics(
    daemon: ManagedEditorDaemon,
    doc: Record<string, unknown>,
  ) {
    const diagnostics = technicalDiagnostics(doc);
    const nativeLint: unknown[] = [];
    const pages = Array.isArray(doc.pages) ? doc.pages : [];
    const originalPage = Number(record(doc.editorMeta)?.activePageIndex ?? 0);
    try {
      for (let index = 0; index < Math.max(1, pages.length); index++) {
        if (pages.length > 1)
          await callNative(daemon, "set_active_page", { index: String(index) });
        const lint = await callNative(daemon, "lint_document", {});
        const quality = await callNative(daemon, "get_design_quality", {});
        nativeLint.push(lint);
        diagnostics.push(
          ...nativeDiagnostics(lint),
          ...nativeQualityDiagnostics(doc, quality),
        );
      }
    } finally {
      if (pages.length > 1)
        await callNative(daemon, "set_active_page", {
          index: String(originalPage),
        });
    }
    return { diagnostics, nativeLint };
  }
  private async validateCanvasDocument(e: Entry, text: string) {
    const doc = parseDocument(text);
    const path = join(e.directory, "validation", randomUUID(), "document.op");
    await atomicWrite(path, text);
    const daemon = await this.start(path);
    try {
      return (await this.documentDiagnostics(daemon, doc)).diagnostics;
    } finally {
      await stopManagedEditorDaemon(daemon);
    }
  }
  private async validation(e: Entry) {
    const snap = await this.snapshot(e);
    const { diagnostics, nativeLint } = await this.documentDiagnostics(
      e.daemon,
      parseDocument(snap.documentJson),
    );
    return {
      ok: true,
      path: e.path,
      valid: !diagnostics.some((i) => i.blocking),
      diagnostics,
      nativeLint,
      workingVersion: (await this.snapshot(e)).version,
      repairTargets: diagnostics
        .filter((i) => i.nodeId)
        .map((i) => ({
          nodeId: i.nodeId,
          source: i.source,
          code: i.code,
          blocking: i.blocking,
          repair: i.repair,
          ...(i.patch ? { patch: i.patch } : {}),
        })),
    };
  }
  async save(path: string, owner: string) {
    const e = await this.entry(path, owner, true);
    return this.serialEntry(e, async () => {
      const b = await this.lease(e);
      try {
        const validation = await this.validation(e);
        if (!validation.valid)
          throw new StudioError(
            "VALIDATION_REQUIRED",
            "Correct blocking technical diagnostics and save again",
            validation,
          );
        const snap = await this.snapshot(e);
        await this.commit(e, snap.documentJson);
        e.phase = "saved";
        await this.metadata(e);
        if (b) this.queueCanvasSync(e, b, snap.documentJson);
        return {
          ok: true,
          path: e.path,
          saved: true,
          editable: true,
          stage: "saved",
          diagnostics: validation.diagnostics,
          editorNeedsReload: b?.needsReload ?? false,
        };
      } finally {
        if (b) await this.release(b);
      }
    });
  }
  private async commit(e: Entry, text: string) {
    parseDocument(text);
    await this.serialRecovery(e, async () => {
      await this.recoveryRecord(e);
      await this.dismissedRecoveryHashes(e);
    });
    await atomicWrite(e.path, text, async () => {
      await this.authorize(e.path, e.owner, true);
      if (hash(await readFile(e.path, "utf8")) !== e.baseline)
        throw new StudioError(
          "SAVE_CONFLICT",
          "The source file changed since this working copy was loaded; no overwrite performed",
          { recoverable: true },
        );
    });
    e.baseline = hash(text);
    e.documentBaseline = documentHash(text);
    await atomicWrite(e.backing, text);
    await this.retireSavedRecovery(e, text);
  }
  private async syncBrowser(_e: Entry, b: BrowserState, text: string) {
    const live = await (
      await official()
    ).read(b.daemon.baseUrl, b.daemon.token);
    await (
      await official()
    ).restore(b.daemon.baseUrl, b.daemon.token, {
      documentJson: text,
      version: live.version,
    });
    b.baseline = hash(text);
    b.needsReload = false;
    delete b.pendingSync;
  }
  async resolveUnsaved(
    path: string,
    owner: string,
    mode: "save-user" | "discard-user" | "edit-saved" | "cancel",
    revision: number,
  ) {
    const e = await this.entry(path, owner, true);
    return this.serialEntry(e, async () => {
      const b = e.browser;
      if (!b)
        throw new StudioError(
          "NO_USER_CANVAS",
          "There is no attached user canvas",
        );
      await this.command(b, "lease");
      try {
        if (b.state.revision !== revision)
          throw new StudioError(
            "EDITOR_REVISION_CHANGED",
            "The user canvas changed after confirmation; ask again",
            { editorRevision: b.state.revision },
          );
        if (mode === "cancel") return { ok: true, cancelled: true };
        if (mode === "edit-saved") {
          b.choice = { mode, revision };
          return {
            ok: true,
            mode,
            editorRevision: revision,
            next: "The next mutation may edit the working file while retaining the user canvas.",
          };
        }
        if (mode === "save-user") {
          if (
            documentHash((await this.snapshot(e)).documentJson) !==
            e.documentBaseline
          )
            throw new StudioError(
              "AGENT_WORKING_CHANGES",
              "Agent work is also unsaved. Save or explicitly reload that working copy before saving the user canvas.",
            );
          await this.command(b, "save", { revision });
          const source = await readFile(e.path, "utf8");
          const snap = await this.snapshot(e);
          await (
            await official()
          ).restore(e.daemon.baseUrl, e.daemon.token, {
            documentJson: source,
            version: snap.version,
          });
          await atomicWrite(e.backing, source);
          e.baseline = hash(source);
          e.documentBaseline = documentHash(source);
          await this.metadata(e);
        } else {
          const source = await readFile(e.path, "utf8");
          await this.command(b, "reload", { documentJson: source, revision });
          b.baseline = hash(source);
          b.needsReload = false;
          delete b.pendingSync;
        }
        return { ok: true, mode, editorRevision: b.state.revision };
      } finally {
        if (mode !== "edit-saved") await this.release(b);
        else {
          delete b.lease;
          await this.command(b, "release");
        }
      }
    });
  }
  async reload(path: string, owner: string, discardAgentChanges: boolean) {
    if (!discardAgentChanges)
      throw new StudioError(
        "EXPLICIT_DISCARD_REQUIRED",
        "Confirm discardAgentChanges before reloading the saved file",
      );
    const e = await this.entry(path, owner, true);
    return this.serialEntry(e, async () => {
      const b = await this.lease(e);
      try {
        const text = await readFile(e.path, "utf8");
        parseDocument(text);
        const snap = await this.snapshot(e);
        await (
          await official()
        ).restore(e.daemon.baseUrl, e.daemon.token, {
          documentJson: text,
          version: snap.version,
        });
        await atomicWrite(e.backing, text);
        e.baseline = hash(text);
        e.documentBaseline = documentHash(text);
        e.phase = "ready";
        await this.metadata(e);
        e.history?.clear();
        if (b) this.queueCanvasSync(e, b, text);
        return { ok: true, path: e.path, reloaded: true };
      } finally {
        if (b) await this.release(b);
      }
    });
  }
  async grantForDocument(
    path: string,
    _text: string,
    context?: { sessionId: string },
  ): Promise<PresentationGrant> {
    if (!context)
      throw new StudioError(
        "SESSION_REQUIRED",
        "Workspace must pass the owning session ID; install the Studio workspace integration",
      );
    const e = await this.entry(path, context.sessionId);
    const id = randomUUID();
    this.grants.set(id, { path: e.path, owner: context.sessionId });
    return {
      sourcePath: e.path,
      document: { path: e.path, url: ROUTE + "/grant/" + id + "/document" },
      editor: {
        enabled: true,
        launchUrl: ROUTE + "/grant/" + id + "/launch",
        refreshUrl: ROUTE + "/refresh",
      },
    };
  }
  async attach(id: string, owner: string) {
    const grant = this.grants.get(id);
    if (!grant || grant.owner !== owner)
      throw new StudioError(
        "INVALID_GRANT",
        "Editor capability is not owned by this session",
      );
    const e = await this.entry(grant.path, owner, true);
    return this.serialEntry(e, async () => {
      if (this.grants.get(id) !== grant)
        throw new StudioError("INVALID_GRANT", "Editor capability was released; reopen the document");
      if (e.browser) return this.launchResult(e, e.browser);
      const text = await readFile(e.path, "utf8");
      const backing = join(e.directory, "browser", randomUUID(), "document.op");
      await atomicWrite(backing, text);
      const daemon = await this.start(backing);
      const b: BrowserState = {
        id: randomUUID(),
        daemon,
        baseline: hash(text),
        state: { dirty: false, generation: 0, revision: 0, sequence: 0, phase: "loading" },
        reportedAt: 0,
        needsReload: false,
      };
      e.browser = b;
      try {
        return await this.launchResult(e, b);
      } catch (error) {
        delete e.browser;
        await stopManagedEditorDaemon(daemon);
        throw error;
      }
    });
  }
  private async launchResult(e: Entry, b: BrowserState) {
    const base = ROUTE + "/editor/" + b.id;
    return {
      sessionId: b.id,
      iframeUrl: canvasPrefix(b.id) + "?embed=vscode",
      token: b.daemon.token,
      saveUrl: base + "/save",
      closeUrl: base + "/close",
      selectionUrl: base + "/selection",
      recoveryUrl: base + "/recovery",
      stateUrl: base + "/state",
      docJson: (await (await official()).read(b.daemon.baseUrl, b.daemon.token))
        .documentJson,
      sourcePath: e.path,
      ...((await this.recoverySummary(e))
        ? { recovery: await this.recoverySummary(e) }
        : {}),
    };
  }
  browser(id: string) {
    const e = [...this.entries.values()].find((x) => x.browser?.id === id);
    if (!e || !e.browser)
      throw new StudioError(
        "EDITOR_NOT_FOUND",
        "Editor was closed; reopen the document",
      );
    return { entry: e, browser: e.browser };
  }
  async browserSelection(id: string) {
    const { entry: e, browser: b } = this.browser(id);
    const response = await fetch(new URL("/api/mcp/selection", b.daemon.baseUrl), {
      headers: { "x-openpencil-token": b.daemon.token }, signal: AbortSignal.timeout(5000),
    });
    const value = record(await response.json());
    if (!response.ok || !value || !Array.isArray(value.selectedIds) || !value.selectedIds.every(x => typeof x === "string"))
      throw new StudioError("SELECTION_UNAVAILABLE", "Live canvas selection could not be read", { recoverable:true,status:response.status });
    const document = parseDocument((await (await official()).read(b.daemon.baseUrl,b.daemon.token)).documentJson);
    const byId = new Map<string,Record<string,unknown>>();
    const visit = (raw:unknown) => { const node=record(raw);if(!node)return;if(typeof node.id === "string")byId.set(node.id,node);if(Array.isArray(node.children))node.children.forEach(visit); };
    if(Array.isArray(document.children))document.children.forEach(visit);
    if(Array.isArray(document.pages))document.pages.forEach(visit);
    const selectedIds = value.selectedIds as string[];
    const nodes = selectedIds.flatMap(nodeId=>{const node=byId.get(nodeId);return node?[Object.fromEntries(["id","type","name","x","y","width","height"].filter(key=>key in node).map(key=>[key,node[key]]))]:[];});
    const selection = { sourcePath:e.path, activePageId:String(value.activePageId ?? record(document.editorMeta)?.activePageIndex ?? 0), selectedIds,nodes, unresolvedIds:selectedIds.filter(nodeId=>!byId.has(nodeId)),updatedAt:Date.now(),source:"user-canvas",generation:b.state.generation,revision:b.state.revision };
    b.state.selection = selection;
    return selection;
  }
  private browserReport(b: BrowserState) {
    const activeLease = b.toolLease ?? b.lease ?? null;
    return {
      command: b.command ?? null,
      needsReload: b.needsReload,
      activeLease,
      ...(!activeLease && !b.command && !b.state.dirty && b.pendingSync
        ? { sync: { id: b.pendingSync.id, documentJson: b.pendingSync.documentJson } }
        : {}),
    };
  }
  report(
    id: string,
    state: StudioSnapshot,
    ack?: string,
    failedCommand?: { id: string; message: string },
    syncAck?: string,
  ) {
    const { browser: b } = this.browser(id);
    if (state.sequence <= b.state.sequence) return this.browserReport(b);
    if (state.revision !== b.state.revision || state.generation !== b.state.generation)
      delete b.choice;
    b.state = { ...state, selection: b.state.selection };
    b.reportedAt = Date.now();
    if (failedCommand && failedCommand.id === b.command?.id)
      b.commandFailure ??= new StudioError(
        "EDITOR_COMMAND_FAILED", failedCommand.message,
        { command: b.command?.type, recoverable: true, committed: false },
      );
    if (ack && b.command?.id === ack) {
      if (b.command.type === "lease" && state.leaseId === ack) b.lease = ack;
      delete b.command;
    }
    // A late refresh acknowledgement cannot consume a newer document update.
    if (syncAck && syncAck === b.pendingSync?.id && !state.dirty &&
        state.phase === "ready" && !b.toolLease && !b.lease && !b.command) {
      b.baseline = b.pendingSync.sourceHash;
      b.needsReload = false;
      delete b.pendingSync;
    }
    return this.browserReport(b);
  }
  async saveBrowser(
    id: string,
    documentJson: string,
    generation: number,
    revision: number,
  ) {
    const { entry: e, browser: b } = this.browser(id);
    const run = async () => {
      if ((b.toolLease || b.lease || b.command) && b.command?.type !== "save")
        throw new StudioError(
          "EDITOR_WRITE_LEASE",
          "Agent is committing an edit; retry after it completes",
        );
      if (b.state.generation !== generation || b.state.revision !== revision)
        throw new StudioError(
          "EDITOR_REVISION_CHANGED",
          "Canvas changed during save; the newer edits remain unsaved",
        );
      await this.authorize(e.path, e.owner, true);
      const diagnostics = await this.validateCanvasDocument(e, documentJson);
      if (diagnostics.some((x) => x.blocking))
        throw new StudioError(
          "VALIDATION_REQUIRED",
          "Correct blocking canvas diagnostics",
          {
            diagnostics,
            repairTargets: diagnostics
              .filter((i) => i.nodeId)
              .map((i) => ({
                nodeId: i.nodeId,
                source: i.source,
                code: i.code,
                blocking: i.blocking,
                repair: i.repair,
                ...(i.patch ? { patch: i.patch } : {}),
              })),
          },
        );
      const before = await this.snapshot(e);
      if (documentHash(before.documentJson) !== e.documentBaseline)
        throw new StudioError(
          "AGENT_WORKING_CHANGES",
          "Agent work is also unsaved; save or explicitly reload that working copy before saving the canvas.",
        );
      if (hash(await readFile(e.path, "utf8")) !== b.baseline)
        throw new StudioError(
          "SAVE_CONFLICT",
          "Source changed outside this canvas; use explicit reload",
        );
      if ((b.toolLease || b.lease || b.command) && b.command?.type !== "save")
        throw new StudioError(
          "EDITOR_WRITE_LEASE",
          "The editor acquired a write lease during save; retry later",
        );
      await this.commit(e, documentJson);
      await (
        await official()
      ).restore(e.daemon.baseUrl, e.daemon.token, {
        documentJson,
        version: before.version,
      });
      b.baseline = hash(documentJson);
      b.needsReload = false;
      delete b.pendingSync;
      e.phase = "saved";
      await this.metadata(e);
      return { ok: true, saved: true, revision, generation };
    };
    const invoke = async () => {
      try {
        return await run();
      } catch (error) {
        if (b.command?.type === "save") b.commandFailure = error;
        throw error;
      }
    };
    if (b.command?.type === "save") return invoke();
    return this.serialEntry(e, invoke);
  }
  private serialRecovery<T>(e: Entry, run: () => Promise<T>): Promise<T> {
    // Checkpoint callbacks can arrive while flushOwner holds the document queue.
    // Keep every recovery read/write on its own queue, including source saves.
    return this.serial("recovery\0" + e.directory, run);
  }
  private async recoveryRecord(e: Entry) {
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(await readFile(join(e.directory, "recovery", "latest.json"), "utf8")));
    } catch (error) {
      if (record(error)?.code === "ENOENT") return undefined;
      if (error instanceof SyntaxError) throw new StudioError("RECOVERY_METADATA_INVALID", "Recovery metadata is invalid; retained snapshots were not changed");
      throw error;
    }
    if (!value || typeof value.id !== "string" || !/^[A-Za-z0-9_-]{43}$/.test(value.id) ||
        !Number.isSafeInteger(value.capturedAt) || Number(value.capturedAt) <= 0 ||
        !Number.isSafeInteger(value.bytes) || Number(value.bytes) <= 0 ||
        typeof value.sourceHash !== "string" || !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
        typeof value.precise !== "boolean" ||
        (value.authoredHash !== undefined && (typeof value.authoredHash !== "string" || !/^[a-f0-9]{64}$/.test(value.authoredHash))) ||
        (value.retired !== undefined && typeof value.retired !== "boolean"))
      throw new StudioError("RECOVERY_METADATA_INVALID", "Recovery metadata is invalid; retained snapshots were not changed");
    return value;
  }
  private async recoveryAuthoredHash(e: Entry, saved: Record<string, unknown>): Promise<string> {
    if (typeof saved.authoredHash === "string") return saved.authoredHash;
    // Older checkpoints did not store a content version. Derive it from their
    // retained snapshot, never from the currently loaded source or daemon.
    const text = await readFile(join(e.directory, "recovery", String(saved.id) + ".op"), "utf8");
    parseDocument(text);
    return documentHash(text);
  }
  private async dismissedRecoveryHashes(e: Entry): Promise<string[]> {
    let value: Record<string, unknown> | undefined;
    try {
      value = record(JSON.parse(await readFile(join(e.directory, "recovery", "dismissed.json"), "utf8")));
    } catch (error) {
      if (record(error)?.code === "ENOENT") return [];
      if (error instanceof SyntaxError) throw new StudioError("RECOVERY_METADATA_INVALID", "Recovery dismissal metadata is invalid; retained snapshots were not changed");
      throw error;
    }
    if (!value || value.version !== 1 || !Array.isArray(value.authoredHashes) ||
        !value.authoredHashes.every((item) => typeof item === "string" && /^[a-f0-9]{64}$/.test(item)))
      throw new StudioError("RECOVERY_METADATA_INVALID", "Recovery dismissal metadata is invalid; retained snapshots were not changed");
    return value.authoredHashes as string[];
  }
  private async pendingRecoverySummary(e: Entry) {
    const saved = await this.recoveryRecord(e);
    if (!saved || saved.retired === true) return undefined;
    const authoredHash = await this.recoveryAuthoredHash(e, saved);
    if ((await this.dismissedRecoveryHashes(e)).includes(authoredHash)) return undefined;
    const source = await readFile(e.path, "utf8");
    if (documentHash(source) === authoredHash) return undefined;
    return {
      id: String(saved.id),
      capturedAt: Number(saved.capturedAt),
      bytes: Number(saved.bytes),
      sourceName: basename(e.path),
      sourceChangedSinceCapture: hash(source) !== saved.sourceHash,
      cacheLabel: "openpencil-studio/recovery/" + String(saved.id),
    };
  }
  private recoverySummary(e: Entry) {
    return this.serialRecovery(e, () => this.pendingRecoverySummary(e));
  }
  private retireSavedRecovery(e: Entry, text: string) {
    return this.serialRecovery(e, async () => {
      const saved = await this.recoveryRecord(e);
      if (!saved || await this.recoveryAuthoredHash(e, saved) !== documentHash(text)) return;
      await atomicWrite(join(e.directory, "recovery", "latest.json"), JSON.stringify({
        ...saved, authoredHash: documentHash(text), retired: true,
      }));
    });
  }
  private captureRecovery(e: Entry, b: BrowserState, documentJson?: string, precise = documentJson !== undefined) {
    return this.serialRecovery(e, async () => {
      if (this.browser(b.id).browser !== b)
        throw new StudioError("EDITOR_NOT_FOUND", "Editor changed during recovery capture; reopen the document");
      const previous = await this.recoveryRecord(e);
      await this.dismissedRecoveryHashes(e);
      if (!precise && previous?.precise === true)
        return {
          ok: true,
          recovery: await this.pendingRecoverySummary(e),
          retained: true,
          automaticExpiry: false,
        };
      const text = documentJson ??
        (await (await official()).read(b.daemon.baseUrl, b.daemon.token)).documentJson;
      parseDocument(text);
      const authoredHash = documentHash(text);
      const recoveryId = randomBytes(32).toString("base64url");
      const path = join(e.directory, "recovery", recoveryId + ".op");
      const source = await readFile(e.path, "utf8");
      const retired = documentHash(source) === authoredHash ||
        (previous?.retired === true && await this.recoveryAuthoredHash(e, previous) === authoredHash);
      await atomicWrite(path, text);
      await atomicWrite(join(e.directory, "recovery", "latest.json"), JSON.stringify({
        id: recoveryId,
        capturedAt: Date.now(),
        bytes: Buffer.byteLength(text),
        sourceHash: b.baseline,
        precise,
        authoredHash,
        retired,
      }));
      return {
        ok: true,
        path,
        recovery: await this.pendingRecoverySummary(e),
        retained: true,
        automaticExpiry: false,
        precise,
      };
    });
  }
  async recovery(id: string, documentJson?: string) {
    const { entry: e, browser: b } = this.browser(id);
    const checkpointId = b.command?.type === "checkpoint" ? b.command.id : undefined;
    const run = async () => {
      try { return await this.captureRecovery(e, b, documentJson); }
      catch (error) {
        // Preserve Host durability failures even if the client reports only a
        // generic command failure or subsequently disconnects.
        if (checkpointId && b.command?.id === checkpointId)
          b.checkpointFailure = { commandId: checkpointId, error };
        throw error;
      }
    };
    // The caller awaiting this command already owns the document queue.
    if (b.command?.type === "checkpoint") return run();
    return this.serialEntry(e, run);
  }
  async recoveryItem(id: string, recoveryId: string, discard = false) {
    const { entry: e, browser: b } = this.browser(id);
    return this.serialEntry(e, () => this.serialRecovery(e, async () => {
      if (this.browser(id).browser !== b)
        throw new StudioError("EDITOR_NOT_FOUND", "Editor changed; reopen the document");
      const latest = await this.recoveryRecord(e);
      if (latest?.id !== recoveryId)
        throw new StudioError(
          "RECOVERY_NOT_FOUND",
          "The requested recovery is not the current snapshot for this document",
        );
      if (discard) {
        const authoredHash = await this.recoveryAuthoredHash(e, latest);
        const authoredHashes = [...new Set([...(await this.dismissedRecoveryHashes(e)), authoredHash])];
        await atomicWrite(join(e.directory, "recovery", "dismissed.json"), JSON.stringify({ version: 1, authoredHashes }));
        return { ok: true, ignored: true, snapshotRetained: true };
      }
      const docJson = await readFile(join(e.directory, "recovery", recoveryId + ".op"), "utf8");
      parseDocument(docJson);
      return { ok: true, docJson, retained: true };
    }));
  }
  private async stopBrowser(e: Entry, b: BrowserState) {
    if (b.lease || b.toolLease || b.command)
      throw new StudioError("EDITOR_BUSY", "Wait for the active editor transaction before closing");
    await stopManagedEditorDaemon(b.daemon);
    delete e.browser;
  }
  async closeBrowser(id: string) {
    const { entry: e } = this.browser(id);
    return this.serialEntry(e, async () => {
      const { browser: b } = this.browser(id);
      await this.stopBrowser(e, b);
      return { ok: true, closed: true };
    });
  }
  private async clearPreviews(owner: string, sourcePath?: string) {
    const directories = new Map<string, string>();
    for (const [id, p] of this.previews) {
      if (p.owner !== owner || (sourcePath !== undefined && p.sourcePath !== sourcePath)) continue;
      directories.set(dirname(p.path), join(this.root, hash(p.sourcePath + "\0" + owner), "previews"));
      this.previews.delete(id);
    }
    const removed = await Promise.allSettled([...directories].map(([directory, previewRoot]) =>
      removePreviewDirectory(directory, previewRoot)));
    const failures = removed.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length)
      throw new StudioError("PREVIEW_CLEANUP_PARTIAL", "Preview grants were released; some temporary files could not be removed", { diagnostics: failures.map((r) => String(r.reason)) });
  }
  async close(path: string, owner: string) {
    const e = await this.entry(path, owner);
    return this.serialEntry(e, async () => {
      if (e.browser?.state.dirty) throw this.dirtyError(e.browser);
      if (e.browser) await this.stopBrowser(e, e.browser);
      await stopManagedEditorDaemon(e.daemon);
      this.entries.delete(e.path);
      for (const [id, grant] of this.grants)
        if (grant.path === e.path && grant.owner === owner) this.grants.delete(id);
      await this.clearPreviews(owner, e.path);
      return { ok: true, closed: true, checkpointRetained: true };
    });
  }
  async flushOwner(owner: string) {
    const warnings: Record<string, unknown>[] = [];
    for (const e of [...this.entries.values()].filter((e) => e.owner === owner))
      await this.serialEntry(e, async () => {
        await atomicWrite(e.backing, (await this.snapshot(e)).documentJson);
        await this.metadata(e);
        const b = e.browser;
        if (!b?.state.dirty) return;
        const callbackFailure = (): BrowserState["checkpointFailure"] => b.checkpointFailure;
        delete b.checkpointFailure;
        try {
          if (Date.now() - b.reportedAt >= 5000 || b.state.phase !== "ready")
            throw new StudioError("EDITOR_UNRESPONSIVE", "The canvas is disconnected; its latest edits could not be checkpointed");
          await this.command(b, "checkpoint");
          const failure = callbackFailure();
          if (failure) throw failure.error;
          delete e.checkpointWarning;
        } catch (error) {
          const failure = callbackFailure();
          if (failure) {
            delete b.checkpointFailure;
            throw failure.error;
          }
          // Browser availability must not veto the durable agent/session checkpoint.
          // Recovery metadata and disk failures still reject: they are durability failures.
          const previous = await this.serialRecovery(e, async () => {
            const saved = await this.recoveryRecord(e);
            await this.dismissedRecoveryHashes(e);
            if (saved) parseDocument(await readFile(join(e.directory, "recovery", String(saved.id) + ".op"), "utf8"));
            return saved;
          });
          let snapshotRetained = previous !== undefined;
          let capture: "retained" | "fallback" | "unavailable" = "retained";
          if (previous?.precise !== true) {
            let fallback: Snapshot | undefined;
            try {
              fallback = await (await official()).read(b.daemon.baseUrl, b.daemon.token);
            } catch {
              capture = "unavailable";
            }
            if (fallback) {
              await this.captureRecovery(e, b, fallback.documentJson, false);
              snapshotRetained = true;
              capture = "fallback";
            }
          }
          const warning = {
            code: "EDITOR_CHECKPOINT_UNAVAILABLE",
            error: error instanceof Error ? error.message : String(error),
            workingCheckpointRetained: true,
            browserSnapshotRetained: snapshotRetained,
            latestCanvasSnapshotCaptured: false,
            capture,
            editorRevision: b.state.revision,
          };
          e.checkpointWarning = warning;
          warnings.push(warning);
        }
      });
    return { ok: true, warnings };
  }
  async endOwner(owner: string) {
    const pending = this.endingOwners.get(owner);
    if (pending) return pending;
    const cleanup = this.cleanupOwner(owner);
    this.endingOwners.set(owner, cleanup);
    try {
      return await cleanup;
    } finally {
      if (this.endingOwners.get(owner) === cleanup) this.endingOwners.delete(owner);
    }
  }
  private async cleanupOwner(owner: string) {
    this.ownerEpochs.set(owner, (this.ownerEpochs.get(owner) ?? 0) + 1);
    await Promise.allSettled([...(this.openingEntries.get(owner) ?? [])]);
    const failures: unknown[] = [];
    for (const e of [...this.entries.values()].filter((e) => e.owner === owner)) {
      try {
        await this.serial(e.path, async () => {
          if (this.entries.get(e.path) !== e) return;
          try {
            await atomicWrite(e.backing, (await this.snapshot(e)).documentJson);
            await this.metadata(e);
          } catch (error) {
            failures.push(error);
          }
          const stopped = await Promise.allSettled([
            stopManagedEditorDaemon(e.daemon),
            ...(e.browser ? [stopManagedEditorDaemon(e.browser.daemon)] : []),
          ]);
          for (const r of stopped)
            if (r.status === "rejected") failures.push(r.reason);
          this.entries.delete(e.path);
        });
      } catch (error) {
        failures.push(error);
      }
    }
    for (const [id, g] of this.grants)
      if (g.owner === owner) this.grants.delete(id);
    try {
      await this.clearPreviews(owner);
    } catch (error) {
      failures.push(error);
    }
    if (failures.length)
      throw new StudioError(
        "SESSION_CLEANUP_PARTIAL",
        "Session registrations were released; retained checkpoints may need manual recovery",
        { diagnostics: failures.map(String), checkpointRetained: true },
      );
    return { ok: true, closed: true, checkpointRetained: true };
  }
  async dispose() {
    this.disposed = true;
    const owners = new Set([
      ...this.ownerEpochs.keys(),
      ...[...this.entries.values()].map((e) => e.owner),
      ...[...this.grants.values()].map((g) => g.owner),
      ...[...this.previews.values()].map((p) => p.owner),
    ]);
    const results = await Promise.allSettled([...owners].map((owner) => this.endOwner(owner)));
    this.grants.clear();
    const failures = results.filter((r): r is PromiseRejectedResult => r.status === "rejected");
    if (failures.length)
      throw new StudioError("STUDIO_CLEANUP_PARTIAL", "All session cleanup attempts completed; some retained work needs manual recovery", { diagnostics: failures.map((r) => String(r.reason)), checkpointRetained: true });
  }
}
