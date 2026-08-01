import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { ensureUserConfigDirs, getUserLogDir } from "../user-config.js";
import { getCloudflaredConfigPath } from "./yml.js";

/** Default wait for the first Cloudflare edge registration. */
const DEFAULT_READY_TIMEOUT_MS = 45_000;

export interface TunnelSidecarOptions {
    bin: string;
    tunnelId: string;
    configPath?: string;
    /** Mirror log lines to the parent terminal with a prefix. */
    mirrorLogs?: boolean;
    /** Max wait for edge registration (ms). */
    readyTimeoutMs?: number;
}

export interface TunnelReadyInfo {
    /** Cloudflare PoP code when present (e.g. hkg01). */
    location?: string;
    /** Transport used for the first connection (e.g. http2). */
    protocol?: string;
}

/**
 * Manage a long-running `cloudflared tunnel run` child process.
 *
 * Logs go to `~/.codex-mcp/logs/tunnel.log` by default so the project
 * terminal stays readable. `start()` only resolves after Cloudflare
 * accepts a connector (`Registered tunnel connection`).
 */
export class CloudflaredSidecar {
    private child: ChildProcess | undefined;
    private logStream: WriteStream | undefined;
    private readonly logPath: string;
    private exitCode: number | null = null;
    private readonly mirrorLogs: boolean;
    private readonly readyTimeoutMs: number;
    private readySeen = false;
    private logLineCarry = "";
    private readyResolve: ((info: TunnelReadyInfo) => void) | undefined;
    private readyReject: ((error: Error) => void) | undefined;

    /**
     * @param options - Binary, tunnel id, and log mirroring
     */
    constructor(private readonly options: TunnelSidecarOptions) {
        ensureUserConfigDirs();
        mkdirSync(getUserLogDir(), { recursive: true });
        this.logPath = join(getUserLogDir(), "tunnel.log");
        this.mirrorLogs = options.mirrorLogs === true;
        this.readyTimeoutMs =
            options.readyTimeoutMs !== undefined && options.readyTimeoutMs > 0
                ? options.readyTimeoutMs
                : DEFAULT_READY_TIMEOUT_MS;
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
     * Start cloudflared and wait until Cloudflare registers a connection.
     *
     * @returns Edge registration details from the first successful connector
     */
    async start(): Promise<TunnelReadyInfo> {
        if (this.child) {
            throw new Error("cloudflared sidecar already started");
        }

        const configPath = this.options.configPath ?? getCloudflaredConfigPath();
        this.logStream = createWriteStream(this.logPath, { flags: "a" });
        this.writeLog(
            `\n---- ${new Date().toISOString()} start tunnel ${this.options.tunnelId} ----\n`,
        );

        const readyPromise = new Promise<TunnelReadyInfo>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });

        const child = spawn(
            this.options.bin,
            [
                "tunnel",
                "--config",
                configPath,
                "--protocol",
                "http2",
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
        this.readySeen = false;
        this.logLineCarry = "";

        child.stdout?.on("data", (chunk: Buffer) => {
            this.onLogChunk(chunk.toString("utf8"));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            this.onLogChunk(chunk.toString("utf8"));
        });
        child.on("error", (error) => {
            this.writeLog(`spawn error: ${error.message}\n`);
            this.failReady(
                new Error(`cloudflared spawn failed: ${error.message}`),
            );
        });
        child.on("close", (code) => {
            this.exitCode = code;
            this.writeLog(`---- exited code=${code ?? "null"} ----\n`);
            this.child = undefined;
            if (!this.readySeen) {
                this.failReady(
                    new Error(
                        `cloudflared exited before tunnel was ready (code ${code}). See ${this.logPath}`,
                    ),
                );
            }
        });

        const timeoutMs = this.readyTimeoutMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<TunnelReadyInfo>((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(
                    new Error(
                        `Tunnel did not become ready within ${Math.round(timeoutMs / 1000)}s ` +
                            `(no "Registered tunnel connection"). Often QUIC/UDP is blocked — ` +
                            `this build forces http2. See ${this.logPath}`,
                    ),
                );
            }, timeoutMs);
        });

        try {
            const info = await Promise.race([readyPromise, timeoutPromise]);
            return info;
        } catch (error) {
            await this.stop();
            throw error;
        } finally {
            if (timer) clearTimeout(timer);
            this.readyResolve = undefined;
            this.readyReject = undefined;
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
     * Feed a stdout/stderr chunk into the log and ready detector.
     *
     * @param text - Log chunk
     */
    private onLogChunk(text: string): void {
        this.writeLog(text);
        if (this.readySeen) return;

        const combined = this.logLineCarry + text;
        const lines = combined.split(/\r?\n/);
        this.logLineCarry = lines.pop() ?? "";
        for (const line of lines) {
            this.noteReadyLine(line);
            if (this.readySeen) return;
        }
        // Last partial line may already contain the registration phrase.
        this.noteReadyLine(this.logLineCarry);
    }

    /**
     * Mark the tunnel ready when cloudflared reports an edge registration.
     *
     * @param line - One log line (or trailing partial)
     */
    private noteReadyLine(line: string): void {
        if (this.readySeen) return;
        if (!line.includes("Registered tunnel connection")) return;

        this.readySeen = true;
        const info: TunnelReadyInfo = {
            location: /(?:^|\s)location=(\S+)/.exec(line)?.[1],
            protocol: /(?:^|\s)protocol=(\S+)/.exec(line)?.[1],
        };
        this.readyResolve?.(info);
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }

    /**
     * Reject the in-flight ready wait once.
     *
     * @param error - Failure reason
     */
    private failReady(error: Error): void {
        if (this.readySeen) return;
        this.readySeen = true;
        this.readyReject?.(error);
        this.readyResolve = undefined;
        this.readyReject = undefined;
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
