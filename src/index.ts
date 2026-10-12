import type { Context } from "@deepseek-ai/cordis";
import { apply as applyWorkspace } from "dsh-openpencil-workspace";
import type FileSystem from "@deepseek-ai/dsh-fs";
import type SandboxPolicy from "@deepseek-ai/dsh-sandbox-policy";
import type { SessionStore } from "@deepseek-ai/dsh-session";
import type WebServer from "@deepseek-ai/dsh-host-webserver";
import {
  type ToolDefinition,
  type ToolRunContext,
} from "@deepseek-ai/dsh-tools";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, relative } from "node:path";
import { realpath } from "node:fs/promises";
import { Studio } from "./studio.js";
import { StudioError, errorResult, record } from "./errors.js";
import { TECHNICAL_CATALOG } from "./native.js";
import { GUIDANCE } from "./guidance.js";
import { ROUTE, type PresentationGrant } from "./contracts.js";
import { handleStudio } from "./http.js";
import { RecentDocuments } from "./recent.js";
export const name = "dsh-openpencil-studio";
export const inject = ["fs", "sessions", "sandboxPolicy", "tools", "webServer"];
interface Host extends Context {
  fs: FileSystem;
  sessions: SessionStore;
  sandboxPolicy: SandboxPolicy;
}
export interface Config {
  stateDirectory?: string;
  allowedOrigin?: string;
}
export function makeAuthorizer(
  ctx: Pick<Host, "fs" | "sessions" | "sandboxPolicy">,
) {
  return async (
    path: string,
    owner: string,
    write: boolean,
    create = false,
  ) => {
    if (!path || !path.toLowerCase().endsWith(".op") || path.includes("\0"))
      throw new StudioError("INVALID_PATH", "Expected a native .op file path");
    const session = ctx.sessions.get(
      owner as Parameters<SessionStore["get"]>[0],
    );
    if (!session)
      throw new StudioError(
        "SESSION_NOT_FOUND",
        "Owning DSH session does not exist",
      );
    const policy = ctx.sandboxPolicy.resolve({ session });
    if (write && policy.mode === "read-only")
      throw new StudioError("READ_ONLY", "This session cannot write documents");
    const target = await ctx.fs.resolve(path, { cwd: policy.workspaceRoot });
    const raw = ctx.fs.processPath(target);
    const resolved = create
      ? join(await realpath(dirname(raw)), basename(raw))
      : await realpath(raw);
    if (policy.mode !== "danger-full-access") {
      const root = await realpath(policy.workspaceRoot),
        tail = relative(root, resolved);
      if (tail === ".." || tail.startsWith("../") || isAbsolute(tail))
        throw new StudioError(
          "OUTSIDE_WORKSPACE",
          "File is outside the authorized workspace",
        );
    }
    return resolved;
  };
}
const owner = (exec: ToolRunContext) => {
  if (!exec.agent)
    throw new StudioError(
      "SESSION_REQUIRED",
      "Studio tools require an owning agent session",
    );
  return String(exec.agent.id);
};
const outputSchema = { type: "object", additionalProperties: true } as const;
const render = (
  _args: unknown,
  value: unknown,
): [{ type: "text"; text: string }] => [
  { type: "text", text: JSON.stringify(value, null, 2) },
];
export function createTools(studio: Studio, recent?: RecentDocuments) {
  const presentations = new Map<string, PresentationGrant>();
  const tool = (
    name: string,
    description: string,
    properties: Record<string, unknown>,
    run: (
      args: Record<string, unknown>,
      owner: string,
      signal: AbortSignal,
    ) => Promise<unknown>,
  ): ToolDefinition => {
    const registeredName = name.replace(/^studio_/, "pencil_");
    const required = Object.entries(properties)
      .filter(([, p]) => record(p)?.required === true)
      .map(([k]) => k);
    const props = Object.fromEntries(
      Object.entries(properties).map(([k, p]) => {
        const { required: _required, ...rest } = record(p) ?? {};
        return [k, rest];
      }),
    );
    return {
      name: registeredName,
      description,
      parameters: {
        type: "object",
        properties: props,
        required,
        additionalProperties: false,
      } as ToolDefinition["parameters"],
      output: {
        schema: outputSchema,
        render,
        presentationMeta: (_args, value) => {
          const id = record(value)?.presentationId;
          const grant =
            typeof id === "string" ? presentations.get(id) : undefined;
          return grant
            ? JSON.parse(JSON.stringify({ $openpencilStudio: { grant } }))
            : {};
        },
      },
      async execute(raw, exec) {
        try {
          const args = record(raw);
          if (!args || (name !== "pencil_recent" && typeof args.path !== "string"))
            throw new StudioError(
              "INVALID_ARGUMENT",
              "Expected a path-bound argument object",
            );
          const id = owner(exec);
          const result = await run(args, id, exec.signal);
          const value = record(result) ?? { ok: true, value: result };
          if (recent && ["studio_create", "studio_open"].includes(name) && value.ok !== false) {
            try { await recent.touch(id, String(value.path ?? args.path)); }
            catch (error) { value.recentWarning = error instanceof Error ? error.message : String(error); }
          }
          if (
            value.ok !== false &&
            typeof value.path === "string" &&
            [
              "studio_create",
              "studio_open",
              "studio_save",
              "studio_preview",
            ].includes(name)
          ) {
            const grant = await studio.grantForDocument(value.path, "", {
              sessionId: id,
            });
            const frames = Array.isArray(value.frames) ? value.frames : [];
            grant.images = frames
              .map(record)
              .filter(
                (f): f is Record<string, unknown> =>
                  !!f && typeof f.previewId === "string",
              )
              .map((f) => ({
                previewUrl: ROUTE + "/preview/" + f.previewId,
                name: String(f.name),
              }));
            const key = crypto.randomUUID();
            value.presentationId = key;
            presentations.set(key, grant);
          }
          return value;
        } catch (error) {
          return errorResult(error);
        }
      },
      presentCall: () => ({
        card: "generic",
        title: registeredName.replaceAll("_", " "),
        kind: "execute",
      }),
    };
  };
  const path = {
    type: "string",
    required: true,
    description:
      "Native .op path, relative to the owning session workspace or absolute.",
  };
  const tools = [
    tool(
      "studio_create",
      "Create an empty editable native .op file without overwriting an existing file. Add any number of pages/artboards with native tools.",
      { path },
      async (a, o) => studio.create(String(a.path), o),
    ),
    tool(
      "studio_open",
      "Open a saved file as a recoverable working copy and expose its editor action.",
      { path },
      async (a, o) => studio.status(String(a.path), o),
    ),
    tool(
      "studio_status",
      "Read working-file state, user canvas dirty revision, ownership, saved-source conflicts and checkpoint retention.",
      { path },
      async (a, o) => studio.status(String(a.path), o),
    ),
    tool(
      "studio_control_semantics",
      "Set a control accessible label or label-node references by exact node ID. Runtime 0.8.5 drops unsupported node label fields; Studio stores design semantics in a persistent native string variable. This does not add DOM accessibility support to the native canvas.",
      {
        path,
        nodeId: { type: "string", required: true },
        label: { type: "string", minLength: 1, pattern: "\\S" },
        labelledBy: { type: "array", items: { type: "string", minLength: 1, pattern: "\\S" } },
      },
      async (a, o) =>
        studio.controlSemantics(String(a.path), o, String(a.nodeId), {
          ...(a.label !== undefined ? { label: a.label as string } : {}),
          ...(a.labelledBy !== undefined ? { labelledBy: a.labelledBy as string[] } : {}),
        }),
    ),
    tool(
      "studio_catalog",
      "Query available native technical schemas and execution limits. Design guidance queries are optional.",
      { path },
      async (a, o) => studio.catalog(String(a.path), o),
    ),
    tool(
      "studio_validate",
      "Run native lint and document/control legality checks. Returns real node IDs and repair targets. Advisory visual preferences do not prevent saving.",
      { path },
      async (a, o) => studio.validate(String(a.path), o),
    ),
    tool(
      "studio_save",
      "Validate and persist the current working document with source-conflict and dirty user canvas protection. A successful result delivers an editable .op file.",
      { path },
      async (a, o) => studio.save(String(a.path), o),
    ),
    tool(
      "studio_reload",
      "Explicitly discard agent working changes and reload the saved source after reviewing a conflict. Dirty user canvas still requires a disposition.",
      { path, discardAgentChanges: { type: "boolean", required: true } },
      async (a, o) =>
        studio.reload(String(a.path), o, a.discardAgentChanges === true),
    ),
    tool(
      "studio_resolve_unsaved",
      "Use only after asking the user how to handle their unsaved canvas. The decision is bound to the exact revision. save-user saves their work; discard-user reloads; edit-saved preserves their canvas; cancel cancels.",
      {
        path,
        mode: {
          type: "string",
          required: true,
          enum: ["save-user", "discard-user", "edit-saved", "cancel"],
        },
        revision: { type: "integer", required: true },
      },
      async (a, o) =>
        studio.resolveUnsaved(
          String(a.path),
          o,
          a.mode as "save-user" | "discard-user" | "edit-saved" | "cancel",
          Number(a.revision),
        ),
    ),
    tool(
      "studio_close",
      "Release this session's daemons while retaining its work checkpoint. Refuses to discard dirty user canvas.",
      { path },
      async (a, o) => studio.close(String(a.path), o),
    ),
    tool(
      "studio_preview",
      "Render independent artboards from the working copy at native dimensions. Preview errors are separate from save state; no Jian renderer is required.",
      { path, nodeId: { type: "string" } },
      async (a, o) =>
        studio.preview(
          String(a.path),
          o,
          typeof a.nodeId === "string" ? a.nodeId : undefined,
        ),
    ),
  ];
  for (const native of TECHNICAL_CATALOG) {
    const schema = native.inputSchema as Record<string, unknown>,
      props = record(schema.properties) ?? {},
      required = Array.isArray(schema.required) ? schema.required : [];
    const parameters = Object.fromEntries(
      Object.entries(props).map(([key, v]) => [
        key,
        { ...record(v), ...(required.includes(key) ? { required: true } : {}) },
      ]),
    );
    const description =
      native.name === "batch_design"
        ? "Apply an atomic incremental batch: script creates with I/K; operations edits with U/D/M/C/R/G. Supply one non-empty field. Move C copies to root in a separate call using returned IDs. IDs are opaque; validate and save when ready."
        : native.name === "undo" || native.name === "redo"
          ? `${native.name === "undo" ? "Undo" : "Redo"} one completed Studio transaction in the agent working copy. History lasts until close and is limited to 32 steps / 32 MiB; user canvas protection still applies.`
          : native.name === "get_history_depth"
            ? "Report undo and redo counts for completed Studio transactions in the agent working copy."
            : "Invoke native OpenPencil " +
              native.name +
              " on the path-bound working document. Arguments follow its technical schema; optional style queries do not lock the document.";
    tools.push(
      tool(
        "studio_" + native.name,
        description,
        { path, ...parameters },
        async (a, o, signal) => {
          const { path, ...args } = a;
          return studio.call(String(path), o, native.name, args, signal);
        },
      ),
    );
  }
  if (recent) tools.push(tool("pencil_recent", "List or remove this workspace's recently opened OpenPencil documents. Removing a record never deletes its document.", {
    action: { type: "string", required: true, enum: ["list", "remove"] },
    path: { type: "string" },
  }, async (args, owner) => {
    if (args.action === "list") return recent.list(owner);
    if (args.action === "remove" && typeof args.path === "string") return recent.remove(owner, args.path);
    throw new StudioError("INVALID_ARGUMENT", "Removing a recent record requires a path");
  }));
  return tools;
}
export function apply(ctx: Host, config: Config = {}) {
  const server = ctx.get("webServer") as WebServer;
  const studio = new Studio(
    makeAuthorizer(ctx),
    config.stateDirectory ??
      join(
        process.env.DSH_HOME ?? join(homedir(), ".dsh"),
        "state",
        "openpencil-studio",
      ),
    config.allowedOrigin ?? "http://127.0.0.1:" + server.port,
  );
  const recent = new RecentDocuments(async owner => {
    const session = ctx.sessions.get(owner as Parameters<SessionStore["get"]>[0]);
    if (!session) throw new StudioError("SESSION_NOT_FOUND", "Owning DSH session does not exist");
    const policy = ctx.sandboxPolicy.resolve({ session });
    return { root: policy.workspaceRoot, writable: policy.mode !== "read-only" };
  }, studio.authorize);
  ctx.effect(() => {
    if (ctx.get("openpencilWorkspaceHost"))
      throw new StudioError(
        "HOST_CONFLICT",
        "Disable the previous OpenPencil plugin before enabling Studio; it remains only a code dependency.",
      );
    const unregisterHost = ctx.provide("openpencilWorkspaceHost", studio);
    return async () => {
      unregisterHost();
      await studio.dispose();
    };
  });
  applyWorkspace(ctx);
  ctx.on("session/flush", async (session) => {
    const result = await studio.flushOwner(session.id);
    for (const warning of result.warnings)
      ctx.logger.warn("OpenPencil canvas checkpoint unavailable; the working checkpoint was retained", warning);
  });
  ctx.on("session/disposed", async (session) => {
    await studio.endOwner(session.id);
  });
  for (const tool of createTools(studio, recent))
    ctx.effect(() => ctx.tools.register(tool));
  void ctx.inject(["systemPrompt"], (p) => {
    const prompt = p.get("systemPrompt") as
      | {
          section(v: {
            name: string;
            order: number;
            text: () => string;
          }): () => void;
        }
      | undefined;
    if (prompt)
      p.effect(() =>
        prompt.section({
          name: "openpencil-studio-technical",
          order: 100,
          text: () => GUIDANCE,
        }),
      );
  });
  void ctx.inject(["webServer"], (w) => {
    const server = w.get("webServer") as WebServer;
    w.effect(() =>
      server.register({
        kind: "prefix",
        path: ROUTE,
        handler: (req, res) => handleStudio(studio, req, res, recent),
      }),
    );
  });
}
