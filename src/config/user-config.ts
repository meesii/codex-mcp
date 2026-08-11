import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { expandHomePath } from "./loader.js";

export interface ClientCapabilitiesConfig {
    /** Tool patterns used when a client has no explicit override. Defaults to ["*"]. */
    default?: string[];
    /** Exact OAuth client_id or `local:noauth` → tool patterns. */
    clients?: Record<string, string[]>;
}

export interface UserUiConfig {
    /** Show custom cards for ordinary coding tools. Defaults to false. */
    tools?: boolean;
    /** Show custom cards for summary/goal status tools. Defaults to true. */
    status?: boolean;
}

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
    /** Optional per-client tool registration policy; omitted means full compatibility. */
    clientCapabilities?: ClientCapabilitiesConfig;
    /** ChatGPT-facing custom UI preferences. */
    ui?: UserUiConfig;
}

export function getUserConfigDir(): string {
    return join(homedir(), ".codex-mcp");
}

export function getUserConfigPath(): string {
    return join(getUserConfigDir(), "config.json");
}

export function getUserLogDir(): string {
    return join(getUserConfigDir(), "logs");
}

export function ensureUserConfigDirs(): void {
    mkdirSync(getUserLogDir(), { recursive: true });
}

export function loadUserConfig(): UserConfig {
    const path = getUserConfigPath();
    if (!existsSync(path)) {
        return {};
    }
    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
            throw new Error("配置内容格式不正确");
        }
        return normalizeUserConfig(raw as Record<string, unknown>);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`配置文件有问题：${path}：${message}`);
    }
}

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
    if (patch.clientCapabilities !== undefined) {
        merged.clientCapabilities = normalizeClientCapabilities(patch.clientCapabilities);
    }
    if (patch.ui !== undefined) {
        merged.ui = normalizeUserUiConfig({ ...(merged.ui ?? {}), ...patch.ui });
    }
    writeFileSync(getUserConfigPath(), `${JSON.stringify(merged, null, 4)}\n`, "utf8");
    return merged;
}

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

export function normalizeHostname(value: string): string {
    const text = value.trim();
    if (!text) throw invalidDomainError(value);

    let parsed: URL;
    try {
        parsed = text.includes("://") ? new URL(text) : new URL(`https://${text}`);
    } catch {
        throw invalidDomainError(value);
    }
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
        throw invalidDomainError(value);
    }
    if (parsed.username || parsed.password) {
        throw invalidDomainError(value);
    }

    const hostname = parsed.hostname.toLowerCase().replace(/\.$/, "");
    if (!hostname || isIP(hostname) !== 0 || hostname.length > 253 || !hostname.includes(".")) {
        throw invalidDomainError(value);
    }
    const labels = hostname.split(".");
    if (
        labels.some(
            (label) =>
                label.length === 0 ||
                label.length > 63 ||
                !/^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(label),
        )
    ) {
        throw invalidDomainError(value);
    }
    return hostname;
}

function invalidDomainError(value: string): Error {
    return new Error(`域名格式不正确：${value}`);
}

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
    if (raw.clientCapabilities !== undefined) {
        config.clientCapabilities = normalizeClientCapabilities(raw.clientCapabilities);
    }
    if (raw.ui !== undefined) {
        config.ui = normalizeUserUiConfig(raw.ui);
    }
    return config;
}

function normalizeUserUiConfig(value: unknown): UserUiConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("ui must be an object");
    }
    const raw = value as Record<string, unknown>;
    const result: UserUiConfig = {};
    if (raw.tools !== undefined) {
        if (typeof raw.tools !== "boolean") throw new Error("ui.tools must be a boolean");
        result.tools = raw.tools;
    }
    if (raw.status !== undefined) {
        if (typeof raw.status !== "boolean") throw new Error("ui.status must be a boolean");
        result.status = raw.status;
    }
    return result;
}

function normalizeClientCapabilities(value: unknown): ClientCapabilitiesConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("clientCapabilities must be an object");
    }
    const raw = value as Record<string, unknown>;
    const result: ClientCapabilitiesConfig = {};
    if (raw.default !== undefined) {
        result.default = normalizeToolPatterns(raw.default, "clientCapabilities.default");
    }
    if (raw.clients !== undefined) {
        if (!raw.clients || typeof raw.clients !== "object" || Array.isArray(raw.clients)) {
            throw new Error("clientCapabilities.clients must be an object");
        }
        const clients: Record<string, string[]> = {};
        for (const [clientId, patterns] of Object.entries(raw.clients as Record<string, unknown>)) {
            if (!clientId.trim() || clientId.length > 2048) {
                throw new Error("clientCapabilities client id must be a non-empty string");
            }
            clients[clientId] = normalizeToolPatterns(
                patterns,
                `clientCapabilities.clients.${clientId}`,
            );
        }
        result.clients = clients;
    }
    return result;
}

function normalizeToolPatterns(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value.map((item, index) => {
        if (typeof item !== "string") throw new Error(`${label}[${index}] must be a string`);
        const pattern = item.trim();
        if (
            !pattern ||
            pattern.length > 128 ||
            (pattern !== "*" && !/^[A-Za-z0-9_-]+\*?$/.test(pattern))
        ) {
            throw new Error(`${label}[${index}] is not a valid tool pattern`);
        }
        return pattern;
    });
}
