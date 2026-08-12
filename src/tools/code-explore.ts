import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, relative, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { ProjectContext } from "../config/project.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { registerTool } from "../lib/tool/log.js";
import { openWorldAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult, resultText } from "../lib/tool/result.js";
import { queryToSearchPattern, rankMatchesByFile } from "../lib/search/query-relevance.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

export function registerCodeExploreTool(
    server: McpServer,
    scope: ToolScopeProvider,
    hub: DownstreamMcpHub,
): void {
    registerTool(
        server,
        "code_explore",
        withToolAuth({
            title: "Explore code relationships",
            description:
                "Explore code for a symbol/flow question. Uses the imported codegraph MCP when both a CodeGraph index and codegraph_explore tool are available; otherwise falls back to bounded workspace_search-style matches.",
            inputSchema: {
                query: z.string().min(1).max(4_000),
                project_path: z.string().optional(),
                max_files: z.number().int().min(1).max(30).optional(),
            },
            outputSchema: {
                source: z.enum(["codegraph", "workspace_search"]),
                projectPath: z.string(),
                text: z.string(),
                matches: z.array(
                    z.object({
                        path: z.string(),
                        line: z.number().int(),
                        column: z.number().int(),
                        text: z.string(),
                        kind: z.enum(["match", "context"]),
                    }),
                ),
                fallbackReason: z.string().nullable(),
            },
            annotations: openWorldAnnotations,
        }),
        async ({ query, project_path: projectPath, max_files: maxFiles }) => {
            try {
                const { project, workspace } = scope();
                const selection = await selectCodegraphProject(project, workspace, query, projectPath);
                const codegraph = hub.listServers().find(
                    (item) => item.name === "codegraph" && item.status === "ready",
                );
                let fallbackReason = selection.reason;

                if (selection.absolute && codegraph) {
                    try {
                        const tools = await hub.listTools("codegraph");
                        if (tools.items.some((tool) => tool.name === "codegraph_explore")) {
                            const result = await hub.callTool("codegraph", "codegraph_explore", {
                                query,
                                projectPath: selection.absolute,
                                maxFiles: maxFiles ?? 12,
                            });
                            if (result.isError !== true) {
                                return okResult("CodeGraph exploration completed.", {
                                    source: "codegraph" as const,
                                    projectPath: selection.relative,
                                    text: clipText(resultText(result), 100_000),
                                    matches: [],
                                    fallbackReason: null,
                                });
                            }
                            fallbackReason = resultText(result) || "codegraph_explore returned an error";
                        } else {
                            fallbackReason = "codegraph MCP does not expose codegraph_explore";
                        }
                    } catch (error) {
                        fallbackReason = error instanceof Error ? error.message : String(error);
                    }
                } else if (!codegraph) {
                    fallbackReason = fallbackReason ?? "codegraph MCP is not ready";
                }

                const target = projectPath?.trim() || selection.relative || ".";
                const search = await workspace.search({
                    pattern: queryToSearchPattern(query),
                    path: target,
                    caseInsensitive: true,
                    maxMatches: 240,
                });
                const rankedFiles = rankMatchesByFile(query, search.matches, maxFiles ?? 12, 3);
                const matches = rankedFiles.flatMap((item) => item.matches);
                const text = rankedFiles
                    .map((file) => {
                        const header = `${file.path} (coverage=${file.coverage}, score=${file.score})`;
                        const evidence = file.matches
                            .map((match) => `  ${match.line}:${match.column}: ${match.text}`)
                            .join("\n");
                        return `${header}\n${evidence}`;
                    })
                    .join("\n");
                return okResult(
                    `CodeGraph unavailable; ranked ${rankedFiles.length} relevant file(s) from ${search.matches.length} structured search candidate(s).`,
                    {
                        source: "workspace_search" as const,
                        projectPath: target,
                        text,
                        matches,
                        fallbackReason: fallbackReason ?? "no applicable CodeGraph index",
                    },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );
}

async function selectCodegraphProject(
    project: ProjectContext,
    workspace: WorkspaceRegistry,
    query: string,
    requestedPath?: string,
): Promise<{ absolute?: string; relative: string; reason?: string }> {
    if (requestedPath?.trim()) {
        const absolute = project.resolvePath(requestedPath.trim());
        const workspaceRoot = containingWorkspaceRoot(project, absolute);
        if (workspaceRoot && hasCodegraphAtOrAbove(workspaceRoot, absolute)) {
            return { absolute, relative: project.displayPath(absolute) };
        }
        return {
            relative: requestedPath.trim(),
            reason: `no .codegraph index applies to ${requestedPath.trim()}`,
        };
    }

    if (existsSync(join(project.root, ".codegraph"))) {
        return { absolute: project.root, relative: "." };
    }

    const indexed = (await workspace.listProjects(3)).filter((item) => item.codegraph);
    if (indexed.length === 1) {
        return {
            absolute: project.resolvePath(indexed[0]!.path),
            relative: indexed[0]!.path,
        };
    }
    const normalized = query.toLowerCase();
    const named = indexed.find((item) => normalized.includes(item.name.toLowerCase()));
    if (named) {
        return { absolute: project.resolvePath(named.path), relative: named.path };
    }
    return {
        relative: ".",
        reason:
            indexed.length > 1
                ? `multiple CodeGraph projects are available (${indexed.map((item) => item.path).join(", ")}); specify project_path`
                : "no CodeGraph index discovered under registered workspaces",
    };
}

function containingWorkspaceRoot(project: ProjectContext, candidate: string): string | undefined {
    return project.roots
        .filter((root) => isInside(root, candidate))
        .sort((left, right) => right.length - left.length)[0];
}

function hasCodegraphAtOrAbove(projectRoot: string, candidate: string): boolean {
    let current = candidate;
    if (!isInside(projectRoot, current)) return false;

    while (isInside(projectRoot, current)) {
        if (existsSync(join(current, ".codegraph"))) return true;
        if (current === projectRoot) break;
        const parent = dirname(current);
        if (parent === current) break;
        current = parent;
    }
    return false;
}

function isInside(root: string, candidate: string): boolean {
    const relationship = relative(root, candidate);
    return (
        relationship === "" ||
        (!isAbsolute(relationship) &&
            relationship !== ".." &&
            !relationship.startsWith(`..${sep}`))
    );
}

function clipText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    const half = Math.floor(maxChars / 2);
    return `${value.slice(0, half)}\n... code exploration truncated ...\n${value.slice(-half)}`;
}
