import { existsSync } from "node:fs";
import { join } from "node:path";
import type { CapabilityProvider } from "../provider.js";

export const agentsCapabilityProvider: CapabilityProvider = {
    id: "agents",
    label: "Agent Skills",
    supportsMcp: false,
    supportsSkills: true,
    async detect(context) {
        const skills = existsSync(join(context.homeDirectory, ".agents", "skills"));
        return {
            source: "agents",
            label: "Agent Skills",
            detected: skills,
            mcp: false,
            skills,
            detail: skills ? "~/.agents/skills" : undefined,
        };
    },
    skillRoots(context) {
        return [
            {
                path: join(context.homeDirectory, ".agents", "skills"),
                source: "agents",
                scope: "user",
            },
        ];
    },
    watchTargets(context) {
        return [
            {
                key: "agents-skills",
                directory: join(context.homeDirectory, ".agents", "skills"),
                recursiveWhenExact: true,
                kind: "skills",
            },
        ];
    },
};
