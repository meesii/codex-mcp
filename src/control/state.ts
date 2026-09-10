import { existsSync, readFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { getUserConfigDir } from "../config/user-config.js";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";
import { loopbackHost } from "../lib/http/listen-address.js";

export const CONTROLLER_API_VERSION = 1 as const;

export interface ControllerState {
    schemaVersion: 1;
    apiVersion: typeof CONTROLLER_API_VERSION;
    pid: number;
    host: "127.0.0.1" | "::1";
    port: number;
    controlToken: string;
    startedAt: string;
    version: string;
}

export function getControllerStatePath(): string {
    return join(getUserConfigDir(), "controller.json");
}

export function controllerPanelUrl(state: Pick<ControllerState, "host" | "port">): string {
    return `http://${loopbackHost(state.host)}:${state.port}/`;
}

export function loadControllerState(): ControllerState | undefined {
    const path = getControllerStatePath();
    if (!existsSync(path)) return undefined;
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("controller state must be an object");
        }
        const state = raw as Record<string, unknown>;
        const allowed = ["schemaVersion", "apiVersion", "pid", "host", "port", "controlToken", "startedAt", "version"];
        const unknown = Object.keys(state).filter((key) => !allowed.includes(key));
        if (unknown.length > 0) throw new Error(`unsupported fields: ${unknown.join(", ")}`);
        if (
            state.schemaVersion !== 1 ||
            state.apiVersion !== CONTROLLER_API_VERSION ||
            !Number.isInteger(state.pid) || (state.pid as number) <= 0 ||
            (state.host !== "127.0.0.1" && state.host !== "::1") ||
            !Number.isInteger(state.port) || (state.port as number) < 1 || (state.port as number) > 65535 ||
            typeof state.controlToken !== "string" || state.controlToken.length < 32 ||
            typeof state.startedAt !== "string" || !state.startedAt ||
            typeof state.version !== "string" || !state.version
        ) {
            throw new Error("unsupported or malformed controller state");
        }
        return {
            schemaVersion: 1,
            apiVersion: CONTROLLER_API_VERSION,
            pid: state.pid as number,
            host: state.host,
            port: state.port as number,
            controlToken: state.controlToken,
            startedAt: state.startedAt,
            version: state.version,
        };
    } catch (error) {
        throw new Error(`无法读取有效的 Controller 状态：${path}：${error instanceof Error ? error.message : String(error)}`);
    }
}

export async function saveControllerState(state: ControllerState): Promise<void> {
    writePrivateFileAtomic(getControllerStatePath(), `${JSON.stringify(state, null, 4)}\n`);
}

export async function removeControllerState(): Promise<void> {
    try {
        await unlink(getControllerStatePath());
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
}

export async function removeControllerStateIfOwned(pid: number): Promise<void> {
    let state: ControllerState | undefined;
    try {
        state = loadControllerState();
    } catch {
        return;
    }
    if (state?.pid === pid) await removeControllerState();
}
