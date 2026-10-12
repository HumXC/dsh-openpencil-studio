// Pinned OpenPencil 442c484: top_bar.rs places ToggleSidebar at (26, 22).
// a11y_bridge.rs publishes LayerPanel (1000) only while the sidebar is open.
const SIDEBAR_REGION = '[data-op-a11y-id="1000"]';
const TOPBAR_REGION = '[data-op-a11y-id="5000"]';

function nativeCanvas(iframe: HTMLIFrameElement) {
  try {
    const document = iframe.contentDocument;
    const view = document?.defaultView as (Window & typeof globalThis) | null;
    const canvas = document?.getElementById('op') as HTMLCanvasElement | null;
    const mirror = document?.getElementById('op-a11y-mirror');
    if (!view || !canvas || canvas.tagName !== 'CANVAS' || !mirror?.querySelector(TOPBAR_REGION)) return undefined;
    return { document: document!, view, canvas, mirror };
  } catch { return undefined; }
}

export function editorSidebarOpen(iframe: HTMLIFrameElement): boolean | undefined {
  const native = nativeCanvas(iframe);
  return native === undefined ? undefined : native.mirror.querySelector(SIDEBAR_REGION) !== null;
}

/** Observe native repaint and iframe reload changes, without inventing UI state. */
export function observeEditorSidebar(iframe: HTMLIFrameElement, changed: (open: boolean | undefined) => void): () => void {
  let observer: MutationObserver | undefined;
  let previous: boolean | undefined;
  let initialized = false;
  const publish = () => {
    const open = editorSidebarOpen(iframe);
    if (!initialized || open !== previous) { initialized = true; previous = open; changed(open); }
  };
  const attach = () => {
    observer?.disconnect();
    observer = undefined;
    try {
      const native = nativeCanvas(iframe);
      const document = iframe.contentDocument;
      const target = native?.mirror ?? document?.body;
      if (target && document?.defaultView) {
        const view = document.defaultView as Window & typeof globalThis;
        observer = new view.MutationObserver(publish);
        observer.observe(target, { childList: true, subtree: true });
      }
    } catch { /* Inaccessible or loading frames remain disabled. */ }
    publish();
  };
  iframe.addEventListener('load', attach);
  attach();
  return () => { observer?.disconnect(); iframe.removeEventListener('load', attach); };
}

/** Activate the original native button; resolve only after its state changes. */
export function toggleEditorSidebar(iframe: HTMLIFrameElement, signal?: AbortSignal): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const native = nativeCanvas(iframe);
    const before = editorSidebarOpen(iframe);
    if (!native || before === undefined) { reject(new Error('Native sidebar control is not ready')); return; }
    if (signal?.aborted) { reject(new Error('Sidebar action cancelled')); return; }
    const { view, canvas, mirror } = native;
    const rect = canvas.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) { reject(new Error('Native canvas is not visible')); return; }
    let completed = false;
    let timer: number | undefined;
    const finish = (error?: Error, open?: boolean) => {
      if (completed) return;
      completed = true;
      observer.disconnect();
      if (timer !== undefined) view.clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      iframe.removeEventListener('load', reloaded);
      if (error) reject(error); else resolve(open!);
    };
    const cancel = () => finish(new Error('Sidebar action cancelled'));
    const reloaded = () => finish(new Error('Editor changed during sidebar action'));
    const observer = new view.MutationObserver(() => {
      if (iframe.contentDocument !== native.document) { reloaded(); return; }
      const open = editorSidebarOpen(iframe);
      if (open !== undefined && open !== before) finish(undefined, open);
    });
    observer.observe(mirror, { childList: true, subtree: true });
    timer = view.setTimeout(() => finish(new Error('Native sidebar did not change')), 1500);
    signal?.addEventListener('abort', cancel, { once: true });
    iframe.addEventListener('load', reloaded, { once: true });
    try {
      // Native mount consumes offsetX/Y, including when the native bar is
      // clipped above the iframe viewport. Mouseup bubbles to its window listener.
      for (const type of ['mousedown', 'mouseup']) {
        const event = new view.MouseEvent(type, {
          bubbles: true, cancelable: true, view, button: 0, buttons: type === 'mousedown' ? 1 : 0,
          clientX: rect.left + 26, clientY: rect.top + 22,
        });
        Object.defineProperties(event, { offsetX: { value: 26 }, offsetY: { value: 22 } });
        canvas.dispatchEvent(event);
      }
    } catch (error) { finish(error instanceof Error ? error : new Error(String(error))); }
  });
}
