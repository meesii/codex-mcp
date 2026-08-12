import { realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import {
    AccessDeniedError,
    canonicalizePotentialPath,
    isPathInsideRoot,
    resolveAllowedPath,
} from "../lib/fs/path-guard.js";
import { ProjectLock } from "../lib/fs/project-lock.js";
import { expandHomePath } from "./loader.js";

/**
 * Primary project plus additional trusted workspace roots used by coding tools.
 *
 * Relative paths remain anchored to the primary root for compatibility. Absolute
 * paths may address additional workspaces. Read tools may also use arbitrary
 * absolute paths through resolveReadPath(); mutation/exec callers authorize any
 * candidate that is not under a registered workspace root.
 */
export class ProjectContext {
    readonly lock = new ProjectLock();
    readonly root: string;
    readonly roots: string[];

    constructor(root: string, workspaceRoots: string[] = [root]) {
        this.root = realpathSync.native(root);
        this.roots = Array.from(
            new Set(
                [this.root, ...workspaceRoots]
                    .map((item) => realpathSync.native(resolve(expandHomePath(item))))
            ),
        );
    }

    /** Resolve a path that must remain under one of the registered workspaces. */
    resolvePath(inputPath: string): string {
        return resolveAllowedPath(inputPath, this.root, this.roots);
    }

    /** Resolve a readable path without imposing a workspace boundary. */
    resolveReadPath(inputPath: string): string {
        return canonicalizePotentialPath(this.resolveInput(inputPath));
    }

    /** Resolve a potential mutation/exec target before permission evaluation. */
    resolveExternalPath(inputPath: string): string {
        return canonicalizePotentialPath(this.resolveInput(inputPath));
    }

    isWorkspacePath(pathValue: string): boolean {
        return this.roots.some((workspaceRoot) => isPathInsideRoot(pathValue, workspaceRoot));
    }

    resolveWorkspaceRoot(pathValue: string): string {
        const absolute = resolve(expandHomePath(pathValue));
        if (!statSync(absolute).isDirectory()) {
            throw new Error(`Workspace root is not a directory: ${pathValue}`);
        }
        return realpathSync.native(absolute);
    }

    addWorkspaceRoot(pathValue: string): string {
        const canonical = this.resolveWorkspaceRoot(pathValue);
        if (!this.roots.includes(canonical)) this.roots.push(canonical);
        return canonical;
    }

    requireAdditionalWorkspaceRoot(pathValue: string): string {
        const canonical = canonicalizePotentialPath(resolve(expandHomePath(pathValue)));
        if (canonical === this.root) {
            throw new Error("The primary workspace cannot be removed while codex-mcp is running.");
        }
        if (!this.roots.includes(canonical)) {
            throw new Error(`Workspace is not registered: ${pathValue}`);
        }
        return canonical;
    }

    removeWorkspaceRoot(pathValue: string): string {
        const canonical = this.requireAdditionalWorkspaceRoot(pathValue);
        this.roots.splice(this.roots.indexOf(canonical), 1);
        return canonical;
    }

    /** Stable model/user-facing path: primary-root relative, otherwise absolute. */
    displayPath(absolutePath: string): string {
        if (isPathInsideRoot(absolutePath, this.root)) {
            return relative(this.root, absolutePath).replaceAll("\\", "/") || ".";
        }
        return absolutePath;
    }

    /** Default directory scope for a file mutation grant. */
    writePermissionScope(absolutePath: string): string {
        return dirname(absolutePath);
    }

    private resolveInput(inputPath: string): string {
        const expanded = expandHomePath(inputPath.trim() || ".");
        return isAbsolute(expanded) ? resolve(expanded) : resolve(this.root, expanded);
    }
}

export { AccessDeniedError };
