import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";

/**
 * Register the `read` tool.
 *
 * @param server - MCP server instance
 * @param project - Bound project context
 */
export function registerReadTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "read",
        withNoAuth({
            title: "Read file",
            description:
                "Read a project file before changing or explaining it. File text is in structuredContent.content. Prefer this over bash cat/type/Get-Content.",
            inputSchema: {
                path: z.string().describe("File path relative to the project root."),
                offset: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("1-indexed line number to start from."),
                limit: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Maximum number of lines to return."),
            },
            outputSchema: {
                path: z.string(),
                content: z.string(),
                offset: z.number().int(),
                lineCount: z.number().int(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path: filePath, offset, limit }) => {
            try {
                const absolutePath = project.resolvePath(filePath);
                const raw = await readFile(absolutePath, "utf8");
                const lines = raw.split(/\r?\n/);
                const startIndex = Math.max((offset ?? 1) - 1, 0);
                const sliced =
                    limit === undefined
                        ? lines.slice(startIndex)
                        : lines.slice(startIndex, startIndex + limit);
                const content = truncateText(sliced.join("\n"));
                return okResult(`Read ${filePath} (${sliced.length} lines).`, {
                    path: filePath,
                    content,
                    offset: offset ?? 1,
                    lineCount: sliced.length,
                });
            } catch (error) {
                const message =
                    error instanceof AccessDeniedError || error instanceof Error
                        ? error.message
                        : String(error);
                return errorResult(message);
            }
        },
    );
}
