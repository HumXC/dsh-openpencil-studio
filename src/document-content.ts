import { canonicalizeDocumentImages } from "./document-images.js";

/** Stable authored-content identity, independent of view metadata and image table encoding. */
export function authoredContent(text: string): string {
    const document = JSON.parse(text);
    delete document.editorMeta;
    canonicalizeDocumentImages(document);
    const canonical = (value: unknown): unknown => {
        if (Array.isArray(value)) return value.map(canonical);
        if (value && typeof value === "object")
            return Object.fromEntries(
                Object.entries(value)
                    .sort(([a], [b]) => a.localeCompare(b))
                    .map(([key, item]) => [key, canonical(item)]),
            );
        return value;
    };
    return JSON.stringify(canonical(document));
}
