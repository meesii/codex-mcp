import { existsSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import {
    loadUserConfig,
    type CapabilitySourceId,
    type UserConfig,
} from "../config/user-config.js";
import { loadUserMcpOverrides, type McpServerConfig, type UserMcpConfig } from "../config/user-mcp.js";
import { SkillRegistry, type SkillRoot } from "../skills/registry.js";
import { resolveCapabilitiesConfig, type ResolvedCapabilitiesConfig } from "./config.js";
import type {
    CapabilityContext,
    CapabilityProvider,
    CapabilitySourceDetection,
    CapabilityWatchTarget,
} from "./provider.js";
import { agentsCapabilityProvider } from "./providers/agents.js";
import { claudeCapabilityProvider } from "./providers/claude.js";
import { codexCapabilityProvider } from "./providers/codex.js";

export interface CapabilitySourceDiagnostic {
    source: CapabilitySourceId;
    enabled: boolean;
    mcpEnabled: boolean;
    skillsEnabled: boolean;
    mcpCount: number;
    skillCount: number;
    warnings: string[];
}

export interface CapabilityManagerOptions {
    homeDirectory?: string;
    loadConfig?: () => UserConfig;
    providers?: CapabilityProvider[];
}

const DEFAULT_PROVIDERS: CapabilityProvider[] = [
    agentsCapabilityProvider,
    codexCapabilityProvider,
    claudeCapabilityProvider,
];

export class CapabilityManager {
    private readonly homeDirectory: string;
    private readonly loadConfig: () => UserConfig;
    private readonly providers: CapabilityProvider[];
    private readonly lastMcpCounts = new Map<CapabilitySourceId, number>();
    private readonly lastWarnings = new Map<CapabilitySourceId, string[]>();
    private readonly lastProviderConfigs = new Map<CapabilitySourceId, UserMcpConfig>();
    private lastSkillCounts = new Map<CapabilitySourceId, number>();

    constructor(
        private readonly primaryWorkspace: string,
        options: CapabilityManagerOptions = {},
    ) {
        this.homeDirectory = options.homeDirectory ?? homedir();
        this.loadConfig = options.loadConfig ?? loadUserConfig;
        this.providers = options.providers ?? DEFAULT_PROVIDERS;
    }

    getConfig(): ResolvedCapabilitiesConfig {
        return resolveCapabilitiesConfig(this.loadConfig().capabilities);
    }

    getContext(): CapabilityContext {
        const user = this.loadConfig();
        const workspaceRoots = [this.primaryWorkspace, ...(user.workspaces ?? [])]
            .map((root) => resolve(root))
            .filter((root, index, all) => all.indexOf(root) === index)
            .filter(isDirectory);
        if (!workspaceRoots.includes(resolve(this.primaryWorkspace))) {
            workspaceRoots.unshift(resolve(this.primaryWorkspace));
        }
        return {
            homeDirectory: this.homeDirectory,
            primaryWorkspace: resolve(this.primaryWorkspace),
            workspaceRoots,
        };
    }

    async detectSources(): Promise<CapabilitySourceDetection[]> {
        const context = this.getContext();
        return await Promise.all(this.providers.map((provider) => provider.detect(context)));
    }

    createSkillRegistry(): SkillRegistry {
        const registry = SkillRegistry.discover(this.buildSkillRoots());
        this.captureSkillCounts(registry);
        return registry;
    }

    refreshSkills(registry: SkillRegistry): { generation: number; count: number } {
        registry.setRoots(this.buildSkillRoots());
        const result = registry.refresh();
        this.captureSkillCounts(registry);
        return result;
    }

    async loadMcpConfig(): Promise<UserMcpConfig> {
        const context = this.getContext();
        const resolved = this.getConfig();
        const providerConfigs = new Map<CapabilitySourceId, UserMcpConfig>();
        this.lastMcpCounts.clear();
        this.lastWarnings.clear();

        for (const provider of this.providers) {
            const sourceConfig = resolved.sources[provider.id];
            if (!sourceConfig.enabled || !sourceConfig.mcp || !provider.supportsMcp || !provider.loadMcp) {
                this.lastMcpCounts.set(provider.id, 0);
                this.lastProviderConfigs.delete(provider.id);
                continue;
            }
            try {
                const loaded = await provider.loadMcp(context);
                providerConfigs.set(provider.id, loaded.config);
                this.lastProviderConfigs.set(provider.id, loaded.config);
                this.lastMcpCounts.set(provider.id, Object.keys(loaded.config.mcpServers).length);
                if (loaded.warnings?.length) this.lastWarnings.set(provider.id, [...loaded.warnings]);
            } catch (error) {
                const cached = this.lastProviderConfigs.get(provider.id);
                if (cached) providerConfigs.set(provider.id, cached);
                this.lastMcpCounts.set(provider.id, cached ? Object.keys(cached.mcpServers).length : 0);
                const detail = error instanceof Error ? error.message : String(error);
                this.lastWarnings.set(provider.id, [
                    cached ? `${detail} (keeping last successful MCP configuration)` : detail,
                ]);
            }
        }

        const mcpServers: Record<string, McpServerConfig> = {};
        const owner = new Map<string, CapabilitySourceId>();
        // Merge low -> high so the first item in priority wins deterministically.
        for (const source of [...resolved.priority].reverse()) {
            const config = providerConfigs.get(source);
            if (!config) continue;
            for (const [name, server] of Object.entries(config.mcpServers)) {
                const previous = owner.get(name);
                if (previous && previous !== source) {
                    const warnings = this.lastWarnings.get(source) ?? [];
                    warnings.push(`MCP ${name} from ${source} overrides the same name from ${previous}`);
                    this.lastWarnings.set(source, warnings);
                }
                mcpServers[name] = server;
                owner.set(name, source);
            }
        }

        // codex-mcp's own mcp.json remains the explicit highest-priority override layer.
        const overrides = loadUserMcpOverrides();
        for (const name of overrides.disabledServers) delete mcpServers[name];
        Object.assign(mcpServers, overrides.mcpServers);
        return { mcpServers };
    }

    getWatchTargets(): CapabilityWatchTarget[] {
        const resolved = this.getConfig();
        if (resolved.sync !== "watch") return [];
        const context = this.getContext();
        const targets: CapabilityWatchTarget[] = [
            {
                key: "codex-mcp-user-config",
                directory: join(this.homeDirectory, ".codex-mcp"),
                fileName: "config.json",
                recursiveWhenExact: false,
            },
            {
                key: "codex-mcp-mcp-overrides",
                directory: join(this.homeDirectory, ".codex-mcp"),
                fileName: "mcp.json",
                recursiveWhenExact: false,
            },
        ];
        for (const provider of this.providers) {
            const sourceConfig = resolved.sources[provider.id];
            if (!sourceConfig.enabled || !provider.watchTargets) continue;
            if (!sourceConfig.mcp && !sourceConfig.skills) continue;
            for (const target of provider.watchTargets(context)) {
                if (target.kind === "mcp" && !sourceConfig.mcp) continue;
                if (target.kind === "skills" && !sourceConfig.skills) continue;
                if (target.kind === "both" && !sourceConfig.mcp && !sourceConfig.skills) continue;
                targets.push(target);
            }
        }
        const deduped = new Map<string, CapabilityWatchTarget>();
        for (const target of targets) deduped.set(target.key, target);
        return [...deduped.values()];
    }

    getDiagnostics(skills?: SkillRegistry): CapabilitySourceDiagnostic[] {
        if (skills) this.captureSkillCounts(skills);
        const resolved = this.getConfig();
        return resolved.priority.map((source) => ({
            source,
            enabled: resolved.sources[source].enabled,
            mcpEnabled: resolved.sources[source].mcp,
            skillsEnabled: resolved.sources[source].skills,
            mcpCount: this.lastMcpCounts.get(source) ?? 0,
            skillCount: this.lastSkillCounts.get(source) ?? 0,
            warnings: [...(this.lastWarnings.get(source) ?? [])],
        }));
    }

    private buildSkillRoots(): SkillRoot[] {
        const context = this.getContext();
        const resolved = this.getConfig();
        const rootsBySource = new Map<CapabilitySourceId, SkillRoot[]>();
        for (const provider of this.providers) {
            const sourceConfig = resolved.sources[provider.id];
            if (!sourceConfig.enabled || !sourceConfig.skills || !provider.supportsSkills || !provider.skillRoots) {
                rootsBySource.set(provider.id, []);
                continue;
            }
            rootsBySource.set(provider.id, provider.skillRoots(context));
        }
        return resolved.priority.flatMap((source) => rootsBySource.get(source) ?? []);
    }

    private captureSkillCounts(registry: SkillRegistry): void {
        const counts = new Map<CapabilitySourceId, number>();
        for (const item of registry.list()) counts.set(item.source, (counts.get(item.source) ?? 0) + 1);
        this.lastSkillCounts = counts;
    }
}

function isDirectory(pathValue: string): boolean {
    try {
        return existsSync(pathValue) && statSync(pathValue).isDirectory();
    } catch {
        return false;
    }
}
