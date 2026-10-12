import { useEffect, useState } from "react";
import type { EmptyViewProps } from "./workbench/contracts.js";
import { ROUTE } from "./contracts.js";
interface RecentRow { path: string; displayPath?: string; lastOpenedAt: string }
export async function recentRequest(sessionId: string, action: "list" | "remove" | "touch", path?: string, signal?: AbortSignal) {
  const response = await fetch(ROUTE + "/recent", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ sessionId, action, path }), signal });
  const value = await response.json() as { items?: RecentRow[]; error?: string; ok?: boolean };
  if (!response.ok || value.ok === false) throw new Error(value.error ?? "无法更新最近打开的文件");
  return value.items ?? [];
}
export function RecentDocumentsView({ sessionId, open }: EmptyViewProps) {
  const [items, setItems] = useState<RecentRow[]>([]), [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>(), [busy, setBusy] = useState(false);
  const [removed, setRemoved] = useState<string>();
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError(undefined); setItems([]); setRemoved(undefined);
    void recentRequest(sessionId, "list", undefined, controller.signal).then(setItems).catch(error => { if (!controller.signal.aborted) setError(String(error.message ?? error)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId]);
  const openRecent = async (path: string) => {
    setBusy(true); setError(undefined);
    try { await open(path); } catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  const remove = async (row: RecentRow) => {
    setBusy(true); setError(undefined);
    try { setItems(await recentRequest(sessionId, "remove", row.path)); setRemoved(row.path.split(/[\\/]/).at(-1)); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setBusy(false); }
  };
  return <section className="pencil-recent" aria-label="最近打开">
    <header className="pencil-recent-toolbar"><strong>OpenPencil</strong><span>最近打开</span></header>
    <div className="pencil-recent-body">
      <div className="pencil-recent-heading"><h2>最近打开</h2><p>点击已有草稿，继续上次的设计。</p></div>
      {error && <div role="alert" className="pencil-recent-error">{error}<button onClick={() => { setLoading(true); void recentRequest(sessionId, "list").then(setItems).then(() => setError(undefined)).catch(error => setError(String(error.message ?? error))).finally(() => setLoading(false)); }}>重试</button></div>}
      {loading ? <p role="status">正在读取最近文件…</p> : items.length ? <ul className="pencil-recent-list">
        {items.map((row, index) => <li key={row.path}>
          <button className="pencil-recent-file" disabled={busy} onClick={() => void openRecent(row.path)}><span className="pencil-recent-icon" aria-hidden="true">OP</span><span><strong>{row.path.split(/[\\/]/).at(-1)}</strong><small>{row.displayPath ?? row.path}</small></span>{index === 0 && <span className="pencil-recent-badge">最新打开</span>}</button>
          <time dateTime={row.lastOpenedAt}>{new Date(row.lastOpenedAt).toLocaleString("zh-CN", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })}</time>
          <button disabled={busy} aria-label={`从最近打开移除 ${row.path.split(/[\\/]/).at(-1)}`} onClick={() => void remove(row)}>移除</button>
        </li>)}
      </ul> : <div className="pencil-recent-empty"><span className="pencil-recent-icon" aria-hidden="true">OP</span><h3>还没有最近打开的草稿</h3><p>在对话中创建或使用草稿后，记录会自动出现在这里。</p><p>最近打开的文件会显示在最上面。</p></div>}
      <p className="pencil-recent-note">移除只会清除列表记录，不会删除草稿文件。</p>
      {removed && <p role="status" className="pencil-recent-feedback">已从最近打开移除「{removed}」</p>}
    </div>
  </section>;
}
export const recentStyle = `
.pencil-recent{position:absolute;inset:0;overflow:auto;background:var(--dsw-alias-bg-base);color:var(--dsw-alias-label-primary)}
.pencil-recent-toolbar{box-sizing:border-box;height:32px;display:flex;align-items:center;gap:12px;padding:0 12px;border-bottom:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-layer-1);font-size:12px}
.pencil-recent-toolbar>span,.pencil-recent p,.pencil-recent small,.pencil-recent time{color:var(--dsw-alias-label-secondary)}
.pencil-recent-body{width:min(824px,calc(100% - 48px));margin:48px auto}
.pencil-recent-heading{margin-bottom:24px}.pencil-recent h2{font-size:24px;margin:0 0 8px}.pencil-recent p{font-size:13px;margin:8px 0}
.pencil-recent button{font:inherit;font-size:13px;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l2);border-radius:6px;background:var(--dsw-alias-bg-layer-1);padding:7px 12px;cursor:pointer}.pencil-recent button:disabled{opacity:.5;cursor:default}.pencil-recent button:focus-visible{outline:2px solid var(--dsw-alias-brand-primary);outline-offset:2px}
.pencil-recent-list{padding:0;margin:0;list-style:none;border:1px solid var(--dsw-alias-border-l1);border-radius:10px;overflow:hidden;background:var(--dsw-alias-bg-layer-1)}
.pencil-recent-list li{display:flex;align-items:center;gap:16px;padding:12px 16px;border-bottom:1px solid var(--dsw-alias-border-l1)}.pencil-recent-list li:last-child{border-bottom:0}
.pencil-recent .pencil-recent-file{flex:1;min-width:0;display:flex;align-items:center;gap:12px;text-align:left;padding:0;background:transparent;border:0}.pencil-recent-file strong,.pencil-recent-file small{display:block;overflow-wrap:anywhere}.pencil-recent-file small{font-size:12px;margin-top:6px}.pencil-recent-file>span:nth-child(2){min-width:0;flex:1}
.pencil-recent-icon{display:inline-grid;place-items:center;flex:none;width:40px;height:40px;border-radius:8px;font-size:12px;font-weight:600;color:var(--dsw-alias-brand-primary);background:var(--dsw-alias-bg-layer-2)}.pencil-recent-badge{font-size:11px;color:var(--dsw-alias-brand-primary)}.pencil-recent time{font-size:12px;white-space:nowrap}
.pencil-recent-empty{border:1px dashed var(--dsw-alias-border-l2);border-radius:10px;padding:48px 20px;text-align:center;background:var(--dsw-alias-bg-layer-1)}.pencil-recent-empty h3{margin:20px 0 12px;font-size:18px}.pencil-recent-note{margin-top:16px!important}.pencil-recent-error{color:var(--dsw-alias-state-error-primary);margin:12px 0}.pencil-recent-error button{margin-left:12px}.pencil-recent-feedback{color:var(--dsw-alias-state-success-primary)!important}
@media(max-width:600px){.pencil-recent-body{width:calc(100% - 32px);margin:28px auto}.pencil-recent-list li{gap:8px;padding:12px}.pencil-recent time,.pencil-recent-badge{display:none}}
`;
