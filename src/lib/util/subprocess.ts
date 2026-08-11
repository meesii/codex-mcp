import { spawn } from "node:child_process";
import { terminateChildProcess } from "../process/tree.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_STDOUT_BYTES = 2 * 1024 * 1024;
const DEFAULT_MAX_STDERR_BYTES = 256 * 1024;
const DEFAULT_MAX_TOTAL_BYTES = 2 * 1024 * 1024;

export interface RunSubprocessOptions {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    timeoutMs?: number;
    maxStdoutBytes?: number;
    maxStderrBytes?: number;
    maxTotalBytes?: number;
    detached?: boolean;
}

export interface SubprocessResult {
    stdout: string;
    stderr: string;
    exitCode: number | null;
    signal?: NodeJS.Signals;
    timedOut: boolean;
    truncated: boolean;
}

/**
 * Run one executable without a shell, with bounded capture and TERM→KILL shutdown.
 *
 * Hitting an output budget intentionally terminates the child and resolves with
 * `truncated=true`; callers that require complete output (for example JSON) must
 * reject truncated results. Timeouts reject so a stuck helper never blocks the
 * Node event loop or silently looks like valid partial output.
 */
export async function runSubprocess(
    file: string,
    args: readonly string[],
    options: RunSubprocessOptions = {},
): Promise<SubprocessResult> {
    const timeoutMs = positiveInt(options.timeoutMs, DEFAULT_TIMEOUT_MS, "timeoutMs");
    const maxStdoutBytes = positiveInt(
        options.maxStdoutBytes,
        DEFAULT_MAX_STDOUT_BYTES,
        "maxStdoutBytes",
    );
    const maxStderrBytes = positiveInt(
        options.maxStderrBytes,
        DEFAULT_MAX_STDERR_BYTES,
        "maxStderrBytes",
    );
    const maxTotalBytes = positiveInt(
        options.maxTotalBytes,
        DEFAULT_MAX_TOTAL_BYTES,
        "maxTotalBytes",
    );

    return await new Promise<SubprocessResult>((resolve, reject) => {
        const child = spawn(file, [...args], {
            ...(options.cwd ? { cwd: options.cwd } : {}),
            ...(options.env ? { env: options.env } : {}),
            stdio: ["ignore", "pipe", "pipe"],
            shell: false,
            windowsHide: true,
            detached: options.detached ?? process.platform !== "win32",
        });

        const stdoutChunks: Buffer[] = [];
        const stderrChunks: Buffer[] = [];
        let stdoutBytes = 0;
        let stderrBytes = 0;
        let totalBytes = 0;
        let truncated = false;
        let timedOut = false;
        let terminating = false;
        let settled = false;

        const finishError = (error: Error): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        };

        const terminate = (): void => {
            if (terminating || !child.pid) return;
            terminating = true;
            void terminateChildProcess(child).catch(finishError);
        };

        const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
            if (truncated) return;
            const targetBytes = target === "stdout" ? stdoutBytes : stderrBytes;
            const targetLimit = target === "stdout" ? maxStdoutBytes : maxStderrBytes;
            const allowed = Math.max(
                0,
                Math.min(targetLimit - targetBytes, maxTotalBytes - totalBytes),
            );
            const accepted = chunk.subarray(0, allowed);
            if (accepted.byteLength > 0) {
                if (target === "stdout") {
                    stdoutChunks.push(accepted);
                    stdoutBytes += accepted.byteLength;
                } else {
                    stderrChunks.push(accepted);
                    stderrBytes += accepted.byteLength;
                }
                totalBytes += accepted.byteLength;
            }
            if (accepted.byteLength < chunk.byteLength || totalBytes >= maxTotalBytes) {
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
        child.once("error", finishError);
        child.once("close", (code, signal) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`${file} timed out after ${timeoutMs}ms`));
                return;
            }
            resolve({
                stdout: Buffer.concat(stdoutChunks, stdoutBytes).toString("utf8"),
                stderr: Buffer.concat(stderrChunks, stderrBytes).toString("utf8"),
                exitCode: code,
                ...(signal ? { signal } : {}),
                timedOut: false,
                truncated,
            });
        });
    });
}

function positiveInt(value: number | undefined, fallback: number, label: string): number {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved <= 0) {
        throw new Error(`${label} must be a positive safe integer`);
    }
    return resolved;
}
