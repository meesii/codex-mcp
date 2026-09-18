import { chmodSync, existsSync, readFileSync } from "node:fs";
import { isIP } from "node:net";
import { join } from "node:path";
import { expandHomePath } from "./loader.js";
import { ensureUserConfigDirs, getUserConfigDir } from "./user-config.js";

export interface McpServerBase {
    /** When true, skip this entry entirely. */
    disabled?: boolean;
    /** Runtime connect timeout imported from Codex. */
    startupTimeoutMs?: number;
    /** Runtime tool-call timeout imported from Codex. */
    toolTimeoutMs?: number;
}

export interface StdioMcpServerConfig extends McpServerBase {
    command: string;
    args?: string[];
    env?: Record<string, string>;
    cwd?: string;
}

export interface UrlMcpServerConfig extends McpServerBase {
    url: string;
    headers?: Record<string, string>;
}

export type McpServerConfig = StdioMcpServerConfig | UrlMcpServerConfig;

export interface UserMcpConfig {
    mcpServers: Record<string, McpServerConfig>;
}

export interface UserMcpOverrides extends UserMcpConfig {
    disabledServers: string[];
}

export interface NamedMcpServer {
    name: string;
    config: McpServerConfig;
}

export function getUserMcpConfigPath(): string {
    return join(getUserConfigDir(), "mcp.json");
}

export function isStdioMcpServer(config: McpServerConfig): config is StdioMcpServerConfig {
    return "command" in config && typeof config.command === "string";
}

export function isUrlMcpServer(config: McpServerConfig): config is UrlMcpServerConfig {
    return "url" in config && typeof config.url === "string";
}

export function loadUserMcpConfig(): UserMcpConfig {
    const overrides = loadUserMcpOverrides();
    return { mcpServers: overrides.mcpServers };
}

export function loadUserMcpOverrides(): UserMcpOverrides {
    ensureUserConfigDirs();
    const path = getUserMcpConfigPath();
    if (!existsSync(path)) {
        return { mcpServers: {}, disabledServers: [] };
    }

    try {
        if (process.platform !== "win32") chmodSync(path, 0o600);
        const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
        return normalizeUserMcpOverrides(raw);
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        throw new Error(`MCP 配置文件有问题：${path}：${message}`);
    }
}

export function listEnabledMcpServers(config: UserMcpConfig): NamedMcpServer[] {
    return Object.keys(config.mcpServers)
        .sort((left, right) => left.localeCompare(right))
        .map((name) => ({ name, config: config.mcpServers[name]! }));
}

function normalizeUserMcpOverrides(raw: unknown): UserMcpOverrides {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error("MCP 配置最外层必须是对象");
    }

    const root = raw as Record<string, unknown>;
    const serversRaw = root.mcpServers;
    if (serversRaw === undefined) {
        return { mcpServers: {}, disabledServers: [] };
    }
    if (!serversRaw || typeof serversRaw !== "object" || Array.isArray(serversRaw)) {
        throw new Error("配置项 mcpServers 必须是对象");
    }

    const mcpServers: Record<string, McpServerConfig> = {};
    const disabledServers: string[] = [];
    for (const [name, entry] of Object.entries(serversRaw as Record<string, unknown>)) {
        assertServerName(name);
        if (
            entry &&
            typeof entry === "object" &&
            !Array.isArray(entry) &&
            (entry as Record<string, unknown>).disabled === true
        ) {
            disabledServers.push(name);
            continue;
        }
        mcpServers[name] = normalizeMcpServerEntry(name, entry, true);
    }

    return { mcpServers, disabledServers };
}

export function assertServerName(name: string): void {
    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
        throw new Error(
            `MCP 服务名称“${name}”格式不正确，只能使用字母、数字、下划线和短横线`,
        );
    }
}

export function normalizeMcpServerEntry(
    name: string,
    entry: unknown,
    protectSensitiveValues = true,
): McpServerConfig {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`配置项 mcpServers.${name} 必须是对象`);
    }

    const raw = entry as Record<string, unknown>;
    const hasCommand = typeof raw.command === "string" && raw.command.trim();
    const hasUrl = typeof raw.url === "string" && raw.url.trim();

    if (hasCommand && hasUrl) {
        throw new Error(`MCP 服务 ${name} 不能同时配置 command 和 url，请只选择一种连接方式`);
    }
    if (!hasCommand && !hasUrl) {
        throw new Error(`MCP 服务 ${name} 缺少连接方式：需要配置 command 或 url`);
    }

    if (hasCommand) {
        const config: StdioMcpServerConfig = {
            command: String(raw.command).trim(),
        };
        if (Array.isArray(raw.args)) {
            config.args = raw.args.map((item, index) => {
                if (typeof item !== "string") {
                    throw new Error(`配置项 mcpServers.${name}.args[${index}] 必须是字符串`);
                }
                return item;
            });
        }
        if (raw.env !== undefined) {
            config.env = normalizeStringMap(
                raw.env,
                `mcpServers.${name}.env`,
                protectSensitiveValues,
            );
        }
        if (typeof raw.cwd === "string" && raw.cwd.trim()) {
            config.cwd = expandHomePath(raw.cwd.trim());
        }
        return config;
    }

    const url = normalizeRemoteMcpUrl(String(raw.url).trim(), `mcpServers.${name}.url`);

    const config: UrlMcpServerConfig = { url };
    if (raw.headers !== undefined) {
        config.headers = normalizeStringMap(
            raw.headers,
            `mcpServers.${name}.headers`,
            protectSensitiveValues,
        );
    }
    return config;
}

function normalizeStringMap(
    value: unknown,
    label: string,
    protectSensitiveValues = false,
): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    const result: Record<string, string> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
        if (typeof entry !== "string") {
            throw new Error(`${label}.${key} 必须是字符串`);
        }
        if (protectSensitiveValues && isSensitiveConfigKey(key) && !hasEnvironmentReference(entry)) {
            throw new Error(
                `${label}.${key} 看起来包含密码、令牌或密钥。不要把敏感值直接写进配置，请改用环境变量引用，例如 \${ENV_VAR}`,
            );
        }
        result[key] = expandEnvironmentReferences(entry, `${label}.${key}`);
    }
    return result;
}

function normalizeRemoteMcpUrl(value: string, label: string): string {
    let url: URL;
    try {
        url = new URL(value);
    } catch {
        throw new Error(`${label} 不是有效 URL`);
    }
    if (url.username || url.password || url.hash) {
        throw new Error(`${label} 不能在 URL 中包含用户名、密码或 # 片段`);
    }
    const hostname = url.hostname.replace(/^\[|\]$/g, "").toLowerCase();
    const loopback =
        hostname === "localhost" ||
        hostname === "127.0.0.1" ||
        hostname === "::1";
    if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
        throw new Error(`${label} 必须使用 HTTPS；只有 localhost/127.0.0.1/::1 这类本机地址允许使用 HTTP`);
    }
    if (isIP(hostname) !== 0 && !loopback && url.protocol !== "https:") {
        throw new Error(`${label} 指向非本机 IP 时必须使用 HTTPS`);
    }
    return url.href;
}

function isSensitiveConfigKey(key: string): boolean {
    if (/^(?:authorization|cookie)$/i.test(key)) return true;
    return /(?:^|[-_])(?:token|secret|password|credential|api[-_]?key|apikey|access[-_]?key|private[-_]?key)(?:$|[-_])/i.test(
        key,
    );
}

function hasEnvironmentReference(value: string): boolean {
    return /\$\{[A-Za-z_][A-Za-z0-9_]*\}/.test(value);
}

function expandEnvironmentReferences(value: string, label: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_match, name: string) => {
        const resolved = process.env[name];
        if (resolved === undefined) {
            throw new Error(`${label} 引用了环境变量 ${name}，但当前环境没有设置这个变量`);
        }
        return resolved;
    });
}
