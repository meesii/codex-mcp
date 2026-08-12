import { existsSync } from "node:fs";
import { join } from "node:path";
import { loadCodexMcpConfig } from "../../config/codex-import.js";
import { runSubprocess } from "../../lib/util/subprocess.js";
import type { CapabilityProvider } from "../provider.js";

export const codexCapabilityProvider: CapabilityProvider = {
    id: "codex",
    label: "Codex",
    supportsMcp: true,
    supportsSkills: true,
    async detect(context) {
        const skills = existsSync(join(context.homeDirectory, ".codex", "skills"));
        let command = false;
        try {
            const result = await runSubprocess("codex", ["--version"], {
                timeoutMs: 5_000,
                maxStdoutBytes: 16 * 1024,
                maxStderrBytes: 16 * 1024,
                maxTotalBytes: 32 * 1024,
            });
            command = result.exitCode === 0;
        } catch {
            command = false;
        }
        return {
            source: "codex",
            label: "Codex",
            detected: command || skills,
            mcp: command,
            skills,
            detail: command ? "Codex CLI" : skills ? "Codex skills" : undefined,
        };
    },
    async loadMcp() {
        return { config: await loadCodexMcpConfig() };
    },
    skillRoots(context) {
        return [
            {
                path: join(context.homeDirectory, ".codex", "skills"),
                source: "codex",
                scope: "user",
            },
        ];
    },
    watchTargets(context) {
        return [
            {
                key: "codex-config",
                directory: join(context.homeDirectory, ".codex"),
                fileName: "config.toml",
                recursiveWhenExact: false,
                kind: "mcp",
            },
            {
                key: "codex-skills",
                directory: join(context.homeDirectory, ".codex", "skills"),
                recursiveWhenExact: true,
                kind: "skills",
            },
        ];
    },
};
