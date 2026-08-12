import {
    lstatSync,
    readlinkSync,
    realpathSync,
} from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep, win32 } from "node:path";
import { expandHomePath } from "../../config/loader.js";

export class AccessDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "AccessDeniedError";
    }
}

export function isPathInsideRoot(pathValue: string, root: string): boolean {
    const resolvedPath = resolve(expandHomePath(pathValue));
    const resolvedRoot = resolve(expandHomePath(root));
    const relationship = relative(resolvedRoot, resolvedPath);
    return isRelativeInside(relationship);
}

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

export function assertAllowedPath(pathValue: string, allowedRoots: string[]): string {
    const resolvedPath = resolve(expandHomePath(pathValue));
    const canonicalPath = canonicalizePotentialPath(resolvedPath);

    for (const root of allowedRoots) {
        const resolvedRoot = resolve(expandHomePath(root));
        const canonicalRoot = realpathSync.native(resolvedRoot);
        const relationship = relative(canonicalRoot, canonicalPath);
        if (isRelativeInside(relationship)) {
            return canonicalPath;
        }
    }

    throw new AccessDeniedError(`Path is outside registered workspaces: ${pathValue}`);
}

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

export function isPathRelationshipInside(relationship: string): boolean {
    if (relationship === "") return true;
    if (isAbsolute(relationship) || win32.isAbsolute(relationship)) return false;
    return (
        relationship !== ".." &&
        !relationship.startsWith(`..${sep}`) &&
        !relationship.startsWith("../") &&
        !relationship.startsWith("..\\")
    );
}

function isRelativeInside(relationship: string): boolean {
    return isPathRelationshipInside(relationship);
}
