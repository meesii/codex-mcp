import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { SkillRegistry } from "../skills/registry.js";

/** External capabilities visible to one tool call. */
export interface CapabilityToolScope {
    hub: DownstreamMcpHub;
    skills: SkillRegistry;
}

export type CapabilityToolScopeProvider = () => Promise<CapabilityToolScope>;
