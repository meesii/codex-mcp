import { readdir, stat } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

/**
 * Register the `ls` tool.
 *
 * @param server - MCP server instance
 * @param project - Bound project context
 */
export function registerLsTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "ls",
        withNoAuth({
            title: "List directory",
            description:
                "List directory entries inside the project root. Prefer this over bash ls/Get-ChildItem for simple listings. Entries are in structuredContent.entries.",
            inputSchema: {
                path: z
                    .string()
                    .optional()
                    .describe("Directory path relative to project root (default .)."),
            },
            outputSchema: {
                path: z.string(),
                entries: z.array(
                    z.object({
                        name: z.string(),
                        type: z.enum(["dir", "file", "other"]),
                    }),
                ),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path: dirPath }) => {
            try {
                const absolutePath = project.resolvePath(dirPath ?? ".");
                const info = await stat(absolutePath);
                if (!info.isDirectory()) {
                    return errorResult(`Not a directory: ${dirPath ?? "."}`);
                }

                const entries = await readdir(absolutePath, { withFileTypes: true });
                const items = entries
                    .map((entry) => ({
                        name: entry.name,
                        type: (entry.isDirectory()
                            ? "dir"
                            : entry.isFile()
                              ? "file"
                              : "other") as "dir" | "file" | "other",
                    }))
                    .sort((left, right) => left.name.localeCompare(right.name));

                return okResult(`Listed ${items.length} entries in ${dirPath ?? "."}.`, {
                    path: dirPath ?? ".",
                    entries: items,
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
