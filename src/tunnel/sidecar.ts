import { spawn, type ChildProcess } from "node:child_process";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { terminateChildProcess } from "../lib/process/tree.js";
import { printCompactLog } from "../lib/util/terminal.js";
import { ensureUserConfigDirs, getUserLogDir } from "../config/user-config.js";
import { cloudflaredChildEnv } from "./exec.js";

const DEFAULT_READY_TIMEOUT_MS = 180_000;
const MAX_DIAGNOSTIC_LOG_CHARS = 16_000;

export function cloudflaredRunArgs(configPath: string, tunnelId: string): string[] {
    return [
        "tunnel",
        "--config",
        configPath,
        "--edge-ip-version",
        "4",
        "run",
        tunnelId,
    ];
}

export function tunnelReadinessTimeoutMessage(
    timeoutMs: number,
    logText: string,
    logPath: string,
): string {
    const prefix = `公网连接在 ${Math.round(timeoutMs / 1000)} 秒内没有准备好。`;
    const ipv6Tcp7844Timeout = /\[[0-9a-f:]+\]:7844[^\n]*(?:i\/o timeout|timed out|timeout)/i.test(
        logText,
    );
    if (ipv6Tcp7844Timeout) {
        return `${prefix} Cloudflare 的 IPv6 连接超时。当前版本已经强制使用 IPv4；请确认网络允许访问 TCP 7844。日志：${logPath}`;
    }

    const tcp7844Failure =
        /TCP Connectivity[^\n]*FAIL[^\n]*HTTP\/2[^\n]*(?:blocked|unreachable)/i.test(logText) ||
        /(?:dial tcp|TLS handshake)[^\n]*:7844[^\n]*(?:i\/o timeout|timed out|timeout|refused|unreachable)/i.test(
            logText,
        );
    if (tcp7844Failure) {
        return `${prefix} Cloudflare 已回退到 HTTP/2，但 TCP 7844 仍不可达。请检查防火墙或网络限制；自动模式也会优先尝试 QUIC/UDP 7844。日志：${logPath}`;
    }

    return `${prefix} 请检查网络是否允许访问 Cloudflare UDP 或 TCP 7844。日志：${logPath}`;
}

export interface TunnelSidecarOptions {
    bin: string;
    tunnelId: string;
    configPath: string;
    /** Mirror log lines to the parent terminal with a prefix. */
    mirrorLogs?: boolean;
    /** Max wait for edge registration (ms). */
    readyTimeoutMs?: number;
    /** Daemon mode only: restart a connector that exits after becoming ready. */
    maxRestarts?: number;
    onStateChange?: (status: TunnelSidecarStatus) => void;
}

export interface TunnelReadyInfo {
    /** Cloudflare PoP code when present (e.g. hkg01). */
    location?: string;
    /** Transport used for the first connection (e.g. http2). */
    protocol?: string;
}

export type TunnelSidecarState = "off" | "starting" | "connected" | "degraded" | "exited";

export interface TunnelSidecarStatus {
    running: boolean;
    state: TunnelSidecarState;
    restartCount: number;
    detail?: string;
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
    private readonly mirrorLogs: boolean;
    private readonly readyTimeoutMs: number;
    private readySeen = false;
    private logLineCarry = "";
    private diagnosticTail = "";
    private readyResolve: ((info: TunnelReadyInfo) => void) | undefined;
    private readyReject: ((error: Error) => void) | undefined;
    private connectorReady = false;
    private stopping = false;
    private restartCount = 0;
    private restartTimer: ReturnType<typeof setTimeout> | undefined;

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

    getLogPath(): string {
        return this.logPath;
    }

    async start(): Promise<TunnelReadyInfo> {
        this.stopping = false;
        this.restartCount = 0;
        return await this.startOnce();
    }

    private async startOnce(): Promise<TunnelReadyInfo> {
        if (this.child) {
            throw new Error("Cloudflare Tunnel 已经在运行");
        }
        this.emitState("starting", false);

        const configPath = this.options.configPath;
        this.logStream = createWriteStream(this.logPath, { flags: "a" });
        this.logStream.on("error", () => {
            this.logStream = undefined;
        });
        this.writeLog(
            `\n---- ${new Date().toISOString()} start tunnel ${this.options.tunnelId} ----\n`,
        );

        const readyPromise = new Promise<TunnelReadyInfo>((resolve, reject) => {
            this.readyResolve = resolve;
            this.readyReject = reject;
        });

        const child = spawn(
            this.options.bin,
            cloudflaredRunArgs(configPath, this.options.tunnelId),
            {
                stdio: ["ignore", "pipe", "pipe"],
                windowsHide: true,
                env: cloudflaredChildEnv(),
            },
        );
        this.child = child;
        this.readySeen = false;
        this.connectorReady = false;
        this.logLineCarry = "";
        this.diagnosticTail = "";

        child.stdout?.on("data", (chunk: Buffer) => {
            this.onLogChunk(chunk.toString("utf8"));
        });
        child.stderr?.on("data", (chunk: Buffer) => {
            this.onLogChunk(chunk.toString("utf8"));
        });
        child.on("error", (error) => {
            this.writeLog(`spawn error: ${error.message}\n`);
            this.failReady(
                new Error(`无法启动 cloudflared：${error.message}`),
            );
        });
        child.on("close", (code) => {
            this.writeLog(`---- exited code=${code ?? "null"} ----\n`);
            this.child = undefined;
            this.logStream?.end();
            this.logStream = undefined;
            if (!this.connectorReady) {
                this.failReady(
                    new Error(
                        `cloudflared 在公网连接准备好之前退出了（代码 ${code}）。日志：${this.logPath}`,
                    ),
                );
            } else if (!this.stopping) {
                this.scheduleRestart(`cloudflared 退出（代码 ${code ?? "null"}）`);
            }
        });

        const timeoutMs = this.readyTimeoutMs;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeoutPromise = new Promise<TunnelReadyInfo>((_resolve, reject) => {
            timer = setTimeout(() => {
                reject(
                    new Error(
                        tunnelReadinessTimeoutMessage(
                            timeoutMs,
                            this.diagnosticTail,
                            this.logPath,
                        ),
                    ),
                );
            }, timeoutMs);
        });

        try {
            const info = await Promise.race([readyPromise, timeoutPromise]);
            this.emitState("connected", true);
            return info;
        } catch (error) {
            await this.terminateCurrent();
            if (!this.stopping) {
                this.emitState("exited", false, error instanceof Error ? error.message : String(error));
            }
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
        this.stopping = true;
        if (this.restartTimer) clearTimeout(this.restartTimer);
        this.restartTimer = undefined;
        await this.terminateCurrent();
        this.emitState("off", false);
    }

    private onLogChunk(text: string): void {
        this.writeLog(text);
        this.diagnosticTail = (this.diagnosticTail + text).slice(-MAX_DIAGNOSTIC_LOG_CHARS);
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

    private noteReadyLine(line: string): void {
        if (this.readySeen) return;
        if (!line.includes("Registered tunnel connection")) return;

        this.readySeen = true;
        this.connectorReady = true;
        const info: TunnelReadyInfo = {
            location: /(?:^|\s)location=(\S+)/.exec(line)?.[1],
            protocol: /(?:^|\s)protocol=(\S+)/.exec(line)?.[1],
        };
        this.readyResolve?.(info);
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }

    private failReady(error: Error): void {
        if (this.readySeen) return;
        this.readySeen = true;
        this.readyReject?.(error);
        this.readyResolve = undefined;
        this.readyReject = undefined;
    }

    private writeLog(text: string): void {
        this.logStream?.write(text);
        if (this.mirrorLogs) {
            const lines = text.split(/\r?\n/);
            for (const line of lines) {
                if (line.trim()) {
                    printCompactLog("warning", `[tunnel] ${line}`);
                }
            }
        }
    }

    private async terminateCurrent(): Promise<void> {
        const child = this.child;
        try {
            if (child?.pid) {
                await terminateChildProcess(child, 2_000, 1_000);
            }
        } finally {
            // Spawn failures can produce a ChildProcess without a pid. Clear it
            // as well so a later bounded restart is not rejected as duplicate.
            this.child = undefined;
            this.logStream?.end();
            this.logStream = undefined;
        }
    }

    private scheduleRestart(detail: string): void {
        const maxRestarts = Math.max(0, this.options.maxRestarts ?? 0);
        if (this.stopping) return;
        if (this.restartCount >= maxRestarts) {
            this.emitState("exited", false, detail);
            return;
        }
        this.restartCount += 1;
        const delayMs = Math.min(30_000, 1_000 * 2 ** (this.restartCount - 1));
        this.emitState("degraded", false, `${detail}，${delayMs}ms 后尝试恢复`);
        this.restartTimer = setTimeout(() => {
            this.restartTimer = undefined;
            if (this.stopping) return;
            void this.startOnce().catch((error) => {
                if (this.stopping) return;
                this.scheduleRestart(error instanceof Error ? error.message : String(error));
            });
        }, delayMs);
        this.restartTimer.unref();
    }

    private emitState(
        state: TunnelSidecarState,
        running: boolean,
        detail?: string,
    ): void {
        this.options.onStateChange?.({
            running,
            state,
            restartCount: this.restartCount,
            ...(detail ? { detail } : {}),
        });
    }
}
