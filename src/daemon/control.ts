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
import { loopbackHost } from "../lib/http/listen-address.js";
import { terminateChildProcess } from "../lib/process/tree.js";
import { getUserConfigDir } from "../config/user-config.js";
import {
    loadDaemonState,
    loadProjectsFile,
    removeDaemonState,
    type DaemonState,
    type RegisteredProject,
    type RuntimeIntent,
} from "./state.js";

const DAEMON_START_TIMEOUT_MS = 300_000;
export const DAEMON_CONTROL_API_VERSION = 1 as const;
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
    controlApiVersion: typeof DAEMON_CONTROL_API_VERSION;
    ok: boolean;
    version: string;
    mode: "local" | "public";
    pid: number;
    startedAt: string;
    uptimeMs: number;
    localUrl: string;
    publicMcpUrl?: string;
    auth: { required: boolean; configured: boolean };
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
        private readonly host = "127.0.0.1",
    ) {}

    async status(): Promise<DaemonStatusPayload> {
        const data = await this.request("/daemon/status");
        return normalizeDaemonStatusPayload(data);
    }

    async checkTools(): Promise<{ toolCount: number; projectCount: number }> {
        return await this.request("/daemon/check-tools", { method: "POST" }) as { toolCount: number; projectCount: number };
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

    async logs(lines = 100): Promise<{ path: string; text: string }> {
        const data = await this.request(`/daemon/logs?lines=${Math.max(1, Math.min(5000, Math.trunc(lines)))}`);
        return {
            path: typeof (data as { path?: unknown }).path === "string" ? (data as { path: string }).path : "",
            text: typeof (data as { text?: unknown }).text === "string" ? (data as { text: string }).text : "",
        };
    }

    private async request(
        path: string,
        options: { method?: string; body?: string } = {},
    ): Promise<unknown> {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), this.timeoutMs);
        try {
            const response = await fetch(`http://${loopbackHost(this.host)}:${this.port}${path}`, {
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

export function normalizeDaemonStatusPayload(value: unknown): DaemonStatusPayload {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("守护进程返回了无效的状态");
    }
    const input = value as Record<string, unknown>;
    if (input.controlApiVersion !== DAEMON_CONTROL_API_VERSION) {
        throw new Error(
            `守护进程控制协议版本不兼容：期望 ${DAEMON_CONTROL_API_VERSION}，实际 ${String(input.controlApiVersion ?? "缺失")}；请更新并重启 codex-mcp`,
        );
    }
    if (input.ok !== true || typeof input.version !== "string" ||
        !Number.isInteger(input.pid) || (input.pid as number) <= 0 ||
        !input.version || typeof input.startedAt !== "string" || !input.startedAt ||
        !Number.isFinite(input.uptimeMs) || (input.uptimeMs as number) < 0 ||
        typeof input.localUrl !== "string" || !input.localUrl ||
        (input.publicMcpUrl !== undefined && (typeof input.publicMcpUrl !== "string" || !input.publicMcpUrl)) ||
        !isRuntimeIntent(input.runtimeIntent) || !isDaemonAuth(input.auth) ||
        !isTunnelObservedStatus(input.tunnel) ||
        !Array.isArray(input.projects)) {
        throw new Error("守护进程返回了不完整的 1.0 状态；请运行 codex-mcp restart");
    }
    const mode = input.mode;
    if (mode !== "local" && mode !== "public") {
        throw new Error("守护进程状态中的运行模式无效");
    }
    const runtimeIntent = input.runtimeIntent;
    if (runtimeIntent.local !== (mode === "local")) {
        throw new Error("守护进程状态的 mode 与 runtimeIntent 不一致");
    }
    const tunnel = normalizeTunnelObservedStatus(input.tunnel);
    const auth = input.auth;
    const startedAt = input.startedAt;
    const projects = input.projects.map(normalizeDaemonProject);
    return {
        controlApiVersion: DAEMON_CONTROL_API_VERSION,
        ok: true,
        version: input.version,
        mode,
        pid: input.pid as number,
        startedAt,
        uptimeMs: input.uptimeMs as number,
        localUrl: input.localUrl,
        ...(typeof input.publicMcpUrl === "string" ? { publicMcpUrl: input.publicMcpUrl } : {}),
        runtimeIntent,
        tunnel,
        auth,
        projects,
    };
}

function isDaemonAuth(value: unknown): value is { required: boolean; configured: boolean } {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const auth = value as Record<string, unknown>;
    return typeof auth.required === "boolean" && typeof auth.configured === "boolean";
}

function normalizeDaemonProject(value: unknown): DaemonStatusPayload["projects"][number] {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("守护进程状态包含无效项目");
    }
    const project = value as Record<string, unknown>;
    if (typeof project.id !== "string" || typeof project.name !== "string" ||
        typeof project.path !== "string" || typeof project.active !== "boolean" ||
        typeof project.addedAt !== "string" || typeof project.lastSeenAt !== "string" ||
        !Number.isInteger(project.boundSessions) || (project.boundSessions as number) < 0) {
        throw new Error("守护进程状态包含不完整项目");
    }
    return {
        id: project.id,
        name: project.name,
        path: project.path,
        active: project.active,
        addedAt: project.addedAt,
        lastSeenAt: project.lastSeenAt,
        boundSessions: project.boundSessions as number,
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
    if (!isTunnelObservedStatus(value)) {
        throw new Error("守护进程状态包含无效 Tunnel 状态");
    }
    const running = value.running;
    const state = value.state;
    return {
        running,
        state,
        ...(typeof value?.restartCount === "number" ? { restartCount: value.restartCount } : {}),
        ...(typeof value?.detail === "string" ? { detail: value.detail } : {}),
    };
}

function isTunnelObservedStatus(value: unknown): value is TunnelObservedStatus {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const status = value as Record<string, unknown>;
    return typeof status.running === "boolean" && isTunnelObservedState(status.state) &&
        (status.restartCount === undefined || (Number.isInteger(status.restartCount) && (status.restartCount as number) >= 0)) &&
        (status.detail === undefined || typeof status.detail === "string");
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
        const client = new DaemonControlClient(state.port, state.controlToken, 10_000, state.host);
        const status = await client.status();
        if (status.pid !== state.pid) throw new Error("daemon 状态与控制接口 PID 不一致");
        return {
            state: {
                ...state,
                runtimeIntent: status.runtimeIntent,
                ...(status.publicMcpUrl ? { publicMcpUrl: status.publicMcpUrl } : {}),
            },
            client,
        };
    } catch (error) {
        if (!isProcessAlive(state.pid)) return undefined;
        throw new Error(`daemon pid ${state.pid} 仍存在，但控制接口不可用；已停止操作：${error instanceof Error ? error.message : String(error)}`);
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
    terminate: () => Promise<void>;
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
        stdio: ["ignore", "ignore", "ignore", "ipc"],
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
    return { pid: child.pid ?? 0, exited, terminate: () => terminateChildProcess(child, 5_000, 2_000) };
}

/** Spawn and wait for a daemon. Caller must hold the lifecycle lock. */
export async function startDaemonForIntent(
    intent: RuntimeIntent,
    options: { timeoutMs?: number } = {},
): Promise<DaemonContact> {
    const controller = new AbortController();
    const cancel = () => controller.abort(new Error("已取消守护进程启动"));
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const spawned = spawnDaemonProcess(intent);
    try {
        return await waitForDaemonStart(spawned.pid, spawned.exited, {
            ...options,
            signal: controller.signal,
        });
    } catch (error) {
        // This ChildProcess belongs to this start attempt. Never terminate a PID
        // inferred from a stale state file or a different running instance.
        await spawned.terminate();
        if (loadDaemonState()?.pid === spawned.pid) await removeDaemonState();
        throw error;
    } finally {
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
    }
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
    options: { timeoutMs?: number; signal?: AbortSignal } = {},
): Promise<DaemonContact> {
    const deadline = Date.now() + (options.timeoutMs ?? DAEMON_START_TIMEOUT_MS);
    let lastError = "守护进程没有写入状态文件";
    let observedExit: Awaited<SpawnedDaemonProcess["exited"]> | undefined;
    void exited?.then((result) => {
        observedExit = result;
    });
    while (Date.now() < deadline) {
        options.signal?.throwIfAborted();
        if (observedExit) throw daemonExitedError(observedExit);
        const state = loadDaemonState();
        if (!isProcessAlive(pid)) {
            throw new Error(
                "守护进程启动后立即退出了。请查看 ~/.codex-mcp/logs 下的日志文件了解原因。",
            );
        }
        if (state) {
            if (state.pid !== pid) throw new Error(`检测到另一个守护进程 pid ${state.pid}，拒绝把它当成本次启动结果`);
            try {
                const client = new DaemonControlClient(state.port, state.controlToken, 2_000, state.host);
                const status = await client.status();
                options.signal?.throwIfAborted();
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
