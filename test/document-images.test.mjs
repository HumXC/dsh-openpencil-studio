import test from "node:test";
import assert from "node:assert/strict";
import { parseDocument } from "../lib/validation.js";
import { assertNativeArguments } from "../lib/native.js";
import { authoredContent } from "../lib/document-content.js";
import { documentHash } from "../lib/studio.js";

const payload = "data:image/png;base64," + "A".repeat(4096);
const image = (src) => ({ id: "image", type: "image", src, width: 10, height: 10 });
const document = (src, extra = {}) => ({ version: "0.8.5", children: [image(src)], ...extra });
const parse = (value) => parseDocument(JSON.stringify(value));

// The native save serializer moves data URIs >= 4096 bytes to this images table.
test("native compact snapshots validate without expanding or rewriting their image table", () => {
    const compact = document("op-image:paint", { images: { paint: payload } });
    assert.deepEqual(parse(compact), compact);
    for (const src of [payload, "https://example.test/image.png", "http://example.test/image.png"])
        assert.doesNotThrow(() => parse(document(src)));
    assert.doesNotThrow(() =>
        parse(
            document("op-image:remote", { images: { remote: "https://example.test/image.png" } }),
        ),
    );
});

test("image references resolve in pages, nested nodes, fills, strokes and widget state paints", () => {
    const fill = [{ type: "image", url: "op-image:paint" }];
    const compact = {
        version: "0.8.5",
        images: { paint: payload },
        children: [image("op-image:paint")],
        pages: [
            {
                id: "page",
                children: [
                    {
                        id: "frame",
                        type: "frame",
                        fill,
                        stroke: { fill },
                        states: { hover: { fill, stroke: { fill } } },
                        children: [image("op-image:paint")],
                    },
                ],
            },
        ],
    };
    assert.doesNotThrow(() => parse(compact));
    const canonical = JSON.parse(authoredContent(JSON.stringify(compact)));
    const frame = canonical.pages[0].children[0];
    assert.deepEqual(canonical.images, { 0: payload });
    assert.equal(canonical.children[0].src, "op-image:0");
    assert.equal(frame.children[0].src, "op-image:0");
    assert.equal(frame.fill[0].url, "op-image:0");
    assert.equal(frame.stroke.fill[0].url, "op-image:0");
    assert.equal(frame.states.hover.fill[0].url, "op-image:0");
    assert.equal(frame.states.hover.stroke.fill[0].url, "op-image:0");
});

test("comparison size stays bounded when many nodes share one large image", () => {
    const large = "data:image/png;base64," + "A".repeat(64 * 1024);
    const children = Array.from({ length: 128 }, (_, index) => ({
        ...image("op-image:paint"),
        id: `image-${index}`,
    }));
    const compact = JSON.stringify({ version: "0.8.5", children, images: { paint: large } });
    const canonical = authoredContent(compact);
    assert.ok(
        canonical.length < compact.length * 1.1,
        "comparison must store each payload only once",
    );
    const inline = JSON.stringify({
        version: "0.8.5",
        children: children.map((node) => ({ ...node, src: large })),
    });
    assert.equal(authoredContent(inline), canonical);
});

test("canonical image ids do not depend on state property order or original table ids", () => {
    const second = payload + "B";
    const fill = (url) => [{ type: "image", url }];
    const inline = {
        version: "0.8.5",
        children: [
            {
                id: "frame",
                type: "frame",
                states: {
                    hover: { fill: fill(payload) },
                    pressed: { fill: fill(second) },
                },
            },
        ],
    };
    const compact = {
        version: "0.8.5",
        children: [
            {
                id: "frame",
                type: "frame",
                states: {
                    pressed: { fill: fill("op-image:b") },
                    hover: { fill: fill("op-image:a") },
                },
            },
        ],
        images: { b: second, a: payload },
    };
    assert.equal(documentHash(JSON.stringify(inline)), documentHash(JSON.stringify(compact)));
});

test("missing, empty and inherited image references are rejected with node and field diagnostics", () => {
    for (const [src, images] of [
        ["op-image:missing", undefined],
        ["op-image:missing", { paint: payload }],
        ["op-image:", { "": payload }],
        ["op-image:toString", {}],
        ["op-image:__proto__", {}],
    ]) {
        assert.throws(
            () => parse(document(src, images === undefined ? {} : { images })),
            (error) => {
                assert.equal(error.code, "INVALID_IMAGE_REFERENCE");
                assert.equal(error.details.nodeId, "image");
                assert.equal(error.details.property, "$.children[0].src");
                assert.equal(error.details.uriScheme, "op-image");
                assert.equal(error.details.committed, false);
                return true;
            },
        );
    }
});

test("malformed tables, local assets and chained or cyclic table references are rejected", () => {
    for (const images of [
        null,
        [],
        "invalid",
        { paint: null },
        { paint: {} },
        { paint: "" },
        { paint: "/tmp/image.png" },
        { paint: "blob:private" },
        { paint: "file:///tmp/private.png" },
        { paint: "op-image:paint" },
        { paint: "op-image:other", other: "op-image:paint" },
        { paint: payload, unused: "file:///tmp/private.png" },
    ]) {
        assert.throws(
            () => parse(document("op-image:paint", { images })),
            (error) => error.code === "INVALID_IMAGE_TABLE" && error.details.committed === false,
        );
    }
});

test("invalid node and state-paint URIs report location and scheme without exposing URI contents", () => {
    const invalid = "blob:private-image-body";
    assert.throws(
        () =>
            parse({
                version: "0.8.5",
                children: [
                    {
                        id: "frame",
                        type: "frame",
                        states: { hover: { fill: [{ type: "image", url: invalid }] } },
                    },
                ],
            }),
        (error) => {
            assert.equal(error.code, "LOCAL_ASSET_UNSUPPORTED");
            assert.equal(error.details.nodeId, "frame");
            assert.equal(error.details.property, '$.children[0].states["hover"].fill[0].url');
            assert.equal(error.details.uriScheme, "blob");
            assert.equal(error.details.uriLength, invalid.length);
            assert.ok(!JSON.stringify(error.details).includes("private-image-body"));
            return true;
        },
    );
    for (const src of ["", "assets/image.png", "file:///tmp/image.png", "blob:temporary"])
        assert.throws(
            () => parse(document(src)),
            (error) => error.code === "LOCAL_ASSET_UNSUPPORTED",
        );
});

test("free-form app data, state defaults, action params and software routes are preserved", () => {
    const free = { type: "image", src: "op-image:unresolved", url: "/software/route" };
    const value = document(payload, {
        app: free,
        state: { image: free },
        routes: [{ path: "/settings", image: free }],
    });
    value.children[0].actions = [{ params: free }];
    assert.deepEqual(parse(value), value);
    const canonical = JSON.parse(authoredContent(JSON.stringify(value)));
    assert.deepEqual(canonical.app, free);
    assert.deepEqual(canonical.children[0].actions[0].params, free);
});

test("content identity is independent of image table ids, encoding and derived thumbnails", () => {
    const inline = JSON.stringify(document(payload));
    const compact = document("op-image:first", {
        images: { first: payload },
        imageThumbs: { 123: "thumbnail" },
        editorMeta: { zoom: 2 },
    });
    const renamed = document("op-image:other", { images: { other: payload, unused: payload } });
    for (const value of [compact, renamed]) {
        assert.equal(authoredContent(JSON.stringify(value)), authoredContent(inline));
        assert.equal(documentHash(JSON.stringify(value)), documentHash(inline));
    }
    compact.images.first += "B";
    assert.notEqual(documentHash(JSON.stringify(compact)), documentHash(inline));
    const free = document(payload, { state: { text: "op-image:first" } });
    const changed = document(payload, { state: { text: "op-image:other" } });
    assert.notEqual(documentHash(JSON.stringify(free)), documentHash(JSON.stringify(changed)));
});

test("document image table support does not loosen native tool argument restrictions", () => {
    for (const args of [
        { data: image("op-image:paint"), images: { paint: payload } },
        { node_json: JSON.stringify(image("op-image:paint")) },
        { data: { type: "frame", fill: [{ type: "image", url: "op-image:paint" }] } },
    ])
        assert.throws(
            () => assertNativeArguments(args),
            (error) => error.code === "LOCAL_ASSET_UNSUPPORTED",
        );
    assert.doesNotThrow(() => assertNativeArguments({ data: image(payload) }));
});
