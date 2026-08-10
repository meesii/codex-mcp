import { runSubprocess } from "./lib/subprocess.js";
import {
    assertServerName,
    loadUserMcpOverrides,
    normalizeMcpServerEntry,
    type McpServerConfig,
    type UserMcpConfig,
} from "./user-mcp-config.js";

const CODEX_MCP_LIST_MAX_BYTES = 8 * 1024 * 1024;
const CODEX_MCP_LIST_TIMEOUT_MS = 15_000;

/** Load enabled MCP servers from Codex, then apply optional codex-mcp overrides. */
export async function loadMergedMcpConfig(): Promise<UserMcpConfig> {
    return mergeMcpConfigs(await loadCodexMcpConfig(), loadUserMcpOverrides());
}

/** @internal Apply codex-mcp additions/overrides on top of imported Codex MCPs. */
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

/** Load the normalized MCP list emitted by the local Codex CLI. */
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
            `Unable to import Codex MCP configuration via \`codex mcp list --json\`: ${
                error instanceof Error ? error.message : String(error)
            }`,
        );
    }
    if (result.truncated) {
        throw new Error(
            `Codex MCP list exceeded ${CODEX_MCP_LIST_MAX_BYTES} bytes; refusing partial JSON`,
        );
    }
    if (result.exitCode !== 0) {
        const detail = result.stderr.trim() || `exit code ${result.exitCode ?? "unknown"}`;
        throw new Error(`Unable to import Codex MCP configuration: ${detail}`);
    }

    let raw: unknown;
    try {
        raw = JSON.parse(result.stdout) as unknown;
    } catch {
        throw new Error("Codex MCP list returned invalid JSON.");
    }
    return normalizeCodexMcpList(raw);
}

/** @internal Normalize `codex mcp list --json` without exposing secret values. */
export function normalizeCodexMcpList(
    raw: unknown,
    env: NodeJS.ProcessEnv = process.env,
): UserMcpConfig {
    if (!Array.isArray(raw)) {
        throw new Error("Codex MCP list must be an array");
    }

    const mcpServers: Record<string, McpServerConfig> = {};
    for (const item of raw) {
        if (!item || typeof item !== "object" || Array.isArray(item)) {
            throw new Error("Codex MCP entry must be an object");
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
                        `Codex MCP ${name} requires environment variable ${envName} for HTTP header ${header}`,
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
                            `Codex MCP ${name} requires environment variable ${envName} for bearer authentication`,
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

        throw new Error(`Codex MCP ${name} uses unsupported transport type ${type}`);
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
        throw new Error("Codex MCP timeout must be a positive number");
    }
    return Math.ceil(value * 1000);
}

function requireObject(value: unknown, label: string): Record<string, unknown> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    return value as Record<string, unknown>;
}

function requireString(value: unknown, label: string): string {
    if (typeof value !== "string" || !value.trim()) {
        throw new Error(`${label} must be a non-empty string`);
    }
    return value.trim();
}

function normalizeStringArray(value: unknown, label: string): string[] {
    if (value === undefined || value === null) return [];
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value.map((item, index) => {
        if (typeof item !== "string") {
            throw new Error(`${label}[${index}] must be a string`);
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
            throw new Error(`${label}.${key} must be a string`);
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
