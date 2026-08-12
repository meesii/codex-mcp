import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { terminateChildProcess } from "../lib/process/tree.js";
import { getManagedCloudflareDir } from "./yml.js";

const MAX_CAPTURE_CHARS = 1_000_000;

export interface CloudflaredRunResult {
    code: number | null;
    stdout: string;
    stderr: string;
}

export function cloudflaredChildEnv(
    base: NodeJS.ProcessEnv = process.env,
    managedHome: string = getManagedCloudflareDir(),
): NodeJS.ProcessEnv {
    mkdirSync(managedHome, { recursive: true });
    const env = { ...base };
    for (const key of Object.keys(env)) {
        if (key.toUpperCase().startsWith("TUNNEL_")) {
            delete env[key];
        }
    }
    // cloudflared derives cert.pem and <UUID>.json from the user home directory.
    // Give it a private home so unrelated ~/.cloudflared state is never selected
    // or overwritten by codex-mcp management and sidecar processes.
    env.HOME = managedHome;
    env.USERPROFILE = managedHome;
    return env;
}

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
            env: cloudflaredChildEnv(),
            detached: process.platform !== "win32",
        });
        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let settled = false;

        const append = (target: "stdout" | "stderr", chunk: Buffer): void => {
            const text = chunk.toString("utf8");
            if (target === "stdout") {
                if (stdout.length < MAX_CAPTURE_CHARS) {
                    stdout += text.slice(0, MAX_CAPTURE_CHARS - stdout.length);
                }
            } else if (stderr.length < MAX_CAPTURE_CHARS) {
                stderr += text.slice(0, MAX_CAPTURE_CHARS - stderr.length);
            }
        };

        const timer = setTimeout(() => {
            timedOut = true;
            void terminateChildProcess(child).catch((error) => {
                if (settled) return;
                settled = true;
                reject(error);
            });
        }, timeoutMs);
        timer.unref();

        child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk));
        child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk));
        child.on("error", (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`cloudflared 运行超时：${args.join(" ")}`));
                return;
            }
            resolve({ code, stdout, stderr });
        });
    });

    if (!options.allowFailure && result.code !== 0) {
        const detail = (result.stderr || result.stdout).trim() || `退出代码 ${result.code}`;
        throw new Error(`cloudflared 执行失败（${args.join(" ")}）：${detail}`);
    }
    return result;
}

export async function runCloudflaredInherit(
    bin: string,
    args: string[],
): Promise<number> {
    return await new Promise<number>((resolve, reject) => {
        const child = spawn(bin, args, {
            stdio: "inherit",
            windowsHide: false,
            env: cloudflaredChildEnv(),
        });
        child.on("error", reject);
        child.on("close", (code) => resolve(code ?? 1));
    });
}
