import { realpathSync } from "node:fs";
import {
    AccessDeniedError,
    resolveAllowedPath,
} from "./lib/path-guard.js";
import { ProjectLock } from "./lib/project-lock.js";

/**
 * Startup-bound project directory used by all coding tools.
 */
export class ProjectContext {
    readonly lock = new ProjectLock();
    readonly root: string;

    /**
     * @param root - Absolute project root from server config
     */
    constructor(root: string) {
        this.root = realpathSync.native(root);
    }

    /**
     * Resolve a path inside the project root (must stay under root).
     *
     * @param inputPath - Relative or absolute path
     * @returns Absolute path under the project root
     */
    resolvePath(inputPath: string): string {
        return resolveAllowedPath(inputPath, this.root, [this.root]);
    }
}

export { AccessDeniedError };
