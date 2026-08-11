import { access, readFile, readdir } from "node:fs/promises";
import { basename, join, relative } from "node:path";
import { runGitReadOnly } from "../lib/fs/git-readonly.js";
import { structuredSearch } from "../lib/search/structured.js";
import type { ProjectContext } from "../config/project.js";

const DEFAULT_MAX_REPOS = 100;
const DEFAULT_MAX_DEPTH = 3;
const MAX_GIT_OUTPUT_BYTES = 512_000;
const TOPOLOGY_CACHE_TTL_MS = 5_000;
const PROJECT_INSPECTION_CONCURRENCY = 4;
const TOPOLOGY_INSPECTION_CONCURRENCY = 8;
const SKIP_DIRECTORIES = new Set([
    ".git",
    ".codex-worktrees",
    "node_modules",
    "dist",
    "build",
    "coverage",
    "unpackage",
]);

export interface WorkspaceProjectInfo {
    name: string;
    path: string;
    kind: string;
    branch: string;
    dirty: boolean;
    changedFiles: number;
    codegraph: boolean;
}

export interface WorkspaceSearchMatch {
    path: string;
    line: number;
    column: number;
    text: string;
    kind: "match" | "context";
}

interface WorkspaceProjectTopology {
    root: string;
    name: string;
    path: string;
    kind: string;
    codegraph: boolean;
}

interface TopologyCacheEntry {
    expiresAt: number;
    value: Promise<WorkspaceProjectTopology[]>;
}

export class WorkspaceRegistry {
    private readonly topologyCache = new Map<number, TopologyCacheEntry>();

    constructor(private readonly project: ProjectContext) {}

    async listProjects(maxDepth = DEFAULT_MAX_DEPTH): Promise<WorkspaceProjectInfo[]> {
        const depth = Math.max(0, Math.min(Math.floor(maxDepth), 6));
        const topology = await this.listTopology(depth);
        const projects = await mapWithConcurrency(
            topology,
            PROJECT_INSPECTION_CONCURRENCY,
            inspectGitProject,
        );
        return projects.sort((left, right) => left.path.localeCompare(right.path));
    }

    private async listTopology(maxDepth: number): Promise<WorkspaceProjectTopology[]> {
        const now = Date.now();
        const cached = this.topologyCache.get(maxDepth);
        if (cached && cached.expiresAt > now) return await cached.value;

        const value = (async () => {
            const roots = await discoverGitRoots(this.project.root, maxDepth, DEFAULT_MAX_REPOS);
            return await mapWithConcurrency(
                roots,
                TOPOLOGY_INSPECTION_CONCURRENCY,
                (root) => inspectProjectTopology(this.project.root, root),
            );
        })();
        this.topologyCache.set(maxDepth, {
            expiresAt: now + TOPOLOGY_CACHE_TTL_MS,
            value,
        });
        try {
            return await value;
        } catch (error) {
            if (this.topologyCache.get(maxDepth)?.value === value) {
                this.topologyCache.delete(maxDepth);
            }
            throw error;
        }
    }

    async search(input: {
        pattern: string;
        path?: string;
        caseInsensitive?: boolean;
        maxMatches?: number;
        include?: string[];
        exclude?: string[];
        beforeContext?: number;
        afterContext?: number;
        maxMatchesPerFile?: number;
    }): Promise<{ matches: WorkspaceSearchMatch[]; truncated: boolean }> {
        const result = await structuredSearch(this.project, {
            pattern: input.pattern,
            hidden: true,
            ...(input.path ? { path: input.path } : {}),
            ...(input.caseInsensitive !== undefined
                ? { caseInsensitive: input.caseInsensitive }
                : {}),
            ...(input.maxMatches !== undefined ? { maxResults: input.maxMatches } : {}),
            ...(input.include ? { include: input.include } : {}),
            ...(input.exclude ? { exclude: input.exclude } : {}),
            ...(input.beforeContext !== undefined
                ? { beforeContext: input.beforeContext }
                : {}),
            ...(input.afterContext !== undefined
                ? { afterContext: input.afterContext }
                : {}),
            ...(input.maxMatchesPerFile !== undefined
                ? { maxMatchesPerFile: input.maxMatchesPerFile }
                : {}),
        });
        return { matches: result.matches, truncated: result.truncated };
    }

    async projectsForPath(path: string, maxDepth = DEFAULT_MAX_DEPTH): Promise<WorkspaceProjectInfo[]> {
        const scope = path.trim().replaceAll("\\", "/").replace(/^\.\//, "").replace(/\/$/, "") || ".";
        const projects = await this.listProjects(maxDepth);
        if (scope === ".") return projects;

        const containing = projects
            .filter((item) =>
                item.path === "."
                    ? true
                    : scope === item.path || scope.startsWith(`${item.path}/`),
            )
            .sort((left, right) => right.path.length - left.path.length);
        if (containing.length > 0) return [containing[0]!];

        return projects.filter((item) => item.path === scope || item.path.startsWith(`${scope}/`));
    }
}

async function discoverGitRoots(root: string, maxDepth: number, maxRepos: number): Promise<string[]> {
    const roots: string[] = [];
    const queue: Array<{ path: string; depth: number }> = [{ path: root, depth: 0 }];
    while (queue.length > 0 && roots.length < maxRepos) {
        const current = queue.shift()!;
        if (await pathExists(join(current.path, ".git"))) {
            roots.push(current.path);
            continue;
        }
        if (current.depth >= maxDepth) continue;

        let entries;
        try {
            entries = await readdir(current.path, { withFileTypes: true });
        } catch {
            continue;
        }
        for (const entry of entries) {
            if (!entry.isDirectory()) continue;
            if (SKIP_DIRECTORIES.has(entry.name)) continue;
            if (entry.name.startsWith(".") && entry.name !== ".github") continue;
            queue.push({
                path: join(current.path, entry.name),
                depth: current.depth + 1,
            });
        }
    }
    return roots;
}

async function inspectProjectTopology(
    workspaceRoot: string,
    repoRoot: string,
): Promise<WorkspaceProjectTopology> {
    const relativePath = relative(workspaceRoot, repoRoot).replaceAll("\\", "/") || ".";
    const [kind, codegraph] = await Promise.all([
        detectProjectKind(repoRoot),
        pathExists(join(repoRoot, ".codegraph")),
    ]);
    return {
        root: repoRoot,
        name: basename(repoRoot),
        path: relativePath,
        kind,
        codegraph,
    };
}

async function inspectGitProject(
    topology: WorkspaceProjectTopology,
): Promise<WorkspaceProjectInfo> {
    const [branchResult, statusResult] = await Promise.all([
        runGitReadOnly(topology.root, ["branch", "--show-current"], {
            maxOutputBytes: 64 * 1024,
        }).catch(() => undefined),
        runGitReadOnly(
            topology.root,
            ["status", "--porcelain=v1", "-z", "-uall"],
            { maxOutputBytes: MAX_GIT_OUTPUT_BYTES, allowTruncation: true },
        ).catch(() => undefined),
    ]);
    const changedFiles = statusResult ? countPorcelainV1Z(statusResult.stdout, statusResult.truncated) : 0;
    return {
        name: topology.name,
        path: topology.path,
        kind: topology.kind,
        branch: branchResult?.stdout.trim() || "(detached)",
        dirty: changedFiles > 0 || statusResult?.truncated === true,
        changedFiles,
        codegraph: topology.codegraph,
    };
}

async function mapWithConcurrency<T, R>(
    items: readonly T[],
    concurrency: number,
    map: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
    if (items.length === 0) return [];
    const results = new Array<R>(items.length);
    let nextIndex = 0;
    const workerCount = Math.min(Math.max(1, concurrency), items.length);
    const workers = Array.from({ length: workerCount }, async () => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= items.length) return;
            results[index] = await map(items[index]!, index);
        }
    });
    await Promise.all(workers);
    return results;
}

async function detectProjectKind(root: string): Promise<string> {
    if ((await pathExists(join(root, "manifest.json"))) && (await pathExists(join(root, "pages.json")))) {
        return "uni-app";
    }
    if (await pathExists(join(root, "pom.xml"))) return "maven-java";
    if ((await pathExists(join(root, "build.gradle"))) || (await pathExists(join(root, "build.gradle.kts")))) {
        return "gradle";
    }
    if (await pathExists(join(root, "pyproject.toml"))) return "python";
    if (await pathExists(join(root, "Cargo.toml"))) return "rust";
    if (await pathExists(join(root, "go.mod"))) return "go";
    const packagePath = join(root, "package.json");
    if (await pathExists(packagePath)) {
        try {
            const pkg = JSON.parse(await readFile(packagePath, "utf8")) as Record<string, unknown>;
            const dependencies = {
                ...asStringRecord(pkg.dependencies),
                ...asStringRecord(pkg.devDependencies),
            };
            if ("next" in dependencies) return "nextjs";
            if ("vite" in dependencies) return "vite";
            if ("vue" in dependencies) return "node-vue";
            if ("react" in dependencies) return "node-react";
        } catch {
            // fall back to generic node
        }
        return "node";
    }
    return "git";
}

function countPorcelainV1Z(raw: string, truncated: boolean): number {
    const records = raw.split("\0");
    if (truncated && records.at(-1) !== "") records.pop();
    let count = 0;
    for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        if (record.length < 3) continue;
        count += 1;
        const x = record[0];
        const y = record[1];
        if (x === "R" || x === "C" || y === "R" || y === "C") index += 1;
    }
    return count;
}

function asStringRecord(value: unknown): Record<string, string> {
    if (!value || typeof value !== "object" || Array.isArray(value)) return {};
    const result: Record<string, string> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
        if (typeof item === "string") result[key] = item;
    }
    return result;
}

async function pathExists(path: string): Promise<boolean> {
    try {
        await access(path);
        return true;
    } catch {
        return false;
    }
}
