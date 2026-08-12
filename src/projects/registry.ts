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

/**
 * In-memory registry of registered projects backed by `~/.codex-mcp/projects.json`.
 *
 * Project ids are deterministic (path + display name hash), so a CLI invocation
 * can derive the same id without a round trip. `register` matches on canonical
 * path first so a display-name change updates the entry instead of duplicating it.
 */
export class ProjectRegistry {
    private projects: RegisteredProject[];
    private readonly save: (projects: RegisteredProject[]) => Promise<void>;

    constructor(options: {
        projects?: RegisteredProject[];
        save?: (projects: RegisteredProject[]) => Promise<void>;
    } = {}) {
        this.projects = (options.projects ?? loadProjectsFile()).map((item) => ({ ...item }));
        this.save = options.save ?? saveProjectsFile;
    }

    list(): RegisteredProject[] {
        return [...this.projects];
    }

    listActive(): RegisteredProject[] {
        return this.projects.filter((item) => item.active);
    }

    getById(id: string): RegisteredProject | undefined {
        return this.projects.find((item) => item.id === id);
    }

    getActiveById(id: string): RegisteredProject | undefined {
        return this.projects.find((item) => item.id === id && item.active);
    }

    getByPath(path: string): RegisteredProject | undefined {
        return this.projects.find((item) => item.path === path);
    }

    /** Register or refresh a project. Returns the canonical registered entry. */
    register(input: { path: string; name?: string }): RegisteredProject {
        const canonicalPath = canonicalProjectPath(input.path);
        const now = new Date().toISOString();
        const existing = this.getByPath(canonicalPath);

        if (existing) {
            const name = input.name?.trim() || existing.name || detectProjectDisplayName(canonicalPath);
            const id = deriveProjectId(name, canonicalPath);
            const updated: RegisteredProject = {
                ...existing,
                id,
                name,
                active: true,
                lastSeenAt: now,
            };
            this.projects = this.projects.map((item) =>
                item.path === canonicalPath ? updated : item,
            );
            void this.persist();
            return { ...updated };
        }

        const name = input.name?.trim() || detectProjectDisplayName(canonicalPath);
        const entry: RegisteredProject = {
            id: deriveProjectId(name, canonicalPath),
            name,
            path: canonicalPath,
            active: true,
            addedAt: now,
            lastSeenAt: now,
        };
        this.projects.push(entry);
        void this.persist();
        return { ...entry };
    }

    deactivateById(id: string): RegisteredProject | undefined {
        const target = this.getById(id);
        if (!target || !target.active) return undefined;
        return this.setActive(target, false);
    }

    deactivateByPath(path: string): RegisteredProject | undefined {
        const canonicalPath = canonicalProjectPath(path);
        const target = this.getByPath(canonicalPath);
        if (!target || !target.active) return undefined;
        return this.setActive(target, false);
    }

    deactivateAll(): void {
        const changed = this.projects.some((item) => item.active);
        if (!changed) return;
        this.projects = this.projects.map((item) => ({ ...item, active: false }));
        void this.persist();
    }

    private setActive(target: RegisteredProject, active: boolean): RegisteredProject {
        const updated = { ...target, active };
        this.projects = this.projects.map((item) =>
            item.id === target.id ? updated : item,
        );
        void this.persist();
        return { ...updated };
    }

    private persist(): void {
        this.save(this.projects).catch((error: unknown) => {
            const detail = error instanceof Error ? error.message : String(error);
            writeRuntimeLog("error", "project_state_save_failed", { error: detail });
        });
    }
}
