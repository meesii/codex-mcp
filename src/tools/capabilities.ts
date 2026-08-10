import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { SkillRegistry } from "../skills/registry.js";
import { reloadCodexCapabilities } from "../capabilities/runtime.js";
import { registerTool } from "../lib/tool-log.js";
import { operationalAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

/** Register an explicit refresh control alongside automatic file watching. */
export function registerCapabilityTools(
    server: McpServer,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
): void {
    registerTool(
        server,
        "capabilities_reload",
        withToolAuth({
            title: "Reload Codex capabilities",
            description:
                "Re-import local Codex MCP configuration and re-scan Codex/Agents skills in place. Existing MCP HTTP sessions remain connected.",
            inputSchema: {},
            outputSchema: {
                mcp: z.object({
                    generation: z.number().int(),
                    added: z.array(z.string()),
                    changed: z.array(z.string()),
                    removed: z.array(z.string()),
                    ready: z.number().int(),
                    error: z.number().int(),
                }),
                skills: z.object({
                    generation: z.number().int(),
                    count: z.number().int(),
                }),
            },
            annotations: operationalAnnotations,
        }),
        async () => {
            try {
                const result = await reloadCodexCapabilities(hub, skills);
                return okResult(
                    `Reloaded Codex capabilities: ${result.mcp.ready} MCP ready, ${result.mcp.error} unavailable, ${result.skills.count} skills.`,
                    { ...result },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}
