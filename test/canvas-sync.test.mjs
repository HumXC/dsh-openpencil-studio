import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { stripTypeScriptTypes } from "node:module";
import ts from "typescript";
import React from "react";
import { act, create } from "react-test-renderer";

// Load the authored sources without building or changing shared lib artifacts.
const dataModule = (text) => "data:text/javascript;base64," + Buffer.from(text).toString("base64");
const errorsUrl = dataModule(
    ts.transpileModule(await readFile(new URL("../src/errors.ts", import.meta.url), "utf8"), {
        compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext },
    }).outputText,
);
const imagesUrl = dataModule(
    stripTypeScriptTypes(
        (await readFile(new URL("../src/document-images.ts", import.meta.url), "utf8")).replace(
            "./errors.js",
            errorsUrl,
        ),
    ),
);
const contentUrl = dataModule(
    stripTypeScriptTypes(
        (await readFile(new URL("../src/document-content.ts", import.meta.url), "utf8")).replace(
            "./document-images.js",
            imagesUrl,
        ),
    ),
);
const helperUrl = dataModule(
    stripTypeScriptTypes(
        (await readFile(new URL("../src/canvas-sync.ts", import.meta.url), "utf8")).replace(
            "./document-content.js",
            contentUrl,
        ),
    ),
);
const { authoredContent } = await import(contentUrl);
const { refreshCleanCanvas } = await import(helperUrl);
const documentJson = (name) =>
    JSON.stringify({ pages: [{ name }], editorMeta: { selected: name } });
const original = documentJson("original"),
    updated = documentJson("host"),
    edited = documentJson("user");
const sync = { id: "sync-1", documentJson: updated };
const deferred = () => {
    let resolve, reject;
    const promise = new Promise((yes, no) => {
        resolve = yes;
        reject = no;
    });
    return { promise, resolve, reject };
};
function fixture(overrides = {}) {
    const state = {
        current: true,
        baseline: authoredContent(original),
        generation: 1,
        revision: 4,
        comparison: 1,
        phase: "ready",
        dirty: false,
        pending: false,
        recovered: false,
        activeLease: false,
        command: false,
    };
    let doc = original;
    const locks = [],
        reloads = [];
    const hooks = {
        state: () => ({ ...state }),
        lock: (value) => locks.push(value),
        snapshot: async () => ({
            docJson: doc,
            generation: state.generation,
            revision: state.revision,
        }),
        reload: async (text) => {
            reloads.push(text);
            doc = text;
            state.generation++;
            state.revision = 0;
            state.dirty = false;
        },
        baseline: (value) => {
            state.baseline = value;
            state.recovered = false;
        },
        dirty: () => {
            state.dirty = true;
        },
        ...overrides,
    };
    return {
        state,
        locks,
        reloads,
        hooks,
        setDoc: (value) => {
            doc = value;
        },
    };
}
test("actual snapshot catches an edit before its dirty notification", async () => {
    const f = fixture();
    f.setDoc(edited);
    assert.equal(await refreshCleanCanvas(sync, f.hooks), "dirty");
    assert.equal(f.state.dirty, true);
    assert.deepEqual(f.reloads, []);
    assert.equal(f.state.baseline, authoredContent(original));
    assert.deepEqual(f.locks, [true, false]);
});
test("editor metadata changes are safe and successful refresh installs authored baseline", async () => {
    const f = fixture();
    f.setDoc(JSON.stringify({ pages: [{ name: "original" }], editorMeta: { zoom: 2 } }));
    assert.equal(await refreshCleanCanvas(sync, f.hooks), "applied");
    assert.deepEqual(f.reloads, [updated]);
    assert.equal(f.state.baseline, authoredContent(updated));
    assert.equal(f.state.dirty, false);
    assert.deepEqual(f.locks, [true, false]);
});
for (const [field, value] of [
    ["baseline", undefined],
    ["phase", "loading"],
    ["dirty", true],
    ["pending", true],
    ["recovered", true],
    ["activeLease", true],
    ["command", true],
    ["current", false],
]) {
    test(`refresh defers while ${field}=${value}`, async () => {
        const f = fixture({
            snapshot: async () => {
                assert.fail("must not request a snapshot");
            },
        });
        f.state[field] = value;
        assert.equal(await refreshCleanCanvas(sync, f.hooks), "deferred");
        assert.deepEqual(f.locks, []);
        assert.deepEqual(f.reloads, []);
    });
}
for (const mismatch of [
    "snapshot",
    "revision",
    "generation",
    "dirty",
    "pending",
    "comparison",
    "launch",
]) {
    test(`pre-reload ${mismatch} drift preserves the canvas`, async () => {
        const waiting = deferred();
        const f = fixture({ snapshot: () => waiting.promise });
        const operation = refreshCleanCanvas(sync, f.hooks);
        if (mismatch === "revision") f.state.revision++;
        if (mismatch === "generation") f.state.generation++;
        if (mismatch === "dirty" || mismatch === "pending") f.state[mismatch] = true;
        if (mismatch === "comparison") f.state.comparison++;
        if (mismatch === "launch") f.state.current = false;
        waiting.resolve({
            docJson: original,
            generation: 1,
            revision: mismatch === "snapshot" ? 3 : 4,
        });
        assert.notEqual(await operation, "applied");
        assert.deepEqual(f.reloads, []);
        assert.deepEqual(f.locks, [true, false]);
        assert.equal(f.state.baseline, authoredContent(original));
    });
}
test("a fresh snapshot after a version change still cannot overwrite the pre-snapshot version", async () => {
    const f = fixture();
    f.hooks.snapshot = async () => {
        f.state.revision++;
        return { docJson: original, generation: 1, revision: f.state.revision };
    };
    assert.equal(await refreshCleanCanvas(sync, f.hooks), "deferred");
    assert.deepEqual(f.reloads, []);
});
test("edits arriving during reload stay dirty against the Host baseline", async () => {
    const f = fixture();
    const normalReload = f.hooks.reload;
    f.hooks.reload = async (text) => {
        await normalReload(text);
        f.setDoc(edited);
        f.state.revision++;
    };
    assert.equal(await refreshCleanCanvas(sync, f.hooks), "dirty");
    assert.equal(f.state.dirty, true);
    assert.equal(f.state.baseline, authoredContent(updated));
    assert.deepEqual(f.locks, [true, false]);
});
test("post-reload version drift defers acknowledgement without inventing an edit", async () => {
    const f = fixture();
    const normalSnapshot = f.hooks.snapshot;
    let count = 0;
    f.hooks.snapshot = async () => {
        const snapshot = await normalSnapshot();
        if (++count === 2) f.state.revision++;
        return snapshot;
    };
    assert.equal(await refreshCleanCanvas(sync, f.hooks), "deferred");
    assert.equal(f.state.dirty, false);
});
test("failed reload preserves confirmed clean state and always releases its lock", async () => {
    const f = fixture({
        reload: async () => {
            throw Error("reload failed");
        },
    });
    await assert.rejects(refreshCleanCanvas(sync, f.hooks), /reload failed/);
    assert.equal(f.state.dirty, false);
    assert.deepEqual(f.locks, [true, false]);
});
test("failed reload still detects a real differing canvas snapshot", async () => {
    const f = fixture();
    f.hooks.reload = async () => {
        f.setDoc(edited);
        throw Error("reload failed");
    };
    await assert.rejects(refreshCleanCanvas(sync, f.hooks), /reload failed/);
    assert.equal(f.state.dirty, true);
    assert.equal(f.state.baseline, authoredContent(original));
});
test("partially applied Host refresh is not mistaken for a user edit after failure", async () => {
    const f = fixture();
    f.hooks.reload = async () => {
        f.setDoc(updated);
        throw Error("reload failed");
    };
    await assert.rejects(refreshCleanCanvas(sync, f.hooks), /reload failed/);
    assert.equal(f.state.dirty, false);
    assert.equal(f.state.baseline, authoredContent(updated));
});
test("failed reload and unavailable snapshot do not invent dirty", async () => {
    const f = fixture();
    let snapshots = 0;
    const snapshot = f.hooks.snapshot;
    f.hooks.snapshot = async () => {
        if (++snapshots > 1) throw Error("snapshot unavailable");
        return snapshot();
    };
    f.hooks.reload = async () => {
        throw Error("reload failed");
    };
    await assert.rejects(refreshCleanCanvas(sync, f.hooks), /reload failed/);
    assert.equal(f.state.dirty, false);
    assert.deepEqual(f.locks, [true, false]);
});
test("snapshot failure releases the lock without changing the baseline", async () => {
    const f = fixture({
        snapshot: async () => {
            throw Error("snapshot failed");
        },
    });
    await assert.rejects(refreshCleanCanvas(sync, f.hooks), /snapshot failed/);
    assert.equal(f.state.baseline, authoredContent(original));
    assert.deepEqual(f.locks, [true, false]);
});
test("replacement launch during reload never receives the old baseline or acknowledgement", async () => {
    const f = fixture({
        reload: async () => {
            f.state.current = false;
        },
    });
    assert.equal(await refreshCleanCanvas(sync, f.hooks), "obsolete");
    assert.equal(f.state.baseline, authoredContent(original));
    assert.deepEqual(f.locks, [true, false]);
});

const bridgeUrl = dataModule(
    stripTypeScriptTypes(
        await readFile(new URL("../src/vendor/client/editor-bridge.ts", import.meta.url), "utf8"),
    ),
);
const hookSource = (await readFile(new URL("../src/studio-sync.tsx", import.meta.url), "utf8"))
    .replace('from "react"', `from ${JSON.stringify(import.meta.resolve("react"))}`)
    .replace("./document-content.js", contentUrl)
    .replace("./canvas-sync.js", helperUrl)
    .replaceAll("./vendor/client/editor-bridge.js", bridgeUrl);
const { useStudioSync } = await import(
    dataModule(
        ts.transpileModule(
            `import React from ${JSON.stringify(import.meta.resolve("react"))};\n` + hookSource,
            {
                compilerOptions: {
                    target: ts.ScriptTarget.ES2022,
                    module: ts.ModuleKind.ESNext,
                    jsx: ts.JsxEmit.React,
                },
            },
        ).outputText,
    )
);
const settle = async () => {
    for (let i = 0; i < 5; i++) await new Promise((resolve) => setImmediate(resolve));
};
async function hookFixture(run) {
    const originals = Object.fromEntries(
        ["window", "document", "fetch", "setInterval", "clearInterval"].map((key) => [
            key,
            globalThis[key],
        ]),
    );
    const window = new EventTarget();
    window.confirm = () => true;
    globalThis.window = window;
    globalThis.document = { activeElement: null };
    let tick;
    globalThis.setInterval = (callback) => {
        tick = callback;
        return 1;
    };
    globalThis.clearInterval = () => {};
    const frame = { inert: false, blur() {}, contentWindow: {} };
    const launch = { stateUrl: "http://localhost/state" };
    const p = {
        launchRef: { current: launch },
        sessionId: "owner",
        iframeRef: { current: frame },
        originRef: { current: "http://localhost" },
        versionRef: { current: { generation: 1, revision: 4 } },
        dirtyRef: { current: false },
        phaseRef: { current: "ready" },
        updateDirty(value) {
            p.dirtyRef.current = value;
        },
        updatePhase(value) {
            p.phaseRef.current = value;
        },
        save: async () => true,
        checkpoint: async () => {},
    };
    let doc = original,
        server = {},
        hook,
        reloadCount = 0;
    const posts = [],
        duringReload = [];
    p.snapshot = async () => ({ docJson: doc, ...p.versionRef.current });
    p.reload = async (text) => {
        reloadCount++;
        duringReload.push(frame.inert);
        doc = text;
        p.versionRef.current = { generation: 2, revision: 0 };
        // Reproduce the panel's opened callback racing the reload waiter.
        await hook.opened();
        await hook.observeDirty(false);
        p.updateDirty(false);
    };
    globalThis.fetch = async (_url, options) => {
        const body = JSON.parse(options.body);
        posts.push(body);
        if (body.syncAck && body.syncAck === server.sync?.id) server = {};
        return { ok: true, json: async () => server };
    };
    function Component() {
        hook = useStudioSync(p);
        return null;
    }
    let renderer;
    try {
        await act(async () => {
            renderer = create(React.createElement(Component));
            await settle();
        });
        await act(async () => {
            await hook.opened();
            await settle();
        });
        await run({
            p,
            frame,
            posts,
            duringReload,
            get hook() {
                return hook;
            },
            get reloadCount() {
                return reloadCount;
            },
            setDoc: (text) => {
                doc = text;
            },
            setServer: (value) => {
                server = value;
            },
            beat: async () => {
                await act(async () => {
                    tick();
                    await settle();
                });
            },
            unmount: async () => {
                await act(async () => {
                    renderer.unmount();
                    await settle();
                });
            },
        });
    } finally {
        if (renderer)
            await act(async () => {
                renderer.unmount();
                await settle();
            });
        for (const [key, value] of Object.entries(originals)) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    }
}
test("heartbeat applies refresh, guards opened comparisons and acknowledges on the next POST", async () =>
    hookFixture(async (f) => {
        f.setServer({ sync });
        await f.beat();
        assert.equal(f.reloadCount, 1);
        assert.deepEqual(f.duringReload, [true]);
        assert.equal(f.frame.inert, false);
        assert.equal(f.p.dirtyRef.current, false);
        assert.ok(f.posts.some((body) => body.syncAck === sync.id));
        f.setDoc(edited);
        await act(async () => {
            await f.hook.observeDirty(true);
        });
        assert.equal(
            f.p.dirtyRef.current,
            true,
            "a later user edit compares against the Host baseline",
        );
    }));
test("heartbeat's snapshot catches an unreported edit and sends no refresh ack", async () =>
    hookFixture(async (f) => {
        f.setDoc(edited);
        f.setServer({ sync });
        await f.beat();
        assert.equal(f.reloadCount, 0);
        assert.equal(f.p.dirtyRef.current, true);
        assert.equal(f.frame.inert, false);
        assert.ok(f.posts.every((body) => !body.syncAck));
    }));
test("Host tool lease locks without a command acknowledgement and unlocks on release", async () =>
    hookFixture(async (f) => {
        f.setServer({ activeLease: "tool-lease" });
        await f.beat();
        assert.equal(f.frame.inert, true);
        assert.ok(f.posts.every((body) => !body.ack));
        f.setServer({});
        await f.beat();
        assert.equal(f.frame.inert, false);
    }));
test("failed same sync is not retried every heartbeat", async () =>
    hookFixture(async (f) => {
        let attempts = 0;
        f.p.reload = async () => {
            attempts++;
            throw Error("reload failed");
        };
        f.setServer({ sync });
        await f.beat();
        f.p.dirtyRef.current = false;
        await f.beat();
        assert.equal(attempts, 1);
        assert.equal(f.frame.inert, false);
        assert.ok(f.posts.every((body) => !body.syncAck));
    }));
test("unmount during snapshot skips reload and acknowledgement", async () =>
    hookFixture(async (f) => {
        const waiting = deferred();
        f.p.snapshot = () => waiting.promise;
        f.setServer({ sync });
        await f.beat();
        assert.equal(f.frame.inert, true);
        await f.unmount();
        waiting.resolve({ docJson: original, generation: 1, revision: 4 });
        await settle();
        assert.equal(f.reloadCount, 0);
        assert.equal(f.frame.inert, false);
        assert.ok(f.posts.every((body) => !body.syncAck));
    }));
test("newer pending sync survives the previous acknowledgement and is applied next", async () =>
    hookFixture(async (f) => {
        const next = { id: "sync-2", documentJson: documentJson("newer host") };
        const reload = f.p.reload;
        let count = 0;
        f.p.reload = async (text) => {
            await reload(text);
            if (++count === 1) f.setServer({ sync: next });
        };
        f.setServer({ sync });
        await f.beat();
        assert.equal(f.reloadCount, 2);
        assert.deepEqual(
            f.posts.filter((body) => body.syncAck).map((body) => body.syncAck),
            [sync.id, next.id],
        );
    }));
test("a failed sync retries after a transport reconnect", async () =>
    hookFixture(async (f) => {
        const reload = f.p.reload;
        let attempts = 0;
        f.p.reload = async (text) => {
            if (++attempts === 1) throw Error("reload failed");
            await reload(text);
        };
        f.setServer({ sync });
        await f.beat();
        const fetch = globalThis.fetch;
        globalThis.fetch = async () => {
            throw Error("disconnected");
        };
        await f.beat();
        globalThis.fetch = fetch;
        f.p.dirtyRef.current = false;
        await f.beat();
        assert.equal(attempts, 2);
        assert.ok(f.posts.some((body) => body.syncAck === sync.id));
    }));
test("launch replacement during snapshot skips stale reload and ack", async () =>
    hookFixture(async (f) => {
        const waiting = deferred();
        f.p.snapshot = () => waiting.promise;
        f.setServer({ sync });
        await f.beat();
        assert.equal(f.frame.inert, true);
        f.p.launchRef.current = { stateUrl: "http://localhost/next/state" };
        waiting.resolve({ docJson: original, generation: 1, revision: 4 });
        await settle();
        assert.equal(f.reloadCount, 0);
        assert.equal(f.frame.inert, false);
        assert.ok(f.posts.every((body) => !body.syncAck));
    }));
test("explicit lease and release commands retain their acknowledgement protocol", async () =>
    hookFixture(async (f) => {
        f.setServer({ command: { id: "lease-1", type: "lease" } });
        await f.beat();
        assert.equal(f.frame.inert, true);
        assert.ok(
            f.posts.some((body) => body.ack === "lease-1" && body.state.leaseId === "lease-1"),
        );
        f.setServer({ command: { id: "release-1", type: "release" } });
        await f.beat();
        assert.equal(f.frame.inert, false);
        assert.ok(f.posts.some((body) => body.ack === "release-1"));
    }));
test("checkpoint failure does not treat a failed sync as a transport reconnect", async () =>
    hookFixture(async (f) => {
        let attempts = 0;
        f.p.reload = async () => {
            attempts++;
            throw Error("reload failed");
        };
        f.p.checkpoint = async () => {
            throw Error("checkpoint failed");
        };
        f.setServer({ sync });
        await f.beat();
        f.p.dirtyRef.current = false;
        await f.beat();
        assert.equal(attempts, 1);
        assert.ok(f.posts.every((body) => !body.syncAck));
    }));

test("pending comparison is not reported as an unsaved edit", async () =>
    hookFixture(async (f) => {
        const waiting = deferred();
        f.p.snapshot = () => waiting.promise;
        const comparison = f.hook.observeDirty(false);
        await f.beat();
        assert.equal(f.posts.at(-1).state.dirty, false);
        waiting.resolve({ docJson: original, ...f.p.versionRef.current });
        await comparison;
    }));
for (const operation of ["opened", "observeDirty"]) {
    test(`${operation} snapshot failure preserves the last confirmed clean state`, async () =>
        hookFixture(async (f) => {
            f.p.snapshot = async () => {
                throw Error("editor unavailable");
            };
            await act(async () => {
                await f.hook[operation](false);
            });
            await f.beat();
            assert.equal(f.p.dirtyRef.current, false);
            assert.equal(f.posts.at(-1).state.dirty, false);
        }));
    test(`${operation} snapshot failure preserves confirmed unsaved edits`, async () =>
        hookFixture(async (f) => {
            f.p.dirtyRef.current = true;
            f.p.snapshot = async () => {
                throw Error("editor unavailable");
            };
            await act(async () => {
                await f.hook[operation](false);
            });
            await f.beat();
            assert.equal(f.p.dirtyRef.current, true);
            assert.equal(f.posts.at(-1).state.dirty, true);
        }));
}
test("opened version drift is not reported as a user edit", async () =>
    hookFixture(async (f) => {
        f.p.snapshot = async () => ({ docJson: original, generation: 1, revision: 3 });
        await act(async () => {
            await f.hook.opened();
        });
        await f.beat();
        assert.equal(f.p.dirtyRef.current, false);
        assert.equal(f.posts.at(-1).state.dirty, false);
    }));
test("failed automatic refresh leaves a clean editor unblocked on later heartbeats", async () =>
    hookFixture(async (f) => {
        f.p.reload = async () => {
            throw Error("editor unavailable");
        };
        f.setServer({ sync });
        await f.beat();
        await f.beat();
        assert.equal(f.p.dirtyRef.current, false);
        assert.equal(f.posts.at(-1).state.dirty, false);
        assert.ok(f.posts.every((body) => !body.syncAck));
    }));

// Exercise the actual panel callback with a small bridge environment.
const panelSource = await readFile(
    new URL("../src/vendor/client/editor-panel.tsx", import.meta.url),
    "utf8",
);
const callbackSource = panelSource.slice(
    panelSource.indexOf("const reloadStudioDocument = useCallback("),
    panelSource.indexOf("const checkpointStudioDocument"),
);
const { makeReload } = await import(
    dataModule(
        stripTypeScriptTypes(`
export function makeReload({launchRef,iframeRef,originRef,post,updatePhase,window,setTimeout,clearTimeout,editorMessageFrom}) {
  const useCallback = callback => callback;
  ${callbackSource}
  return reloadStudioDocument;
}`),
    )
);
for (const change of ["launch", "frame", "origin", "none"]) {
    test(`panel reload guards ${change} identity and never clears dirty without a snapshot`, async () => {
        const window = new EventTarget(),
            phases = [],
            posts = [],
            timers = new Map();
        let nextTimer = 0;
        const state = {
            launchRef: { current: {} },
            iframeRef: { current: { contentWindow: {} } },
            originRef: { current: "http://localhost" },
        };
        const reload = makeReload({
            ...state,
            window,
            post: (value) => posts.push(value),
            updatePhase: (value) => phases.push(value),
            setTimeout: (callback) => {
                timers.set(++nextTimer, callback);
                return nextTimer;
            },
            clearTimeout: (id) => timers.delete(id),
            editorMessageFrom: (event) => event.data,
        });
        const operation = reload(updated);
        if (change === "launch") state.launchRef.current = {};
        if (change === "frame") state.iframeRef.current = { contentWindow: {} };
        if (change === "origin") state.originRef.current = "http://elsewhere";
        window.dispatchEvent(new MessageEvent("message", { data: { type: "op-bridge/opened" } }));
        if (change === "none") {
            await operation;
            assert.deepEqual(phases, ["ready"]);
        } else {
            await assert.rejects(operation, /Canvas changed during reload/);
            assert.deepEqual(phases, []);
        }
        assert.equal(timers.size, 0);
        assert.equal(posts.length, 1);
    });
}
