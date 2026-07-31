import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandHomePath } from "./config.js";

/** Persisted per-machine settings under `~/.codex-mcp/config.json`. */
export interface UserConfig {
    host?: string;
    port?: number;
    /** Public hostname for ChatGPT / Host allow-list (e.g. mcp.example.com). */
    domain?: string;
    /** When true, `codex-mcp` starts a cloudflared sidecar. */
    useCloudflared?: boolean;
    /** Absolute path or command name for the cloudflared binary. */
    cloudflaredBin?: string;
    /** Cloudflare tunnel name (default codex-mcp). */
    tunnelName?: string;
    /** Cloudflare tunnel UUID. */
    tunnelId?: string;
}

/**
 * Return the `~/.codex-mcp` directory path.
 *
 * @returns Absolute directory path
 */
export function getUserConfigDir(): string {
    return join(homedir(), ".codex-mcp");
}

/**
 * Return the user config JSON path.
 *
 * @returns Absolute file path
 */
export function getUserConfigPath(): string {
    return join(getUserConfigDir(), "config.json");
}

/**
 * Return the directory for sidecar logs.
 *
 * @returns Absolute directory path
 */
export function getUserLogDir(): string {
    return join(getUserConfigDir(), "logs");
}

/**
 * Ensure `~/.codex-mcp` and `logs` exist.
 */
export function ensureUserConfigDirs(): void {
    mkdirSync(getUserLogDir(), { recursive: true });
}

/**
 * Load `~/.codex-mcp/config.json` when present.
 *
 * @returns Parsed config or empty object
 */
export function loadUserConfig(): UserConfig {
    const path = getUserConfigPath();
    if (!existsSync(path)) {
        return {};
    }
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("config root must be an object");
        }
        return normalizeUserConfig(raw as Record<string, unknown>);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid ${path}: ${message}`);
    }
}

/**
 * Merge and write user config.
 *
 * @param patch - Fields to merge into the existing file
 * @returns Full config after write
 */
export function saveUserConfig(patch: UserConfig): UserConfig {
    ensureUserConfigDirs();
    const merged: UserConfig = { ...loadUserConfig() };
    if (patch.host !== undefined) merged.host = patch.host;
    if (patch.port !== undefined) merged.port = patch.port;
    if (patch.domain !== undefined) merged.domain = normalizeHostname(patch.domain);
    if (patch.useCloudflared !== undefined) {
        merged.useCloudflared = patch.useCloudflared;
    }
    if (patch.cloudflaredBin !== undefined) {
        merged.cloudflaredBin = expandHomePath(patch.cloudflaredBin);
    }
    if (patch.tunnelName !== undefined) merged.tunnelName = patch.tunnelName;
    if (patch.tunnelId !== undefined) merged.tunnelId = patch.tunnelId;
    writeFileSync(getUserConfigPath(), `${JSON.stringify(merged, null, 4)}\n`, "utf8");
    return merged;
}

/**
 * Create a starter config file when missing (host/port only).
 *
 * @param host - Bind host
 * @param port - Bind port
 * @returns Current config after ensure
 */
export function ensureStarterUserConfig(host: string, port: number): UserConfig {
    ensureUserConfigDirs();
    const path = getUserConfigPath();
    if (!existsSync(path)) {
        const starter: UserConfig = { host, port };
        writeFileSync(path, `${JSON.stringify(starter, null, 4)}\n`, "utf8");
        return starter;
    }
    return loadUserConfig();
}

/**
 * Normalize a hostname: strip scheme/path/port and lowercase.
 *
 * @param value - Raw domain input
 * @returns Hostname only
 */
export function normalizeHostname(value: string): string {
    let text = value.trim().toLowerCase();
    if (text.includes("://")) {
        text = new URL(text).hostname;
    } else {
        text = text.replace(/\/.*$/, "").replace(/:\d+$/, "");
    }
    if (!text || text.includes(" ") || !text.includes(".")) {
        throw new Error(`Invalid domain hostname: ${value}`);
    }
    return text;
}

/**
 * @param raw - JSON object from disk
 * @returns Typed user config
 */
function normalizeUserConfig(raw: Record<string, unknown>): UserConfig {
    const config: UserConfig = {};
    if (typeof raw.host === "string" && raw.host.trim()) {
        config.host = raw.host.trim();
    }
    if (typeof raw.port === "number" && Number.isFinite(raw.port)) {
        config.port = raw.port;
    } else if (typeof raw.port === "string" && raw.port.trim()) {
        const port = Number.parseInt(raw.port, 10);
        if (Number.isFinite(port)) {
            config.port = port;
        }
    }
    if (typeof raw.domain === "string" && raw.domain.trim()) {
        config.domain = normalizeHostname(raw.domain);
    }
    if (typeof raw.useCloudflared === "boolean") {
        config.useCloudflared = raw.useCloudflared;
    }
    if (typeof raw.cloudflaredBin === "string" && raw.cloudflaredBin.trim()) {
        config.cloudflaredBin = expandHomePath(raw.cloudflaredBin.trim());
    }
    if (typeof raw.tunnelName === "string" && raw.tunnelName.trim()) {
        config.tunnelName = raw.tunnelName.trim();
    }
    if (typeof raw.tunnelId === "string" && raw.tunnelId.trim()) {
        config.tunnelId = raw.tunnelId.trim();
    }
    return config;
}
