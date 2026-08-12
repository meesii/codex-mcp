import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { ProjectContext } from "../config/project.js";
import { loadUserConfig, saveUserConfig } from "../config/user-config.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { CapabilityManager } from "../capabilities/manager.js";
import { reloadCapabilities } from "../capabilities/runtime.js";
import { buildWorkspaceContext } from "../workspace/context.js";
import { registerTool } from "../lib/tool/log.js";
import {
    readOnlyAnnotations,
    stateWriteAnnotations,
    withToolAuth,
    writeAnnotations,
} from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import {
    queryToSearchPattern,
    rankMatchesByFile,
    significantQueryTokens,
} from "../lib/search/query-relevance.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";
import {
    bindCurrentOwnerProject,
    type ProjectToolDeps,
} from "./projects.js";

const CONTEXT_PACK_SEARCH_CANDIDATES = 80;
const CONTEXT_PACK_MAX_MATCHES = 20;
const CONTEXT_PACK_MAX_MATCHES_PER_FILE = 2;
const CONTEXT_PACK_MAX_SKILLS = 5;
const CONTEXT_PACK_MAX_MATCH_TEXT_CHARS = 800;
const WORKSPACE_CONTROL_ACTIONS = ["roots", "add", "remove"] as const;

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

const workspaceContextGoalSchema = z.object({
    id: z.string(),
    scopePath: z.string(),
    objective: z.string(),
    status: z.string(),
    updatedAt: z.string(),
    tasks: z.object({
        total: z.number().int(),
        done: z.number().int(),
        inProgress: z.number().int(),
        blocked: z.number().int(),
        pending: z.number().int(),
    }),
    openTasks: z.array(z.object({
        id: z.string(),
        title: z.string(),
        status: z.string(),
        note: z.string().optional(),
    })),
    checkpoint: z.object({
        summary: z.string(),
        next: z.string().optional(),
        findings: z.array(z.string()),
        blockers: z.array(z.string()),
        createdAt: z.string(),
    }).nullable(),
});

const workspaceContextOutputSchema = {
    path: z.string(),
    intent: z.string(),
    projects: z.array(projectSchema),
    project: projectSchema.nullable(),
    git: z.object({
        available: z.boolean(),
        repository: z.string().nullable(),
        branch: z.string().nullable(),
        dirty: z.boolean().nullable(),
        changedFiles: z.number().int().nullable(),
        files: z.array(z.object({
            path: z.string(),
            indexStatus: z.string(),
            worktreeStatus: z.string(),
        })),
        filesTruncated: z.boolean(),
        recentCommits: z.array(z.object({
            shortHash: z.string(),
            date: z.string(),
            subject: z.string(),
        })),
        error: z.string().nullable(),
    }),
    work: z.object({
        goal: workspaceContextGoalSchema.nullable(),
        activeGoals: z.array(z.object({
            id: z.string(),
            scopePath: z.string(),
            objective: z.string(),
            status: z.string(),
            updatedAt: z.string(),
        })),
        processes: z.array(z.object({
            processId: z.number().int(),
            name: z.string().optional(),
            command: z.string(),
            cwd: z.string(),
            running: z.boolean(),
            startedAt: z.number().int(),
            wallTimeMs: z.number(),
            exitCode: z.number().int().optional(),
            signal: z.string().optional(),
        })),
    }),
    instructions: z.object({
        agents: z.array(z.object({
            path: z.string(),
            source: z.enum(["global", "project"]),
            excerpt: z.string(),
            truncated: z.boolean(),
        })),
        skills: z.array(z.object({
            name: z.string(),
            description: z.string(),
            source: z.enum(["agents", "codex", "claude"]),
            scope: z.enum(["user", "project"]).optional(),
            workspaceRoot: z.string().optional(),
        })),
    }),
    focus: z.object({
        files: z.array(z.object({
            path: z.string(),
            line: z.number().int(),
            column: z.number().int(),
            text: z.string(),
        })),
        searchTruncated: z.boolean(),
        searchError: z.string().nullable(),
        entryPoints: z.array(z.object({ path: z.string(), reason: z.string() })),
        manifest: z.object({
            path: z.string(),
            name: z.string().optional(),
            version: z.string().optional(),
            scripts: z.array(z.object({ name: z.string(), command: z.string() })),
        }).nullable(),
        codegraph: z.object({
            indexedProjects: z.array(z.string()),
            mcpReady: z.boolean(),
        }),
    }),
    warnings: z.array(z.string()),
    budget: z.object({
        maxStructuredChars: z.number().int(),
        estimatedChars: z.number().int(),
        truncated: z.boolean(),
    }),
};

/** Register bounded multi-repo discovery/search/context tools. */
export function registerWorkspaceTools(
    server: McpServer,
    scope: ToolScopeProvider,
    skills: SkillRegistry,
    hub: DownstreamMcpHub,
    capabilities?: CapabilityManager,
    projectTools?: ProjectToolDeps,
): void {
    registerTool(
        server,
        "workspace_roots",
        withToolAuth({
            title: "List workspace roots",
            description: "List the primary workspace and additional trusted workspace roots.",
            inputSchema: {},
            outputSchema: {
                primaryRoot: z.string(),
                roots: z.array(z.object({ path: z.string(), primary: z.boolean() })),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            try {
                const { project } = scope();
                return okResult(`Listed ${project.roots.length} workspace root(s).`, {
                    primaryRoot: project.root,
                    roots: project.roots.map((path) => ({ path, primary: path === project.root })),
                });
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "workspace_control",
        withToolAuth({
            title: "Manage trusted workspaces",
            description:
                "Stable low-frequency trusted-workspace gateway. roots lists current roots; add/remove persistently change the read/write/exec trust boundary and require explicit user intent. Persistent trust is deliberately excluded from workspace_projects compatibility binding.",
            inputSchema: {
                action: z.enum(WORKSPACE_CONTROL_ACTIONS),
                path: z.string().min(1).optional(),
            },
            outputSchema: {
                action: z.enum(WORKSPACE_CONTROL_ACTIONS),
                path: z.string().nullable(),
                primaryRoot: z.string(),
                roots: z.array(z.object({ path: z.string(), primary: z.boolean() })),
            },
            annotations: writeAnnotations,
        }),
        async ({ action, path }) => {
            try {
                const { project, workspace } = scope();
                let changedPath: string | null = null;
                if (action === "add") {
                    if (!path) throw new Error("action=add 需要 path。");
                    changedPath = project.resolveWorkspaceRoot(path);
                    persistWorkspaceAdded(changedPath, project);
                    project.addWorkspaceRoot(changedPath);
                    workspace.invalidate();
                } else if (action === "remove") {
                    if (!path) throw new Error("action=remove 需要 path。");
                    changedPath = project.requireAdditionalWorkspaceRoot(path);
                    persistWorkspaceRemoved(changedPath, project);
                    project.removeWorkspaceRoot(changedPath);
                    workspace.invalidate();
                } else if (path !== undefined) {
                    throw new Error("path 仅适用于 action=add/remove。");
                }
                return okResult(
                    action === "add"
                        ? `Trusted workspace ${changedPath}.`
                        : action === "remove"
                          ? `Removed workspace trust for ${changedPath}.`
                          : `Listed ${project.roots.length} workspace root(s).`,
                    {
                        action,
                        path: changedPath,
                        primaryRoot: project.root,
                        roots: project.roots.map((root) => ({
                            path: root,
                            primary: root === project.root,
                        })),
                    },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "workspace_add",
        withToolAuth({
            title: "Trust workspace root",
            description:
                "Add an existing directory as a trusted read/write/exec workspace and persist it. This broadens the trusted boundary, so use only when the user explicitly wants that directory treated as a workspace.",
            inputSchema: {
                path: z.string().min(1).describe("Absolute or home-relative directory to trust."),
            },
            outputSchema: {
                path: z.string(),
                roots: z.array(z.string()),
            },
            annotations: writeAnnotations,
        }),
        async ({ path }) => {
            try {
                const { project, workspace } = scope();
                const canonical = project.resolveWorkspaceRoot(path);
                persistWorkspaceAdded(canonical, project);
                project.addWorkspaceRoot(canonical);
                workspace.invalidate();
                if (capabilities?.getConfig().sync === "watch") {
                    await reloadCapabilities(capabilities, hub, skills).catch(() => undefined);
                }
                return okResult(`Trusted workspace ${canonical}.`, {
                    path: canonical,
                    roots: [...project.roots],
                });
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "workspace_remove",
        withToolAuth({
            title: "Remove workspace trust",
            description:
                "Remove an additional trusted workspace and persist the change. The primary workspace cannot be removed while the server is running.",
            inputSchema: {
                path: z.string().min(1).describe("Registered additional workspace path."),
            },
            outputSchema: {
                path: z.string(),
                roots: z.array(z.string()),
            },
            annotations: writeAnnotations,
        }),
        async ({ path }) => {
            try {
                const { project, workspace } = scope();
                const removed = project.requireAdditionalWorkspaceRoot(path);
                persistWorkspaceRemoved(removed, project);
                project.removeWorkspaceRoot(removed);
                workspace.invalidate();
                if (capabilities?.getConfig().sync === "watch") {
                    await reloadCapabilities(capabilities, hub, skills).catch(() => undefined);
                }
                return okResult(`Removed workspace trust for ${removed}.`, {
                    path: removed,
                    roots: [...project.roots],
                });
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "workspace_projects",
        withToolAuth({
            title: "List workspace projects",
            description:
                "Stable ChatGPT ABI: discover bounded Git repositories and, in daemon mode, optionally bind this conversation first with project_id or project_path when project_select is absent from a frozen host action snapshot. Supplying a selector changes only low-risk conversation binding state; it never grants external access or changes persistent workspace trust.",
            inputSchema: {
                max_depth: z.number().int().min(0).max(6).optional(),
                project_id: z
                    .string()
                    .min(1)
                    .max(256)
                    .optional()
                    .describe("Compatibility selector: bind this conversation to a registered daemon project before listing its workspace projects."),
                project_path: z
                    .string()
                    .max(2_000)
                    .optional()
                    .describe("Compatibility selector: absolute registered project path to bind before listing."),
                force: z
                    .boolean()
                    .optional()
                    .describe("Deliberate switch when already bound to another project."),
            },
            outputSchema: {
                projects: z.array(projectSchema),
                binding: z.object({
                    projectId: z.string(),
                    projectPath: z.string(),
                }).nullable(),
            },
            // The selector path writes conversation binding state. Old frozen
            // snapshots may retain the historical read-only descriptor, so the
            // operation remains explicit, non-destructive, and narrowly scoped.
            annotations: stateWriteAnnotations,
        }),
        async ({
            max_depth: maxDepth,
            project_id: projectId,
            project_path: projectPath,
            force,
        }) => {
            try {
                let selectedProject: { id: string; path: string } | undefined;
                if (projectId !== undefined || projectPath !== undefined) {
                    if (!projectTools) {
                        throw new Error("Project selection is available only in daemon mode.");
                    }
                    const selected = bindCurrentOwnerProject(projectTools, {
                        projectId,
                        path: projectPath,
                        force,
                    });
                    selectedProject = {
                        id: selected.project.id,
                        path: selected.project.path,
                    };
                }
                const { project, workspace } = scope();
                const registered = selectedProject ?? projectTools?.registry.getByPath(project.root);
                const projects = await workspace.listProjects(maxDepth ?? 3);
                return okResult(
                    registered
                        ? `Bound to daemon project ${registered.id}; discovered ${projects.length} Git project(s).`
                        : `Discovered ${projects.length} Git project(s).`,
                    {
                        projects,
                        binding: registered
                            ? { projectId: registered.id, projectPath: registered.path }
                            : null,
                    },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "workspace_search",
        withToolAuth({
            title: "Search across workspace",
            description:
                "Run a bounded ripgrep regex search across the primary workspace by default, or a workspace-relative/absolute scope (including external read-only scopes), returning structured file/line/column matches.",
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
                const { workspace } = scope();
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
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "workspace_context",
        withToolAuth({
            title: "Read Chat workspace context",
            description:
                "Return one bounded, Chat-oriented snapshot for a project/scope: Git state and recent commits, relevant durable Goal, managed processes, scoped AGENTS excerpts, matching Skills, intent-ranked code evidence, entry points, manifest hints, CodeGraph readiness, warnings, and an explicit output budget. Prefer this first for prompts like 'continue this project', 'what is going on here?', or 'look at my current work'; use lower-level tools only for detail that is still missing.",
            inputSchema: {
                path: z
                    .string()
                    .max(2_000)
                    .optional()
                    .describe("Workspace-relative or absolute registered-workspace project/file scope. Defaults to project_root."),
                intent: z
                    .string()
                    .min(1)
                    .max(2_000)
                    .optional()
                    .describe("What the user wants to understand or continue; used to rank code/Skill context."),
            },
            outputSchema: workspaceContextOutputSchema,
            annotations: readOnlyAnnotations,
        }),
        async ({ path, intent }) => {
            try {
                const { project, processes, workspace, agents, goals } = scope();
                const result = await buildWorkspaceContext(
                    { project, processes, workspace, agents, skills, goals, hub },
                    { ...(path ? { path } : {}), ...(intent ? { intent } : {}) },
                );
                const projectLabel = result.project?.path ?? result.path;
                return okResult(
                    `Workspace context for ${projectLabel}: ${result.git.changedFiles ?? 0} changed file(s), ${result.work.goal ? `goal ${result.work.goal.id} ${result.work.goal.status}` : "no relevant active goal"}, ${result.work.processes.filter((item) => item.running).length} running process(es), ${result.focus.files.length} intent-ranked code file(s)${result.budget.truncated ? " (bounded/truncated)" : ""}.`,
                    { ...result },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "context_pack",
        withToolAuth({
            title: "Build task context pack",
            description:
                "Build a scope-focused context pack for a coding task: the relevant project, ranked file matches, applicable AGENTS.md rules, high-confidence imported skills, and CodeGraph availability. When path is supplied, unrelated workspace projects are omitted.",
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
                        source: z.enum(["agents", "codex", "claude"]),
                        scope: z.enum(["user", "project"]).optional(),
                        workspaceRoot: z.string().optional(),
                    }),
                ),
                codegraphProjects: z.array(z.string()),
                codegraphMcpReady: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ query, path }) => {
            try {
                const { workspace, agents } = scope();
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
                return projectErrorResult(error);
            }
        },
    );
}

function persistWorkspaceAdded(canonical: string, project: ProjectContext): void {
    if (canonical === project.root) return;
    const configured = loadUserConfig().workspaces ?? [];
    const next = new Set<string>();
    for (const item of configured) {
        try {
            const resolved = project.resolveExternalPath(item);
            if (resolved !== project.root) next.add(resolved);
        } catch {
            next.add(item);
        }
    }
    next.add(canonical);
    saveUserConfig({ workspaces: [...next] });
}

function persistWorkspaceRemoved(removed: string, project: ProjectContext): void {
    const configured = loadUserConfig().workspaces ?? [];
    const next = configured.filter((item) => {
        try {
            return project.resolveExternalPath(item) !== removed;
        } catch {
            return item !== removed;
        }
    });
    saveUserConfig({ workspaces: next });
}

/** @internal Rank context-pack matches by file-level token coverage and preserve diversity. */
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
