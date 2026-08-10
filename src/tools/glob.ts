import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { Minimatch } from "minimatch";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

const MAX_DISCOVERED_FILES = 50_000;
const MAX_RETURNED_FILES = 500;

const GLOB_OPTIONS = {
    dot: true,
    nocase: process.platform === "win32",
    nocomment: true,
    magicalBraces: true,
} as const;

interface GlobWalkState {
    candidateCount: number;
    files: string[];
}

async function walkGlobFiles(
    projectRoot: string,
    scopeRoot: string,
    current: string,
    matcher: Minimatch,
    excludes: Minimatch[],
    state: GlobWalkState,
    maxDiscoveredFiles: number,
): Promise<boolean> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;

        const full = join(current, entry.name);
        const scopeRelativePath = relative(scopeRoot, full).replaceAll("\\", "/");
        const projectRelativePath = relative(projectRoot, full).replaceAll("\\", "/");
        if (entry.isDirectory()) {
            if (matcher.negate || matcher.match(scopeRelativePath, true)) {
                if (
                    await walkGlobFiles(
                        projectRoot,
                        scopeRoot,
                        full,
                        matcher,
                        excludes,
                        state,
                        maxDiscoveredFiles,
                    )
                ) {
                    return true;
                }
            }
            continue;
        }
        if (!entry.isFile()) continue;

        const matches = matcher.match(scopeRelativePath);
        if (!matches && !matcher.negate && !matcher.match(scopeRelativePath, true)) {
            continue;
        }

        state.candidateCount += 1;
        if (matches && !excludes.some((item) => item.match(scopeRelativePath))) {
            state.files.push(projectRelativePath);
        }
        if (state.candidateCount >= maxDiscoveredFiles) return true;
    }
    return false;
}

/** @internal Exported for focused regression tests. */
export async function listGlobFiles(
    project: ProjectContext,
    pattern: string,
    maxDiscoveredFiles = MAX_DISCOVERED_FILES,
    options: { path?: string; exclude?: string[] } = {},
): Promise<{ files: string[]; scanTruncated: boolean }> {
    const matcher = new Minimatch(pattern.replaceAll("\\", "/"), GLOB_OPTIONS);
    const excludes = (options.exclude ?? []).map(
        (item) => new Minimatch(item.replaceAll("\\", "/"), GLOB_OPTIONS),
    );
    const scopeRoot = project.resolvePath(options.path?.trim() || ".");
    const state: GlobWalkState = { candidateCount: 0, files: [] };
    const scanTruncated = await walkGlobFiles(
        project.root,
        scopeRoot,
        scopeRoot,
        matcher,
        excludes,
        state,
        maxDiscoveredFiles,
    );
    return { files: state.files, scanTruncated };
}

/** Register the `glob` tool. */
export function registerGlobTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "glob",
        withToolAuth({
            title: "Find files by glob",
            description:
                "Find files by standard glob syntax with optional subtree scope, exclusion globs, and result limits. Returned paths stay project-relative.",
            inputSchema: {
                pattern: z
                    .string()
                    .min(1)
                    .max(1024)
                    .describe("Glob pattern, e.g. **/*.ts or *.txt"),
                path: z
                    .string()
                    .optional()
                    .describe("Optional project-relative subtree; pattern is evaluated relative to this scope."),
                exclude: z
                    .union([z.string(), z.array(z.string()).max(50)])
                    .optional()
                    .describe("Optional scope-relative exclusion glob(s)."),
                max_results: z.number().int().min(1).max(2_000).optional(),
            },
            outputSchema: {
                count: z.number().int(),
                files: z.array(z.string()),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ pattern, path, exclude, max_results: maxResults }) => {
            try {
                const excludes = exclude === undefined ? [] : Array.isArray(exclude) ? exclude : [exclude];
                const { files, scanTruncated } = await listGlobFiles(
                    project,
                    pattern,
                    MAX_DISCOVERED_FILES,
                    {
                        ...(path ? { path } : {}),
                        exclude: excludes,
                    },
                );
                const limited = files.slice(0, maxResults ?? MAX_RETURNED_FILES);
                const truncated = scanTruncated || files.length > limited.length;
                return okResult(
                    `Found ${files.length}${scanTruncated ? "+" : ""} files${truncated ? " (truncated)" : ""}.`,
                    {
                        count: files.length,
                        files: limited,
                        truncated,
                    },
                );
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
