import { record, StudioError } from "./errors.js";

const IMAGE_REFERENCE = "op-image:";
const EXTERNAL_IMAGE = /^(https?:\/\/|data:)/i;
interface ImageSlot {
    object: Record<string, unknown>;
    field: "src" | "url";
    path: string;
    nodeId?: string;
}

/** Match the native ImageSrc schema, without entering free-form app/state/action data. */
function visitImageSources(document: Record<string, unknown>, visit: (slot: ImageSlot) => void) {
    const stack: { value: unknown; path: string }[] = [];
    const children = (value: unknown, path: string) => {
        if (Array.isArray(value))
            value.forEach((value, index) => stack.push({ value, path: `${path}[${index}]` }));
    };
    children(document.children, "$.children");
    children(document.pages, "$.pages");
    while (stack.length) {
        const { value, path } = stack.pop()!;
        const node = record(value);
        if (!node) continue;
        const nodeId = typeof node.id === "string" ? node.id : undefined;
        const slot = (object: Record<string, unknown>, field: "src" | "url", path: string) =>
            visit({ object, field, path, ...(nodeId ? { nodeId } : {}) });
        const fill = (value: unknown, path: string) => {
            if (!Array.isArray(value)) return;
            value.forEach((value, index) => {
                const image = record(value);
                if (image?.type === "image") slot(image, "url", `${path}[${index}].url`);
            });
        };
        const paints = (object: Record<string, unknown>, path: string) => {
            fill(object.fill, `${path}.fill`);
            const stroke = record(object.stroke);
            if (stroke) fill(stroke.fill, `${path}.stroke.fill`);
        };
        if (node.type === "image") slot(node, "src", `${path}.src`);
        paints(node, path);
        for (const [name, value] of Object.entries(record(node.states) ?? {})) {
            const override = record(value);
            if (override) paints(override, `${path}.states[${JSON.stringify(name)}]`);
        }
        children(node.children, `${path}.children`);
    }
}

function uriDetails(value: unknown) {
    if (typeof value !== "string") return {};
    const scheme = /^([a-z][a-z\d+.-]*):/i.exec(value.trim())?.[1]?.toLowerCase();
    return { uriScheme: scheme ?? (value.trim() ? "relative" : "empty"), uriLength: value.length };
}

function imageTable(document: Record<string, unknown>) {
    if (!Object.hasOwn(document, "images")) return {};
    const table = record(document.images);
    if (!table)
        throw new StudioError("INVALID_IMAGE_TABLE", "Document images must be an object", {
            property: "$.images",
            committed: false,
        });
    for (const [imageId, source] of Object.entries(table)) {
        if (typeof source !== "string" || !EXTERNAL_IMAGE.test(source.trim()))
            throw new StudioError(
                "INVALID_IMAGE_TABLE",
                "Image table entries must contain HTTP(S) or data URIs, not image references",
                {
                    imageId,
                    property: `$.images[${JSON.stringify(imageId)}]`,
                    ...uriDetails(source),
                    committed: false,
                },
            );
    }
    return table;
}

/** Document-only support for native image tables. Native tool arguments stay URI-only. */
export function assertDocumentResourceUris(document: Record<string, unknown>) {
    const table = imageTable(document);
    visitImageSources(document, ({ object, field, path, nodeId }) => {
        const source = object[field];
        if (typeof source !== "string") return;
        const details = { field, property: path, ...(nodeId ? { nodeId } : {}), committed: false };
        if (source.startsWith(IMAGE_REFERENCE)) {
            const imageId = source.slice(IMAGE_REFERENCE.length);
            if (!imageId || !Object.hasOwn(table, imageId))
                throw new StudioError(
                    "INVALID_IMAGE_REFERENCE",
                    "Image reference has no matching entry in the document images table",
                    { ...details, imageId, ...uriDetails(source) },
                );
        } else if (!EXTERNAL_IMAGE.test(source.trim())) {
            throw new StudioError(
                "LOCAL_ASSET_UNSUPPORTED",
                "Use an HTTP(S) or data URI for images; native filesystem asset paths are not exposed",
                { ...details, ...uriDetails(source) },
            );
        }
    });
}

/** Canonicalize a comparison copy without expanding repeated payloads; saved snapshots stay intact. */
export function canonicalizeDocumentImages(document: Record<string, unknown>) {
    assertDocumentResourceUris(document);
    const table = record(document.images) ?? {};
    const resolve = (source: string) =>
        source.startsWith(IMAGE_REFERENCE)
            ? (table[source.slice(IMAGE_REFERENCE.length)] as string)
            : source;
    const unique = new Set<string>();
    visitImageSources(document, ({ object, field }) => {
        if (typeof object[field] === "string") unique.add(resolve(object[field]));
    });
    // Content order, rather than original table ids or object key order, determines reference ids.
    const sources = [...unique].sort();
    const references = new Map(
        sources.map((source, index) => [source, `${IMAGE_REFERENCE}${index}`]),
    );
    visitImageSources(document, ({ object, field }) => {
        if (typeof object[field] === "string")
            object[field] = references.get(resolve(object[field]));
    });
    if (sources.length)
        document.images = Object.fromEntries(
            sources.map((source, index) => [String(index), source]),
        );
    else delete document.images;
    delete document.imageThumbs; // Derived raster previews are not authored content.
}
