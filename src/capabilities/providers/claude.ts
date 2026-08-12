import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { normalizeMcpServerEntry, type McpServerConfig } from "../../config/user-mcp.js";
import { runSubprocess } from "../../lib/util/subprocess.js";
import type { SkillRoot } from "../../skills/registry.js";
import type {
    CapabilityContext,
    CapabilityProvider,
    CapabilityProviderLoadResult,
} from "../provider.js";

interface ClaudeJsonRoot {
    mcpServers?: unknown;
    projects?: unknown;
}

interface NormalizedServerSet {
    servers: Record<string, McpServerConfig>;
    warnings: string[];
}

export const claudeCapabilityProvider: CapabilityProvider = {
    id: "claude",
    label: "Claude Code",
    supportsMcp: true,
    supportsSkills: true,
    async detect(context) {
        const globalConfig = existsSync(join(context.homeDirectory, ".claude.json"));
        const personalSkills = existsSync(join(context.homeDirectory, ".claude", "skills"));
        const projectMcp = context.workspaceRoots.some((root) => existsSync(join(root, ".mcp.json")));
        const projectSkills = context.workspaceRoots.some((root) => existsSync(join(root, ".claude", "skills")));
        let command = false;
        try {
            const result = await runSubprocess("claude", ["--version"], {
                timeoutMs: 5_000,
                maxStdoutBytes: 16 * 1024,
                maxStderrBytes: 16 * 1024,
                maxTotalBytes: 32 * 1024,
            });
            command = result.exitCode === 0;
        } catch {
            command = false;
        }
        const mcp = globalConfig || projectMcp;
        const skills = personalSkills || projectSkills;
        return {
            source: "claude",
            label: "Claude Code",
            detected: command || mcp || skills,
            mcp,
            skills,
            detail: command ? "Claude Code CLI" : mcp ? "Claude MCP config" : skills ? "Claude skills" : undefined,
        };
    },
    async loadMcp(context) {
        return loadClaudeMcpConfig(context);
    },
    skillRoots(context) {
        const roots: SkillRoot[] = [
            {
                path: join(context.homeDirectory, ".claude", "skills"),
                source: "claude" as const,
                scope: "user" as const,
                respectModelInvocation: true,
            },
        ];
        context.workspaceRoots.forEach((workspaceRoot, index) => {
            roots.push({
                path: join(workspaceRoot, ".claude", "skills"),
                source: "claude" as const,
                scope: "project" as const,
                workspaceRoot,
                ...(index > 0 ? { namePrefix: `${workspaceLabel(workspaceRoot)}:` } : {}),
                respectModelInvocation: true,
            });
        });
        return roots;
    },
    watchTargets(context) {
        return [
            {
                key: "claude-user-config",
                directory: context.homeDirectory,
                fileName: ".claude.json",
                recursiveWhenExact: false,
                kind: "mcp",
            },
            {
                key: "claude-user-skills",
                directory: join(context.homeDirectory, ".claude", "skills"),
                recursiveWhenExact: true,
                kind: "skills",
            },
            ...context.workspaceRoots.flatMap((workspaceRoot, index) => [
                {
                    key: `claude-project-mcp:${index}`,
                    directory: workspaceRoot,
                    fileName: ".mcp.json",
                    recursiveWhenExact: false,
                    kind: "mcp" as const,
                },
                {
                    key: `claude-project-skills:${index}`,
                    directory: join(workspaceRoot, ".claude", "skills"),
                    recursiveWhenExact: true,
                    kind: "skills" as const,
                },
            ]),
        ];
    },
};

export function loadClaudeMcpConfig(context: CapabilityContext): CapabilityProviderLoadResult {
    const warnings: string[] = [];
    const claudeJsonPath = join(context.homeDirectory, ".claude.json");
    const claudeJson = readJsonObject(claudeJsonPath) as ClaudeJsonRoot | undefined;

    const userSet = normalizeClaudeServerContainer(claudeJson?.mcpServers, {
        label: `${claudeJsonPath} user scope`,
        cwd: context.primaryWorkspace,
    });
    warnings.push(...userSet.warnings);
    const merged: Record<string, McpServerConfig> = { ...userSet.servers };

    context.workspaceRoots.forEach((workspaceRoot, workspaceIndex) => {
        const projectPath = join(workspaceRoot, ".mcp.json");
        const projectJson = readJsonObject(projectPath);
        const projectSet = normalizeClaudeServerContainer(projectJson?.mcpServers, {
            label: `${projectPath} project scope`,
            cwd: workspaceRoot,
        });
        warnings.push(...projectSet.warnings);

        const localContainer = findLocalProjectMcpServers(claudeJson?.projects, workspaceRoot);
        const localSet = normalizeClaudeServerContainer(localContainer, {
            label: `${claudeJsonPath} local scope (${workspaceRoot})`,
            cwd: workspaceRoot,
        });
        warnings.push(...localSet.warnings);

        // Claude Code precedence inside one project is local > project > user.
        const scoped = { ...projectSet.servers, ...localSet.servers };
        for (const [name, config] of Object.entries(scoped)) {
            if (workspaceIndex === 0) {
                // The primary workspace is the process-relative default, so its local/project
                // scopes may safely override the global user-scope name exactly as Claude does.
                merged[name] = config;
                continue;
            }
            // Secondary workspace project/local MCPs are always qualified. Exposing them under
            // their raw name would silently turn a project-scoped capability into a global one.
            const qualified = `${workspaceLabel(workspaceRoot)}__${name}`;
            if (merged[qualified] === undefined) {
                merged[qualified] = config;
            } else {
                warnings.push(`Claude MCP ${name} from ${workspaceRoot} conflicts with ${qualified}; skipped`);
            }
        }
    });

    return { config: { mcpServers: merged }, ...(warnings.length > 0 ? { warnings } : {}) };
}

function normalizeClaudeServerContainer(
    value: unknown,
    options: { label: string; cwd: string },
): NormalizedServerSet {
    if (value === undefined) return { servers: {}, warnings: [] };
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        return { servers: {}, warnings: [`${options.label}: mcpServers must be an object`] };
    }
    const servers: Record<string, McpServerConfig> = {};
    const warnings: string[] = [];
    for (const [name, entry] of Object.entries(value as Record<string, unknown>)) {
        try {
            servers[name] = normalizeClaudeServer(name, entry, options.cwd);
        } catch (error) {
            warnings.push(`${options.label}: ${error instanceof Error ? error.message : String(error)}`);
        }
    }
    return { servers, warnings };
}

function normalizeClaudeServer(name: string, value: unknown, cwd: string): McpServerConfig {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`MCP ${name} must be an object`);
    }
    const raw = value as Record<string, unknown>;
    if (raw.headersHelper !== undefined) {
        throw new Error(`MCP ${name} uses headersHelper, which codex-mcp cannot safely reproduce`);
    }
    if (raw.oauth !== undefined) {
        throw new Error(`MCP ${name} uses Claude-managed OAuth, which codex-mcp does not currently import`);
    }

    const type = typeof raw.type === "string" ? raw.type.trim().toLowerCase() : undefined;
    if (type === "sse") {
        throw new Error(`MCP ${name} uses unsupported SSE transport`);
    }

    if (type === "http" || type === "streamable-http") {
        if (typeof raw.url !== "string" || !raw.url.trim()) {
            throw new Error(`MCP ${name} http transport requires url`);
        }
        return normalizeMcpServerEntry(
            name,
            {
                url: expandClaudeValue(raw.url, `MCP ${name}.url`),
                ...(raw.headers !== undefined
                    ? { headers: expandClaudeStringMap(raw.headers, `MCP ${name}.headers`) }
                    : {}),
            },
            false,
        );
    }

    if (raw.url !== undefined && type === undefined) {
        throw new Error(`MCP ${name} has url but no type; Claude Code treats this as invalid stdio config`);
    }
    if (type !== undefined && type !== "stdio") {
        throw new Error(`MCP ${name} uses unsupported transport type ${type}`);
    }
    if (typeof raw.command !== "string" || !raw.command.trim()) {
        throw new Error(`MCP ${name} stdio transport requires command`);
    }
    const args = raw.args === undefined ? undefined : expandClaudeStringArray(raw.args, `MCP ${name}.args`);
    const env = raw.env === undefined ? undefined : expandClaudeStringMap(raw.env, `MCP ${name}.env`);
    return normalizeMcpServerEntry(
        name,
        {
            command: expandClaudeValue(raw.command, `MCP ${name}.command`),
            ...(args && args.length > 0 ? { args } : {}),
            ...(env && Object.keys(env).length > 0 ? { env } : {}),
            cwd:
                typeof raw.cwd === "string" && raw.cwd.trim()
                    ? expandClaudeValue(raw.cwd, `MCP ${name}.cwd`)
                    : cwd,
        },
        false,
    );
}

function expandClaudeStringArray(value: unknown, label: string): string[] {
    if (!Array.isArray(value)) throw new Error(`${label} must be an array`);
    return value.map((item, index) => {
        if (typeof item !== "string") throw new Error(`${label}[${index}] must be a string`);
        return expandClaudeValue(item, `${label}[${index}]`);
    });
}

function expandClaudeStringMap(value: unknown, label: string): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error(`${label} must be an object`);
    }
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item !== "string") throw new Error(`${label}.${key} must be a string`);
        result[key] = expandClaudeValue(item, `${label}.${key}`);
    }
    return result;
}

function expandClaudeValue(value: string, label: string): string {
    return value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_match, name: string, fallback: string | undefined) => {
        const resolved = process.env[name];
        if (resolved !== undefined) return resolved;
        if (fallback !== undefined) return fallback;
        throw new Error(`${label} references missing environment variable ${name}`);
    });
}

function findLocalProjectMcpServers(projects: unknown, workspaceRoot: string): unknown {
    if (!projects || typeof projects !== "object" || Array.isArray(projects)) return undefined;
    const target = comparablePath(workspaceRoot);
    for (const [projectPath, projectValue] of Object.entries(projects as Record<string, unknown>)) {
        if (comparablePath(projectPath) !== target) continue;
        if (!projectValue || typeof projectValue !== "object" || Array.isArray(projectValue)) return undefined;
        return (projectValue as Record<string, unknown>).mcpServers;
    }
    return undefined;
}

function comparablePath(value: string): string {
    const absolute = resolve(value);
    let normalized = absolute;
    try {
        normalized = realpathSync.native(absolute);
    } catch {
        // Claude may keep stale project entries; compare their normalized absolute path.
    }
    return process.platform === "win32" ? normalized.toLowerCase() : normalized;
}

function readJsonObject(path: string): Record<string, unknown> | undefined {
    if (!existsSync(path)) return undefined;
    let raw: unknown;
    try {
        raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
        throw new Error(`Invalid Claude config ${path}: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
        throw new Error(`Invalid Claude config ${path}: root must be an object`);
    }
    return raw as Record<string, unknown>;
}

function workspaceLabel(workspaceRoot: string): string {
    const canonical = comparablePath(workspaceRoot);
    const base = basename(canonical).replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "workspace";
    const suffix = createHash("sha1").update(canonical).digest("hex").slice(0, 6);
    return `${base}-${suffix}`;
}
