import { realpathSync } from "node:fs";
import { relative } from "node:path";
import { resolveAllowedPath } from "../lib/fs/path-guard.js";
import { ProjectLock } from "../lib/fs/project-lock.js";

/** Strict project-root path boundary shared by all public coding tools. */
export class ProjectContext {
    readonly lock = new ProjectLock();
    readonly root: string;
    readonly roots: readonly string[];

    constructor(root: string) {
        this.root = realpathSync.native(root);
        this.roots = [this.root];
    }

    resolvePath(inputPath: string): string {
        return resolveAllowedPath(inputPath, this.root, this.roots);
    }

    displayPath(absolutePath: string): string {
        return relative(this.root, absolutePath).replaceAll("\\", "/") || ".";
    }
}
