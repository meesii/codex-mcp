import { ProjectContext } from "../config/project.js";
import { ProcessOwnerPool } from "../lib/process/owner-pool.js";
import { ProcessSessionManager } from "../lib/process/sessions.js";
import { RoundChangeStore } from "../lib/tool/round-changes.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";

export interface ProjectRuntime {
    readonly id: string;
    readonly project: ProjectContext;
    readonly rootProcesses: ProcessSessionManager;
    readonly processOwners: ProcessOwnerPool;
    readonly roundChanges: RoundChangeStore;
}

export class ProjectRuntimeManager {
    private readonly runtimes = new Map<string, ProjectRuntime>();

    has(id: string): boolean { return this.runtimes.has(id); }

    get(id: string, canonicalPath: string): ProjectRuntime {
        const existing = this.runtimes.get(id);
        if (existing) return existing;
        const project = new ProjectContext(canonicalPath);
        const runtime: ProjectRuntime = {
            id, project,
            rootProcesses: new ProcessSessionManager(),
            processOwners: new ProcessOwnerPool(new ProcessSessionManager()),
            roundChanges: new RoundChangeStore(),
        };
        this.runtimes.set(id, runtime);
        writeRuntimeLog("info", "project_runtime_created", { project: id });
        return runtime;
    }

    async remove(id: string): Promise<void> {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        this.runtimes.delete(id);
        try { await runtime.processOwners.shutdown(); }
        catch (error) {
            writeRuntimeLog("error", "project_runtime_shutdown_failed", {
                project: id, error: error instanceof Error ? error.message : String(error),
            });
        }
        writeRuntimeLog("info", "project_runtime_removed", { project: id });
    }

    async shutdownAll(): Promise<void> {
        await Promise.all([...this.runtimes.keys()].map((id) => this.remove(id)));
    }
}
