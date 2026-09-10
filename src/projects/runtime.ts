import { ProjectContext } from "../config/project.js";
import { CapabilityManager } from "../capabilities/manager.js";
import { CapabilityWatcher } from "../capabilities/runtime.js";
import { DownstreamMcpHub } from "../downstream/hub.js";
import { ProcessOwnerPool } from "../lib/process/owner-pool.js";
import { ProcessSessionManager } from "../lib/process/sessions.js";
import { RoundChangeStore } from "../lib/tool/round-changes.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import type { SkillRegistry } from "../skills/registry.js";

export interface ProjectRuntime {
    readonly id: string;
    readonly project: ProjectContext;
    readonly rootProcesses: ProcessSessionManager;
    readonly processOwners: ProcessOwnerPool;
    readonly roundChanges: RoundChangeStore;
}

export interface ProjectCapabilityRuntime {
    readonly manager: CapabilityManager;
    readonly hub: DownstreamMcpHub;
    readonly skills: SkillRegistry;
    readonly watcher: CapabilityWatcher;
}

export class ProjectRuntimeManager {
    private readonly runtimes = new Map<string, ProjectRuntime>();
    private readonly capabilityRuntimes = new Map<string, Promise<ProjectCapabilityRuntime>>();

    has(id: string): boolean { return this.runtimes.has(id); }

    get(id: string, canonicalPath: string): ProjectRuntime {
        const existing = this.runtimes.get(id);
        if (existing) return existing;
        const project = new ProjectContext(canonicalPath);
        const rootProcesses = new ProcessSessionManager();
        const runtime: ProjectRuntime = {
            id, project,
            rootProcesses,
            processOwners: new ProcessOwnerPool(rootProcesses),
            roundChanges: new RoundChangeStore(),
        };
        this.runtimes.set(id, runtime);
        writeRuntimeLog("info", "project_runtime_created", { project: id });
        return runtime;
    }

    async getCapabilities(id: string, canonicalPath: string): Promise<ProjectCapabilityRuntime> {
        const existing = this.capabilityRuntimes.get(id);
        if (existing) return await existing;
        // Ensure the path is validated and the ordinary runtime exists before external
        // project capabilities are allowed to start any downstream process.
        this.get(id, canonicalPath);
        const pending = this.createCapabilities(id, canonicalPath);
        this.capabilityRuntimes.set(id, pending);
        try {
            return await pending;
        } catch (error) {
            if (this.capabilityRuntimes.get(id) === pending) this.capabilityRuntimes.delete(id);
            throw error;
        }
    }

    async shutdownOwner(id: string, ownerId: string): Promise<void> {
        const runtime = this.runtimes.get(id);
        if (!runtime) return;
        await runtime.processOwners.shutdownOwner(ownerId);
    }

    async remove(id: string): Promise<void> {
        const runtime = this.runtimes.get(id);
        const capability = this.capabilityRuntimes.get(id);
        if (!runtime && !capability) return;
        const errors: unknown[] = [];
        if (runtime) {
            try { await runtime.processOwners.shutdown(); }
            catch (error) { errors.push(error); }
        }
        if (capability) {
            try {
                const resolved = await capability;
                resolved.watcher.close();
                await resolved.hub.close();
            } catch (error) {
                errors.push(error);
            }
        }
        for (const error of errors) {
            writeRuntimeLog("error", "project_runtime_shutdown_failed", {
                project: id, error: error instanceof Error ? error.message : String(error),
            });
        }
        if (errors.length > 0) {
            throw new AggregateError(errors, `项目 ${id} 的运行资源清理未完成，可重试 project remove`);
        }
        if (this.runtimes.get(id) === runtime) this.runtimes.delete(id);
        if (this.capabilityRuntimes.get(id) === capability) this.capabilityRuntimes.delete(id);
        writeRuntimeLog("info", "project_runtime_removed", { project: id });
    }

    async shutdownAll(): Promise<void> {
        const ids = new Set([...this.runtimes.keys(), ...this.capabilityRuntimes.keys()]);
        const results = await Promise.allSettled([...ids].map((id) => this.remove(id)));
        const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason] : []);
        if (errors.length) throw new AggregateError(errors, "部分项目运行资源清理失败");
    }

    private async createCapabilities(id: string, canonicalPath: string): Promise<ProjectCapabilityRuntime> {
        const manager = new CapabilityManager(canonicalPath, {
            includeUserScopes: true,
            includeProjectScopes: true,
        });
        const hub = await DownstreamMcpHub.connectFromDefaultConfig({
            loadConfig: () => manager.loadMcpConfig(),
        });
        const skills = manager.createSkillRegistry();
        const watcher = new CapabilityWatcher(manager, hub, skills);
        watcher.start();
        writeRuntimeLog("info", "project_capabilities_created", {
            project: id,
            downstream: hub.listServers().length,
            skills: skills.list().length,
        });
        return { manager, hub, skills, watcher };
    }
}
