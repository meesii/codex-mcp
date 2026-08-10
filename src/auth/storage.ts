import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { randomUUID } from "node:crypto";

/** Read JSON from disk, returning the supplied fallback when the file is absent. */
export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
        throw error;
    }
}

/** Atomically persist JSON with owner-only permissions where the platform supports it. */
export async function writePrivateJson(path: string, value: unknown): Promise<void> {
    await mkdir(dirname(path), { recursive: true });
    const tempPath = `${path}.${process.pid}.${randomUUID()}.tmp`;
    const body = `${JSON.stringify(value, null, 2)}\n`;
    await writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
    await rename(tempPath, path);
    if (process.platform !== "win32") {
        await chmod(path, 0o600);
    }
}

/** Small async mutex for state stores that persist full snapshots. */
export class AsyncMutex {
    private tail: Promise<void> = Promise.resolve();

    async run<T>(task: () => Promise<T>): Promise<T> {
        const previous = this.tail;
        let release!: () => void;
        const gate = new Promise<void>((resolve) => {
            release = resolve;
        });
        this.tail = previous.then(() => gate, () => gate);
        await previous.catch(() => undefined);
        try {
            return await task();
        } finally {
            release();
        }
    }
}
