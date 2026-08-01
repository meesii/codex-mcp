import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expandHomePath } from "./config.js";
import { ensureUserConfigDirs, getUserConfigDir } from "./user-config.js";

/** Shared fields for every downstream MCP entry in `mcp.json`. */
export interface McpServerBase {
    /** When true, skip this entry entirely. */
    disabled?: boolean;
}

/** Spawn a local MCP server over stdio. */
export interface StdioMcpServerConfig extends McpServerBase {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}

/** Connect to a remote MCP server over Streamable HTTP. */
export interface UrlMcpServerConfig extends McpServerBase {
    url: string;
    headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpServerConfig | UrlMcpServerConfig;

/** Parsed `~/.codex-mcp/mcp.json`. */
export interface UserMcpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

export interface NamedMcpServer {
    name: string;
    config: McpServerConfig;
}

/**
 * Return the user mcp.json path.
 *
 * @returns Absolute file path under `~/.codex-mcp`
 */
export function getUserMcpConfigPath(): string {
    return join(getUserConfigDir(), "mcp.json");
}

/**
 * Whether a config entry uses stdio transport.
 *
 * @param config - Parsed server entry
 * @returns True for command-based servers
 */
export function isStdioMcpServer(config: McpServerConfig): config is StdioMcpServerConfig {
    return "command" in config && typeof config.command === "string";
}

/**
 * Whether a config entry uses HTTP transport.
 *
 * @param config - Parsed server entry
 * @returns True for url-based servers
 */
export function isUrlMcpServer(config: McpServerConfig): config is UrlMcpServerConfig {
    return "url" in config && typeof config.url === "string";
}

/**
 * Load `~/.codex-mcp/mcp.json` when present.
 *
 * Missing file → empty `mcpServers`. Disabled entries are omitted.
 *
 * @returns Normalized config
 */
export function loadUserMcpConfig(): UserMcpConfig {
    ensureUserConfigDirs();
    const path = getUserMcpConfigPath();
    if (!existsSync(path)) {
        return { mcpServers: {} };
    }

    try {
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return normalizeUserMcpConfig(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`Invalid ${path}: ${message}`);
    }
}

/**
 * List enabled servers in stable name order.
 *
 * @param config - Parsed user mcp config
 * @returns Named entries ready to connect
 */
export function listEnabledMcpServers(config: UserMcpConfig): NamedMcpServer[] {
    return Object.keys(config.mcpServers)
        .sort((left, right) => left.localeCompare(right))
        .map((name) => ({ name, config: config.mcpServers[name]! }));
}

/**
 * @param raw - JSON from disk
 * @returns Typed config with disabled entries removed
 */
function normalizeUserMcpConfig(raw: unknown): UserMcpConfig {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("root must be an object");
    }

    const root = raw as Record<string, unknown>;
    const serversRaw = root.mcpServers;
    if (serversRaw === undefined) {
        return { mcpServers: {} };
    }
    if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
        throw new Error("mcpServers must be an object");
    }

    const mcpServers: Record<string, McpServerConfig> = {};
    for (const [name, entry] of Object.entries(serversRaw as Record<string, unknown>)) {
        assertServerName(name);
        const parsed = normalizeServerEntry(name, entry);
        if (!parsed) continue;
        mcpServers[name] = parsed;
    }

    return { mcpServers };
}

/**
 * @param name - Server key from mcp.json
 */
function assertServerName(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(
            `invalid server name "${name}" (use letters, digits, _ or -)`,
        );
    }
}

/**
 * @param name - Server key
 * @param entry - Raw JSON value
 * @returns Normalized config, or null when disabled
 */
function normalizeServerEntry(name: string, entry: unknown): McpServerConfig | null {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`mcpServers.${name} must be an object`);
    }

    const raw = entry as Record<string, unknown>;
    if (raw.disabled === true) {
        return null;
    }

    const hasCommand = typeof raw.command === "string" && raw.command.trim();
    const hasUrl = typeof raw.url === "string" && raw.url.trim();

    if (hasCommand && hasUrl) {
        throw new Error(`mcpServers.${name}: use either command or url, not both`);
    }
    if (!hasCommand && !hasUrl) {
        throw new Error(`mcpServers.${name}: requires command or url`);
    }

    if (hasCommand) {
        const config: StdioMcpServerConfig = {
            command: String(raw.command).trim(),
        };
        if (Array.isArray(raw.args)) {
            config.args = raw.args.map((item, index) => {
                if (typeof item !== "string") {
                    throw new Error(`mcpServers.${name}.args[${index}] must be a string`);
                }
                return item;
            });
        }
        if (raw.env !== undefined) {
            config.env = normalizeStringMap(raw.env, `mcpServers.${name}.env`);
        }
        if (typeof raw.cwd === "string" && raw.cwd.trim()) {
            config.cwd = expandHomePath(raw.cwd.trim());
        }
        return config;
    }

    const url = String(raw.url).trim();
    try {
        new URL(url);
    } catch {
        throw new Error(`mcpServers.${name}.url is not a valid URL`);
    }

    const config: UrlMcpServerConfig = { url };
    if (raw.headers !== undefined) {
        config.headers = normalizeStringMap(raw.headers, `mcpServers.${name}.headers`);
    }
    return config;
}

/**
 * @param value - Raw map
 * @param label - Error label
 * @returns String-to-string map
 */
function normalizeStringMap(value: unknown, label: string): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry !== "string") {
            throw new Error(`${label}.${key} must be a string`);
        }
        result[key] = entry;
    }
    return result;
}
