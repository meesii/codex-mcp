import {
    canonicalProjectPath,
    deriveProjectId,
    detectProjectDisplayName,
} from "./identity.js";
import {
    loadProjectsFile,
    saveProjectsFile,
    type RegisteredProject,
} from "../daemon/state.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import { AsyncMutex } from "../lib/util/mutex.js";

/**
 * In-memory registry of registered projects backed by `~/.codex-mcp/projects.json`.
 *
 * New project ids are deterministic, while an already-registered canonical path
 * keeps its original id forever. Display-name/package-name changes are metadata
 * updates only: changing them must not invalidate durable conversation bindings
 * or leave an orphaned runtime under the previous id.
 */
export class ProjectRegistry {
    private projects: RegisteredProject[];
    private readonly save: (projects: RegisteredProject[]) => Promise<void>;
    private readonly mutex = new AsyncMutex();

    constructor(options: {
        projects?: RegisteredProject[];
        save?: (projects: RegisteredProject[]) => Promise<void>;
    } = {}) {
        this.projects = (options.projects ?? loadProjectsFile()).map((item) => ({ ...item }));
        this.save = options.save ?? saveProjectsFile;
    }

    list(): RegisteredProject[] {
        return this.projects.map((item) => ({ ...item }));
    }

    listActive(): RegisteredProject[] {
        return this.projects.filter((item) => item.active).map((item) => ({ ...item }));
    }

    getById(id: string): RegisteredProject | undefined {
        const project = this.projects.find((item) => item.id === id);
        return project ? { ...project } : undefined;
    }

    getActiveById(id: string): RegisteredProject | undefined {
        const project = this.projects.find((item) => item.id === id && item.active);
        return project ? { ...project } : undefined;
    }

    getByPath(path: string): RegisteredProject | undefined {
        const project = this.projects.find((item) => item.path === path);
        return project ? { ...project } : undefined;
    }

    /** Register or refresh a project. Returns the canonical registered entry. */
    async register(input: { path: string; name?: string }): Promise<RegisteredProject> {
        return await this.mutex.runExclusive(async () => {
            const canonicalPath = canonicalProjectPath(input.path);
            const now = new Date().toISOString();
            const existing = this.getByPath(canonicalPath);

            if (existing) {
                const name = input.name?.trim() || existing.name || detectProjectDisplayName(canonicalPath);
                const updated: RegisteredProject = {
                    ...existing,
                    name,
                    active: true,
                    lastSeenAt: now,
                };
                const nextProjects = this.projects.map((item) =>
                    item.path === canonicalPath ? updated : item,
                );
                await this.persist(nextProjects);
                this.projects = nextProjects;
                return { ...updated };
            }

            const name = input.name?.trim() || detectProjectDisplayName(canonicalPath);
            const id = deriveProjectId(name, canonicalPath);
            const collision = this.projects.find((item) => item.id === id && item.path !== canonicalPath);
            if (collision) {
                throw new Error(
                    `项目 ID 冲突：${canonicalPath} 与 ${collision.path} 生成了相同 ID ${id}；已拒绝注册以避免跨项目误路由`,
                );
            }
            const entry: RegisteredProject = {
                id,
                name,
                path: canonicalPath,
                active: true,
                addedAt: now,
                lastSeenAt: now,
            };
            const nextProjects = [...this.projects, entry];
            await this.persist(nextProjects);
            this.projects = nextProjects;
            return { ...entry };
        });
    }

    async deactivateById(id: string): Promise<RegisteredProject | undefined> {
        return await this.mutex.runExclusive(async () => {
            const target = this.getById(id);
            if (!target || !target.active) return undefined;
            return await this.setActive(target, false);
        });
    }

    async deactivateByPath(path: string): Promise<RegisteredProject | undefined> {
        return await this.mutex.runExclusive(async () => {
            const canonicalPath = canonicalProjectPath(path);
            const target = this.getByPath(canonicalPath);
            if (!target || !target.active) return undefined;
            return await this.setActive(target, false);
        });
    }

    private async setActive(target: RegisteredProject, active: boolean): Promise<RegisteredProject> {
        const updated = { ...target, active };
        const nextProjects = this.projects.map((item) =>
            item.id === target.id ? updated : item,
        );
        await this.persist(nextProjects);
        this.projects = nextProjects;
        return { ...updated };
    }

    private async persist(projects: RegisteredProject[]): Promise<void> {
        try {
            await this.save(projects);
        } catch (error: unknown) {
            const detail = error instanceof Error ? error.message : String(error);
            writeRuntimeLog("error", "project_state_save_failed", { error: detail });
            throw error;
        }
    }
}
