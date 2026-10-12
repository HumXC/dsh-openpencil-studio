import {
  useEffect,
  useRef,
  useState,
  type RefObject,
  type MutableRefObject,
} from "react";
import type { LaunchResponse } from "./vendor/client/editor-panel.js";
import type { EditorInboundMessage } from "./vendor/client/editor-bridge.js";
import { editorMessageFrom } from "./vendor/client/editor-bridge.js";
import { authoredContent } from "./document-content.js";
import { canRefreshCanvas, refreshCleanCanvas, type CanvasSync } from "./canvas-sync.js";
interface Command {
  id: string;
  type: string;
  documentJson?: string;
  revision?: number;
}
export function useStudioSync(p: {
  launchRef: MutableRefObject<LaunchResponse | undefined>;
  sessionId: string;
  iframeRef: RefObject<HTMLIFrameElement>;
  originRef: MutableRefObject<string>;
  versionRef: MutableRefObject<{ generation: number; revision: number }>;
  dirtyRef: MutableRefObject<boolean>;
  phaseRef: MutableRefObject<string>;
  save: () => Promise<boolean>;
  reload: (text: string) => Promise<void>;
  checkpoint: () => Promise<void>;
  snapshot: () => Promise<{docJson:string; generation:number; revision:number}>;
  updateDirty: (dirty:boolean) => void;
  updatePhase: (phase:"ready"|"error") => void;
}) {
  const [locked, setLocked] = useState(false),
    [needsReload, setNeedsReload] = useState(false),
    [error, setError] = useState("");
  const current = useRef(p);
  current.current = p;
  const baseline = useRef<string>();
  const baselineLaunch = useRef<LaunchResponse>();
  const comparison = useRef(0);
  const pending = useRef(false);
  const recovered = useRef(false);
  const mounted = useRef(false);
  const refreshing = useRef<{ launch: LaunchResponse; ticket: number; reloading: boolean }>();
  const opened = async (recovery = false) => {
    const launch = current.current.launchRef.current;
    if (!mounted.current || !launch || (refreshing.current?.launch === launch && refreshing.current.reloading)) return;
    const ticket = ++comparison.current;
    pending.current = true;
    if (baselineLaunch.current !== launch) baseline.current = undefined;
    recovered.current = recovery;
    const valid = () => mounted.current && launch === current.current.launchRef.current && ticket === comparison.current;
    try {
      const snapshot = await current.current.snapshot();
      if (!valid()) return;
      const version = current.current.versionRef.current;
      if (snapshot.generation !== version.generation || snapshot.revision !== version.revision) return;
      baseline.current = authoredContent(snapshot.docJson);
      baselineLaunch.current = launch;
      current.current.updateDirty(recovery);
      current.current.updatePhase("ready");
      setError("");
    } catch (e) {
      if (valid()) {
        current.current.updatePhase("error");
        setError(String(e));
      }
    } finally {
      if (ticket === comparison.current) pending.current = false;
    }
  };
  const observeDirty = async (_nativeDirty: boolean) => {
    const launch = current.current.launchRef.current;
    if (!mounted.current || !launch || baseline.current === undefined || baselineLaunch.current !== launch ||
      (refreshing.current?.launch === launch && refreshing.current.reloading)) return;
    const ticket = ++comparison.current;
    pending.current = true;
    const valid = () => mounted.current && launch === current.current.launchRef.current && ticket === comparison.current;
    try {
      const snapshot = await current.current.snapshot();
      const version = current.current.versionRef.current;
      if (!valid() || snapshot.generation !== version.generation || snapshot.revision !== version.revision) return;
      current.current.updateDirty(recovered.current || authoredContent(snapshot.docJson) !== baseline.current);
      setError("");
    } catch (e) {
      if (valid()) setError(String(e));
    } finally {
      if (ticket === comparison.current) pending.current = false;
    }
  };
  const saved = (text: string) => {
    ++comparison.current;
    pending.current = false;
    baseline.current = authoredContent(text);
    baselineLaunch.current = current.current.launchRef.current;
    recovered.current = false;
  };
  useEffect(() => {
    mounted.current = true;
    let stopped = false,
      running = false,
      sequence = Date.now() * 1000;
    let launchIdentity: LaunchResponse | undefined;
    let leaseId: string | undefined,
      hostLease: string | undefined,
      ack: string | undefined,
      syncAck: string | undefined,
      failedCommand: { id: string; message: string } | undefined;
    let refreshLocked = false,
      disconnected = false,
      lastCheckpoint = "",
      lastAttempt = 0;
    const seen = new Set<string>();
    const failedSyncs = new Set<string>();
    const lock = () => {
      const value = launchIdentity === current.current.launchRef.current &&
        (refreshLocked || Boolean(leaseId || hostLease));
      const frame = current.current.iframeRef.current;
      if (frame) {
        (frame as HTMLIFrameElement & { inert: boolean }).inert = value;
        if (value) {
          frame.blur();
          (document.activeElement as HTMLElement | null)?.blur();
        }
      }
      if (!stopped) setLocked(value);
    };
    const beat = async () => {
      if (stopped || running) return;
      const launch = current.current.launchRef.current;
      if (!launch?.stateUrl) return;
      const isCurrent = () => !stopped && mounted.current && launch === current.current.launchRef.current;
      if (launchIdentity !== launch) {
        launchIdentity = launch;
        leaseId = hostLease = ack = syncAck = undefined;
        failedCommand = undefined;
        seen.clear();
        failedSyncs.clear();
        lastCheckpoint = "";
        disconnected = false;
        lock();
      }
      running = true;
      let received = false;
      try {
        const s = current.current;
        const response = await fetch(launch.stateUrl, {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerSessionId: s.sessionId,
            state: {
              ...s.versionRef.current,
              dirty: s.dirtyRef.current || recovered.current,
              phase: s.phaseRef.current,
              sequence: ++sequence,
              ...(leaseId ? { leaseId } : {}),
            },
            ...(ack ? { ack } : {}),
            ...(syncAck ? { syncAck } : {}),
            ...(failedCommand ? { failedCommand } : {}),
          }),
        });
        if (!response.ok) throw Error("Editor state synchronization failed (" + response.status + ")");
        const result = (await response.json()) as {
          command?: Command;
          sync?: CanvasSync;
          needsReload?: boolean;
          activeLease?: string;
        };
        if (!isCurrent()) return;
        received = true;
        if (disconnected) { failedSyncs.clear(); disconnected = false; }
        ack = syncAck = undefined;
        failedCommand = undefined;
        hostLease = result.activeLease;
        setNeedsReload(result.needsReload === true);
        const cmd = result.command;
        if (!cmd && !hostLease) leaseId = undefined;
        lock(); // Tool leases lock opportunistically; the Host never waits for an ack.
        if (cmd && !seen.has(cmd.id)) {
          seen.add(cmd.id);
          setError("");
          try {
            if (cmd.type === "lease") {
              leaseId = cmd.id;
              lock();
            } else if (cmd.type === "release") {
              leaseId = undefined;
              lock();
            } else if (cmd.type === "save") {
              if (await current.current.save()) {
                if (!isCurrent()) return;
                leaseId = cmd.id;
                lock();
              } else throw Error("Canvas save failed; inspect the editor diagnostics");
            } else if (cmd.type === "reload" && typeof cmd.documentJson === "string") {
              await current.current.reload(cmd.documentJson);
              if (!isCurrent()) return;
              leaseId = cmd.id;
              lock();
            } else if (cmd.type === "checkpoint") {
              await current.current.checkpoint();
              if (!isCurrent()) return;
              leaseId = cmd.id;
              lock();
            }
            ack = cmd.id;
          } catch (e) {
            if (!isCurrent()) return;
            failedCommand = { id: cmd.id, message: String(e) };
            ack = cmd.id;
            setError(String(e));
          }
        }
        const sync = result.sync;
        const state = () => ({
          current: isCurrent(),
          baseline: baselineLaunch.current === launch ? baseline.current : undefined,
          ...current.current.versionRef.current,
          comparison: comparison.current,
          phase: current.current.phaseRef.current,
          dirty: current.current.dirtyRef.current,
          // This transaction owns its pending ticket. Any competing comparison still blocks it.
          pending: pending.current && refreshing.current?.ticket !== comparison.current,
          recovered: recovered.current,
          activeLease: Boolean(hostLease || leaseId),
          command: Boolean(cmd),
        });
        if (sync && !failedSyncs.has(sync.id) && canRefreshCanvas(state())) {
          const transaction = { launch, ticket: ++comparison.current, reloading: false };
          refreshing.current = transaction;
          pending.current = true;
          try {
            const outcome = await refreshCleanCanvas(sync, {
              state,
              lock: value => { refreshLocked = value; lock(); },
              snapshot: () => current.current.snapshot(),
              reload: async text => {
                transaction.reloading = true;
                await current.current.reload(text);
              },
              baseline: content => { baseline.current = content; recovered.current = false; },
              dirty: () => current.current.updateDirty(true),
            });
            if (isCurrent() && outcome === "applied") { syncAck = sync.id; setError(""); }
          } catch (e) {
            if (isCurrent()) { failedSyncs.add(sync.id); setError(String(e)); }
          } finally {
            if (refreshing.current === transaction) refreshing.current = undefined;
            if (comparison.current === transaction.ticket) pending.current = false;
          }
        }
        if (!isCurrent()) return;
        const signature = s.versionRef.current.generation + ":" + s.versionRef.current.revision;
        if (!cmd && !hostLease && !leaseId && !pending.current && s.dirtyRef.current &&
          s.phaseRef.current === "ready" && signature !== lastCheckpoint && Date.now() - lastAttempt >= 2000) {
          lastAttempt = Date.now();
          await current.current.checkpoint();
          if (!isCurrent()) return;
          lastCheckpoint = signature;
        }
      } catch (e) {
        if (isCurrent()) { if (!received) disconnected = true; setError(String(e)); }
      } finally {
        running = false;
        if ((ack || syncAck) && !disconnected && isCurrent()) queueMicrotask(() => { void beat(); });
      }
    };
    const listener = (event: MessageEvent) => {
      const s = current.current;
      const m = editorMessageFrom(event, s.iframeRef.current?.contentWindow ?? null, s.originRef.current) as
        | (EditorInboundMessage & { generation?: number; revision?: number }) | null;
      if (!m) return;
      if (typeof m.generation === "number") s.versionRef.current.generation = m.generation;
      if (typeof m.revision === "number") s.versionRef.current.revision = m.revision;
    };
    window.addEventListener("message", listener);
    const timer = setInterval(() => { void beat(); }, 400);
    void beat();
    return () => {
      stopped = true;
      mounted.current = false;
      ++comparison.current;
      pending.current = false;
      refreshing.current = undefined;
      clearInterval(timer);
      window.removeEventListener("message", listener);
    };
  }, []);
  const reload = async () => {
    if (
      p.dirtyRef.current &&
      !window.confirm("重新加载会放弃当前画布的未保存修改，是否继续？")
    )
      return;
    const launch = p.launchRef.current;
    if (!launch?.stateUrl) return;
    try {
      const response = await fetch(
        launch.stateUrl.replace(/state$/, "reload"),
        {
          method: "POST",
          credentials: "same-origin",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            ownerSessionId: p.sessionId,
            ...p.versionRef.current,
          }),
        },
      );
      if (!response.ok)
        throw Error(((await response.json()) as { error: string }).error);
      setNeedsReload(false);
      setError("");
    } catch (e) {
      setError(String(e));
    }
  };
  return {
    opened, observeDirty, saved,
    locked,
    actions: (
      <>
        {needsReload ? (
          <button
            type="button"
            disabled={locked}
            onClick={() => {
              void reload();
            }}
          >
            重新加载已保存文件
          </button>
        ) : null}
        {locked ? <span role="status">正在同步画布…</span> : null}
        {error ? <span role="alert">{error}</span> : null}
      </>
    ),
  };
}
