import { unlink } from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getUserConfigDir } from "../config/user-config.js";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";

export interface RuntimeIntent {
    local: boolean;
    noTunnel: boolean;
    tunnelLogs: boolean;
}

export interface DaemonState {
    schemaVersion: 1;
    pid: number;
    host: string;
    port: number;
    /** Random loopback-only control token protecting /daemon/* routes. */
    controlToken: string;
    /** Public MCP URL when the daemon runs in public mode. */
    publicMcpUrl?: string;
    startedAt: string;
    version: string;
    runtimeIntent: RuntimeIntent;
}

export interface RegisteredProject {
    id: string;
    name: string;
    path: string;
    active: boolean;
    addedAt: string;
    lastSeenAt: string;
}

export interface ProjectStateFile {
    schemaVersion: 1;
    projects: RegisteredProject[];
}

export interface SessionBinding {
    ownerKey: string;
    projectId: string;
    boundAt: string;
    lastSeenAt: string;
}

export interface BindingStateFile {
    schemaVersion: 1;
    bindings: SessionBinding[];
}

const STATE_VERSION = 1 as const;

function requireString(value: unknown, name: string): string {
    if (typeof value !== "string" || !value) throw new Error(`malformed ${name}`);
    return value;
}

function daemonStatePath(): string {
    return join(getUserConfigDir(), "daemon.json");
}

function projectsStatePath(): string {
    return join(getUserConfigDir(), "projects.json");
}

function bindingsStatePath(): string {
    return join(getUserConfigDir(), "session-bindings.json");
}

export function loadDaemonState(): DaemonState | undefined {
    const path = daemonStatePath();
    if (!existsSync(path)) return undefined;
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("daemon state must be an object");
        }
        const state = raw as Record<string, unknown>;
        assertExactKeys(state, "daemon state", [
            "schemaVersion", "pid", "host", "port", "controlToken", "publicMcpUrl",
            "startedAt", "version", "runtimeIntent",
        ]);
        if (
            state.schemaVersion !== STATE_VERSION ||
            typeof state.pid !== "number" ||
            !Number.isInteger(state.pid) ||
            state.pid <= 0 ||
            typeof state.port !== "number" ||
            typeof state.controlToken !== "string" ||
            state.controlToken.length < 32 ||
            !Number.isInteger(state.port) || state.port < 0 || state.port > 65535
        ) {
            throw new Error("unsupported or malformed daemon state");
        }
        if (Object.prototype.hasOwnProperty.call(state, "publicMcpUrl") &&
            (typeof state.publicMcpUrl !== "string" || !state.publicMcpUrl)) {
            throw new Error("malformed publicMcpUrl");
        }
        return {
            schemaVersion: STATE_VERSION,
            pid: state.pid,
            host: requireString(state.host, "host"),
            port: state.port,
            controlToken: state.controlToken,
            ...(typeof state.publicMcpUrl === "string" ? { publicMcpUrl: state.publicMcpUrl } : {}),
            startedAt: requireString(state.startedAt, "startedAt"),
            version: requireString(state.version, "version"),
            runtimeIntent: parseRuntimeIntent(state.runtimeIntent),
        };
    } catch {
        throw new Error(`无法读取有效的 daemon 状态：${path}`);
    }
}

function parseRuntimeIntent(value: unknown): RuntimeIntent {
    if (value && typeof value === "object" && !Array.isArray(value)) {
        const input = value as Record<string, unknown>;
        assertExactKeys(input, "runtime intent", ["local", "noTunnel", "tunnelLogs"]);
        if (
            typeof input.local === "boolean" &&
            typeof input.noTunnel === "boolean" &&
            typeof input.tunnelLogs === "boolean"
        ) {
            return {
                local: input.local,
                noTunnel: input.noTunnel,
                tunnelLogs: input.tunnelLogs,
            };
        }
    }
    throw new Error("malformed runtime intent");
}

export async function saveDaemonState(state: DaemonState): Promise<void> {
    await atomicWriteJson(daemonStatePath(), state);
}

export async function removeDaemonState(): Promise<void> {
    await removeFileIfExists(daemonStatePath());
}

export function loadProjectsFile(): RegisteredProject[] {
    const path = projectsStatePath();
    if (!existsSync(path)) return [];
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
            (raw as Record<string, unknown>).schemaVersion !== STATE_VERSION ||
            !Array.isArray((raw as { projects?: unknown }).projects)) {
            throw new Error("unsupported or malformed projects state");
        }
        assertExactKeys(raw as Record<string, unknown>, "projects state", ["schemaVersion", "projects"]);
        const records = (raw as ProjectStateFile).projects;
        if (!records.every(isRegisteredProjectRecord)) {
            throw new Error("projects state contains an invalid record");
        }
        assertUniqueProjects(records);
        return records.map((item) => ({
                id: item.id,
                name: item.name,
                path: item.path,
                active: item.active === true,
                addedAt: item.addedAt,
                lastSeenAt: item.lastSeenAt,
            }));
    } catch (error) {
        throw new Error(`无法读取有效的项目状态：${path}：${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function saveProjectsFile(projects: RegisteredProject[]): Promise<void> {
    await atomicWriteJson(projectsStatePath(), { schemaVersion: STATE_VERSION, projects } satisfies ProjectStateFile);
}

export function loadBindingsFile(): SessionBinding[] {
    const path = bindingsStatePath();
    if (!existsSync(path)) return [];
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
            (raw as Record<string, unknown>).schemaVersion !== STATE_VERSION ||
            !Array.isArray((raw as { bindings?: unknown }).bindings)) {
            throw new Error("unsupported or malformed bindings state");
        }
        assertExactKeys(raw as Record<string, unknown>, "bindings state", ["schemaVersion", "bindings"]);
        const records = (raw as BindingStateFile).bindings;
        if (!records.every(isSessionBindingRecord)) {
            throw new Error("bindings state contains an invalid record");
        }
        assertUniqueBindings(records);
        return records.map((item) => ({
            ownerKey: item.ownerKey,
            projectId: item.projectId,
            boundAt: item.boundAt,
            lastSeenAt: item.lastSeenAt,
        }));
    } catch (error) {
        throw new Error(`无法读取有效的会话绑定状态：${path}：${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function saveBindingsFile(bindings: SessionBinding[]): Promise<void> {
    await atomicWriteJson(bindingsStatePath(), { schemaVersion: STATE_VERSION, bindings } satisfies BindingStateFile);
}

const pendingWrites = new Map<string, Promise<void>>();

function atomicWriteJson(path: string, value: unknown): Promise<void> {
    const previous = pendingWrites.get(path) ?? Promise.resolve();
    const next = previous.then(() => atomicWriteJsonNow(path, value));
    // Keep the chain on the map so a rejected write does not poison the queue.
    pendingWrites.set(path, next.catch(() => undefined));
    return next;
}

async function atomicWriteJsonNow(path: string, value: unknown): Promise<void> {
    const payload = `${JSON.stringify(value, null, 4)}\n`;
    writePrivateFileAtomic(path, payload);
}

async function removeFileIfExists(path: string): Promise<void> {
    try {
        await unlink(path);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

function isRegisteredProjectRecord(value: unknown): value is RegisteredProject {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    try {
        assertExactKeys(item, "project record", ["id", "name", "path", "active", "addedAt", "lastSeenAt"]);
    } catch {
        return false;
    }
    return (
        typeof item.id === "string" && item.id.length > 0 &&
        typeof item.name === "string" && item.name.length > 0 &&
        typeof item.path === "string" && item.path.length > 0 &&
        typeof item.active === "boolean" &&
        typeof item.addedAt === "string" && item.addedAt.length > 0 &&
        typeof item.lastSeenAt === "string" && item.lastSeenAt.length > 0
    );
}

function isSessionBindingRecord(value: unknown): value is SessionBinding {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    try {
        assertExactKeys(item, "binding record", ["ownerKey", "projectId", "boundAt", "lastSeenAt"]);
    } catch {
        return false;
    }
    return (
        typeof item.ownerKey === "string" && item.ownerKey.length > 0 &&
        typeof item.projectId === "string" && item.projectId.length > 0 &&
        typeof item.boundAt === "string" && item.boundAt.length > 0 &&
        typeof item.lastSeenAt === "string" && item.lastSeenAt.length > 0
    );
}

function assertUniqueProjects(projects: RegisteredProject[]): void {
    const ids = new Set<string>();
    const paths = new Set<string>();
    for (const project of projects) {
        if (ids.has(project.id)) throw new Error(`projects state contains duplicate id: ${project.id}`);
        if (paths.has(project.path)) throw new Error(`projects state contains duplicate path: ${project.path}`);
        ids.add(project.id);
        paths.add(project.path);
    }
}

function assertUniqueBindings(bindings: SessionBinding[]): void {
    const owners = new Set<string>();
    for (const binding of bindings) {
        if (owners.has(binding.ownerKey)) {
            throw new Error(`bindings state contains duplicate owner: ${binding.ownerKey}`);
        }
        owners.add(binding.ownerKey);
    }
}

function assertExactKeys(value: Record<string, unknown>, label: string, allowed: readonly string[]): void {
    const unknown = Object.keys(value).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) throw new Error(`${label} contains unsupported fields: ${unknown.join(", ")}`);
}
