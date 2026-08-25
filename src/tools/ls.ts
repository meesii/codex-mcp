import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

const MAX_DIRECTORY_ENTRIES = 2_000;

export function registerLsTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(
        server,
        "ls",
        withToolAuth({
            title: "List directory",
            description: "List a single directory without recursion.",
            inputSchema: {
                path: z
                    .string()
                    .optional()
                    .describe("Workspace-relative or absolute directory path (default .)."),
            },
            outputSchema: {
                path: z.string(),
                text: z.string(),
                count: z.number().int(),
                entries: z.array(z.object({ name: z.string(), type: z.enum(["directory", "file"]), size: z.number().int().optional() })),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path: dirPath }) => {
            try {
                const { project } = scope();
                const absolutePath = project.resolvePath(dirPath ?? ".");
                const info = await stat(absolutePath);
                if (!info.isDirectory()) {
                    return errorResult(`Not a directory: ${dirPath ?? "."}`);
                }

                const entries = await readdir(absolutePath, { withFileTypes: true });
                const items = await Promise.all(entries.slice(0, MAX_DIRECTORY_ENTRIES).map(async (entry) => {
                    const isDirectory = entry.isDirectory();
                    const entryInfo = isDirectory ? undefined : await stat(join(absolutePath, entry.name));
                    return { name: entry.name, type: isDirectory ? "directory" as const : "file" as const, ...(entryInfo ? { size: entryInfo.size } : {}) };
                }));
                items.sort((a, b) => a.type === b.type ? a.name.localeCompare(b.name) : a.type === "directory" ? -1 : 1);
                const text = items.map((item) => `${item.type === "directory" ? "[dir] " : "      "}${item.name}`).join("\n") || "(empty)";
                return okResult(text, { text, path: dirPath ?? ".", count: items.length, entries: items });
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );
}
