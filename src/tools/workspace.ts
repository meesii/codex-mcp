import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { AgentInstructionRegistry } from "../agents/registry.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

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
});

/** Register bounded multi-repo discovery/search/context tools. */
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
                "Build a lightweight context pack for a coding task: workspace projects, relevant file matches, scoped AGENTS.md rules, matching Codex skills, and CodeGraph availability. It does not modify files or execute project code.",
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
                const projectsPromise = workspace.listProjects(3);
                const searchPromise = workspace
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
                const [projects, searchResult] = await Promise.all([projectsPromise, searchPromise]);
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
                const applicableAgents = agents.forPath(targetPath);
                const skillMatches = rankSkills(query, skills.list()).slice(0, CONTEXT_PACK_MAX_SKILLS);
                const codegraphProjects = projects
                    .filter((item) => item.codegraph)
                    .map((item) => item.path);
                const codegraphMcpReady = hub.listServers().some(
                    (item) => item.name === "codegraph" && item.status === "ready",
                );

                return okResult(
                    `Built context pack with ${projects.length} project(s), ${files.length} file match(es), ${applicableAgents.length} AGENTS.md file(s), and ${skillMatches.length} skill candidate(s).`,
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

function queryToSearchPattern(query: string): string {
    const tokens = query.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
    const unique = [...new Set(tokens.map((token) => token.toLowerCase()))].slice(0, 8);
    const selected = unique.length > 0 ? unique : [query];
    return selected.map(escapeRegex).join("|");
}

/** @internal Rank context-pack matches by query relevance while preserving file diversity. */
export function rankContextMatches<T extends { path: string; line: number; column: number; text: string }>(
    query: string,
    matches: T[],
    maxMatches = CONTEXT_PACK_MAX_MATCHES,
    maxMatchesPerFile = CONTEXT_PACK_MAX_MATCHES_PER_FILE,
): T[] {
    const normalizedQuery = query.trim().toLowerCase();
    const queryTokens = [...new Set(queryToTokens(normalizedQuery))];
    const scored = matches.map((match, index) => {
        const normalizedPath = match.path.replaceAll("\\", "/").toLowerCase();
        const fileName = normalizedPath.split("/").at(-1) ?? normalizedPath;
        const text = match.text.toLowerCase();
        let score = 0;

        if (normalizedQuery && fileName.includes(normalizedQuery)) score += 100;
        if (normalizedQuery && normalizedPath.includes(normalizedQuery)) score += 40;
        for (const token of queryTokens) {
            if (fileName.includes(token)) score += 20;
            else if (normalizedPath.includes(token)) score += 10;
            if (text.includes(token)) score += 2;
        }
        return { match, index, normalizedPath, score };
    });

    scored.sort(
        (left, right) =>
            right.score - left.score ||
            left.normalizedPath.localeCompare(right.normalizedPath) ||
            left.match.line - right.match.line ||
            left.match.column - right.match.column ||
            left.index - right.index,
    );

    const selected: T[] = [];
    const perFile = new Map<string, number>();
    for (const item of scored) {
        if (selected.length >= maxMatches) break;
        const count = perFile.get(item.normalizedPath) ?? 0;
        if (count >= maxMatchesPerFile) continue;
        perFile.set(item.normalizedPath, count + 1);
        selected.push(item.match);
    }
    return selected;
}

function rankSkills<T extends { name: string; description: string }>(query: string, skills: T[]): T[] {
    const normalized = query.toLowerCase();
    const queryTokens = new Set(queryToTokens(normalized));
    return skills
        .map((skill) => {
            const text = `${skill.name} ${skill.description}`.toLowerCase();
            let score = normalized.includes(skill.name.toLowerCase()) ? 20 : 0;
            for (const token of queryTokens) {
                if (text.includes(token)) score += 1;
            }
            return { skill, score };
        })
        .filter((item) => item.score > 0)
        .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
        .map((item) => item.skill);
}

function queryToTokens(value: string): string[] {
    return value.match(/[\p{L}\p{N}_-]{2,}/gu) ?? [];
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function clipText(value: string, maxChars: number): string {
    if (value.length <= maxChars) return value;
    return `${value.slice(0, Math.max(0, maxChars - 1))}…`;
}
