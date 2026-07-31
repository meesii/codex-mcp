import { isAbsolute, relative, resolve, sep } from "node:path";
import { expandHomePath } from "../config.js";

export class AccessDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AccessDeniedError";
    }
}

/**
 * Check whether `pathValue` is inside `root` (inclusive).
 *
 * @param pathValue - Candidate path
 * @param root - Allowed root directory
 * @returns True when the path is under the root
 */
export function isPathInsideRoot(pathValue: string, root: string): boolean {
    const resolvedPath = resolve(expandHomePath(pathValue));
    const resolvedRoot = resolve(expandHomePath(root));
    const relationship = relative(resolvedRoot, resolvedPath);

    return (
        relationship === "" ||
        (!isAbsolute(relationship) &&
            !relationship.startsWith("..") &&
            relationship !== ".." &&
            !relationship.includes(`..${sep}`))
    );
}

/**
 * Ensure a path sits under at least one allowed root.
 *
 * @param pathValue - Candidate path
 * @param allowedRoots - Configured allow-list roots
 * @returns Resolved absolute path
 */
export function assertAllowedPath(pathValue: string, allowedRoots: string[]): string {
    const resolvedPath = resolve(expandHomePath(pathValue));
    if (allowedRoots.some((root) => isPathInsideRoot(resolvedPath, root))) {
        return resolvedPath;
    }

    throw new AccessDeniedError(`Path is outside project root: ${pathValue}`);
}

/**
 * Resolve a user path against a workspace cwd and enforce allow-list roots.
 *
 * @param inputPath - Relative or absolute path from the model
 * @param cwd - Workspace root used as base for relative paths
 * @param allowedRoots - Configured allow-list roots
 * @returns Resolved absolute path inside an allowed root
 */
export function resolveAllowedPath(
    inputPath: string,
    cwd: string,
    allowedRoots: string[],
): string {
    const absolutePath = resolve(cwd, inputPath);
    return assertAllowedPath(absolutePath, allowedRoots);
}
