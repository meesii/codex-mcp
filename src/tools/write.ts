import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../config/project.js";
import { AccessDeniedError } from "../config/project.js";
import { registerTool } from "../lib/tool/log.js";
import { withToolAuth, writeAnnotations } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { buildMutationDiff } from "../lib/util/mutation-diff.js";

export function registerWriteTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "write",
        withToolAuth({
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
                filesChanged: z.number().int(),
                diff: z.string(),
                diffTruncated: z.boolean(),
            },
            annotations: writeAnnotations,
        }),
        async ({ path: filePath, content }) => {
            try {
                return await project.lock.runExclusive(async () => {
                    const absolutePath = project.resolvePath(filePath);
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
                const message =
                    error instanceof AccessDeniedError || error instanceof Error
                        ? error.message
                        : String(error);
                return errorResult(message);
            }
        },
    );
}
