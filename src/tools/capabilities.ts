import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CapabilityManager } from "../capabilities/manager.js";
import { reloadCapabilities } from "../capabilities/runtime.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { SkillRegistry } from "../skills/registry.js";
import { registerTool } from "../lib/tool/log.js";
import { operationalAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";

const sourceDiagnosticSchema = z.object({
    source: z.enum(["agents", "codex", "claude"]),
    enabled: z.boolean(),
    mcpEnabled: z.boolean(),
    skillsEnabled: z.boolean(),
    mcpCount: z.number().int(),
    skillCount: z.number().int(),
    warnings: z.array(z.string()),
});

export function registerCapabilityTools(
    server: McpServer,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
    capabilities?: CapabilityManager,
): void {
    registerTool(
        server,
        "capabilities_reload",
        withToolAuth({
            title: "Reload external capabilities",
            description:
                "Re-read enabled external MCP and Skill sources in place. Existing parent MCP HTTP sessions remain connected; configured startup-only mode affects automatic watching, not this explicit reload.",
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
                sources: z.array(sourceDiagnosticSchema),
            },
            annotations: operationalAnnotations,
        }),
        async () => {
            if (!capabilities) {
                return errorResult("External capability reload is unavailable in this embedded server instance.");
            }
            try {
                const result = await reloadCapabilities(capabilities, hub, skills);
                const sources = capabilities.getDiagnostics(skills);
                return okResult(
                    `Reloaded external capabilities: ${result.mcp.ready} MCP ready, ${result.mcp.error} unavailable, ${result.skills.count} skills.`,
                    { ...result, sources },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}
