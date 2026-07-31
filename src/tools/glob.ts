import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

/**
 * Match a relative path against a simple glob (`*`, `**`, `?`).
 *
 * @param value - Relative path using `/` separators
 * @param pattern - Glob pattern
 * @returns Whether the path matches
 */
function simpleGlobMatch(value: string, pattern: string): boolean {
    const normalizedValue = value.replaceAll("\\", "/");
    const normalizedPattern = pattern.replaceAll("\\", "/");
    const patterns = new Set<string>([normalizedPattern]);
    // `**/*.txt` should also match root-level `hello.txt`
    if (normalizedPattern.startsWith("**/")) {
        patterns.add(normalizedPattern.slice(3));
    }

    for (const candidate of patterns) {
        const escaped = candidate
            .replaceAll(".", "\\.")
            .replaceAll("**/", "(.*/)?")
            .replaceAll("**", ".*")
            .replaceAll("*", "[^/]*")
            .replaceAll("?", ".");
        if (new RegExp(`^${escaped}$`, "i").test(normalizedValue)) {
            return true;
        }
    }
    return false;
}

/**
 * Recursively collect relative file paths under a root.
 *
 * @param root - Workspace root
 * @param current - Directory being walked
 * @param out - Accumulator for relative paths
 */
async function walkFiles(root: string, current: string, out: string[]): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(root, full, out);
        } else if (entry.isFile()) {
            out.push(relative(root, full).replaceAll("\\", "/"));
        }
    }
}

/**
 * List relative file paths matching a glob under root.
 *
 * Uses a Node walk (not ripgrep) so root-level files match patterns like
 * star-star/star.txt reliably across platforms.
 *
 * @param root - Workspace root
 * @param pattern - Glob pattern
 * @returns Matching relative paths (posix separators)
 */
async function listGlobFiles(root: string, pattern: string): Promise<string[]> {
    const all: string[] = [];
    await walkFiles(root, root, all);
    return all.filter((file) => simpleGlobMatch(file, pattern));
}

/**
 * Register the `glob` tool.
 *
 * @param server - MCP server instance
 * @param project - Bound project context
 */
export function registerGlobTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "glob",
        withNoAuth({
            title: "Find files by glob",
            description:
                "Find files by glob under the project root (Codex would use rg --files / Get-ChildItem; prefer this tool). Paths are in structuredContent.files.",
            inputSchema: {
                pattern: z.string().describe("Glob pattern, e.g. **/*.ts or *.txt"),
            },
            outputSchema: {
                count: z.number().int(),
                files: z.array(z.string()),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ pattern }) => {
            try {
                const files = await listGlobFiles(project.root, pattern);
                const limited = files.slice(0, 500);
                return okResult(`Found ${files.length} files.`, {
                    count: files.length,
                    files: limited,
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
