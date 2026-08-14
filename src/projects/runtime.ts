import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AgentInstructionRegistry } from "../agents/registry.js";
import { expandHomePath } from "../config/loader.js";
import { ProjectContext } from "../config/project.js";
import { loadUserConfig, saveUserConfig } from "../config/user-config.js";
import { GoalStore } from "../goals/store.js";
import { ProcessOwnerPool } from "../lib/process/owner-pool.js";
import { ProcessSessionManager } from "../lib/process/sessions.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import { WorkspaceRegistry } from "../workspace/registry.js";

/**
 * One lazy per-project runtime container. Everything project-scoped lives
 * here; daemon-wide services (HTTP server, OAuth, tunnel, hub, skills, UI
 * settings, runtime log) stay shared outside this container.
 */
export interface ProjectRuntime {
    readonly id: string;
    readonly project: ProjectContext;
    readonly workspace: WorkspaceRegistry;
    readonly agents: AgentInstructionRegistry;
    readonly goals: GoalStore;
    readonly rootProcesses: ProcessSessionManager;
    readonly processOwners: ProcessOwnerPool;
}

export interface ProjectRuntimeManagerOptions {
    /** Optional goal storage directory override, primarily for isolated tests. */
    goalStorageDir?: string;
}

/**
 * Lazy per-project runtime registry. Runtimes are created on first use so
 * registering a project does not build workspaces until a conversation binds.
 */
export class ProjectRuntimeManager {
    private readonly runtimes = new Map<string, ProjectRuntime>();

    constructor(private readonly options: ProjectRuntimeManagerOptions = {}) {}

    has(id: string): boolean {
        return this.runtimes.has(id);
    }

    /** Persist daemon-global workspace trust and publish it to every live runtime. */
    addTrustedWorkspace(pathValue: string): string {
        const canonical = canonicalExistingDirectory(pathValue);
        const configured = loadUserConfig().workspaces ?? [];
        if (!configured.some((item) => comparableWorkspacePath(item) === canonical)) {
            saveUserConfig({ workspaces: [...configured, canonical] });
        }
        for (const runtime of this.runtimes.values()) {
            if (!runtime.project.roots.includes(canonical)) {
                runtime.project.addWorkspaceRoot(canonical);
                runtime.workspace.invalidate();
            }
        }
        writeRuntimeLog("info", "workspace_trust_added", { path: canonical });
        return canonical;
    }

    /** Revoke daemon-global workspace trust immediately from every live runtime. */
    removeTrustedWorkspace(pathValue: string): string {
        const canonical = canonicalExistingDirectory(pathValue);
        const configured = loadUserConfig().workspaces ?? [];
        if (!configured.some((item) => comparableWorkspacePath(item) === canonical)) {
            throw new Error(`Workspace is not registered: ${pathValue}`);
        }
        saveUserConfig({
            workspaces: configured.filter((item) => comparableWorkspacePath(item) !== canonical),
        });
        for (const runtime of this.runtimes.values()) {
            // A registered project always keeps its own primary root. Global
            // removal only revokes the path as an additional trusted root.
            if (runtime.project.root === canonical) continue;
            if (runtime.project.roots.includes(canonical)) {
                runtime.project.removeWorkspaceRoot(canonical);
                runtime.workspace.invalidate();
            }
        }
        writeRuntimeLog("info", "workspace_trust_removed", { path: canonical });
        return canonical;
    }

    /** Create (or reuse) the runtime for a registered project. */
    get(id: string, canonicalPath: string): ProjectRuntime {
        const existing = this.runtimes.get(id);
        if (existing) return existing;

        const project = new ProjectContext(canonicalPath, this.workspaceRootsFor(canonicalPath));
        const runtime: ProjectRuntime = {
            id,
            project,
            workspace: new WorkspaceRegistry(project),
            agents: new AgentInstructionRegistry(project),
            goals: new GoalStore(project, this.options.goalStorageDir),
            rootProcesses: new ProcessSessionManager(),
            processOwners: new ProcessOwnerPool(new ProcessSessionManager()),
        };
        this.runtimes.set(id, runtime);
        writeRuntimeLog("info", "project_runtime_created", { project: id });
        return runtime;
    }

    /** Stop a project's managed processes and drop its runtime container. */
    async remove(id: string): Promise<void> {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        this.runtimes.delete(id);
        try {
            await runtime.processOwners.shutdown();
        } catch (error) {
            writeRuntimeLog("error", "project_runtime_shutdown_failed", {
                project: id,
                error: errorMessage(error),
            });
        }
        writeRuntimeLog("info", "project_runtime_removed", { project: id });
    }

    async shutdownAll(): Promise<void> {
        const ids = [...this.runtimes.keys()];
        await Promise.all(ids.map((id) => this.remove(id)));
    }

    /** Additional user-config workspaces keep applying to every project runtime. */
    private workspaceRootsFor(primaryRoot: string): string[] {
        return [...new Set([primaryRoot, ...this.configuredWorkspaceRoots()])];
    }

    private configuredWorkspaceRoots(): string[] {
        const roots: string[] = [];
        for (const pathValue of loadUserConfig().workspaces ?? []) {
            try {
                roots.push(canonicalExistingDirectory(pathValue));
            } catch {
                // Unavailable/offline configured roots are not part of the live
                // trust boundary until they exist again.
            }
        }
        return [...new Set(roots)];
    }
}

function canonicalExistingDirectory(pathValue: string): string {
    const candidate = resolve(expandHomePath(pathValue));
    if (!existsSync(candidate) || !statSync(candidate).isDirectory()) {
        throw new Error(`Workspace root is not a directory: ${pathValue}`);
    }
    return realpathSync.native(candidate);
}

function comparableWorkspacePath(pathValue: string): string {
    try {
        return canonicalExistingDirectory(pathValue);
    } catch {
        return resolve(expandHomePath(pathValue));
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
