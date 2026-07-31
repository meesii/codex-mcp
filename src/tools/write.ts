import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { withNoAuth, writeAnnotations } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

/**
 * Register the `write` tool.
 *
 * @param server - MCP server instance
 * @param project - Bound project context
 */
export function registerWriteTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "write",
        withNoAuth({
            title: "Write file",
            description:
                "Create or completely overwrite a file. Use for new files or full rewrites; prefer edit for small targeted changes to existing files. Do not use bash redirection/heredoc to write source.",
            inputSchema: {
                path: z.string().describe("File path relative to the project root."),
                content: z.string().describe("Full file contents to write."),
            },
            outputSchema: {
                path: z.string(),
                bytes: z.number().int(),
            },
            annotations: writeAnnotations,
        }),
        async ({ path: filePath, content }) => {
            try {
                return await project.lock.runExclusive(async () => {
                    const absolutePath = project.resolvePath(filePath);
                    await mkdir(dirname(absolutePath), { recursive: true });
                    await writeFile(absolutePath, content, "utf8");
                    const bytes = Buffer.byteLength(content, "utf8");
                    return okResult(`Wrote ${filePath} (${bytes} bytes).`, {
                        path: filePath,
                        bytes,
                    });
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
