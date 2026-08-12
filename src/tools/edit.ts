import { readFile, writeFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PermissionManager } from "../permissions/manager.js";
import { registerTool } from "../lib/tool/log.js";
import { withToolAuth, writeAnnotations } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { buildMutationDiff } from "../lib/util/mutation-diff.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

export function registerEditTool(
    server: McpServer,
    scope: ToolScopeProvider,
    permissions: PermissionManager,
): void {
    registerTool(
        server,
        "edit",
        withToolAuth({
            title: "Edit file",
            description:
                "Apply a targeted code change by replacing exact old_string with new_string. Relative paths use the primary workspace; absolute paths and symlink targets outside registered workspaces trigger lightweight user approval. old_string must match exactly once.",
            inputSchema: {
                path: z.string().describe("Workspace-relative or absolute file path."),
                old_string: z
                    .string()
                    .min(1)
                    .describe("Exact non-empty text to find; must match exactly once."),
                new_string: z.string().describe("Replacement text."),
            },
            outputSchema: {
                path: z.string(),
                replaced: z.boolean(),
                filesChanged: z.number().int(),
                diff: z.string(),
                diffTruncated: z.boolean(),
            },
            annotations: writeAnnotations,
        }),
        async ({ path: filePath, old_string: oldString, new_string: newString }) => {
            try {
                const { project } = scope();
                const absolutePath = project.resolveExternalPath(filePath);
                await permissions.authorize({
                    capability: "write",
                    targets: [absolutePath],
                    scope: project.writePermissionScope(absolutePath),
                    reason: `编辑文件 ${filePath}`,
                });
                return await project.lock.runExclusive(async () => {
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
                    // Replacement must be literal: String.replace(string, string)
                    // interprets $&, $`, $' and $$ sequences in newString.
                    const next = current.replace(oldString, () => newString);
                    const mutation = buildMutationDiff(filePath, current, next);
                    await writeFile(absolutePath, next, "utf8");
                    return okResult(`Edited ${filePath}; bounded diff included.`, {
                        path: filePath,
                        replaced: true,
                        filesChanged: 1,
                        diff: mutation.diff,
                        diffTruncated: mutation.diffTruncated,
                    });
                });
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );
}
