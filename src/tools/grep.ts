import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";
import { findRipgrep, runRipgrep } from "../lib/ripgrep.js";

async function walkFiles(root: string, current: string, out: string[]): Promise<void> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
            await walkFiles(root, full, out);
        } else if (entry.isFile()) {
            out.push(full);
        }
    }
}

/**
 * Fallback content search without ripgrep.
 *
 * @param root - Workspace root
 * @param pattern - JS RegExp source
 * @param pathGlob - Optional simple substring filter on relative path
 * @returns Matching lines
 */
async function nodeGrep(
    root: string,
    pattern: string,
    pathGlob?: string,
): Promise<string[]> {
    const regex = new RegExp(pattern);
    const files: string[] = [];
    await walkFiles(root, root, files);
    const hits: string[] = [];

    for (const file of files) {
        const rel = relative(root, file).replaceAll("\\", "/");
        if (pathGlob && !rel.includes(pathGlob.replaceAll("*", ""))) {
            // Very small fallback: treat glob as a path substring when no rg.
            if (!simpleGlobMatch(rel, pathGlob)) continue;
        }
        let content: string;
        try {
            content = await readFile(file, "utf8");
        } catch {
            continue;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
            if (regex.test(lines[index]!)) {
                hits.push(`${rel}:${index + 1}:${lines[index]}`);
            }
        }
    }

    return hits;
}

/**
 * Extremely small glob matcher for Node fallback (`*` and `**`).
 *
 * @param value - Relative path
 * @param pattern - Glob pattern
 * @returns Whether the path matches
 */
function simpleGlobMatch(value: string, pattern: string): boolean {
    const escaped = pattern
        .replaceAll(".", "\\.")
        .replaceAll("**/", "(.*/)?")
        .replaceAll("**", ".*")
        .replaceAll("*", "[^/]*")
        .replaceAll("?", ".");
    return new RegExp(`^${escaped}$`).test(value);
}

/**
 * Register the `grep` tool.
 *
 * @param server - MCP server instance
 * @param project - Bound project context
 */
export function registerGrepTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "grep",
        withNoAuth({
            title: "Search file contents",
            description:
                "Search file contents with a regex (ripgrep when available). Prefer this over bash Select-String/grep. Matches are in structuredContent.matches.",
            inputSchema: {
                pattern: z.string().describe("Regular expression pattern to search for."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional subdirectory or path scope relative to project root."),
                case_insensitive: z
                    .boolean()
                    .optional()
                    .describe("When true, search case-insensitively."),
            },
            outputSchema: {
                matchCount: z.number().int(),
                matches: z.array(z.string()),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ pattern, path: scopePath, case_insensitive: caseInsensitive }) => {
                try {
                    if (scopePath) {
                        const scoped = project.resolvePath(scopePath);
                        const info = await stat(scoped).catch(() => null);
                        if (info && !info.isDirectory() && !info.isFile()) {
                            return errorResult(`Invalid path: ${scopePath}`);
                        }
                    }

                    const rg = await findRipgrep();
                    let lines: string[] = [];

                    if (rg) {
                        const args = ["--line-number", "--no-heading", "--color", "never"];
                        if (caseInsensitive) args.push("-i");
                        args.push("--", pattern);
                        if (scopePath) args.push(scopePath);
                        else args.push(".");
                        const result = await runRipgrep(rg, args, project.root);
                        if (result.exitCode !== 0 && result.exitCode !== 1) {
                            return errorResult(
                                result.stderr || `rg failed with code ${result.exitCode}`,
                            );
                        }
                        lines = result.stdout
                            .split(/\r?\n/)
                            .map((line) => line.trimEnd())
                            .filter(Boolean);
                    } else if (caseInsensitive) {
                        lines = await nodeGrepCaseInsensitive(project.root, pattern, scopePath);
                    } else {
                        lines = await nodeGrep(project.root, pattern, scopePath);
                    }

                    const matches = lines.slice(0, 200).map((line) => truncateText(line, 2000));
                    return okResult(`Found ${lines.length} matches.`, {
                        matchCount: lines.length,
                        matches,
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

async function nodeGrepCaseInsensitive(
    root: string,
    pattern: string,
    pathGlob?: string,
): Promise<string[]> {
    const regex = new RegExp(pattern, "i");
    const files: string[] = [];
    await walkFiles(root, root, files);
    const hits: string[] = [];

    for (const file of files) {
        const rel = relative(root, file).replaceAll("\\", "/");
        if (pathGlob && !simpleGlobMatch(rel, pathGlob) && !rel.includes(pathGlob)) {
            continue;
        }
        let content: string;
        try {
            content = await readFile(file, "utf8");
        } catch {
            continue;
        }
        const lines = content.split(/\r?\n/);
        for (let index = 0; index < lines.length; index += 1) {
            if (regex.test(lines[index]!)) {
                hits.push(`${rel}:${index + 1}:${lines[index]}`);
            }
        }
    }

    return hits;
}
