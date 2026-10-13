import { lstat, mkdir, readFile, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { StudioError } from "./errors.js";
export interface RecentItem {
    path: string;
    lastOpenedAt: string;
}
export interface RecentAccess {
    root: string;
    writable: boolean;
}
/** Workspace metadata, never document authority or persisted presentation grants. */
export class RecentDocuments {
    private queues = new Map<string, Promise<unknown>>();
    constructor(
        private readonly access: (owner: string) => Promise<RecentAccess>,
        private readonly authorize: (
            path: string,
            owner: string,
            write: boolean,
        ) => Promise<string>,
    ) {}
    private async context(owner: string, write: boolean) {
        const access = await this.access(owner);
        if (write && !access.writable)
            throw new StudioError("READ_ONLY", "This session cannot update recent documents");
        const root = await realpath(access.root);
        let directory = root;
        for (const part of [".dsh", "openpencil"]) {
            directory = join(directory, part);
            if (write)
                await mkdir(directory, { recursive: false }).catch((error) => {
                    if (error.code !== "EEXIST") throw error;
                });
            try {
                const resolved = await realpath(directory),
                    tail = relative(root, resolved);
                if (tail === ".." || tail.startsWith("../") || isAbsolute(tail))
                    throw new StudioError(
                        "INVALID_RECENT_DIRECTORY",
                        "Recent metadata must stay in the workspace",
                    );
                directory = resolved;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
        }
        return { root, file: join(directory, "recent.json") };
    }
    private serial<T>(key: string, run: () => Promise<T>): Promise<T> {
        const result = (this.queues.get(key) ?? Promise.resolve()).then(run);
        const tail = result.catch(() => undefined);
        this.queues.set(key, tail);
        void tail.then(() => {
            if (this.queues.get(key) === tail) this.queues.delete(key);
        });
        return result;
    }
    private async read(file: string): Promise<RecentItem[]> {
        let text: string;
        try {
            const info = await lstat(file);
            if (info.isSymbolicLink() || !info.isFile())
                throw new StudioError(
                    "INVALID_RECENT_FILE",
                    "Recent metadata must be a regular workspace file",
                );
            text = await readFile(file, "utf8");
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
            throw error;
        }
        try {
            const value = JSON.parse(text);
            if (
                value.version !== 1 ||
                !Array.isArray(value.items) ||
                !value.items.every(
                    (item: RecentItem) =>
                        typeof item.path === "string" &&
                        isAbsolute(item.path) &&
                        item.path.toLowerCase().endsWith(".op") &&
                        !item.path.includes("\0") &&
                        typeof item.lastOpenedAt === "string" &&
                        Number.isFinite(Date.parse(item.lastOpenedAt)),
                )
            )
                throw new Error("invalid format");
            const unique = new Set<string>();
            return (value.items as RecentItem[])
                .sort((a, b) => Date.parse(b.lastOpenedAt) - Date.parse(a.lastOpenedAt))
                .filter((item) => {
                    if (unique.has(item.path)) return false;
                    unique.add(item.path);
                    return true;
                });
        } catch {
            throw new StudioError(
                "INVALID_RECENT_FILE",
                "Recent documents metadata is invalid; the existing file was preserved",
            );
        }
    }
    private async save(file: string, items: RecentItem[]) {
        const temporary = file + "." + randomUUID() + ".tmp";
        try {
            await writeFile(temporary, JSON.stringify({ version: 1, items }, null, 2) + "\n", {
                flag: "wx",
                mode: 0o600,
            });
            await rename(temporary, file);
        } finally {
            await unlink(temporary).catch(() => undefined);
        }
    }
    async list(owner: string) {
        const { root, file } = await this.context(owner, false);
        return this.serial(file, async () => ({
            ok: true,
            items: (await this.read(file)).map((item) => ({
                ...item,
                displayPath: relative(root, item.path) || item.path,
            })),
        }));
    }
    async touch(owner: string, path: string) {
        const canonical = await this.authorize(path, owner, false),
            { file } = await this.context(owner, true);
        return this.serial(file, async () => {
            const items = (await this.read(file)).filter((item) => item.path !== canonical);
            items.unshift({ path: canonical, lastOpenedAt: new Date().toISOString() });
            await this.save(file, items);
            return { ok: true, items };
        });
    }
    async remove(owner: string, path: string) {
        // A missing document can still be removed from the list; never open/delete it.
        const { root, file } = await this.context(owner, true),
            canonical = resolve(root, path);
        return this.serial(file, async () => {
            const before = await this.read(file),
                items = before.filter((item) => item.path !== canonical);
            if (items.length !== before.length) await this.save(file, items);
            return { ok: true, removed: items.length !== before.length, items };
        });
    }
}
