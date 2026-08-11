import { accessSync, constants, existsSync } from "node:fs";
import { delimiter, isAbsolute, join, resolve } from "node:path";
import { execFile } from "node:child_process";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { expandHomePath } from "../config/loader.js";
import { getManagedToolPath } from "../managed-tools/paths.js";

const execFileAsync = promisify(execFile);

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

    throw new Error("没有找到 cloudflared。请先安装 cloudflared，再运行 `codex-mcp setup`");
}

export async function suggestCloudflaredBin(
    configured?: string,
): Promise<string> {
    if (configured?.trim()) {
        const candidate = normalizeBinPath(configured.trim());
        if (existsSync(candidate)) {
            return candidate;
        }
    }

    const managed = getManagedToolPath("cloudflared");
    if (existsSync(managed)) {
        return managed;
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

export async function probeCloudflaredVersion(bin: string): Promise<string> {
    const { stdout, stderr } = await execFileAsync(bin, ["--version"], {
        windowsHide: true,
        timeout: 15_000,
    });
    const text = `${stdout}\n${stderr}`.trim();
    const first = text.split(/\r?\n/).find((line) => line.trim());
    return first?.trim() || "cloudflared";
}

export function normalizeBinPath(value: string): string {
    const expanded = expandHomePath(value.trim());
    if (isAbsolute(expanded)) {
        return expanded;
    }
    return resolve(process.cwd(), expanded);
}

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

function getPackageRoot(): string {
    const here = fileURLToPath(new URL(".", import.meta.url));
    // src/tunnel or dist/tunnel → repo root
    return resolve(here, "../..");
}

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

function assertExecutable(candidate: string): void {
    try {
        accessSync(candidate, constants.F_OK);
    } catch {
        throw new Error(`找不到 cloudflared：${candidate}`);
    }
}
