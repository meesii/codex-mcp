import { readFile, readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const SKIP_DIRECTORIES = new Set([".git", "node_modules", ".dart_tool", "build", "dist"]);

export interface WalkedFile { absolutePath: string; relativePath: string; }

export async function collectFiles(root: string, maxFiles = 50_000, accept?: (path: string) => boolean): Promise<WalkedFile[]> {
    const info = await stat(root);
    if (info.isFile()) return [{ absolutePath: root, relativePath: root.split(/[\\/]/).at(-1)! }];
    if (!info.isDirectory()) throw new Error(`Invalid path: ${root}`);
    const result: WalkedFile[] = [];
    async function walk(directory: string): Promise<void> {
        for (const entry of await readdir(directory, { withFileTypes: true })) {
            if (result.length >= maxFiles) return;
            if (entry.isDirectory() && SKIP_DIRECTORIES.has(entry.name)) continue;
            const absolutePath = join(directory, entry.name);
            if (entry.isDirectory()) await walk(absolutePath);
            else if (entry.isFile()) {
                const relativePath = relative(root, absolutePath).replaceAll("\\", "/");
                if (!accept || accept(relativePath)) result.push({ absolutePath, relativePath });
            }
        }
    }
    await walk(root);
    return result;
}

export async function readLinesSafe(path: string): Promise<string[]> {
    try {
        const content = await readFile(path, "utf8");
        if (content.includes("\0")) return [];
        return content.replaceAll("\r\n", "\n").split("\n");
    } catch {
        return [];
    }
}
