import type { CapabilitySourceId } from "../config/user-config.js";
import type { UserMcpConfig } from "../config/user-mcp.js";
import type { SkillRoot } from "../skills/registry.js";

export interface CapabilityContext {
    homeDirectory: string;
    primaryWorkspace: string;
    workspaceRoots: string[];
}

export interface CapabilityWatchTarget {
    key: string;
    directory: string;
    fileName?: string;
    recursiveWhenExact: boolean;
    /** Optional feature gate so MCP-only / Skills-only sources do not watch unrelated files. */
    kind?: "mcp" | "skills" | "both";
}

export interface CapabilityProviderLoadResult {
    config: UserMcpConfig;
    warnings?: string[];
}

export interface CapabilitySourceDetection {
    source: CapabilitySourceId;
    label: string;
    detected: boolean;
    mcp: boolean;
    skills: boolean;
    detail?: string;
}

export interface CapabilityProvider {
    id: CapabilitySourceId;
    label: string;
    supportsMcp: boolean;
    supportsSkills: boolean;
    detect(context: CapabilityContext): Promise<CapabilitySourceDetection>;
    loadMcp?(context: CapabilityContext): Promise<CapabilityProviderLoadResult>;
    skillRoots?(context: CapabilityContext): SkillRoot[];
    watchTargets?(context: CapabilityContext): CapabilityWatchTarget[];
}
