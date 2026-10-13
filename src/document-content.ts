/** Stable authored-content identity; selection, viewport and active-page metadata are not edits. */
export function authoredContent(text: string): string {
    const document = JSON.parse(text);
    delete document.editorMeta;
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
