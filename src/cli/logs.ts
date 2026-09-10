import { existsSync } from "node:fs";
import { open } from "node:fs/promises";
import { once } from "node:events";
import { setTimeout as delay } from "node:timers/promises";
import { getCurrentLogPath } from "../lib/log-reader.js";

export { getCurrentLogPath, readRecentLogLines } from "../lib/log-reader.js";

const MAX_FOLLOW_BYTES = 512 * 1024;
const CHUNK_BYTES = 64 * 1024;

/** Follow the current log across rotation, with bounded reads and stdout backpressure. */
export async function followLogFile(initialPath: string): Promise<void> {
    if (!existsSync(initialPath)) throw new Error(`还没有运行日志：${initialPath}`);
    const controller = new AbortController();
    const finish = () => controller.abort();
    process.once("SIGINT", finish);
    process.once("SIGTERM", finish);
    let path = initialPath;
    let offset: number | undefined;
    let identity: string | undefined;
    const buffer = Buffer.alloc(CHUNK_BYTES);
    try {
        while (!controller.signal.aborted) {
            try {
                const file = await open(path, "r");
                try {
                    const info = await file.stat();
                    const nextIdentity = `${info.dev}:${info.ino}`;
                    if (offset === undefined) offset = info.size;
                    else if (identity !== nextIdentity || info.size < offset) offset = 0;
                    identity = nextIdentity;
                    if (info.size - offset > MAX_FOLLOW_BYTES) {
                        offset = info.size - MAX_FOLLOW_BYTES;
                        process.stderr.write("日志增长过快，已跳过较早内容。\n");
                    }
                    while (offset < info.size && !controller.signal.aborted) {
                        const { bytesRead } = await file.read(buffer, 0, Math.min(CHUNK_BYTES, info.size - offset), offset);
                        if (bytesRead === 0) break;
                        offset += bytesRead;
                        // Copy before reusing the read buffer: stdout may retain the chunk.
                        if (!process.stdout.write(Buffer.from(buffer.subarray(0, bytesRead)))) {
                            await once(process.stdout, "drain", { signal: controller.signal });
                        }
                    }
                } finally {
                    await file.close();
                }
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
            }
            const currentPath = getCurrentLogPath();
            if (currentPath !== path) {
                path = currentPath;
                offset = 0;
                identity = undefined;
                continue;
            }
            await delay(250, undefined, { signal: controller.signal });
        }
    } catch (error) {
        if (!controller.signal.aborted) throw error;
    } finally {
        process.off("SIGINT", finish);
        process.off("SIGTERM", finish);
    }
}
