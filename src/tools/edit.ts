import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { withNoAuth, writeAnnotations } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

/**
 * Register the `edit` tool (exact string replacement).
 *
 * @param server - MCP server instance
 * @param project - Bound project context
 */
export function registerEditTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "edit",
        withNoAuth({
            title: "Edit file",
            description:
                "Apply a targeted code change by replacing exact old_string with new_string (our counterpart to Codex apply_patch for small edits). Prefer this over write for existing files. old_string must match exactly once; keep it as small as possible while unique. Do not use bash/sed to edit.",
            inputSchema: {
                path: z.string().describe("File path relative to the project root."),
                old_string: z
                    .string()
                    .describe("Exact text to find; must match exactly once."),
                new_string: z.string().describe("Replacement text."),
            },
            outputSchema: {
                path: z.string(),
                replaced: z.boolean(),
            },
            annotations: writeAnnotations,
        }),
        async ({ path: filePath, old_string: oldString, new_string: newString }) => {
            try {
                return await project.lock.runExclusive(async () => {
                    const absolutePath = project.resolvePath(filePath);
                    const current = await readFile(absolutePath, "utf8");
                    const occurrences = current.split(oldString).length - 1;
                    if (occurrences === 0) {
                        return errorResult(`old_string not found in ${filePath}`);
                    }
                    if (occurrences > 1) {
                        return errorResult(
                            `old_string matched ${occurrences} times in ${filePath}; make it unique`,
                        );
                    }
                    const next = current.replace(oldString, newString);
                    await writeFile(absolutePath, next, "utf8");
                    return okResult(`Edited ${filePath}.`, {
                        path: filePath,
                        replaced: true,
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
