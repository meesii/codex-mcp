import {
    lstatSync,
    readlinkSync,
    realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { expandHomePath } from "../config.js";

export class AccessDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AccessDeniedError";
    }
}

/** Check whether a lexical path is inside a lexical root (inclusive). */
export function isPathInsideRoot(pathValue: string, root: string): boolean {
    const resolvedPath = resolve(expandHomePath(pathValue));
    const resolvedRoot = resolve(expandHomePath(root));
    const relationship = relative(resolvedRoot, resolvedPath);
    return isRelativeInside(relationship);
}

/**
 * Resolve symlinks for an existing path. For a new path, canonicalize the
 * nearest directory/file-system ancestor and append the non-existent suffix.
 * Dangling symlinks are resolved from their link target rather than treated as
 * ordinary new files, which prevents write-through escapes.
 */
export function canonicalizePotentialPath(pathValue: string): string {
    return canonicalizePotentialPathInner(
        resolve(expandHomePath(pathValue)),
        new Set<string>(),
    );
}

function canonicalizePotentialPathInner(
    absolutePath: string,
    seenSymlinks: Set<string>,
): string {
    let existing = absolutePath;
    while (!entryExists(existing)) {
        const parent = dirname(existing);
        if (parent === existing) {
            throw new AccessDeniedError(`No existing ancestor for path: ${absolutePath}`);
        }
        existing = parent;
    }

    const suffix = existing === absolutePath ? "" : relative(existing, absolutePath);
    const info = lstatSync(existing);
    let canonicalExisting: string;
    if (info.isSymbolicLink()) {
        if (seenSymlinks.has(existing)) {
            throw new AccessDeniedError(`Symlink cycle is not allowed: ${existing}`);
        }
        seenSymlinks.add(existing);
        const target = resolve(dirname(existing), readlinkSync(existing));
        canonicalExisting = canonicalizePotentialPathInner(target, seenSymlinks);
    } else {
        canonicalExisting = realpathSync.native(existing);
    }

    if (!suffix) return canonicalExisting;
    if (!isRelativeInside(suffix)) {
        throw new AccessDeniedError(`Invalid path: ${absolutePath}`);
    }
    return resolve(canonicalExisting, suffix);
}

/** Ensure a path is lexically and canonically contained by an allowed root. */
export function assertAllowedPath(pathValue: string, allowedRoots: string[]): string {
    const resolvedPath = resolve(expandHomePath(pathValue));

    for (const root of allowedRoots) {
        const resolvedRoot = resolve(expandHomePath(root));
        if (!isPathInsideRoot(resolvedPath, resolvedRoot)) continue;

        const canonicalRoot = realpathSync.native(resolvedRoot);
        const canonicalPath = canonicalizePotentialPath(resolvedPath);
        const relationship = relative(canonicalRoot, canonicalPath);
        if (isRelativeInside(relationship)) {
            return canonicalPath;
        }
    }

    throw new AccessDeniedError(`Path is outside project root: ${pathValue}`);
}

/** Resolve a user path against cwd and enforce project-root containment. */
export function resolveAllowedPath(
    inputPath: string,
    cwd: string,
    allowedRoots: string[],
): string {
    const absolutePath = resolve(cwd, inputPath);
    return assertAllowedPath(absolutePath, allowedRoots);
}

function entryExists(pathValue: string): boolean {
    try {
        lstatSync(pathValue);
        return true;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
        throw error;
    }
}

function isRelativeInside(relationship: string): boolean {
    return (
        relationship === "" ||
        (!isAbsolute(relationship) &&
            relationship !== ".." &&
            !relationship.startsWith(`..${sep}`))
    );
}
