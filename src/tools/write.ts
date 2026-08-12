import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PermissionManager } from "../permissions/manager.js";
import { registerTool } from "../lib/tool/log.js";
import { withToolAuth, writeAnnotations } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { buildMutationDiff } from "../lib/util/mutation-diff.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

export function registerWriteTool(
    server: McpServer,
    scope: ToolScopeProvider,
    permissions: PermissionManager,
): void {
    registerTool(
        server,
        "write",
        withToolAuth({
            title: "Write file",
            description:
                "Create or completely overwrite a file. Relative paths use the primary workspace; absolute paths and symlink targets outside registered workspaces trigger lightweight user approval. Use for new files or full rewrites; prefer edit for small targeted changes.",
            inputSchema: {
                path: z.string().describe("Workspace-relative or absolute file path."),
                content: z.string().describe("Full file contents to write."),
            },
            outputSchema: {
                path: z.string(),
                bytes: z.number().int(),
                filesChanged: z.number().int(),
                diff: z.string(),
                diffTruncated: z.boolean(),
            },
            annotations: writeAnnotations,
        }),
        async ({ path: filePath, content }) => {
            try {
                const { project } = scope();
                const absolutePath = project.resolveExternalPath(filePath);
                await permissions.authorize({
                    capability: "write",
                    targets: [absolutePath],
                    scope: project.writePermissionScope(absolutePath),
                    reason: `写入文件 ${filePath}`,
                });
                return await project.lock.runExclusive(async () => {
                    const before = await readFile(absolutePath, "utf8").catch(
                        (error: NodeJS.ErrnoException) => {
                            if (error.code === "ENOENT") return null;
                            throw error;
                        },
                    );
                    const mutation = buildMutationDiff(filePath, before, content);
                    await mkdir(dirname(absolutePath), { recursive: true });
                    await writeFile(absolutePath, content, "utf8");
                    const bytes = Buffer.byteLength(content, "utf8");
                    return okResult(`Wrote ${filePath} (${bytes} bytes); bounded diff included.`, {
                        path: filePath,
                        bytes,
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
