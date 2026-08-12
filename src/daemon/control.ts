import { spawn } from "node:child_process";
import {
    closeSync,
    openSync,
    readFileSync,
    statSync,
    unlinkSync,
    writeSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserConfigDir } from "../config/user-config.js";
import {
    loadDaemonState,
    loadProjectsFile,
    type DaemonState,
    type RegisteredProject,
} from "./state.js";

const DAEMON_START_TIMEOUT_MS = 60_000;
const DAEMON_LOCK_PATH = join(getUserConfigDir(), "daemon.lock");
const LOCK_STALE_MS = 30_000;

export interface DaemonStatusPayload {
    ok: boolean;
    version: string;
    mode: "local" | "public";
    pid: number;
    startedAt: string;
    uptimeMs: number;
    localUrl: string;
    publicMcpUrl?: string;
    tunnel: { running: boolean };
    projects: Array<RegisteredProject & { boundSessions: number }>;
}

export interface ControlStatusResponse {
    ok: boolean;
    daemon: DaemonStatusPayload;
}

export interface ControlRegisterResponse {
    ok: boolean;
    project: RegisteredProject;
    projects: RegisteredProject[];
}

export interface ControlDeactivateResponse {
    ok: boolean;
    removed: boolean;
    project?: RegisteredProject;
    projects: RegisteredProject[];
}

/**
 * Loopback-only client for the daemon control API. The control token lives in
 * daemon.json; the endpoint only accepts loopback clients that present it.
 */
export class DaemonControlClient {
    constructor(
        private readonly port: number,
        private readonly token: string,
        private readonly timeoutMs = 10_000,
    ) {}

    async status(): Promise<DaemonStatusPayload> {
        const data = await this.request("/daemon/status");
        return data as DaemonStatusPayload;
    }

    async registerProject(input: { path: string; name?: string }): Promise<RegisteredProject> {
        const data = await this.request("/daemon/projects", {
            method: "POST",
            body: JSON.stringify(input),
        });
        return (data as ControlRegisterResponse).project;
    }

    async deactivateProject(id: string, path?: string): Promise<ControlDeactivateResponse> {
        const query = path ? `?path=${encodeURIComponent(path)}` : "";
        const data = await this.request(`/daemon/projects/${encodeURIComponent(id)}${query}`, {
            method: "DELETE",
        });
        return data as ControlDeactivateResponse;
    }

    async shutdown(): Promise<void> {
        await this.request("/daemon/shutdown", { method: "POST" });
    }

    private async request(
        path: string,
        options: { method?: string; body?: string } = {},
    ): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`http://127.0.0.1:${this.port}${path}`, {
                method: options.method ?? "GET",
                headers: {
                    "x-codex-control-token": this.token,
                    ...(options.body ? { "content-type": "application/json" } : {}),
                },
                ...(options.body ? { body: options.body } : {}),
                signal: controller.signal,
            });
            const payload = (await response.json()) as {
                error?: string;
                [key: string]: unknown;
            };
            if (!response.ok || payload.error) {
                throw new Error(payload.error ?? `控制请求失败（HTTP ${response.status}）`);
            }
            return payload;
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") {
                throw new Error("连接守护进程超时");
            }
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

/** True when the recorded pid refers to a live process. */
export function isProcessAlive(pid: number): boolean {
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

export interface DaemonContact {
    state: DaemonState;
    client: DaemonControlClient;
}

/**
 * Resolve the running daemon from daemon.json: pid liveness + control API
 * reachability. Returns undefined when no usable daemon is running.
 */
export async function contactRunningDaemon(): Promise<DaemonContact | undefined> {
    const state = loadDaemonState();
    if (!state || !isProcessAlive(state.pid)) return undefined;
    try {
        const client = new DaemonControlClient(state.port, state.controlToken, 3_000);
        const status = await client.status();
        if (!status.ok) return undefined;
        return { state, client };
    } catch {
        return undefined;
    }
}

/** Remove a stale daemon file whose process is no longer alive. */
export function cleanStaleDaemonState(): void {
    const state = loadDaemonState();
    if (!state) return;
    if (isProcessAlive(state.pid)) return;
    try {
        unlinkSync(join(getUserConfigDir(), "daemon.json"));
    } catch {
        // already gone
    }
}

export interface SpawnDaemonOptions {
    local: boolean;
    noTunnel: boolean;
    tunnelLogs: boolean;
}

/**
 * Start the daemon as a detached background process. The daemon writes its own
 * daemon.json once it is listening; callers poll for it via waitForDaemonStart.
 */
export function spawnDaemonProcess(options: SpawnDaemonOptions): { pid: number } {
    const cliPath = resolveCliEntryPath();
    // Development runs via tsx load the .ts entry with the tsx loader; the
    // packaged dist/cli.js is plain JavaScript and needs no loader.
    const nodeArgs = cliPath.endsWith(".ts")
        ? ["--import", "tsx", cliPath]
        : [cliPath];
    nodeArgs.push("daemon");
    if (options.local) nodeArgs.push("--local");
    if (options.noTunnel) nodeArgs.push("--no-tunnel");
    if (options.tunnelLogs) nodeArgs.push("--tunnel-logs");
    const child = spawn(process.execPath, nodeArgs, {
        cwd: process.cwd(),
        detached: true,
        // Fully detach the daemon from the parent terminal so the calling
        // shell does not wait on it and Ctrl+C does not reach it.
        stdio: ["ignore", "ignore", "ignore"],
        windowsHide: true,
        env: process.env,
    });
    child.unref();
    return { pid: child.pid ?? 0 };
}

/**
 * Resolve the running CLI entry script. `process.argv[1]` is the invoked
 * entry (dist/cli.js or src/cli.ts under tsx); fall back to a path relative to
 * this control module when argv is unavailable.
 */
function resolveCliEntryPath(): string {
    const candidate = process.argv[1];
    if (candidate && (candidate.endsWith("cli.js") || candidate.endsWith("cli.ts"))) {
        return candidate;
    }
    const controlScript = fileURLToPath(import.meta.url);
    const isTypeScript = controlScript.endsWith(".ts");
    return resolve(dirname(controlScript), isTypeScript ? "../cli.ts" : "../cli.js");
}

/** Wait until the freshly spawned daemon exposes a working control API. */
export async function waitForDaemonStart(pid: number): Promise<DaemonContact> {
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    let lastError = "守护进程没有写入状态文件";
    while (Date.now() < deadline) {
        const contact = await contactRunningDaemon();
        if (contact) return contact;
        const state = loadDaemonState();
        if (state && !isProcessAlive(pid)) {
            throw new Error(
                "守护进程启动后立即退出了。请查看 ~/.codex-mcp/logs 下的日志文件了解原因。",
            );
        }
        if (state) {
            try {
                const client = new DaemonControlClient(state.port, state.controlToken, 2_000);
                await client.status();
                return { state, client };
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
        }
        await sleep(500);
    }
    throw new Error(`守护进程启动超时：${lastError}`);
}

/**
 * Serialize daemon startup across concurrent CLI invocations. The lock is
 * stale when its owner process is dead or the file is older than the grace
 * window, so a crash cannot leave a permanent lock.
 */
export async function withDaemonStartLock<T>(run: () => Promise<T>): Promise<T> {
    for (let attempt = 0; attempt < 3; attempt += 1) {
        let release: (() => void) | undefined;
        try {
            release = tryAcquireLock();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (isLockStale()) {
                try {
                    unlinkSync(DAEMON_LOCK_PATH);
                } catch {
                    // another process removed it first
                }
                continue;
            }
            await sleep(400);
            continue;
        }
        try {
            return await run();
        } finally {
            release();
        }
    }
    throw new Error("另一个 codex-mcp 正在启动守护进程，请稍后再试");
}

function tryAcquireLock(): () => void {
    const handle = openSync(DAEMON_LOCK_PATH, "wx");
    try {
        writeSync(handle, JSON.stringify({ pid: process.pid, at: new Date().toISOString() }), null, "utf8");
    } finally {
        closeSync(handle);
    }
    return () => {
        try {
            unlinkSync(DAEMON_LOCK_PATH);
        } catch {
            // already removed
        }
    };
}

function isLockStale(): boolean {
    try {
        const raw = readFileSync(DAEMON_LOCK_PATH, "utf8") as string;
        const parsed = JSON.parse(raw) as { pid?: unknown };
        if (typeof parsed.pid === "number" && !isProcessAlive(parsed.pid)) return true;
    } catch {
        // unparseable lock: treat as stale if old enough below
    }
    try {
        const ageMs = Date.now() - statSync(DAEMON_LOCK_PATH).mtimeMs;
        return ageMs > LOCK_STALE_MS;
    } catch {
        return true;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export { loadProjectsFile };
