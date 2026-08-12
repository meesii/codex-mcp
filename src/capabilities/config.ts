import type {
    CapabilitySourceConfig,
    CapabilitySourceId,
    CapabilitySyncMode,
    UserCapabilitiesConfig,
} from "../config/user-config.js";

export interface ResolvedCapabilitySourceConfig {
    enabled: boolean;
    mcp: boolean;
    skills: boolean;
}

export interface ResolvedCapabilitiesConfig {
    sync: CapabilitySyncMode;
    /** Highest-priority source first. */
    priority: CapabilitySourceId[];
    sources: Record<CapabilitySourceId, ResolvedCapabilitySourceConfig>;
}

const LEGACY_DEFAULTS: ResolvedCapabilitiesConfig = {
    sync: "watch",
    priority: ["agents", "codex", "claude"],
    sources: {
        agents: { enabled: true, mcp: false, skills: true },
        codex: { enabled: true, mcp: true, skills: true },
        claude: { enabled: false, mcp: true, skills: true },
    },
};

export function resolveCapabilitiesConfig(
    config?: UserCapabilitiesConfig,
): ResolvedCapabilitiesConfig {
    const priority = normalizePriority(config?.priority ?? LEGACY_DEFAULTS.priority);
    return {
        sync: config?.sync ?? LEGACY_DEFAULTS.sync,
        priority,
        sources: {
            agents: resolveSource("agents", config?.sources?.agents),
            codex: resolveSource("codex", config?.sources?.codex),
            claude: resolveSource("claude", config?.sources?.claude),
        },
    };
}

export function describeEnabledCapabilitySources(config: ResolvedCapabilitiesConfig): string {
    const enabled = config.priority
        .filter((source) => config.sources[source].enabled)
        .map((source) => {
            if (source === "agents") return "Agent Skills";
            if (source === "claude") return "Claude Code";
            return "Codex";
        });
    return enabled.length > 0 ? enabled.join(" + ") : "未启用";
}

function resolveSource(
    source: CapabilitySourceId,
    override?: CapabilitySourceConfig,
): ResolvedCapabilitySourceConfig {
    const defaults = LEGACY_DEFAULTS.sources[source];
    const enabled = override?.enabled ?? defaults.enabled;
    return {
        enabled,
        mcp: enabled && (override?.mcp ?? defaults.mcp),
        skills: enabled && (override?.skills ?? defaults.skills),
    };
}

function normalizePriority(priority: CapabilitySourceId[]): CapabilitySourceId[] {
    const result: CapabilitySourceId[] = [];
    for (const source of priority) {
        if (!result.includes(source)) result.push(source);
    }
    for (const source of LEGACY_DEFAULTS.priority) {
        if (!result.includes(source)) result.push(source);
    }
    return result;
}
