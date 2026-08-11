import { access, readFile, readdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import type { AgentInstructionRegistry } from "../agents/registry.js";
import type { GoalRecord, GoalStore, GoalSummary } from "../goals/store.js";
import type { ProcessInfo, ProcessSessionManager } from "../lib/process/sessions.js";
import {
    queryToSearchPattern,
    rankMatchesByFile,
    significantQueryTokens,
} from "../lib/search/query-relevance.js";
import { runGitReadOnly } from "../lib/fs/git-readonly.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { ProjectContext } from "../config/project.js";
import type { SkillInfo, SkillRegistry } from "../skills/registry.js";
import type {
    WorkspaceProjectInfo,
    WorkspaceRegistry,
    WorkspaceSearchMatch,
} from "./registry.js";

const DEFAULT_INTENT = "understand the current project and continue the active development work";
const MAX_RELATED_PROJECTS = 8;
const MAX_GIT_STATUS_BYTES = 512_000;
const MAX_GIT_FILES = 12;
const MAX_RECENT_COMMITS = 5;
const MAX_FOCUS_SEARCH_CANDIDATES = 60;
const MAX_FOCUS_FILES = 10;
const MAX_AGENT_FILES = 4;
const MAX_AGENT_EXCERPT_CHARS = 1_200;
const MAX_SKILLS = 5;
const MAX_PROCESSES = 6;
const MAX_ENTRY_POINTS = 8;
const MAX_WARNINGS = 12;
const MAX_ERROR_CHARS = 500;
const MAX_PATH_CHARS = 400;
const MAX_INTENT_OUTPUT_CHARS = 1_200;
const MAX_GOAL_TEXT_CHARS = 1_000;
const MAX_GOAL_ITEM_CHARS = 500;
const MAX_FOCUS_TEXT_CHARS = 360;
const MAX_SKILL_DESCRIPTION_CHARS = 500;
const MAX_COMMAND_CHARS = 280;
export const WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS = 40_000;

export interface WorkspaceContextInput {
    path?: string;
    intent?: string;
}

export interface WorkspaceContextDependencies {
    project: ProjectContext;
    processes: ProcessSessionManager;
    workspace: WorkspaceRegistry;
    agents: AgentInstructionRegistry;
    skills: SkillRegistry;
    goals: GoalStore;
    hub: DownstreamMcpHub;
}

export interface WorkspaceContextResult {
    path: string;
    intent: string;
    projects: WorkspaceProjectInfo[];
    project: WorkspaceProjectInfo | null;
    git: {
        available: boolean;
        repository: string | null;
        branch: string | null;
        dirty: boolean | null;
        changedFiles: number | null;
        files: Array<{
            path: string;
            indexStatus: string;
            worktreeStatus: string;
        }>;
        filesTruncated: boolean;
        recentCommits: Array<{
            shortHash: string;
            date: string;
            subject: string;
        }>;
        error: string | null;
    };
    work: {
        goal: WorkspaceGoalContext | null;
        activeGoals: Array<{
            id: string;
            scopePath: string;
            objective: string;
            status: string;
            updatedAt: string;
        }>;
        processes: Array<{
            processId: number;
            name?: string;
            command: string;
            cwd: string;
            running: boolean;
            startedAt: number;
            wallTimeMs: number;
            exitCode?: number;
            signal?: string;
        }>;
    };
    instructions: {
        agents: Array<{
            path: string;
            source: "global" | "project";
            excerpt: string;
            truncated: boolean;
        }>;
        skills: SkillInfo[];
    };
    focus: {
        files: Array<{
            path: string;
            line: number;
            column: number;
            text: string;
        }>;
        searchTruncated: boolean;
        searchError: string | null;
        entryPoints: Array<{ path: string; reason: string }>;
        manifest: {
            path: string;
            name?: string;
            version?: string;
            scripts: Array<{ name: string; command: string }>;
        } | null;
        codegraph: {
            indexedProjects: string[];
            mcpReady: boolean;
        };
    };
    warnings: string[];
    budget: {
        maxStructuredChars: number;
        estimatedChars: number;
        truncated: boolean;
    };
}

interface WorkspaceGoalContext {
    id: string;
    scopePath: string;
    objective: string;
    status: string;
    updatedAt: string;
    tasks: {
        total: number;
        done: number;
        inProgress: number;
        blocked: number;
        pending: number;
    };
    openTasks: Array<{
        id: string;
        title: string;
        status: string;
        note?: string;
    }>;
    checkpoint: {
        summary: string;
        next?: string;
        findings: string[];
        blockers: string[];
        createdAt: string;
    } | null;
}

/** Build one bounded, Chat-oriented snapshot of the local engineering workspace. */
export async function buildWorkspaceContext(
    dependencies: WorkspaceContextDependencies,
    input: WorkspaceContextInput,
): Promise<WorkspaceContextResult> {
    const { project, processes, workspace, agents, skills, goals, hub } = dependencies;
    const warnings: string[] = [];
    let truncated = false;

    const absoluteTarget = project.resolvePath(input.path?.trim() || ".");
    const targetPath = relative(project.root, absoluteTarget).replaceAll("\\", "/") || ".";
    const explicitIntent = input.intent?.trim();
    const intent = clipText(explicitIntent || DEFAULT_INTENT, MAX_INTENT_OUTPUT_CHARS);

    let discoveredProjects: WorkspaceProjectInfo[] = [];
    let relatedProjects: WorkspaceProjectInfo[] = [];
    try {
        discoveredProjects = targetPath === "."
            ? await workspace.listProjects(3)
            : await workspace.projectsForPath(targetPath, 3);
        if (discoveredProjects.length > MAX_RELATED_PROJECTS) {
            truncated = true;
            pushWarning(warnings, `Related project list was truncated to ${MAX_RELATED_PROJECTS} repositories.`);
        }
        relatedProjects = discoveredProjects.slice(0, MAX_RELATED_PROJECTS).map(compactProject);
    } catch (error) {
        pushWarning(warnings, `Project discovery unavailable: ${errorMessage(error)}`);
    }

    const primaryProjectSource = selectPrimaryProject(discoveredProjects, targetPath);
    const primaryProject = primaryProjectSource ? compactProject(primaryProjectSource) : null;
    const repositoryAbsolute = primaryProjectSource
        ? project.resolvePath(primaryProjectSource.path)
        : undefined;

    const goalResult = await buildGoalContext(goals, targetPath).catch((error: unknown) => {
        pushWarning(warnings, `Goal state unavailable: ${errorMessage(error)}`);
        return { goal: null, activeGoals: [] };
    });
    if (goalResult.goal?.status === "paused") {
        pushWarning(warnings, `Active goal ${goalResult.goal.id} is paused.`);
    }
    if ((goalResult.goal?.tasks.blocked ?? 0) > 0) {
        pushWarning(warnings, `Active goal has ${goalResult.goal!.tasks.blocked} blocked task(s).`);
    }

    const git = await buildGitContext(primaryProject, repositoryAbsolute).catch((error: unknown) => ({
        available: primaryProject !== null,
        repository: primaryProject?.path ?? null,
        branch: primaryProject?.branch ?? null,
        dirty: primaryProject?.dirty ?? null,
        changedFiles: primaryProject?.changedFiles ?? null,
        files: [],
        filesTruncated: false,
        recentCommits: [],
        error: clipText(errorMessage(error), MAX_ERROR_CHARS),
    }));
    if (!primaryProject) {
        pushWarning(
            warnings,
            relatedProjects.length > 1
                ? "This scope contains multiple Git projects; no single primary repository was selected."
                : "No Git project was found for this scope; Git detail is unavailable.",
        );
    }
    if (git.error) pushWarning(warnings, `Git detail partially unavailable: ${git.error}`);
    if (git.dirty) pushWarning(warnings, `Git working tree has ${git.changedFiles ?? "unknown"} changed file(s).`);
    if (git.filesTruncated) {
        truncated = true;
        pushWarning(warnings, `Changed-file detail was truncated to ${MAX_GIT_FILES} entries.`);
    }

    const processScope = repositoryAbsolute ?? absoluteTarget;
    const visibleProcesses = processes.list()
        .filter((item) => isInside(processScope, item.cwd))
        .sort((left, right) => Number(right.running) - Number(left.running) || right.startedAt - left.startedAt);
    if (visibleProcesses.length > MAX_PROCESSES) truncated = true;
    const processContext = visibleProcesses.slice(0, MAX_PROCESSES).map((item) => compactProcess(project, item));

    let agentContext: WorkspaceContextResult["instructions"]["agents"] = [];
    try {
        const applicable = agents.forPath(targetPath);
        if (applicable.length > MAX_AGENT_FILES) truncated = true;
        agentContext = applicable.slice(0, MAX_AGENT_FILES).map((file) => {
            const excerpt = clipText(file.content, MAX_AGENT_EXCERPT_CHARS);
            const wasClipped = excerpt.length < file.content.length;
            if (file.truncated || wasClipped) truncated = true;
            return {
                path: clipText(file.path, MAX_PATH_CHARS),
                source: file.source,
                excerpt,
                truncated: file.truncated || wasClipped,
            };
        });
    } catch (error) {
        pushWarning(warnings, `Project instructions unavailable: ${errorMessage(error)}`);
    }

    const focusQuery = buildFocusQuery(intent, goalResult.goal, Boolean(explicitIntent));
    const skillMatches = rankSkills(focusQuery, skills.list())
        .slice(0, MAX_SKILLS)
        .map((skill) => ({
            ...skill,
            description: clipText(skill.description, MAX_SKILL_DESCRIPTION_CHARS),
        }));

    let focusFiles: WorkspaceContextResult["focus"]["files"] = [];
    let searchTruncated = false;
    let searchError: string | null = null;
    try {
        const search = await searchFocusCandidates(workspace, focusQuery, targetPath);
        const ranked = rankMatchesByFile(focusQuery, search.matches, MAX_FOCUS_FILES, 1)
            .flatMap((item) => item.matches)
            .slice(0, MAX_FOCUS_FILES);
        focusFiles = ranked.map(compactFocusMatch);
        searchTruncated = search.truncated;
        if (searchTruncated) truncated = true;
    } catch (error) {
        searchError = clipText(errorMessage(error), MAX_ERROR_CHARS);
        pushWarning(warnings, `Intent-focused code search unavailable: ${searchError}`);
    }

    const entryAndManifest = repositoryAbsolute
        ? await discoverEntryPointsAndManifest(repositoryAbsolute, primaryProject!.path)
        : { entryPoints: [], manifest: null };
    if (entryAndManifest.entryPoints.length > MAX_ENTRY_POINTS) truncated = true;

    const indexedProjects = relatedProjects
        .filter((item) => item.codegraph)
        .map((item) => item.path)
        .slice(0, MAX_RELATED_PROJECTS);
    const codegraphMcpReady =
        indexedProjects.length > 0 &&
        hub.listServers().some((item) => item.name === "codegraph" && item.status === "ready");
    if (indexedProjects.length > 0 && !codegraphMcpReady) {
        pushWarning(warnings, "A CodeGraph index exists, but the codegraph MCP is not ready; later code exploration will fall back to structured search.");
    }

    const result: WorkspaceContextResult = {
        path: clipText(targetPath, MAX_PATH_CHARS),
        intent,
        projects: relatedProjects,
        project: primaryProject,
        git,
        work: {
            goal: goalResult.goal,
            activeGoals: goalResult.activeGoals,
            processes: processContext,
        },
        instructions: {
            agents: agentContext,
            skills: skillMatches,
        },
        focus: {
            files: focusFiles,
            searchTruncated,
            searchError,
            entryPoints: entryAndManifest.entryPoints.slice(0, MAX_ENTRY_POINTS),
            manifest: entryAndManifest.manifest,
            codegraph: {
                indexedProjects,
                mcpReady: codegraphMcpReady,
            },
        },
        warnings: warnings.slice(0, MAX_WARNINGS),
        budget: {
            maxStructuredChars: WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS,
            estimatedChars: 0,
            truncated,
        },
    };

    enforceStructuredBudget(result);
    result.budget.estimatedChars = measureJsonChars(result);
    if (result.budget.estimatedChars > WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS) {
        enforceStructuredBudget(result);
        result.budget.estimatedChars = measureJsonChars(result);
    }
    return result;
}

async function buildGitContext(
    project: WorkspaceProjectInfo | null,
    repositoryAbsolute?: string,
): Promise<WorkspaceContextResult["git"]> {
    if (!project || !repositoryAbsolute) {
        return {
            available: false,
            repository: null,
            branch: null,
            dirty: null,
            changedFiles: null,
            files: [],
            filesTruncated: false,
            recentCommits: [],
            error: null,
        };
    }

    const [statusResult, logResult] = await Promise.all([
        runGitReadOnly(repositoryAbsolute, ["status", "--porcelain=v1", "-z", "-uall"], {
            maxOutputBytes: MAX_GIT_STATUS_BYTES,
            allowTruncation: true,
        }).catch((error: unknown) => ({ error })),
        runGitReadOnly(repositoryAbsolute, [
            "log",
            `-${MAX_RECENT_COMMITS}`,
            "--date=iso-strict",
            "--format=%h%x1f%aI%x1f%s%x1e",
        ], { maxOutputBytes: 128_000 }).catch((error: unknown) => ({ error })),
    ]);

    let files: WorkspaceContextResult["git"]["files"] = [];
    let filesTruncated = false;
    let changedFiles = project.changedFiles;
    const errors: string[] = [];

    if ("error" in statusResult) {
        errors.push(errorMessage(statusResult.error));
    } else {
        const rows = parsePorcelainV1Z(statusResult.stdout, statusResult.truncated);
        changedFiles = rows.length;
        files = rows.slice(0, MAX_GIT_FILES).map((item) => ({
            ...item,
            path: clipText(item.path, MAX_PATH_CHARS),
        }));
        filesTruncated = statusResult.truncated || rows.length > files.length;
    }

    let recentCommits: WorkspaceContextResult["git"]["recentCommits"] = [];
    if ("error" in logResult) {
        errors.push(errorMessage(logResult.error));
    } else {
        recentCommits = logResult.stdout
            .split("\x1e")
            .map((record) => record.trim())
            .filter(Boolean)
            .slice(0, MAX_RECENT_COMMITS)
            .map((record) => {
                const [shortHash = "", date = "", subject = ""] = record.split("\x1f");
                return {
                    shortHash: clipText(shortHash, 32),
                    date: clipText(date, 64),
                    subject: clipText(subject, 300),
                };
            });
    }

    return {
        available: true,
        repository: clipText(project.path, MAX_PATH_CHARS),
        branch: clipText(project.branch, 200),
        dirty: changedFiles > 0 || project.dirty,
        changedFiles,
        files,
        filesTruncated,
        recentCommits,
        error: errors.length > 0 ? clipText(errors.join("; "), MAX_ERROR_CHARS) : null,
    };
}

async function buildGoalContext(
    goals: GoalStore,
    targetPath: string,
): Promise<{
    goal: WorkspaceGoalContext | null;
    activeGoals: WorkspaceContextResult["work"]["activeGoals"];
}> {
    const snapshot = await goals.status();
    const relevant = snapshot.activeGoals
        .filter((item) => scopesOverlap(item.scopePath, targetPath))
        .sort((left, right) => goalRelevance(right, targetPath) - goalRelevance(left, targetPath));
    const selected = relevant[0];
    const goal = selected ? (await goals.status(selected.id)).goal : null;
    return {
        goal: goal ? compactGoal(goal) : null,
        activeGoals: relevant.slice(0, 5).map(compactGoalSummary),
    };
}

function compactGoal(goal: GoalRecord): WorkspaceGoalContext {
    const checkpoint = goal.checkpoints.at(-1);
    const tasks = {
        total: goal.tasks.length,
        done: goal.tasks.filter((item) => item.status === "done").length,
        inProgress: goal.tasks.filter((item) => item.status === "in_progress").length,
        blocked: goal.tasks.filter((item) => item.status === "blocked").length,
        pending: goal.tasks.filter((item) => item.status === "pending").length,
    };
    return {
        id: goal.id,
        scopePath: clipText(goal.scopePath, MAX_PATH_CHARS),
        objective: clipText(goal.objective, MAX_GOAL_TEXT_CHARS),
        status: goal.status,
        updatedAt: goal.updatedAt,
        tasks,
        openTasks: goal.tasks
            .filter((item) => item.status !== "done")
            .slice(0, 5)
            .map((item) => ({
                id: item.id,
                title: clipText(item.title, MAX_GOAL_ITEM_CHARS),
                status: item.status,
                ...(item.note ? { note: clipText(item.note, MAX_GOAL_ITEM_CHARS) } : {}),
            })),
        checkpoint: checkpoint
            ? {
                summary: clipText(checkpoint.summary, MAX_GOAL_ITEM_CHARS),
                ...(checkpoint.next ? { next: clipText(checkpoint.next, MAX_GOAL_ITEM_CHARS) } : {}),
                findings: checkpoint.findings.slice(0, 3).map((item) => clipText(item, MAX_GOAL_ITEM_CHARS)),
                blockers: checkpoint.blockers.slice(0, 3).map((item) => clipText(item, MAX_GOAL_ITEM_CHARS)),
                createdAt: checkpoint.createdAt,
            }
            : null,
    };
}

function compactGoalSummary(goal: GoalSummary): WorkspaceContextResult["work"]["activeGoals"][number] {
    return {
        id: goal.id,
        scopePath: clipText(goal.scopePath, MAX_PATH_CHARS),
        objective: clipText(goal.objective, MAX_GOAL_ITEM_CHARS),
        status: goal.status,
        updatedAt: goal.updatedAt,
    };
}

function compactProcess(project: ProjectContext, info: ProcessInfo): WorkspaceContextResult["work"]["processes"][number] {
    const relativeCwd = relative(project.root, info.cwd).replaceAll("\\", "/") || ".";
    return {
        processId: info.processId,
        ...(info.name ? { name: clipText(info.name, 100) } : {}),
        command: clipText(info.command.replace(/\s+/g, " ").trim(), MAX_COMMAND_CHARS),
        cwd: clipText(relativeCwd, MAX_PATH_CHARS),
        running: info.running,
        startedAt: info.startedAt,
        wallTimeMs: info.wallTimeMs,
        ...(info.exitCode !== undefined ? { exitCode: info.exitCode } : {}),
        ...(info.signal ? { signal: clipText(info.signal, 40) } : {}),
    };
}

function compactProject(project: WorkspaceProjectInfo): WorkspaceProjectInfo {
    return {
        ...project,
        name: clipText(project.name, 200),
        path: clipText(project.path, MAX_PATH_CHARS),
        kind: clipText(project.kind, 100),
        branch: clipText(project.branch, 200),
    };
}

function compactFocusMatch(match: WorkspaceSearchMatch): WorkspaceContextResult["focus"]["files"][number] {
    return {
        path: clipText(match.path, MAX_PATH_CHARS),
        line: match.line,
        column: match.column,
        text: clipText(match.text, MAX_FOCUS_TEXT_CHARS),
    };
}

function selectPrimaryProject(
    projects: readonly WorkspaceProjectInfo[],
    targetPath: string,
): WorkspaceProjectInfo | null {
    const exact = projects.find((item) => item.path === targetPath);
    if (exact) return exact;
    if (targetPath === ".") {
        return projects.find((item) => item.path === ".") ?? (projects.length === 1 ? projects[0]! : null);
    }
    return projects.length === 1 ? projects[0]! : null;
}

function buildFocusQuery(
    intent: string,
    goal: WorkspaceGoalContext | null,
    hasExplicitIntent: boolean,
): string {
    if (hasExplicitIntent || !goal) return intent;
    return `${goal.objective}\n${goal.openTasks.map((item) => item.title).join("\n")}`.slice(0, 4_000);
}

async function searchFocusCandidates(
    workspace: WorkspaceRegistry,
    query: string,
    targetPath: string,
): Promise<{ matches: WorkspaceSearchMatch[]; truncated: boolean }> {
    const tokens = significantQueryTokens(query, 8);
    const pattern = tokens.length > 0
        ? tokens.map(flexibleTokenPattern).filter(Boolean).join("|")
        : queryToSearchPattern(query);
    return await workspace.search({
        pattern,
        ...(targetPath !== "." ? { path: targetPath } : {}),
        caseInsensitive: true,
        maxMatches: MAX_FOCUS_SEARCH_CANDIDATES * 2,
        maxMatchesPerFile: 2,
    });
}

function flexibleTokenPattern(token: string): string {
    return token.split(/[-_]+/).filter(Boolean).map(escapeRegex).join("[-_]?");
}

function escapeRegex(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function rankSkills(query: string, skills: SkillInfo[]): SkillInfo[] {
    const normalized = query.toLowerCase();
    const tokens = significantQueryTokens(query);
    return skills
        .map((skill) => {
            const name = skill.name.toLowerCase();
            const text = `${skill.name} ${skill.description}`.toLowerCase();
            const directNameMatch = normalized.includes(name);
            const overlap = tokens.filter((token) => text.includes(token)).length;
            return { skill, score: (directNameMatch ? 20 : 0) + overlap, directNameMatch, overlap };
        })
        .filter((item) => item.directNameMatch || item.overlap >= 2)
        .sort((left, right) => right.score - left.score || left.skill.name.localeCompare(right.skill.name))
        .map((item) => item.skill);
}

async function discoverEntryPointsAndManifest(
    repositoryRoot: string,
    repositoryPath: string,
): Promise<{
    entryPoints: WorkspaceContextResult["focus"]["entryPoints"];
    manifest: WorkspaceContextResult["focus"]["manifest"];
}> {
    const entryPoints: WorkspaceContextResult["focus"]["entryPoints"] = [];
    const seen = new Set<string>();
    const addEntry = (path: string, reason: string): void => {
        const normalized = path.replaceAll("\\", "/");
        if (seen.has(normalized)) return;
        seen.add(normalized);
        entryPoints.push({
            path: clipText(prefixRepositoryPath(repositoryPath, normalized), MAX_PATH_CHARS),
            reason,
        });
    };

    for (const directory of ["src", "."]) {
        const absoluteDirectory = directory === "." ? repositoryRoot : join(repositoryRoot, directory);
        let entries;
        try {
            entries = await readdir(absoluteDirectory, { withFileTypes: true });
        } catch {
            continue;
        }
        const candidates = entries
            .filter((entry) => entry.isFile() && isLikelyCodeEntry(entry.name))
            .sort((left, right) => entryPriority(left.name) - entryPriority(right.name) || left.name.localeCompare(right.name));
        for (const entry of candidates) {
            const path = directory === "." ? entry.name : `${directory}/${entry.name}`;
            addEntry(path, entryReason(entry.name));
            if (entryPoints.length >= MAX_ENTRY_POINTS) break;
        }
        if (entryPoints.length >= MAX_ENTRY_POINTS) break;
    }

    const packagePath = join(repositoryRoot, "package.json");
    if (await pathExists(packagePath)) {
        try {
            const raw = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
            const scriptsRaw = asStringRecord(raw.scripts);
            const scripts = Object.entries(scriptsRaw)
                .slice(0, 8)
                .map(([name, command]) => ({
                    name: clipText(name, 80),
                    command: clipText(command, 180),
                }));
            return {
                entryPoints,
                manifest: {
                    path: prefixRepositoryPath(repositoryPath, "package.json"),
                    ...(typeof raw.name === "string" ? { name: clipText(raw.name, 200) } : {}),
                    ...(typeof raw.version === "string" ? { version: clipText(raw.version, 80) } : {}),
                    scripts,
                },
            };
        } catch {
            return {
                entryPoints,
                manifest: {
                    path: prefixRepositoryPath(repositoryPath, "package.json"),
                    scripts: [],
                },
            };
        }
    }

    for (const manifestName of ["pyproject.toml", "Cargo.toml", "go.mod", "pom.xml", "build.gradle", "build.gradle.kts"]) {
        if (await pathExists(join(repositoryRoot, manifestName))) {
            return {
                entryPoints,
                manifest: {
                    path: prefixRepositoryPath(repositoryPath, manifestName),
                    scripts: [],
                },
            };
        }
    }

    return { entryPoints, manifest: null };
}

function enforceStructuredBudget(result: WorkspaceContextResult): void {
    const overBudget = (): boolean => measureJsonChars(result) > WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS;
    let pruned = false;

    while (overBudget() && result.focus.files.length > 3) {
        result.focus.files.pop();
        pruned = true;
    }
    while (overBudget() && result.git.files.length > 4) {
        result.git.files.pop();
        result.git.filesTruncated = true;
        pruned = true;
    }
    while (overBudget() && result.work.processes.length > 2) {
        result.work.processes.pop();
        pruned = true;
    }
    while (overBudget() && result.instructions.skills.length > 2) {
        result.instructions.skills.pop();
        pruned = true;
    }
    while (overBudget() && result.git.recentCommits.length > 2) {
        result.git.recentCommits.pop();
        pruned = true;
    }
    if (overBudget()) {
        for (const agent of result.instructions.agents) {
            const clipped = clipText(agent.excerpt, 500);
            if (clipped.length < agent.excerpt.length) {
                agent.excerpt = clipped;
                agent.truncated = true;
                pruned = true;
            }
        }
    }
    while (overBudget() && result.instructions.agents.length > 1) {
        result.instructions.agents.pop();
        pruned = true;
    }
    while (overBudget() && result.focus.entryPoints.length > 3) {
        result.focus.entryPoints.pop();
        pruned = true;
    }
    if (overBudget() && result.work.goal) {
        result.work.goal.objective = clipText(result.work.goal.objective, 500);
        result.work.goal.openTasks = result.work.goal.openTasks.slice(0, 3);
        pruned = true;
    }

    if (pruned) {
        result.budget.truncated = true;
        pushWarning(result.warnings, "Optional workspace_context detail was pruned to stay within the structured output budget.");
    }
}

function parsePorcelainV1Z(
    raw: string,
    outputTruncated: boolean,
): Array<{ path: string; indexStatus: string; worktreeStatus: string }> {
    const records = raw.split("\0");
    if (outputTruncated && records.at(-1) !== "") records.pop();
    const files: Array<{ path: string; indexStatus: string; worktreeStatus: string }> = [];
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        if (record.length < 3) continue;
        const indexStatus = record[0] ?? " ";
        const worktreeStatus = record[1] ?? " ";
        let path = record.slice(3);
        if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
            const original = records[index + 1];
            if (original !== undefined) {
                path = `${original} -> ${path}`;
                index += 1;
            }
        }
        files.push({ path, indexStatus, worktreeStatus });
    }
    return files;
}

function scopesOverlap(goalScope: string, targetPath: string): boolean {
    if (goalScope === "." || targetPath === ".") return true;
    return goalScope === targetPath || goalScope.startsWith(`${targetPath}/`) || targetPath.startsWith(`${goalScope}/`);
}

function goalRelevance(goal: GoalSummary, targetPath: string): number {
    if (goal.scopePath === targetPath) return 10_000;
    if (goal.scopePath === ".") return 1_000;
    if (targetPath.startsWith(`${goal.scopePath}/`)) return 5_000 + goal.scopePath.length;
    if (goal.scopePath.startsWith(`${targetPath}/`)) return 3_000 - goal.scopePath.length;
    return 0;
}

function isLikelyCodeEntry(name: string): boolean {
    if (!/\.(?:[cm]?[jt]sx?|py|go|rs|java|kt|kts)$/i.test(name)) return false;
    return /(^|[-_.])(index|main|app|cli|server)([-_.]|$)/i.test(name);
}

function entryPriority(name: string): number {
    const lower = name.toLowerCase();
    if (/^cli\./.test(lower)) return 0;
    if (/^main\./.test(lower) || /^index\./.test(lower)) return 1;
    if (lower.includes("server")) return 2;
    if (lower.includes("app")) return 3;
    return 4;
}

function entryReason(name: string): string {
    const lower = name.toLowerCase();
    if (lower.includes("cli")) return "CLI entry candidate";
    if (lower.includes("server")) return "server entry candidate";
    if (lower.includes("main") || lower.includes("index")) return "application entry candidate";
    if (lower.includes("app")) return "application root candidate";
    return "entry-point candidate";
}

function prefixRepositoryPath(repositoryPath: string, child: string): string {
    const normalized = child.replace(/^\.\//, "");
    return repositoryPath === "." ? normalized : `${repositoryPath}/${normalized}`;
}

function isInside(root: string, candidate: string): boolean {
    const relationship = relative(resolve(root), resolve(candidate));
    return relationship === "" || (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`));
}

function clipText(value: string, maxChars: number): string {
    const text = String(value);
    if (text.length <= maxChars) return text;
    return `${text.slice(0, Math.max(0, maxChars - 1))}…`;
}

function pushWarning(warnings: string[], value: string): void {
    if (warnings.length >= MAX_WARNINGS) return;
    const clipped = clipText(value.replace(/\s+/g, " ").trim(), MAX_ERROR_CHARS);
    if (clipped && !warnings.includes(clipped)) warnings.push(clipped);
}

function errorMessage(error: unknown): string {
    return clipText(error instanceof Error ? error.message : String(error), MAX_ERROR_CHARS);
}

function asStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === "string") result[key] = item;
    }
    return result;
}

function measureJsonChars(value: unknown): number {
    return JSON.stringify(value).length;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
