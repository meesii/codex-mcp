import { spawn } from "node:child_process";

let cachedRgPath: string | null | undefined;

/**
 * Locate a usable `rg` binary on PATH.
 *
 * @returns Absolute or command name for ripgrep, or null when unavailable
 */
export async function findRipgrep(): Promise<string | null> {
    if (cachedRgPath !== undefined) {
        return cachedRgPath;
    }

    const candidates = process.platform === "win32" ? ["rg.exe", "rg"] : ["rg"];
    for (const candidate of candidates) {
        try {
            await new Promise<void>((resolve, reject) => {
                const child = spawn(candidate, ["--version"], {
                    stdio: "ignore",
                    shell: false,
                    windowsHide: true,
                });
                child.on("error", reject);
                child.on("exit", (code) => {
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
}

/**
 * Run ripgrep with the given arguments.
 *
 * @param rgPath - Ripgrep binary
 * @param args - CLI arguments
 * @param cwd - Working directory
 * @returns Captured stdout/stderr/exit code
 */
export async function runRipgrep(
    rgPath: string,
    args: string[],
    cwd: string,
): Promise<RipgrepRunResult> {
    return new Promise((resolve, reject) => {
        const child = spawn(rgPath, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", reject);
        child.on("close", (code) => {
            resolve({
                stdout,
                stderr,
                exitCode: code ?? 1,
            });
        });
    });
}
