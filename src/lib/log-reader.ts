import { closeSync, existsSync, openSync, readdirSync, readSync, statSync } from "node:fs";
import { join } from "node:path";
import { getUserLogDir } from "../config/user-config.js";

const MAX_LOG_READ_BYTES = 512 * 1024;
const ROTATED_LOG_NAME = /^codex-mcp\.\d{4}-\d{2}-\d{2}\.\d+\.jsonl$/;

export function getCurrentLogPath(): string {
    const directory = getUserLogDir();
    try {
        const candidates = readdirSync(directory)
            .filter((name) => ROTATED_LOG_NAME.test(name))
            .map((name) => {
                const path = join(directory, name);
                try {
                    return { path, mtimeMs: statSync(path).mtimeMs };
                } catch {
                    return undefined;
                }
            })
            .filter((entry): entry is { path: string; mtimeMs: number } => entry !== undefined)
            .sort((left, right) => left.mtimeMs - right.mtimeMs || left.path.localeCompare(right.path));
        return candidates.at(-1)?.path ?? join(directory, "codex-mcp.jsonl");
    } catch {
        return join(directory, "codex-mcp.jsonl");
    }
}

/** Read a bounded tail of the current log without loading the whole file. */
export function readRecentLogLines(lines: number): { path: string; text: string } {
    const path = getCurrentLogPath();
    if (!existsSync(path)) return { path, text: "" };
    const requestedLines = Number.isInteger(lines) ? Math.max(1, Math.min(5000, lines)) : 100;
    const size = statSync(path).size;
    const offset = Math.max(0, size - MAX_LOG_READ_BYTES);
    const length = size - offset;
    const buffer = Buffer.alloc(length);
    const fd = openSync(path, "r");
    let bytesRead = 0;
    try {
        bytesRead = readSync(fd, buffer, 0, length, offset);
    } finally {
        closeSync(fd);
    }
    let content = buffer.subarray(0, bytesRead).toString("utf8");
    if (offset > 0) {
        const firstNewline = content.indexOf("\n");
        content = firstNewline >= 0 ? content.slice(firstNewline + 1) : "";
    }
    const rows = content.split(/\r?\n/);
    if (rows.at(-1) === "") rows.pop();
    return { path, text: rows.slice(-requestedLines).join("\n") };
}
