import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import type { ToolScopeTryProvider } from "../server/project-router.js";

export function registerSummaryTool(server: McpServer, tryScope: ToolScopeTryProvider): void {
    registerTool(server, "summary", withToolAuth({
        title: "Round summary",
        description: "Mandatory end-of-round tool. If you used any tool from this MCP server while handling the current user request, call summary exactly once before the final response. The summary must be one short user-facing paragraph without bullets or line breaks.",
        inputSchema: {
            title: z.string().max(80).optional(),
            summary: z.string().min(1).max(600),
        },
        outputSchema: {
            text: z.string(), title: z.string(), summary: z.string(), endedAt: z.string(), workspace: z.string(),
            fileChanges: z.object({
                count: z.number().int(), additions: z.number().int(), deletions: z.number().int(),
                files: z.array(z.object({ path: z.string(), status: z.enum(["added", "deleted", "modified"]), additions: z.number().int(), deletions: z.number().int() })),
            }),
        },
        annotations: readOnlyAnnotations,
    }), async ({ title, summary }) => {
        try {
            const scope = tryScope();
            const text = summary.replace(/\s+/g, " ").trim();
            const structured = {
                text, title: title?.trim() || "本轮处理结束", summary: text,
                endedAt: new Date().toISOString(), workspace: scope?.project.root ?? "unbound",
                fileChanges: scope?.roundChanges.takeAndReset() ?? { count: 0, additions: 0, deletions: 0, files: [] },
            };
            return okResult(text, structured);
        } catch (error) {
            return { isError: true, content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }] };
        }
    });
}
