import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentInstructionRegistry } from "../agents/registry.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import {
    queryToSearchPattern,
    rankMatchesByFile,
    significantQueryTokens,
} from "../lib/search/query-relevance.js";

const CONTEXT_PACK_SEARCH_CANDIDATES = 80;
const CONTEXT_PACK_MAX_MATCHES = 20;
const CONTEXT_PACK_MAX_MATCHES_PER_FILE = 2;
const CONTEXT_PACK_MAX_SKILLS = 5;
const CONTEXT_PACK_MAX_MATCH_TEXT_CHARS = 800;

const projectSchema = z.object({
    name: z.string(),
    path: z.string(),
    kind: z.string(),
    branch: z.string(),
    dirty: z.boolean(),
    changedFiles: z.number().int(),
    codegraph: z.boolean(),
});

const searchMatchSchema = z.object({
    path: z.string(),
    line: z.number().int(),
    column: z.number().int(),
    text: z.string(),
    kind: z.enum(["match", "context"]),
});

export function registerWorkspaceTools(
    server: McpServer,
    workspace: WorkspaceRegistry,
    agents: AgentInstructionRegistry,
    skills: SkillRegistry,
    hub: DownstreamMcpHub,
): void {

    registerTool(
        server,
        "workspace_projects",
        withToolAuth({
            title: "List workspace projects",
            description:
                "Discover bounded Git repositories under project_root and return branch, dirty state, project kind, and CodeGraph availability.",
            inputSchema: {
                max_depth: z.number().int().min(0).max(6).optional(),
            },
            outputSchema: {
                projects: z.array(projectSchema),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ max_depth: maxDepth }) => {
            try {
                const projects = await workspace.listProjects(maxDepth ?? 3);
                return okResult(`Discovered ${projects.length} Git project(s).`, { projects });
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    registerTool(
        server,
        "workspace_search",
        withToolAuth({
            title: "Search across workspace",
            description:
                "Run a bounded ripgrep regex search across project_root or a project-relative subtree, returning structured file/line/column matches.",
            inputSchema: {
                pattern: z.string().min(1).max(4096),
                path: z.string().optional(),
                case_insensitive: z.boolean().optional(),
                max_matches: z.number().int().min(1).max(1_000).optional(),
            },
            outputSchema: {
                matches: z.array(searchMatchSchema),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({
            pattern,
            path,
            case_insensitive: caseInsensitive,
            max_matches: maxMatches,
        }) => {
            try {
                const result = await workspace.search({
                    pattern,
                    ...(path ? { path } : {}),
                    ...(caseInsensitive !== undefined ? { caseInsensitive } : {}),
                    ...(maxMatches !== undefined ? { maxMatches } : {}),
                });
                return okResult(
                    `Found ${result.matches.length}${result.truncated ? "+" : ""} workspace match(es).`,
                    result,
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    registerTool(
        server,
        "context_pack",
        withToolAuth({
            title: "Build task context pack",
            description:
                "Build a scope-focused context pack for a coding task: the relevant project, ranked file matches, applicable AGENTS.md rules, high-confidence Codex skills, and CodeGraph availability. When path is supplied, unrelated workspace projects are omitted.",
            inputSchema: {
                query: z.string().min(1).max(2_000),
                path: z.string().optional(),
            },
            outputSchema: {
                query: z.string(),
                targetPath: z.string(),
                projects: z.array(projectSchema),
                files: z.array(searchMatchSchema),
                searchTruncated: z.boolean(),
                searchError: z.string().nullable(),
                agents: z.array(
                    z.object({
                        path: z.string(),
                        source: z.enum(["global", "project"]),
                        content: z.string(),
                        truncated: z.boolean(),
                    }),
                ),
                skills: z.array(
                    z.object({
                        name: z.string(),
                        description: z.string(),
                        source: z.enum(["agents", "codex"]),
                    }),
                ),
                codegraphProjects: z.array(z.string()),
                codegraphMcpReady: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ query, path }) => {
            try {
                const searchResult = await workspace
                    .search({
                        pattern: queryToSearchPattern(query),
                        ...(path ? { path } : {}),
                        caseInsensitive: true,
                        maxMatches: CONTEXT_PACK_SEARCH_CANDIDATES,
                    })
                    .then((search) => ({ search, error: null as string | null }))
                    .catch((error: unknown) => ({
                        search: undefined,
                        error: error instanceof Error ? error.message : String(error),
                    }));

                const rankedMatches = rankContextMatches(
                    query,
                    searchResult.search?.matches ?? [],
                    CONTEXT_PACK_MAX_MATCHES,
                    CONTEXT_PACK_MAX_MATCHES_PER_FILE,
                );
                const files = rankedMatches.map((match) => ({
                    ...match,
                    text: clipText(match.text, CONTEXT_PACK_MAX_MATCH_TEXT_CHARS),
                }));
                const searchTruncated =
                    (searchResult.search?.truncated ?? false) ||
                    (searchResult.search?.matches.length ?? 0) > rankedMatches.length;
                const searchError = searchResult.error;

                const targetPath = path?.trim() || files[0]?.path || ".";
                const projects =
                    targetPath === "."
                        ? await workspace.listProjects(3)
                        : await workspace.projectsForPath(targetPath, 3);
                const applicableAgents = agents.forPath(targetPath);
                const skillMatches = rankSkills(query, skills.list()).slice(0, CONTEXT_PACK_MAX_SKILLS);
                const codegraphProjects = projects
                    .filter((item) => item.codegraph)
                    .map((item) => item.path);
                const codegraphMcpReady =
                    codegraphProjects.length > 0 &&
                    hub.listServers().some(
                        (item) => item.name === "codegraph" && item.status === "ready",
                    );

                return okResult(
                    `Built scoped context for ${targetPath}: ${projects.length} project(s), ${files.length} ranked file match(es), ${applicableAgents.length} AGENTS.md file(s), ${skillMatches.length} skill candidate(s).`,
                    {
                        query,
                        targetPath,
                        projects,
                        files,
                        searchTruncated,
                        searchError,
                        agents: applicableAgents,
                        skills: skillMatches,
                        codegraphProjects,
                        codegraphMcpReady,
                    },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

export function rankContextMatches<
    T extends { path: string; line: number; column: number; text: string },
>(
    query: string,
    matches: T[],
    maxMatches = CONTEXT_PACK_MAX_MATCHES,
    maxMatchesPerFile = CONTEXT_PACK_MAX_MATCHES_PER_FILE,
): T[] {
    const maxFiles = Math.max(1, maxMatches);
    return rankMatchesByFile(query, matches, maxFiles, maxMatchesPerFile)
        .flatMap((item) => item.matches)
        .slice(0, maxMatches);
}

function rankSkills<T extends { name: string; description: string }>(query: string, skills: T[]): T[] {
    const normalized = query.toLowerCase();
    const queryTokens = significantQueryTokens(query);
    return skills
        .map((skill) => {
            const name = skill.name.toLowerCase();
            const text = `${skill.name} ${skill.description}`.toLowerCase();
            const directNameMatch = normalized.includes(name);
            const overlap = queryTokens.filter((token) => text.includes(token)).length;
            const score = (directNameMatch ? 20 : 0) + overlap;
            return { skill, directNameMatch, overlap, score };
        })
        .filter((item) => item.directNameMatch || item.overlap >= 2)
        .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
        .map((item) => item.skill);
}

function clipText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
