import { createHash } from "node:crypto";
import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, resolve } from "node:path";
import { expandHomePath } from "../config/loader.js";

const ID_HASH_LENGTH = 8;

/**
 * Canonical absolute project path. Fails when the directory is missing so a
 * project cannot be registered against a path that no longer exists.
 */
export function canonicalProjectPath(input: string): string {
    const absolutePath = resolve(expandHomePath(input.trim()));
    if (!existsSync(absolutePath) || !statSync(absolutePath).isDirectory()) {
        throw new Error(`这个项目目录不存在或不是文件夹：${input}`);
    }
    return realpathSync.native(absolutePath);
}

/**
 * Project display name: package.json `name` when present, otherwise the final
 * directory name. Display names may collide across projects; ids must not.
 */
export function detectProjectDisplayName(root: string): string {
    try {
        const packagePath = resolve(root, "package.json");
        if (existsSync(packagePath)) {
            const raw = JSON.parse(readFileSync(packagePath, "utf8")) as {
                name?: unknown;
            };
            if (typeof raw.name === "string" && raw.name.trim()) {
                return raw.name.trim().slice(0, 200);
            }
        }
    } catch {
        // fall through to directory basename
    }
    return basename(root).slice(0, 200) || "project";
}

/**
 * Deterministic project id derived from the normalized display name plus a
 * hash of the canonical absolute path. Ids are stable across daemon restarts
 * and CLI invocations, and unique even when display names collide.
 */
export function deriveProjectId(displayName: string, canonicalPath: string): string {
    const slug =
        displayName
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 40) || "project";
    const hash = createHash("sha256")
        .update(canonicalPath)
        .digest("hex")
        .slice(0, ID_HASH_LENGTH);
    return `pkg-${slug}-${hash}`;
}
