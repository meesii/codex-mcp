import { runSubprocess } from "../lib/util/subprocess.js";
import {
    assertServerName,
    loadUserMcpOverrides,
    normalizeMcpServerEntry,
    type McpServerConfig,
    type UserMcpConfig,
} from "./user-mcp.js";

const CODEX_MCP_LIST_MAX_BYTES = 8 * 1024 * 1024;
const CODEX_MCP_LIST_TIMEOUT_MS = 60_000;

export async function loadMergedMcpConfig(): Promise<UserMcpConfig> {
    return mergeMcpConfigs(await loadCodexMcpConfig(), loadUserMcpOverrides());
}

export function mergeMcpConfigs(
    codex: UserMcpConfig,
    overrides: ReturnType<typeof loadUserMcpOverrides>,
): UserMcpConfig {
    const mcpServers: Record<string, McpServerConfig> = { ...codex.mcpServers };
    for (const name of overrides.disabledServers) {
        delete mcpServers[name];
    }
    Object.assign(mcpServers, overrides.mcpServers);
    return { mcpServers };
}

export async function loadCodexMcpConfig(): Promise<UserMcpConfig> {
    let result;
    try {
        result = await runSubprocess("codex", ["mcp", "list", "--json"], {
            timeoutMs: CODEX_MCP_LIST_TIMEOUT_MS,
            maxStdoutBytes: CODEX_MCP_LIST_MAX_BYTES,
            maxStderrBytes: 256 * 1024,
            maxTotalBytes: CODEX_MCP_LIST_MAX_BYTES + 256 * 1024,
        });
    } catch (error) {
        if ((error as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
            return { mcpServers: {} };
        }
        throw new Error(
            `读取 Codex 的 MCP 配置失败（执行 \`codex mcp list --json\` 时出错）：${
                error instanceof Error ? error.message : String(error)
            }。请先确认 Codex CLI 能正常运行`,
        );
    }
    if (result.truncated) {
        throw new Error(
            `Codex 返回的 MCP 列表超过 ${CODEX_MCP_LIST_MAX_BYTES} 字节，为避免读取到不完整配置，已停止导入`,
        );
    }
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || `退出代码 ${result.exitCode ?? "未知"}`;
        throw new Error(`读取 Codex 的 MCP 配置失败：${detail}。请先运行 \`codex mcp list --json\` 检查 Codex 自身配置`);
    }

    let raw: unknown;
    try {
        raw = JSON.parse(result.stdout) as unknown;
    } catch {
        throw new Error("Codex 返回的 MCP 列表不是有效 JSON。请先运行 `codex mcp list --json` 检查 Codex 输出");
    }
    return normalizeCodexMcpList(raw);
}

export function normalizeCodexMcpList(
    raw: unknown,
    env: NodeJS.ProcessEnv = process.env,
): UserMcpConfig {
    if (!Array.isArray(raw)) {
        throw new Error("Codex 返回的 MCP 列表格式不正确：顶层应该是数组");
    }

    const mcpServers: Record<string, McpServerConfig> = {};
    for (const item of raw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Codex 返回的 MCP 列表中存在格式不正确的项目：每项都应该是对象");
        }
        const entry = item as Record<string, unknown>;
        if (entry.enabled !== true) continue;

        const name = requireString(entry.name, "Codex MCP name");
        assertServerName(name);
        const transport = requireObject(entry.transport, `Codex MCP ${name} transport`);
        const type = requireString(transport.type, `Codex MCP ${name} transport.type`);

        if (type === "stdio") {
            const command = requireString(
                transport.command,
                `Codex MCP ${name} transport.command`,
            );
            const args = normalizeStringArray(
                transport.args,
                `Codex MCP ${name} transport.args`,
            );
            const inheritedEnv = normalizeInheritedEnv(
                transport.env_vars,
                env,
                `Codex MCP ${name} transport.env_vars`,
            );
            const configuredEnv = normalizeOptionalStringMap(
                transport.env,
                `Codex MCP ${name} transport.env`,
            );
            const cwd =
                typeof transport.cwd === "string" && transport.cwd.trim()
                    ? transport.cwd.trim()
                    : undefined;
            const config = normalizeMcpServerEntry(
                name,
                {
                    command,
                    ...(args.length > 0 ? { args } : {}),
                    ...(Object.keys(inheritedEnv).length > 0 || Object.keys(configuredEnv).length > 0
                        ? { env: { ...inheritedEnv, ...configuredEnv } }
                        : {}),
                    ...(cwd ? { cwd } : {}),
                },
                false,
            );
            applyCodexRuntimeOptions(config, entry);
            mcpServers[name] = config;
            continue;
        }

        if (type === "streamable_http") {
            const url = requireString(transport.url, `Codex MCP ${name} transport.url`);
            const headers = normalizeOptionalStringMap(
                transport.http_headers,
                `Codex MCP ${name} transport.http_headers`,
            );
            const envHeaders = normalizeOptionalStringMap(
                transport.env_http_headers,
                `Codex MCP ${name} transport.env_http_headers`,
            );
            for (const [header, envName] of Object.entries(envHeaders)) {
                const value = env[envName];
                if (value === undefined) {
                    throw new Error(
                        `Codex MCP ${name} 的请求头 ${header} 需要环境变量 ${envName}，但当前环境没有设置这个变量`,
                    );
                }
                headers[header] = value;
            }

            if (typeof transport.bearer_token_env_var === "string") {
                const envName = transport.bearer_token_env_var.trim();
                if (envName) {
                    const token = env[envName];
                    if (token === undefined) {
                        throw new Error(
                            `Codex MCP ${name} 的登录令牌来自环境变量 ${envName}，但当前环境没有设置这个变量`,
                        );
                    }
                    headers.Authorization = `Bearer ${token}`;
                }
            }

            const config = normalizeMcpServerEntry(
                name,
                {
                    url,
                    ...(Object.keys(headers).length > 0 ? { headers } : {}),
                },
                false,
            );
            applyCodexRuntimeOptions(config, entry);
            mcpServers[name] = config;
            continue;
        }

        throw new Error(`Codex MCP ${name} 使用了当前不支持的连接方式：${type}`);
    }

    return { mcpServers };
}

function applyCodexRuntimeOptions(
    config: McpServerConfig,
    entry: Record<string, unknown>,
): void {
    const startupTimeoutMs = secondsToMilliseconds(entry.startup_timeout_sec);
    const toolTimeoutMs = secondsToMilliseconds(entry.tool_timeout_sec);
    if (startupTimeoutMs !== undefined) config.startupTimeoutMs = startupTimeoutMs;
    if (toolTimeoutMs !== undefined) config.toolTimeoutMs = toolTimeoutMs;
}

function secondsToMilliseconds(value: unknown): number | undefined {
    if (value === undefined || value === null) return undefined;
    if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
        throw new Error("Codex MCP 的超时时间必须是大于 0 的数字");
    }
    return Math.ceil(value * 1000);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} 必须是对象`);
    }
    return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} 必须是非空字符串`);
    }
    return value.trim();
}

function normalizeStringArray(value: unknown, label: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`${label} 必须是数组`);
    return value.map((item, index) => {
        if (typeof item !== "string") {
            throw new Error(`${label}[${index}] 必须是字符串`);
        }
        return item;
    });
}

function normalizeOptionalStringMap(
    value: unknown,
    label: string,
): Record<string, string> {
    if (value === undefined || value === null) return {};
    const object = requireObject(value, label);
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(object)) {
        if (typeof item !== "string") {
            throw new Error(`${label}.${key} 必须是字符串`);
        }
        result[key] = item;
    }
    return result;
}

function normalizeInheritedEnv(
    value: unknown,
    env: NodeJS.ProcessEnv,
    label: string,
): Record<string, string> {
    const names = normalizeStringArray(value, label);
    const result: Record<string, string> = {};
    for (const name of names) {
        const inherited = env[name];
        if (inherited !== undefined) result[name] = inherited;
    }
    return result;
}
