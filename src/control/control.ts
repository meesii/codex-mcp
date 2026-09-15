import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { closeSync, mkdirSync, openSync, readFileSync, statSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { getUserConfigDir } from "../config/user-config.js";
import { terminateChildProcess } from "../lib/process/tree.js";
import { loopbackHost } from "../lib/http/listen-address.js";
import {
    CONTROLLER_API_VERSION,
    controllerPanelUrl,
    loadControllerState,
    removeControllerState,
    type ControllerState,
} from "./state.js";
import type { ControlStatus, RuntimeStartInput } from "./services.js";
import type { RegisteredProject } from "../daemon/state.js";
import {
    DAEMON_LIFECYCLE_LOCK_WAIT_TIMEOUT_MS,
    DAEMON_START_TIMEOUT_MS,
    DAEMON_STOP_TIMEOUT_MS,
} from "../daemon/control.js";
import { PACKAGE_VERSION } from "../server/version.js";

const CONTROLLER_START_TIMEOUT_MS = 30_000;
const CONTROLLER_LIFECYCLE_MARGIN_MS = 10_000;
const RUNTIME_START_REQUEST_TIMEOUT_MS =
    DAEMON_LIFECYCLE_LOCK_WAIT_TIMEOUT_MS + DAEMON_START_TIMEOUT_MS + CONTROLLER_LIFECYCLE_MARGIN_MS;
const RUNTIME_STOP_REQUEST_TIMEOUT_MS =
    DAEMON_LIFECYCLE_LOCK_WAIT_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS + CONTROLLER_LIFECYCLE_MARGIN_MS;
const RUNTIME_RESTART_REQUEST_TIMEOUT_MS =
    DAEMON_LIFECYCLE_LOCK_WAIT_TIMEOUT_MS + DAEMON_STOP_TIMEOUT_MS + DAEMON_START_TIMEOUT_MS + CONTROLLER_LIFECYCLE_MARGIN_MS;
const CONTROLLER_LOCK_PATH = join(getUserConfigDir(), "controller.lock");
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_TIMEOUT_MS = 30_000;

export interface ControllerStatusPayload {
    apiVersion: typeof CONTROLLER_API_VERSION;
    ok: true;
    pid: number;
    version: string;
    startedAt: string;
    uptimeMs: number;
    panelUrl: string;
    runtime: ControlStatus;
}

export class LocalControllerClient {
    constructor(
        private readonly state: Pick<ControllerState, "host" | "port" | "controlToken">,
        private readonly timeoutMs = 30_000,
    ) {}

    status(): Promise<ControllerStatusPayload> {
        return this.request("/api/controller/status") as Promise<ControllerStatusPayload>;
    }

    start(input: RuntimeStartInput): Promise<{ ok: true; status: ControlStatus }> {
        return this.request("/api/runtime/start", {
            method: "POST",
            body: input,
            timeoutMs: RUNTIME_START_REQUEST_TIMEOUT_MS,
        }) as Promise<{ ok: true; status: ControlStatus }>;
    }

    stop(): Promise<{ ok: true; stopped: boolean; status: ControlStatus }> {
        return this.request("/api/runtime/stop", {
            method: "POST",
            timeoutMs: RUNTIME_STOP_REQUEST_TIMEOUT_MS,
        }) as Promise<{ ok: true; stopped: boolean; status: ControlStatus }>;
    }

    restart(): Promise<{ ok: true; status: ControlStatus }> {
        return this.request("/api/runtime/restart", {
            method: "POST",
            timeoutMs: RUNTIME_RESTART_REQUEST_TIMEOUT_MS,
        }) as Promise<{ ok: true; status: ControlStatus }>;
    }

    removeProject(target: string): Promise<{ ok: true; removed: boolean; project: RegisteredProject; projects: RegisteredProject[] }> {
        return this.request(`/api/projects/${encodeURIComponent(target)}`, { method: "DELETE" }) as Promise<{ ok: true; removed: boolean; project: RegisteredProject; projects: RegisteredProject[] }>;
    }

    project(target: string): Promise<{ ok: true; project: RegisteredProject & { boundSessions?: number | null } }> {
        return this.request(`/api/projects/${encodeURIComponent(target)}`) as Promise<{ ok: true; project: RegisteredProject & { boundSessions?: number | null } }>;
    }

    logs(lines = 100): Promise<{ ok: true; path: string; text: string }> {
        return this.request(`/api/logs?lines=${Math.max(1, Math.min(5000, Math.trunc(lines)))}`) as Promise<{ ok: true; path: string; text: string }>;
    }

    shutdown(): Promise<{ ok: true }> {
        return this.request("/api/controller/shutdown", { method: "POST" }) as Promise<{ ok: true }>;
    }

    retire(): Promise<{ ok: true }> {
        return this.request("/api/controller/retire", { method: "POST" }) as Promise<{ ok: true }>;
    }

    private async request(
        path: string,
        options: { method?: string; body?: unknown; timeoutMs?: number } = {},
    ): Promise<unknown> {
        const controller = new AbortController();
        const timeoutMs = options.timeoutMs ?? this.timeoutMs;
        const timer = setTimeout(() => controller.abort(), timeoutMs);
        try {
            const response = await fetch(`http://${loopbackHost(this.state.host)}:${this.state.port}${path}`, {
                method: options.method ?? "GET",
                headers: {
                    "x-codex-controller-token": this.state.controlToken,
                    ...(options.body !== undefined ? { "content-type": "application/json" } : {}),
                },
                ...(options.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
                signal: controller.signal,
            });
            const payload = await response.json() as { error?: unknown; [key: string]: unknown };
            if (!response.ok || typeof payload.error === "string") {
                throw new Error(typeof payload.error === "string" ? payload.error : `Controller 请求失败（HTTP ${response.status}）`);
            }
            return payload;
        } catch (error) {
            if (error instanceof Error && error.name === "AbortError") throw new Error("连接本机 Controller 超时");
            throw error;
        } finally {
            clearTimeout(timer);
        }
    }
}

export interface ControllerContact {
    state: ControllerState;
    client: LocalControllerClient;
}

export async function contactRunningController(): Promise<ControllerContact | undefined> {
    const state = loadControllerState();
    if (!state || !isProcessAlive(state.pid)) return undefined;
    try {
        const probe = new LocalControllerClient(state, 5_000);
        const status = await probe.status();
        if (status.apiVersion !== CONTROLLER_API_VERSION || status.pid !== state.pid) {
            throw new Error("Controller 状态文件与控制接口不一致");
        }
        return { state, client: new LocalControllerClient(state) };
    } catch (error) {
        if (!isProcessAlive(state.pid)) return undefined;
        throw new Error(`Controller pid ${state.pid} 仍存在，但本机控制接口不可用：${readableError(error)}`);
    }
}

export function cleanStaleControllerState(): void {
    const state = loadControllerState();
    if (!state || isProcessAlive(state.pid)) return;
    try {
        unlinkSync(join(getUserConfigDir(), "controller.json"));
    } catch {
        // already gone
    }
}

export async function ensureControllerRunning(): Promise<ControllerContact> {
    const existing = await contactRunningController();
    if (existing?.state.version === PACKAGE_VERSION) return existing;
    if (existing) {
        const replacement = await spawnReplacementController();
        try { await existing.client.retire(); } catch { /* replacement already owns durable state */ }
        return replacement;
    }
    cleanStaleControllerState();
    return await withControllerLifecycleLock(async () => {
        const again = await contactRunningController();
        if (again?.state.version === PACKAGE_VERSION) return again;
        if (again) {
            // A concurrent command left an older generation alive. Release this path
            // through a direct replacement because the lifecycle lock is already held.
            const replacement = await spawnAndWaitForController(true);
            try { await again.client.retire(); } catch { /* best effort */ }
            return replacement;
        }
        return await spawnAndWaitForController();
    });
}

/** Start a second Controller generation after self-update. The caller remains alive until the new one is ready. */
export async function spawnReplacementController(): Promise<ControllerContact> {
    return await withControllerLifecycleLock(() => spawnAndWaitForController(true));
}

async function spawnAndWaitForController(replacing = false): Promise<ControllerContact> {
    const spawned = spawnControllerProcess();
    try {
        return await waitForControllerStart(spawned.pid, spawned.exited, replacing);
    } catch (error) {
        await spawned.terminate();
        const state = loadControllerState();
        if (state?.pid === spawned.pid) await removeControllerState();
        throw error;
    }
}

function spawnControllerProcess(): {
    pid: number;
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>;
    terminate: () => Promise<void>;
} {
    const cliPath = resolveCliEntryPath();
    const nodeArgs = cliPath.endsWith(".ts") ? ["--import", "tsx", cliPath] : [cliPath];
    nodeArgs.push("controller");
    const child = spawn(process.execPath, nodeArgs, {
        cwd: process.cwd(),
        detached: true,
        stdio: ["ignore", "ignore", "ignore", "ipc"],
        windowsHide: true,
        env: process.env,
    });
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>((resolveExit) => {
        let settled = false;
        const finish = (value: { code: number | null; signal: NodeJS.Signals | null; error?: string }): void => {
            if (settled) return;
            settled = true;
            resolveExit(value);
        };
        child.once("error", (error) => finish({ code: null, signal: null, error: error.message }));
        child.once("exit", (code, signal) => finish({ code, signal }));
    });
    child.unref();
    return { pid: child.pid ?? 0, exited, terminate: () => terminateChildProcess(child, 5_000, 2_000) };
}

async function waitForControllerStart(
    pid: number,
    exited: Promise<{ code: number | null; signal: NodeJS.Signals | null; error?: string }>,
    replacing: boolean,
): Promise<ControllerContact> {
    const deadline = Date.now() + CONTROLLER_START_TIMEOUT_MS;
    let exitResult: Awaited<typeof exited> | undefined;
    void exited.then((value) => { exitResult = value; });
    let lastError = "Controller 尚未写入状态";
    while (Date.now() < deadline) {
        if (exitResult) throw new Error(`Controller 启动后立即退出：${describeExit(exitResult)}`);
        if (!isProcessAlive(pid)) throw new Error("Controller 启动后立即退出");
        let state: ControllerState | undefined;
        try {
            state = loadControllerState();
        } catch (error) {
            lastError = readableError(error);
        }
        if (state?.pid === pid) {
            try {
                const probe = new LocalControllerClient(state, 2_000);
                const status = await probe.status();
                if (status.pid === pid) return { state, client: new LocalControllerClient(state) };
            } catch (error) {
                lastError = readableError(error);
            }
        } else if (state && !replacing && isProcessAlive(state.pid)) {
            throw new Error(`检测到另一个 Controller pid ${state.pid}`);
        }
        await sleep(200);
    }
    throw new Error(`Controller 启动超时：${lastError}`);
}

export async function withControllerLifecycleLock<T>(run: () => Promise<T>): Promise<T> {
    const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
        let release: (() => void) | undefined;
        try {
            release = tryAcquireControllerLock();
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
            if (isControllerLockStale()) {
                try { unlinkSync(CONTROLLER_LOCK_PATH); } catch { /* raced */ }
                continue;
            }
            await sleep(200);
            continue;
        }
        try {
            return await run();
        } finally {
            release();
        }
    }
    throw new Error("另一个 codex-mcp 正在启动或替换本机 Controller；等待 30 秒后仍未完成");
}

function tryAcquireControllerLock(): () => void {
    mkdirSync(dirname(CONTROLLER_LOCK_PATH), { recursive: true });
    const owner = randomUUID();
    const handle = openSync(CONTROLLER_LOCK_PATH, "wx");
    try {
        writeSync(handle, JSON.stringify({ pid: process.pid, owner, at: new Date().toISOString() }), null, "utf8");
    } finally {
        closeSync(handle);
    }
    return () => {
        try {
            const current = JSON.parse(readFileSync(CONTROLLER_LOCK_PATH, "utf8")) as { owner?: unknown };
            if (current.owner === owner) unlinkSync(CONTROLLER_LOCK_PATH);
        } catch {
            // already removed or replaced
        }
    };
}

function isControllerLockStale(): boolean {
    try {
        const parsed = JSON.parse(readFileSync(CONTROLLER_LOCK_PATH, "utf8")) as { pid?: unknown; owner?: unknown };
        if (typeof parsed.pid === "number" && !isProcessAlive(parsed.pid)) return true;
        if (typeof parsed.pid === "number" && typeof parsed.owner === "string") return false;
    } catch {
        // fall back to age
    }
    try {
        return Date.now() - statSync(CONTROLLER_LOCK_PATH).mtimeMs > LOCK_STALE_MS;
    } catch {
        return true;
    }
}

function resolveCliEntryPath(): string {
    const candidate = process.argv[1];
    if (candidate && (candidate.endsWith("cli.js") || candidate.endsWith("cli.ts"))) return candidate;
    const script = fileURLToPath(import.meta.url);
    return resolve(dirname(script), script.endsWith(".ts") ? "../cli.ts" : "../cli.js");
}

function isProcessAlive(pid: number): boolean {
    if (!Number.isInteger(pid) || pid <= 0) return false;
    try {
        process.kill(pid, 0);
        return true;
    } catch (error) {
        return (error as NodeJS.ErrnoException).code === "EPERM";
    }
}

function describeExit(result: { code: number | null; signal: NodeJS.Signals | null; error?: string }): string {
    if (result.error) return result.error;
    if (result.signal) return `信号 ${result.signal}`;
    return `退出码 ${result.code ?? "unknown"}`;
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolveSleep) => setTimeout(resolveSleep, ms));
}

export function currentControllerPanelUrl(): string | undefined {
    try {
        const state = loadControllerState();
        return state && isProcessAlive(state.pid) ? controllerPanelUrl(state) : undefined;
    } catch {
        return undefined;
    }
}
