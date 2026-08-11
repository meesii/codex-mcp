import { realpathSync } from "node:fs";
import {
    AccessDeniedError,
    resolveAllowedPath,
} from "../lib/fs/path-guard.js";
import { ProjectLock } from "../lib/fs/project-lock.js";

/**
 * Startup-bound project directory used by all coding tools.
 */
export class ProjectContext {
    readonly lock = new ProjectLock();
    readonly root: string;

    
    constructor(root: string) {
        this.root = realpathSync.native(root);
    }

    
    resolvePath(inputPath: string): string {
        return resolveAllowedPath(inputPath, this.root, [this.root]);
    }
}

export { AccessDeniedError };
