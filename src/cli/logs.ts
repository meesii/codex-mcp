import { existsSync, openSync, closeSync, readFileSync, readSync, statSync, watchFile, unwatchFile } from "node:fs";
import { join } from "node:path";
import { getUserLogDir } from "../config/user-config.js";

export function getCurrentLogPath(): string {
    return join(getUserLogDir(), "codex-mcp.jsonl");
}

export function readRecentLogLines(lines: number): { path: string; text: string } {
    const path = getCurrentLogPath();
    if (!existsSync(path)) return { path, text: "" };
    const content = readFileSync(path, "utf8");
    const rows = content.split(/\r?\n/);
    if (rows.at(-1) === "") rows.pop();
    return { path, text: rows.slice(-lines).join("\n") };
}

/** Follow appended bytes until SIGINT/SIGTERM. The file must already exist. */
export async function followLogFile(path: string): Promise<void> {
    if (!existsSync(path)) {
        throw new Error(`还没有运行日志：${path}`);
    }
    let offset = statSync(path).size;
    let reading = false;

    const readAppended = () => {
        if (reading || !existsSync(path)) return;
        reading = true;
        try {
            const size = statSync(path).size;
            if (size < offset) offset = 0;
            if (size <= offset) return;
            const length = size - offset;
            const buffer = Buffer.alloc(length);
            const fd = openSync(path, "r");
            try {
                readSync(fd, buffer, 0, length, offset);
            } finally {
                closeSync(fd);
            }
            offset = size;
            process.stdout.write(buffer);
        } finally {
            reading = false;
        }
    };

    await new Promise<void>((resolve) => {
        const finish = () => {
            unwatchFile(path, readAppended);
            process.off("SIGINT", finish);
            process.off("SIGTERM", finish);
            resolve();
        };
        watchFile(path, { interval: 250 }, readAppended);
        process.once("SIGINT", finish);
        process.once("SIGTERM", finish);
    });
}
