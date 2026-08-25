import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
    closeSync,
    mkdirSync,
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
    type RuntimeIntent,
} from "./state.js";

const DAEMON_START_TIMEOUT_MS = 300_000;
const DAEMON_LOCK_PATH = join(getUserConfigDir(), "daemon.lock");
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 30_000;

export type TunnelObservedState = "off" | "starting" | "connected" | "degraded" | "exited";

export interface TunnelObservedStatus {
    running: boolean;
    state: TunnelObservedState;
    restartCount?: number;
    detail?: string;
}

export interface DaemonStatusPayload {
    ok: boolean;
    version: string;
    mode: "local" | "public";
    pid: number;
    startedAt: string;
    uptimeMs: number;
    localUrl: string;
    publicMcpUrl?: string;
    runtimeIntent: RuntimeIntent;
    tunnel: TunnelObservedStatus;
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
        return normalizeDaemonStatusPayload(data);
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

function normalizeDaemonStatusPayload(value: unknown): DaemonStatusPayload {
    const raw = value as Partial<DaemonStatusPayload> & {
        startedAt?: unknown;
        runtimeIntent?: unknown;
        tunnel?: { running?: unknown; state?: unknown; restartCount?: unknown; detail?: unknown };
    };
    const mode = raw.mode === "public" ? "public" : "local";
    const legacyIntent: RuntimeIntent = {
        local: mode === "local",
        noTunnel: false,
        tunnelLogs: false,
    };
    const runtimeIntent = isRuntimeIntent(raw.runtimeIntent)
        ? raw.runtimeIntent
        : legacyIntent;
    const tunnel = normalizeTunnelObservedStatus(raw.tunnel);
    const startedAt = typeof raw.startedAt === "string"
        ? raw.startedAt
        : typeof raw.startedAt === "number" && Number.isFinite(raw.startedAt)
          ? new Date(raw.startedAt).toISOString()
          : new Date().toISOString();
    return {
        ...(raw as DaemonStatusPayload),
        mode,
        startedAt,
        runtimeIntent,
        tunnel,
    };
}

function isRuntimeIntent(value: unknown): value is RuntimeIntent {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const raw = value as Record<string, unknown>;
    return typeof raw.local === "boolean" &&
        typeof raw.noTunnel === "boolean" &&
        typeof raw.tunnelLogs === "boolean";
}

function normalizeTunnelObservedStatus(
    value: { running?: unknown; state?: unknown; restartCount?: unknown; detail?: unknown } | undefined,
): TunnelObservedStatus {
    const running = value?.running === true;
    const state = isTunnelObservedState(value?.state)
        ? value.state
        : running ? "connected" : "off";
    return {
        running,
        state,
        ...(typeof value?.restartCount === "number" ? { restartCount: value.restartCount } : {}),
        ...(typeof value?.detail === "string" ? { detail: value.detail } : {}),
    };
}

function isTunnelObservedState(value: unknown): value is TunnelObservedState {
    return value === "off" || value === "starting" || value === "connected" ||
        value === "degraded" || value === "exited";
}

/** True when the recorded pid refers to a live process. */
export function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
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
        const client = new DaemonControlClient(state.port, state.controlToken);
        const status = await client.status();
        if (!status.ok || status.pid !== state.pid) return undefined;
        return {
            state: {
                ...state,
                mode: status.mode,
                runtimeIntent: status.runtimeIntent,
                publicMcpUrl: status.publicMcpUrl,
            },
            client,
        };
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

export interface SpawnedDaemonProcess {
    pid: number;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>;
}

/**
 * Start the daemon as a detached background process. The daemon writes its own
 * daemon.json once it is listening; callers poll for it via waitForDaemonStart.
 */
export function spawnDaemonProcess(options: SpawnDaemonOptions): SpawnedDaemonProcess {
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
    const exited = new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
        error?: string;
    }>((resolveExit) => {
        let settled = false;
        const finish = (result: {
            code: number | null;
            signal: NodeJS.Signals | null;
            error?: string;
        }): void => {
            if (settled) return;
            settled = true;
            resolveExit(result);
        };
        child.once("error", (error) => {
            finish({ code: null, signal: null, error: error.message });
        });
        child.once("exit", (code, signal) => {
            finish({ code, signal });
        });
    });
    child.unref();
    return { pid: child.pid ?? 0, exited };
}

/** Spawn and wait for a daemon. Caller must hold the lifecycle lock. */
export async function startDaemonForIntent(intent: RuntimeIntent): Promise<DaemonContact> {
    const spawned = spawnDaemonProcess(intent);
    return await waitForDaemonStart(spawned.pid, spawned.exited);
}

/** Gracefully stop one contacted daemon. Caller must hold the lifecycle lock. */
export async function stopDaemonContact(
    daemon: DaemonContact,
    timeoutMs = 20_000,
): Promise<void> {
    await daemon.client.shutdown();
    const deadline = Date.now() + timeoutMs;
    while (isProcessAlive(daemon.state.pid) && Date.now() < deadline) {
        await sleep(200);
    }
    if (isProcessAlive(daemon.state.pid)) {
        throw new Error(`守护进程 pid ${daemon.state.pid} 在 ${timeoutMs}ms 内没有停止`);
    }
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
export async function waitForDaemonStart(
    pid: number,
    exited?: SpawnedDaemonProcess["exited"],
): Promise<DaemonContact> {
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    let lastError = "守护进程没有写入状态文件";
    let observedExit: Awaited<SpawnedDaemonProcess["exited"]> | undefined;
    void exited?.then((result) => {
        observedExit = result;
    });
    while (Date.now() < deadline) {
        if (observedExit) throw daemonExitedError(observedExit);
        const contact = await contactRunningDaemon();
        if (contact) {
            if (contact.state.pid === pid) return contact;
            throw new Error(`检测到另一个守护进程 pid ${contact.state.pid}，拒绝把它当成本次启动结果`);
        }
        const state = loadDaemonState();
        if (!isProcessAlive(pid)) {
            throw new Error(
                "守护进程启动后立即退出了。请查看 ~/.codex-mcp/logs 下的日志文件了解原因。",
            );
        }
        if (state) {
            try {
                const client = new DaemonControlClient(state.port, state.controlToken, 2_000);
                const status = await client.status();
                if (state.pid === pid && status.pid === pid) return { state, client };
                lastError = `状态文件 pid ${state.pid} 与本次 pid ${pid} 不一致`;
            } catch (error) {
                lastError = error instanceof Error ? error.message : String(error);
            }
        }
        await (exited ? Promise.race([sleep(500), exited]) : sleep(500));
    }
    throw new Error(`守护进程启动超时：${lastError}`);
}

function daemonExitedError(
    result: Awaited<SpawnedDaemonProcess["exited"]>,
): Error {
    const outcome = result.error
        ? result.error
        : result.signal
          ? `信号 ${result.signal}`
          : `退出代码 ${result.code ?? "unknown"}`;
    return new Error(
        `守护进程启动后立即退出（${outcome}）。请查看 ~/.codex-mcp/logs 下的日志文件了解原因。`,
    );
}

/**
 * Serialize daemon startup across concurrent CLI invocations. The lock is
 * stale when its owner process is dead or the file is older than the grace
 * window, so a crash cannot leave a permanent lock.
 */
export async function withDaemonStartLock<T>(run: () => Promise<T>): Promise<T> {
    return await withDaemonLifecycleLock(run);
}

/** Serialize every daemon start/stop and public setup transition. */
export async function withDaemonLifecycleLock<T>(run: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
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
    throw new Error("另一个 codex-mcp 正在执行启动、停止或 setup；等待 30 秒后仍未完成，请稍后再试");
}

function tryAcquireLock(): () => void {
    mkdirSync(dirname(DAEMON_LOCK_PATH), { recursive: true });
    const owner = randomUUID();
    const handle = openSync(DAEMON_LOCK_PATH, "wx");
    try {
        writeSync(handle, JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() }), null, "utf8");
    } finally {
        closeSync(handle);
    }
    return () => {
        try {
            const current = JSON.parse(readFileSync(DAEMON_LOCK_PATH, "utf8")) as { owner?: unknown };
            if (current.owner === owner) unlinkSync(DAEMON_LOCK_PATH);
        } catch {
            // Already removed or replaced by another owner.
        }
    };
}

function isLockStale(): boolean {
    try {
        const raw = readFileSync(DAEMON_LOCK_PATH, "utf8") as string;
        const parsed = JSON.parse(raw) as { pid?: unknown; owner?: unknown };
        if (typeof parsed.pid === "number" && !isProcessAlive(parsed.pid)) return true;
        if (typeof parsed.pid === "number" && typeof parsed.owner === "string") return false;
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
