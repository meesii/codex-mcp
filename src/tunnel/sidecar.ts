import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { ensureUserConfigDirs, getUserLogDir } from "../user-config.js";
import { getCloudflaredConfigPath } from "./yml.js";

export interface TunnelSidecarOptions {
    bin: string;
    tunnelId: string;
    configPath?: string;
    /** Mirror log lines to the parent terminal with a prefix. */
    mirrorLogs?: boolean;
}

/**
 * Manage a long-running `cloudflared tunnel run` child process.
 *
 * Logs go to `~/.codex-mcp/logs/tunnel.log` by default so the project
 * terminal stays readable.
 */
export class CloudflaredSidecar {
    private child: ChildProcess | undefined;
    private logStream: WriteStream | undefined;
    private readonly logPath: string;
    private exitCode: number | null = null;
    private readonly mirrorLogs: boolean;

    /**
     * @param options - Binary, tunnel id, and log mirroring
     */
    constructor(private readonly options: TunnelSidecarOptions) {
        ensureUserConfigDirs();
        mkdirSync(getUserLogDir(), { recursive: true });
        this.logPath = join(getUserLogDir(), "tunnel.log");
        this.mirrorLogs = options.mirrorLogs === true;
    }

    /**
     * Path of the tunnel log file for this machine.
     *
     * @returns Absolute log path
     */
    getLogPath(): string {
        return this.logPath;
    }

    /**
     * Start cloudflared and wait until it stays alive briefly.
     *
     * @returns Resolves when the process looks healthy
     */
    async start(): Promise<void> {
        if (this.child) {
            throw new Error("cloudflared sidecar already started");
        }

        const configPath = this.options.configPath ?? getCloudflaredConfigPath();
        this.logStream = createWriteStream(this.logPath, { flags: "a" });
        this.writeLog(
            `\n---- ${new Date().toISOString()} start tunnel ${this.options.tunnelId} ----\n`,
        );

        const child = spawn(
            this.options.bin,
            [
                "tunnel",
                "--config",
                configPath,
                "run",
                this.options.tunnelId,
            ],
            {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                env: process.env,
            },
        );
        this.child = child;
        this.exitCode = null;

        child.stdout?.on("data", (chunk: Buffer) => this.writeLog(chunk.toString("utf8")));
        child.stderr?.on("data", (chunk: Buffer) => this.writeLog(chunk.toString("utf8")));
        child.on("error", (error) => {
            this.writeLog(`spawn error: ${error.message}\n`);
        });
        child.on("close", (code) => {
            this.exitCode = code;
            this.writeLog(`---- exited code=${code ?? "null"} ----\n`);
            this.child = undefined;
        });

        await sleep(1500);
        if (this.exitCode !== null || !this.child) {
            throw new Error(
                `cloudflared exited early (code ${this.exitCode}). See ${this.logPath}`,
            );
        }
    }

    /**
     * Stop the sidecar process if it is still running.
     */
    async stop(): Promise<void> {
        const child = this.child;
        if (!child?.pid) {
            this.logStream?.end();
            this.logStream = undefined;
            return;
        }

        await killProcessTree(child.pid);
        await Promise.race([
            new Promise<void>((resolve) => child.once("close", () => resolve())),
            sleep(3000),
        ]);
        this.child = undefined;
        this.logStream?.end();
        this.logStream = undefined;
    }

    /**
     * @param text - Log chunk
     */
    private writeLog(text: string): void {
        this.logStream?.write(text);
        if (this.mirrorLogs) {
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                if (line.trim()) {
                    console.error(`[tunnel] ${line}`);
                }
            }
        }
    }
}

/**
 * @param pid - Root process id
 */
async function killProcessTree(pid: number): Promise<void> {
    if (process.platform === "win32") {
        await new Promise<void>((resolve) => {
            const killer = spawn("taskkill.exe", ["/T", "/F", "/PID", String(pid)], {
                stdio: "ignore",
                windowsHide: true,
            });
            killer.on("close", () => resolve());
            killer.on("error", () => resolve());
        });
        return;
    }
    try {
        process.kill(pid, "SIGTERM");
    } catch {
        // already gone
    }
}

/**
 * @param ms - Delay
 * @returns Promise that resolves after ms
 */
function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
