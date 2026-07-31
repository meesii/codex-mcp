import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expandHomePath } from "../config.js";

const execFileAsync = promisify(execFile);

/**
 * Resolve a usable cloudflared executable path.
 *
 * Order: explicit path → PATH → package `bin/cloudflared(.exe)` → cwd `bin/`.
 *
 * @param configured - Optional path from user config or prompt
 * @returns Absolute path that can be spawned
 */
export async function resolveCloudflaredBin(
    configured?: string,
): Promise<string> {
    if (configured?.trim()) {
        const candidate = normalizeBinPath(configured.trim());
        assertExecutable(candidate);
        return candidate;
    }

    const suggested = await suggestCloudflaredBin();
    if (suggested) {
        return suggested;
    }

    throw new Error(
        "cloudflared not found. Set cloudflaredBin in ~/.codex-mcp/config.json (e.g. path to bin/cloudflared.exe).",
    );
}

/**
 * Best-effort discovery for prompt defaults (does not throw).
 *
 * @param configured - Optional already-known path
 * @returns Absolute path or empty string
 */
export async function suggestCloudflaredBin(
    configured?: string,
): Promise<string> {
    if (configured?.trim()) {
        const candidate = normalizeBinPath(configured.trim());
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    const fromPath = await findOnPath(
        process.platform === "win32" ? "cloudflared.exe" : "cloudflared",
    );
    if (fromPath) {
        return fromPath;
    }

    if (process.platform === "win32") {
        const withoutExt = await findOnPath("cloudflared");
        if (withoutExt) {
            return withoutExt;
        }
    }

    for (const candidate of localBinCandidates()) {
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    return "";
}

/**
 * Check that cloudflared runs (`cloudflared --version`).
 *
 * @param bin - Executable path
 * @returns Version line when available
 */
export async function probeCloudflaredVersion(bin: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync(bin, ["--version"], {
        windowsHide: true,
        timeout: 15_000,
    });
    const text = `${stdout}\n${stderr}`.trim();
    const first = text.split(/\r?\n/).find((line) => line.trim());
    return first?.trim() || "cloudflared";
}

/**
 * Expand `~`, resolve relative paths against cwd, return absolute path.
 *
 * @param value - User-entered or config path
 * @returns Absolute filesystem path
 */
export function normalizeBinPath(value: string): string {
    const expanded = expandHomePath(value.trim());
    if (isAbsolute(expanded)) {
        return expanded;
    }
    return resolve(process.cwd(), expanded);
}

/**
 * @returns Candidate paths next to this package and under cwd
 */
function localBinCandidates(): string[] {
    const names =
        process.platform === "win32"
            ? ["cloudflared.exe", "cloudflared"]
            : ["cloudflared"];
    const roots = [getPackageRoot(), process.cwd()];
    const out: string[] = [];
    for (const root of roots) {
        for (const name of names) {
            out.push(join(root, "bin", name));
        }
    }
    return out;
}

/**
 * Package root containing `package.json` / `bin/`.
 *
 * @returns Absolute directory
 */
function getPackageRoot(): string {
    const here = fileURLToPath(new URL(".", import.meta.url));
    // src/tunnel or dist/tunnel → repo root
    return resolve(here, "../..");
}

/**
 * @param fileName - Binary name to search on PATH
 * @returns First match or undefined
 */
async function findOnPath(fileName: string): Promise<string | undefined> {
    const pathEnv = process.env.PATH ?? process.env.Path ?? "";
    const parts = pathEnv.split(delimiter).filter(Boolean);
    for (const dir of parts) {
        const candidate = join(dir, fileName);
        try {
            accessSync(candidate, constants.F_OK);
            return candidate;
        } catch {
            // try next
        }
    }

    try {
        const tool = process.platform === "win32" ? "where.exe" : "which";
        const { stdout } = await execFileAsync(tool, [fileName], {
            windowsHide: true,
            timeout: 10_000,
        });
        const first = stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        if (first) {
            assertExecutable(first);
            return first;
        }
    } catch {
        // ignore
    }
    return undefined;
}

/**
 * @param candidate - Path that must exist
 */
function assertExecutable(candidate: string): void {
    try {
        accessSync(candidate, constants.F_OK);
    } catch {
        throw new Error(`cloudflared binary not found: ${candidate}`);
    }
}
