export function patchEditor(text) {
  const patch = (from, to) => {
    if (!text.includes(from))
      throw Error("Pinned editor patch anchor missing: " + from.slice(0, 100));
    text = text.replace(from, to);
  };
  patch(
    "import { useCallback",
    "import { useStudioSync } from '../../studio-sync.js'\nimport { StudioToolbar } from '../../editor-toolbar.js'\nimport { useCallback",
  );
  patch("  saveUrl: string", "  saveUrl: string\n  stateUrl?: string");
  patch(
    "/_dsh/dsh-openpencil/editor/refresh",
    "/_dsh/openpencil-studio/refresh",
  );
  patch(
    "    saveUrl: editorControlUrl(value.saveUrl as string),",
    "    saveUrl: editorControlUrl(value.saveUrl as string),\n    ...(typeof value.stateUrl === 'string' ? { stateUrl: editorControlUrl(value.stateUrl) } : {}),",
  );
  patch(
    "  const dirtyRef = useRef(false)",
    "  const dirtyRef = useRef(false)\n  const studioVersionRef = useRef({ generation: 0, revision: 0 })",
  );
  patch(
    "        updateDirty(false)",
    "        if (studioVersionRef.current.generation === snapshot.generation && studioVersionRef.current.revision === snapshot.revision) updateDirty(false)",
  );
  patch(
    "  useEffect(() => {\n    publishLifecycle()",
    "  const reloadStudioDocument = useCallback(async (text: string): Promise<void> => {\n    await new Promise<void>((resolve,reject) => {\n      const listener=(event: MessageEvent) => {const m=editorMessageFrom(event,iframeRef.current?.contentWindow??null,originRef.current);if(m?.type==='op-bridge/opened'){clearTimeout(timer);window.removeEventListener('message',listener);updateDirty(false);updatePhase('ready');resolve()}}\n      const timer=setTimeout(()=>{window.removeEventListener('message',listener);reject(new Error('Canvas reload timed out'))},8000)\n      window.addEventListener('message',listener);post({type:'op-bridge/open-document',json:text})\n    })\n  },[post,updateDirty,updatePhase])\n  const checkpointStudioDocument=useCallback(async():Promise<void>=>{\n    const launch=launchRef.current;if(!launch?.recoveryUrl)throw new Error('Canvas recovery endpoint unavailable')\n    const requestId='studio-recovery-'+ ++requestCounterRef.current;let timer:ReturnType<typeof setTimeout>|undefined\n    try{\n      const snapshot=await Promise.race([\n        new Promise<Extract<EditorInboundMessage,{type:'op-bridge/snapshot-result'}>>((resolve,reject)=>{saveWaitersRef.current.set(requestId,{resolve,reject});post({type:'op-bridge/snapshot',purpose:'save',requestId})}),\n        new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Recovery snapshot timed out')),8000)})\n      ])\n      const response=await fetch(launch.recoveryUrl,{method:'POST',credentials:'same-origin',headers:{'content-type':'application/json'},body:JSON.stringify({docJson:snapshot.docJson})})\n      await responseJson(response,'Canvas recovery')\n    }finally{if(timer!==undefined)clearTimeout(timer);saveWaitersRef.current.delete(requestId)}\n  },[post])\n  const studio=useStudioSync({launchRef,sessionId,iframeRef,originRef,versionRef:studioVersionRef,dirtyRef,phaseRef,save,reload:reloadStudioDocument,checkpoint:checkpointStudioDocument})\n  useEffect(() => {\n    publishLifecycle()",
  );
  patch(
    "          await captureManagedEditorRecovery(launch)",
    "          await checkpointStudioDocument()",
  );
  patch(
    "  }, [publishLifecycle, updatePhase])",
    "  }, [checkpointStudioDocument, publishLifecycle, updatePhase])",
  );
  const toolbarStart = text.indexOf('      <div style={panelStyles.toolbar}>');
  const toolbarEnd = text.indexOf('      </div>', toolbarStart);
  if (toolbarStart < 0 || toolbarEnd < 0) throw Error('Pinned editor toolbar anchor missing');
  const toolbar = text.slice(toolbarStart, toolbarEnd + '      </div>'.length);
  const titleRow = toolbar.indexOf('\n        {saveEnabled');
  if (titleRow < 0) throw Error('Pinned editor toolbar actions missing');
  const actions = toolbar.slice(titleRow).replace('      </div>', '      </StudioToolbar>')
    .replace('        {workbenchActions}', '        {studio.actions}\n        {workbenchActions}');
  text = text.slice(0, toolbarStart) +
    "      <StudioToolbar title={title} path={documentGrant.path} locale={locale} iframeRef={iframeRef}\n        ready={phase === 'ready'} locked={studio.locked || liveDraft}>" + actions + text.slice(toolbarEnd + '      </div>'.length);
  patch(
    "style={liveDraft ? { ...panelStyles.iframe, pointerEvents: 'none' } : panelStyles.iframe}",
    "style={liveDraft || studio.locked ? { ...panelStyles.iframe, pointerEvents: 'none' } : panelStyles.iframe}",
  );
  patch("  captureManagedEditorRecovery,\n", "");
  patch("        restoredRecoveryRef.current = false", "        restoredRecoveryRef.current = false\n        studio.saved(snapshot.docJson)");
  patch("          updatePhase('ready')\n          if (restoredRecoveryRef.current) updateDirty(true)", "          void studio.opened(restoredRecoveryRef.current)");
  patch("            updateDirty(restoredRecoveryRef.current || message.dirty)", "            void studio.observeDirty(message.dirty)");
  patch("  }, [post, save, startInitLoop, updateDirty, updatePhase])", "  }, [post, save, startInitLoop, updateDirty, updatePhase, studio.opened, studio.observeDirty])");
  patch("  const studio=useStudioSync({", `  const snapshotStudioDocument=useCallback(async()=>{
    const requestId='studio-content-'+ ++requestCounterRef.current;let timer:ReturnType<typeof setTimeout>|undefined;
    try{return await Promise.race([
      new Promise<Extract<EditorInboundMessage,{type:'op-bridge/snapshot-result'}>>((resolve,reject)=>{saveWaitersRef.current.set(requestId,{resolve,reject});post({type:'op-bridge/snapshot',purpose:'save',requestId})}),
      new Promise<never>((_,reject)=>{timer=setTimeout(()=>reject(new Error('Content snapshot timed out')),8000)})
    ])}finally{if(timer!==undefined)clearTimeout(timer);saveWaitersRef.current.delete(requestId)}
  },[post]);
  const studio=useStudioSync({snapshot:snapshotStudioDocument,updateDirty,updatePhase,`);
  // The pinned Wasm shell draws its title bar into the canvas; embedded mode removes Agent chat.
  // Exclude only the 40px native title bar from the viewport, retaining layers, editing tools and zoom.
  patch("  iframe: { display: 'block', width: '100%', height: '100%', border: 0", "  iframe: { display: 'block', width: '100%', height: 'calc(100% + 40px)', transform: 'translateY(-40px)', border: 0");
  patch("        const origin = editorOrigin(launch.iframeUrl)", "        const iframeUrl = new URL(launch.iframeUrl, window.location.href)\n        iframeUrl.searchParams.set('embed', 'vscode')\n        const origin = editorOrigin(iframeUrl.href)");
  patch("editorIframeUrlWithTheme(launch.iframeUrl, colorSchemeRef.current)", "editorIframeUrlWithTheme(iframeUrl.href, colorSchemeRef.current)");
  return text;
}

export function patchBridge(text) {
  const original = `export function editorOrigin(iframeUrl: string): string {
  const url = new URL(iframeUrl)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === 'localhost' || url.hostname === '::1'
  if (!loopback || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('OpenPencil editor URL must use an HTTP loopback origin')
  }
  return url.origin
}`;
  const replacement = `export function editorOrigin(iframeUrl: string, base = window.location.href): string {
  const page = new URL(base)
  const url = new URL(iframeUrl, page)
  if (url.origin !== page.origin || (url.protocol !== 'http:' && url.protocol !== 'https:')) {
    throw new Error('OpenPencil editor URL must use the DSH page origin')
  }
  return url.origin
}`;
  if (!text.includes(original)) throw Error('Pinned editor bridge origin anchor missing');
  return text.replace(original, replacement).replace(
    '/** Require an absolute loopback editor URL and derive its exact target origin. */',
    "/** Resolve the proxied iframe URL and require the DSH page's exact origin. */",
  );
}
