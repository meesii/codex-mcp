import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

export function registerAgentTools(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(
        server,
        "agents_for_path",
        withToolAuth({
            title: "Load scoped Codex instructions",
            description:
                "Return the global and project AGENTS.md instructions that apply to a project path. Use before modifying code under a nested directory when more-specific project instructions may exist.",
            inputSchema: {
                path: z
                    .string()
                    .optional()
                    .describe("Project-relative path; defaults to the project root."),
            },
            outputSchema: {
                path: z.string(),
                files: z.array(
                    z.object({
                        path: z.string(),
                        source: z.enum(["global", "project"]),
                        content: z.string(),
                        truncated: z.boolean(),
                    }),
                ),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path }) => {
            const requestedPath = path?.trim() || ".";
            try {
                const { agents } = scope();
                const files = agents.forPath(requestedPath);
                return okResult(
                    `Loaded ${files.length} applicable AGENTS.md instruction file(s) for ${requestedPath}.`,
                    { path: requestedPath, files },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );
}
