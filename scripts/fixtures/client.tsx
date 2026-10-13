import React, { useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { apply, StudioCard } from "../../src/browser.js";
import { StudioWorkbench } from "../../src/workbench/controller.js";
import { getBridge } from "../../src/workbench/contracts.js";
// Use the real controller with an isolated editor mount; the production parking/view layer is not mounted in this fixture.
const workspace = new StudioWorkbench();
apply({
    effect: (fn: any, label?: string) =>
        label === "OpenPencil Studio conversation workbench" ? undefined : fn(),
    on: () => () => {},
    theme: { getTheme: () => ({ active: { colorScheme: "light" } }) },
    locale: { getLocale: () => ({ active: "en" }) },
    slots: { inject: (_key: any, fn: any) => fn(), register: () => () => {} },
} as any);
getBridge().handler = workspace;
const data = await (await fetch("/test/fixture")).json();
function App() {
    const request = useSyncExternalStore(workspace.subscribe, workspace.getSnapshot),
        state = useSyncExternalStore(workspace.subscribe, workspace.getLifecycle);
    const Editor = getBridge().runtime!.Editor;
    return (
        <>
            <h1>Studio isolated integration fixture</h1>
            <StudioCard
                sessionId={data.owner}
                block={{ meta: { $openpencilStudio: { grant: data.grant } } } as any}
            />
            <output data-testid="lifecycle">{state.phase + " " + state.dirty}</output>
            {request ? (
                <div style={{ height: 760 }}>
                    <Editor
                        key={getBridge().runtime!.key(request.grant, request.sessionId)}
                        grant={request.grant}
                        sessionId={request.sessionId}
                        colorScheme="light"
                        locale="en"
                        allowTakeover={false}
                        onLifecycleState={workspace.onState}
                        onLifecycleController={workspace.onController}
                    />
                </div>
            ) : null}
        </>
    );
}
createRoot(document.getElementById("root")!).render(<App />);
(window as any).__studioTest = { workspace, bridge: getBridge() };
