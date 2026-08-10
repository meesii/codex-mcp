#!/usr/bin/env node
import { ensureManagedTools } from "./managed-tools/install.js";
import type { ManagedToolName } from "./managed-tools/paths.js";
import { loadUserConfig } from "./user-config.js";

async function main(argv: string[]): Promise<void> {
    const command = argv[0] ?? "bootstrap";
    let tools: ManagedToolName[];

    if (command === "ripgrep") {
        tools = ["ripgrep"];
    } else if (command === "cloudflared") {
        tools = ["cloudflared"];
    } else if (command === "all") {
        tools = ["ripgrep", "cloudflared"];
    } else if (command === "bootstrap") {
        tools = ["ripgrep"];
        try {
            if (loadUserConfig().useCloudflared === true) {
                tools.push("cloudflared");
            }
        } catch {
            // Installation must not mutate or reject an existing invalid config.
            // `codex-mcp doctor` will report that separately.
        }
    } else {
        throw new Error(`未知组件安装模式：${command}`);
    }

    await ensureManagedTools(tools);
}

void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
