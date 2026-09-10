import { readFile } from "node:fs/promises";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";

export async function readJsonFile<T>(path: string, fallback: T): Promise<T> {
    try {
        return JSON.parse(await readFile(path, "utf8")) as T;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return fallback;
        throw error;
    }
}

export async function writePrivateJson(path: string, value: unknown): Promise<void> {
    writePrivateFileAtomic(path, `${JSON.stringify(value, null, 2)}\n`);
}
