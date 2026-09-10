import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { isIP } from "node:net";
import { join } from "node:path";
import { expandHomePath } from "./loader.js";
import { writePrivateFileAtomic } from "../lib/fs/atomic-file.js";
import { normalizeTunnelId } from "../tunnel/id.js";

export interface ClientCapabilitiesConfig {
    /** Tool patterns used when a client has no explicit override. Defaults to ["*"]. */
    default?: string[];
    /** Exact OAuth client_id or `local:noauth` → tool patterns. */
    clients?: Record<string, string[]>;
}

export interface UserUiConfig {
    /** Show custom cards for ordinary coding tools. Defaults to false. */
    tools?: boolean;
    /** Show the summary status card. Defaults to true. */
    status?: boolean;
}

export type CapabilitySourceId = "agents" | "codex" | "claude";
export type CapabilitySyncMode = "watch" | "startup";

export interface CapabilitySourceConfig {
    enabled?: boolean;
    mcp?: boolean;
    skills?: boolean;
}

export interface UserCapabilitiesConfig {
    /** Reload external capability sources when their files change, or only at process start. */
    sync?: CapabilitySyncMode;
    /** Highest-priority source first when two sources export the same name. */
    priority?: CapabilitySourceId[];
    sources?: Partial<Record<CapabilitySourceId, CapabilitySourceConfig>>;
}

export interface ExternalPublicAccessConfig {
    kind: "external";
    domain: string;
}

export interface CloudflarePublicAccessConfig {
    kind: "cloudflare";
    domain: string;
    cloudflaredBin: string;
    tunnelName: string;
    tunnelId: string;
    /** Versioned generated YAML selected by the committed config. */
    configRevision: string;
    /** Non-secret Cloudflare ownership metadata used for consistency checks. */
    accountId: string;
    zoneId: string;
}

export type PublicAccessConfig =
    | ExternalPublicAccessConfig
    | CloudflarePublicAccessConfig;

export interface UserConfig {
    host?: string;
    port?: number;
    /** Tagged committed public entry. Only the 1.0 shape is accepted. */
    publicAccess?: PublicAccessConfig;
    /** Optional per-client tool registration policy; omitted means all tools. */
    clientCapabilities?: ClientCapabilitiesConfig;
    /** External MCP / Skill sources consumed at runtime without copying them. */
    capabilities?: UserCapabilitiesConfig;
    /** ChatGPT-facing custom UI preferences. */
    ui?: UserUiConfig;
}

export type UserConfigPatch = Omit<UserConfig, "publicAccess"> & {
    /** `null` explicitly removes the committed public entry. */
    publicAccess?: PublicAccessConfig | null;
};

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
        if (message.includes("不支持的字段")) {
            throw new Error(`${message}；1.0 不会自动迁移旧配置`);
        }
        throw new Error(`配置文件有问题：${path}：${message}`);
    }
}

export function saveUserConfig(patch: UserConfigPatch): UserConfig {
    ensureUserConfigDirs();
    const merged: UserConfig = { ...loadUserConfig() };
    if (patch.host !== undefined) merged.host = patch.host;
    if (patch.port !== undefined) merged.port = patch.port;
    if (Object.prototype.hasOwnProperty.call(patch, "publicAccess")) {
        if (patch.publicAccess === null) {
            delete merged.publicAccess;
        } else if (patch.publicAccess !== undefined) {
            merged.publicAccess = normalizePublicAccess(patch.publicAccess);
        }
    }
    if (patch.clientCapabilities !== undefined) {
        merged.clientCapabilities = normalizeClientCapabilities(patch.clientCapabilities);
    }
    if (patch.capabilities !== undefined) {
        merged.capabilities = normalizeCapabilitiesConfig(patch.capabilities);
    }
    if (patch.ui !== undefined) {
        merged.ui = normalizeUserUiConfig({ ...(merged.ui ?? {}), ...patch.ui });
    }
    const normalized = normalizeUserConfig(merged as unknown as Record<string, unknown>);
    writePrivateFileAtomic(getUserConfigPath(), `${JSON.stringify(normalized, null, 4)}\n`);
    return normalized;
}

export function ensureStarterUserConfig(host: string, port: number): UserConfig {
    ensureUserConfigDirs();
    const path = getUserConfigPath();
    if (!existsSync(path)) {
        const starter: UserConfig = { host, port };
        writePrivateFileAtomic(path, `${JSON.stringify(starter, null, 4)}\n`);
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
    const supportedKeys = new Set([
        "host",
        "port",
        "publicAccess",
        "clientCapabilities",
        "capabilities",
        "ui",
    ]);
    const unknownKeys = Object.keys(raw).filter((key) => !supportedKeys.has(key));
    if (unknownKeys.length > 0) {
        throw new Error(
            `配置包含 1.0 不支持的字段：${unknownKeys.join(", ")}；请重新运行 codex-mcp setup`,
        );
    }
    const config: UserConfig = {};
    if (Object.prototype.hasOwnProperty.call(raw, "host")) {
        config.host = normalizeListenHost(raw.host);
    }
    if (Object.prototype.hasOwnProperty.call(raw, "port")) {
        config.port = normalizePort(raw.port);
    }
    if (raw.publicAccess !== undefined) {
        if (!raw.publicAccess || typeof raw.publicAccess !== "object" || Array.isArray(raw.publicAccess)) {
            throw new Error("publicAccess must be an object");
        }
        config.publicAccess = normalizePublicAccess(raw.publicAccess as PublicAccessConfig);
    }
    if (raw.clientCapabilities !== undefined) {
        config.clientCapabilities = normalizeClientCapabilities(raw.clientCapabilities);
    }
    if (raw.capabilities !== undefined) {
        config.capabilities = normalizeCapabilitiesConfig(raw.capabilities);
    }
    if (raw.ui !== undefined) {
        config.ui = normalizeUserUiConfig(raw.ui);
    }
    return config;
}

function normalizePublicAccess(input: PublicAccessConfig): PublicAccessConfig {
    if (!input || typeof input !== "object" || Array.isArray(input)) {
        throw new Error("publicAccess must be an object");
    }
    const raw = input as unknown as Record<string, unknown>;
    const kind = raw.kind;
    assertObjectKeys(raw, "publicAccess", kind === "cloudflare"
        ? ["kind", "domain", "cloudflaredBin", "tunnelName", "tunnelId", "configRevision", "accountId", "zoneId"]
        : ["kind", "domain"]);
    if (kind === "external") {
        return { kind: "external", domain: normalizeHostname(requireNonEmpty(raw.domain, "publicAccess.domain")) };
    }
    if (kind !== "cloudflare") {
        throw new Error("publicAccess.kind must be external or cloudflare");
    }
    const cloudflaredBin = expandHomePath(requireNonEmpty(raw.cloudflaredBin, "publicAccess.cloudflaredBin"));
    const tunnelName = requireNonEmpty(raw.tunnelName, "publicAccess.tunnelName");
    const tunnelId = normalizeTunnelId(requireNonEmpty(raw.tunnelId, "publicAccess.tunnelId"), "publicAccess.tunnelId");
    const configRevision = requireNonEmpty(raw.configRevision, "publicAccess.configRevision");
    if (!/^[A-Za-z0-9_-]{8,80}$/.test(configRevision)) {
        throw new Error("publicAccess.configRevision has an invalid format");
    }
    const accountId = requireNonEmpty(raw.accountId, "publicAccess.accountId");
    const zoneId = requireNonEmpty(raw.zoneId, "publicAccess.zoneId");
    return {
        kind: "cloudflare",
        domain: normalizeHostname(requireNonEmpty(raw.domain, "publicAccess.domain")),
        cloudflaredBin,
        tunnelName,
        tunnelId,
        configRevision,
        accountId,
        zoneId,
    };
}

function normalizeListenHost(value: unknown): string {
    if (typeof value !== "string") throw new Error("host 必须是本机监听地址");
    const host = value.trim().toLowerCase();
    if (host === "localhost") return "127.0.0.1";
    if (!["127.0.0.1", "::1", "0.0.0.0", "::"].includes(host)) {
        throw new Error("host 只支持 127.0.0.1、::1、0.0.0.0 或 ::，确保本机控制接口可达");
    }
    return host;
}

function normalizePort(value: unknown): number {
    if (typeof value !== "number" || !Number.isInteger(value) || value < 0 || value > 65535) {
        throw new Error("port must be an integer between 0 and 65535");
    }
    return value;
}

function requireNonEmpty(value: unknown, name: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${name} must be a non-empty string`);
    }
    return value.trim();
}

function normalizeCapabilitiesConfig(value: unknown): UserCapabilitiesConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("capabilities must be an object");
    }
    const raw = value as Record<string, unknown>;
    assertObjectKeys(raw, "capabilities", ["sync", "priority", "sources"]);
    const result: UserCapabilitiesConfig = {};
    if (raw.sync !== undefined) {
        if (raw.sync !== "watch" && raw.sync !== "startup") {
            throw new Error("capabilities.sync must be watch or startup");
        }
        result.sync = raw.sync;
    }
    if (raw.priority !== undefined) {
        if (!Array.isArray(raw.priority)) {
            throw new Error("capabilities.priority must be an array");
        }
        const priority = raw.priority.map((item, index) => {
            if (item !== "agents" && item !== "codex" && item !== "claude") {
                throw new Error(`capabilities.priority[${index}] is invalid`);
            }
            return item;
        });
        if (new Set(priority).size !== priority.length) {
            throw new Error("capabilities.priority must not contain duplicates");
        }
        result.priority = priority;
    }
    if (raw.sources !== undefined) {
        if (!raw.sources || typeof raw.sources !== "object" || Array.isArray(raw.sources)) {
            throw new Error("capabilities.sources must be an object");
        }
        const sources: Partial<Record<CapabilitySourceId, CapabilitySourceConfig>> = {};
        for (const [sourceId, sourceValue] of Object.entries(raw.sources as Record<string, unknown>)) {
            if (sourceId !== "agents" && sourceId !== "codex" && sourceId !== "claude") {
                throw new Error(`capabilities.sources.${sourceId} is not supported`);
            }
            if (!sourceValue || typeof sourceValue !== "object" || Array.isArray(sourceValue)) {
                throw new Error(`capabilities.sources.${sourceId} must be an object`);
            }
            const sourceRaw = sourceValue as Record<string, unknown>;
            assertObjectKeys(sourceRaw, `capabilities.sources.${sourceId}`, ["enabled", "mcp", "skills"]);
            const source: CapabilitySourceConfig = {};
            for (const key of ["enabled", "mcp", "skills"] as const) {
                if (sourceRaw[key] === undefined) continue;
                if (typeof sourceRaw[key] !== "boolean") {
                    throw new Error(`capabilities.sources.${sourceId}.${key} must be a boolean`);
                }
                source[key] = sourceRaw[key] as boolean;
            }
            sources[sourceId] = source;
        }
        result.sources = sources;
    }
    return result;
}

function normalizeUserUiConfig(value: unknown): UserUiConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("ui must be an object");
    }
    const raw = value as Record<string, unknown>;
    assertObjectKeys(raw, "ui", ["tools", "status"]);
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
    assertObjectKeys(raw, "clientCapabilities", ["default", "clients"]);
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

function assertObjectKeys(value: unknown, label: string, allowed: readonly string[]): void {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const unknown = Object.keys(value as Record<string, unknown>).filter((key) => !allowed.includes(key));
    if (unknown.length > 0) {
        throw new Error(`${label} 包含 1.0 不支持的字段：${unknown.join(", ")}`);
    }
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
