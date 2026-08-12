import { existsSync, realpathSync, statSync } from "node:fs";
import { resolve } from "node:path";
import { AgentInstructionRegistry } from "../agents/registry.js";
import { expandHomePath } from "../config/loader.js";
import { ProjectContext } from "../config/project.js";
import { loadUserConfig } from "../config/user-config.js";
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
        const roots = [primaryRoot];
        for (const pathValue of loadUserConfig().workspaces ?? []) {
            try {
                const candidate = realpathSync.native(resolve(expandHomePath(pathValue)));
                if (existsSync(candidate) && statSync(candidate).isDirectory()) {
                    roots.push(candidate);
                }
            } catch {
                // Unavailable/offline additional workspaces are omitted, same as loadConfig.
            }
        }
        return [...new Set(roots)];
    }
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
