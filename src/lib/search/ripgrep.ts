import { spawn } from "node:child_process";
import { getManagedToolPath } from "../../managed-tools/paths.js";
import { terminateChildProcess } from "../process/tree.js";

let cachedRgPath: string | null | undefined;

export async function findRipgrep(): Promise<string | null> {
    if (cachedRgPath !== undefined) {
        return cachedRgPath;
    }

    const candidates = [
        getManagedToolPath("ripgrep"),
        ...(process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"]),
    ];
    for (const candidate of candidates) {
        try {
            await new Promise<void>((resolve, reject) => {
                const child = spawn(candidate, ["--version"], {
                    stdio: "ignore",
                    shell: false,
                    windowsHide: true,
                });
                const timer = setTimeout(() => {
                    void terminateChildProcess(child, 500, 500).catch(() => undefined);
                    reject(new Error("ripgrep version probe timed out"));
                }, 5_000);
                timer.unref();
                child.on("error", (error) => {
                    clearTimeout(timer);
                    reject(error);
                });
                child.on("exit", (code) => {
                    clearTimeout(timer);
                    if (code === 0) resolve();
                    else reject(new Error(`exit ${code}`));
                });
            });
            cachedRgPath = candidate;
            return candidate;
        } catch {
            // try next
        }
    }

    cachedRgPath = null;
    return null;
}

export interface RipgrepRunResult {
    stdout: string;
    stderr: string;
    exitCode: number;
    truncated: boolean;
}

export async function runRipgrep(
    rgPath: string,
    args: string[],
    cwd: string,
    maxOutputChars = 1_000_000,
    timeoutMs = 30_000,
): Promise<RipgrepRunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(rgPath, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            detached: process.platform !== "win32",
        });
        let stdout = "";
        let stderr = "";
        let truncated = false;
        let timedOut = false;
        let terminating = false;
        let settled = false;

        const fail = (error: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };
        const terminate = (): void => {
            if (terminating || !child.pid) return;
            terminating = true;
            void terminateChildProcess(child).catch(fail);
        };
        const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
            if (truncated) return;
            const text = chunk.toString("utf8");
            const remaining = Math.max(0, maxOutputChars - stdout.length - stderr.length);
            const clipped = text.slice(0, remaining);
            if (target === "stdout") stdout += clipped;
            else stderr += clipped;
            if (clipped.length < text.length || stdout.length + stderr.length >= maxOutputChars) {
                truncated = true;
                terminate();
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            terminate();
        }, timeoutMs);
        timer.unref();

        child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.on("error", (error) => fail(error));
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`ripgrep timed out after ${timeoutMs}ms`));
                return;
            }
            resolve({
                stdout,
                stderr,
                exitCode: truncated ? 0 : (code ?? 1),
                truncated,
            });
        });
    });
}
