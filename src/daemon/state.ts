import {
    chmod,
    mkdir,
    readFile,
    rename,
    unlink,
    writeFile,
} from "node:fs/promises";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { getUserConfigDir } from "../config/user-config.js";
import { PACKAGE_VERSION } from "../server/version.js";

export type DaemonMode = "local" | "public";

export interface DaemonState {
    pid: number;
    host: string;
    port: number;
    /** Random loopback-only control token protecting /daemon/* routes. */
    controlToken: string;
    /** Public MCP URL when the daemon runs in public mode. */
    publicMcpUrl?: string;
    startedAt: string;
    version: string;
    mode: DaemonMode;
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
    projects: RegisteredProject[];
}

export interface SessionBinding {
    ownerKey: string;
    projectId: string;
    boundAt: string;
    lastSeenAt: string;
}

export interface BindingStateFile {
    bindings: SessionBinding[];
}

export interface NewDaemonStateInput {
    pid: number;
    host: string;
    port: number;
    controlToken: string;
    publicMcpUrl?: string;
    mode: DaemonMode;
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
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
        const state = raw as Record<string, unknown>;
        if (
            typeof state.pid !== "number" ||
            !Number.isInteger(state.pid) ||
            state.pid <= 0 ||
            typeof state.port !== "number" ||
            typeof state.controlToken !== "string" ||
            typeof state.mode !== "string"
        ) {
            return undefined;
        }
        return {
            pid: state.pid,
            host: typeof state.host === "string" ? state.host : "127.0.0.1",
            port: state.port,
            controlToken: state.controlToken,
            ...(typeof state.publicMcpUrl === "string" ? { publicMcpUrl: state.publicMcpUrl } : {}),
            startedAt: typeof state.startedAt === "string" ? state.startedAt : new Date().toISOString(),
            version: typeof state.version === "string" ? state.version : PACKAGE_VERSION,
            mode: state.mode === "public" ? "public" : "local",
        };
    } catch {
        return undefined;
    }
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
        const records =
            raw && typeof raw === "object" && Array.isArray((raw as { projects?: unknown }).projects)
                ? (raw as ProjectStateFile).projects
                : [];
        return records
            .filter(isRegisteredProjectRecord)
            .map((item) => ({
                id: item.id,
                name: item.name,
                path: item.path,
                active: item.active === true,
                addedAt: item.addedAt,
                lastSeenAt: item.lastSeenAt,
            }));
    } catch {
        return [];
    }
}

export async function saveProjectsFile(projects: RegisteredProject[]): Promise<void> {
    await atomicWriteJson(projectsStatePath(), { projects } satisfies ProjectStateFile);
}

export function loadBindingsFile(): SessionBinding[] {
    const path = bindingsStatePath();
    if (!existsSync(path)) return [];
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        const records =
            raw && typeof raw === "object" && Array.isArray((raw as { bindings?: unknown }).bindings)
                ? (raw as BindingStateFile).bindings
                : [];
        return records.filter(isSessionBindingRecord).map((item) => ({
            ownerKey: item.ownerKey,
            projectId: item.projectId,
            boundAt: item.boundAt,
            lastSeenAt: item.lastSeenAt,
        }));
    } catch {
        return [];
    }
}

export async function saveBindingsFile(bindings: SessionBinding[]): Promise<void> {
    await atomicWriteJson(bindingsStatePath(), { bindings } satisfies BindingStateFile);
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
    await mkdir(getUserConfigDir(), { recursive: true });
    const tempPath = `${path}.tmp`;
    const payload = `${JSON.stringify(value, null, 4)}\n`;
    await writeFile(tempPath, payload, "utf8");
    try {
        // User-only permissions on platforms that support them.
        await chmod(tempPath, 0o600);
    } catch {
        // Windows chmod is a no-op for this purpose.
    }
    await rename(tempPath, path);
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
    return (
        typeof item.id === "string" &&
        typeof item.name === "string" &&
        typeof item.path === "string" &&
        typeof item.addedAt === "string" &&
        typeof item.lastSeenAt === "string"
    );
}

function isSessionBindingRecord(value: unknown): value is SessionBinding {
    if (!value || typeof value !== "object" || Array.isArray(value)) return false;
    const item = value as Record<string, unknown>;
    return (
        typeof item.ownerKey === "string" &&
        typeof item.projectId === "string" &&
        typeof item.boundAt === "string" &&
        typeof item.lastSeenAt === "string"
    );
}
