import { spawn } from "node:child_process";

export interface CloudflaredRunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

/**
 * Run a short cloudflared command and capture stdout/stderr.
 *
 * @param bin - cloudflared executable
 * @param args - CLI arguments
 * @param options - Timeout and whether failure should throw
 * @returns Captured result
 */
export async function runCloudflared(
    bin: string,
    args: string[],
    options: { timeoutMs?: number; allowFailure?: boolean } = {},
): Promise<CloudflaredRunResult> {
    const timeoutMs = options.timeoutMs ?? 120_000;
    const result = await new Promise<CloudflaredRunResult>((resolve, reject) => {
        const child = spawn(bin, args, {
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: process.env,
        });
        let stdout = "";
        let stderr = "";
        const timer = setTimeout(() => {
            child.kill();
            reject(new Error(`cloudflared timed out: ${args.join(" ")}`));
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ code, stdout, stderr });
        });
    });

    if (!options.allowFailure && result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim() || `exit ${result.code}`;
        throw new Error(`cloudflared ${args.join(" ")} failed: ${detail}`);
    }
    return result;
}

/**
 * Run cloudflared with inherited stdio (for browser login flows).
 *
 * @param bin - cloudflared executable
 * @param args - CLI arguments
 * @returns Exit code
 */
export async function runCloudflaredInherit(
    bin: string,
    args: string[],
): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const child = spawn(bin, args, {
            stdio: "inherit",
            windowsHide: false,
            env: process.env,
        });
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
    });
}
