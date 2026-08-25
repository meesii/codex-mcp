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
    configRevision?: string;
    /** Non-secret Cloudflare ownership metadata used for consistency checks. */
    accountId?: string;
    zoneId?: string;
}

export type PublicAccessConfig =
    | ExternalPublicAccessConfig
    | CloudflarePublicAccessConfig;

export interface UserConfig {
    host?: string;
    port?: number;
    /** Tagged committed public entry. Legacy flat fields are migrated on read. */
    publicAccess?: PublicAccessConfig;
    /** Optional per-client tool registration policy; omitted means full compatibility. */
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
    writePrivateFileAtomic(getUserConfigPath(), `${JSON.stringify(merged, null, 4)}\n`);
    return merged;
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
    config.publicAccess = normalizePublicAccessFromRaw(raw);
    if (raw.clientCapabilities !== undefined) {
        config.clientCapabilities = normalizeClientCapabilities(raw.clientCapabilities);
    }
    // Legacy `workspaces` and `permissions` keys are intentionally ignored. Project
    // scope is owned by ProjectRegistry/BindingStore/ProjectRuntime now; retaining a
    // second configuration model would make old files appear authoritative when they are not.
    if (raw.capabilities !== undefined) {
        config.capabilities = normalizeCapabilitiesConfig(raw.capabilities);
    }
    if (raw.ui !== undefined) {
        config.ui = normalizeUserUiConfig(raw.ui);
    }
    return config;
}

function normalizePublicAccessFromRaw(
    raw: Record<string, unknown>,
): PublicAccessConfig | undefined {
    if (raw.publicAccess !== undefined) {
        if (!raw.publicAccess || typeof raw.publicAccess !== "object" || Array.isArray(raw.publicAccess)) {
            throw new Error("publicAccess must be an object");
        }
        return normalizePublicAccess(raw.publicAccess as PublicAccessConfig);
    }

    // Read-only compatibility with v0.9.0 and earlier. Any later save writes
    // only the tagged shape and naturally removes these legacy flat fields.
    const domain = typeof raw.domain === "string" && raw.domain.trim()
        ? normalizeHostname(raw.domain)
        : undefined;
    if (!domain) return undefined;
    if (raw.useCloudflared === false) return { kind: "external", domain };
    if (
        typeof raw.cloudflaredBin === "string" && raw.cloudflaredBin.trim() &&
        typeof raw.tunnelName === "string" && raw.tunnelName.trim() &&
        typeof raw.tunnelId === "string" && raw.tunnelId.trim()
    ) {
        return normalizePublicAccess({
            kind: "cloudflare",
            domain,
            cloudflaredBin: raw.cloudflaredBin,
            tunnelName: raw.tunnelName,
            tunnelId: raw.tunnelId,
        });
    }
    return undefined;
}

function normalizePublicAccess(input: PublicAccessConfig): PublicAccessConfig {
    if (input.kind === "external") {
        return { kind: "external", domain: normalizeHostname(input.domain) };
    }
    if (input.kind !== "cloudflare") {
        throw new Error("publicAccess.kind must be external or cloudflare");
    }
    const cloudflaredBin = expandHomePath(requireNonEmpty(input.cloudflaredBin, "publicAccess.cloudflaredBin"));
    const tunnelName = requireNonEmpty(input.tunnelName, "publicAccess.tunnelName");
    const tunnelId = normalizeTunnelId(input.tunnelId, "publicAccess.tunnelId");
    return {
        kind: "cloudflare",
        domain: normalizeHostname(input.domain),
        cloudflaredBin,
        tunnelName,
        tunnelId,
        ...(input.configRevision ? { configRevision: requireNonEmpty(input.configRevision, "publicAccess.configRevision") } : {}),
        ...(input.accountId ? { accountId: requireNonEmpty(input.accountId, "publicAccess.accountId") } : {}),
        ...(input.zoneId ? { zoneId: requireNonEmpty(input.zoneId, "publicAccess.zoneId") } : {}),
    };
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
