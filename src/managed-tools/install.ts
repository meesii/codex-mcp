import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    rename,
    rm,
    writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { safeHttpGet } from "../lib/http/safe-http.js";
import * as tar from "tar";
import { getManagedToolSpec } from "./manifest.js";
import { extractZipFile } from "./unzip.js";
import {
    getManagedBinDir,
    getManagedToolPath,
    type ManagedToolName,
} from "./paths.js";

const execFileAsync = promisify(execFile);

export interface ManagedToolInstallResult {
    tool: ManagedToolName;
    label: string;
    version: string;
    path: string;
    installed: boolean;
}

export async function ensureManagedTool(
    tool: ManagedToolName,
): Promise<ManagedToolInstallResult> {
    const spec = getManagedToolSpec(tool);
    const target = getManagedToolPath(tool);
    const current = await probeVersion(target);
    if (current?.includes(spec.version)) {
        return {
            tool,
            label: spec.label,
            version: spec.version,
            path: target,
            installed: false,
        };
    }

    const tempRoot = await mkdtemp(join(tmpdir(), "codex-mcp-tools-"));
    try {
        const assetPath = join(tempRoot, "asset");
        await downloadVerified(spec.url, assetPath, spec.sha256);

        let sourcePath = assetPath;
        if (spec.archive !== "raw") {
            const extractDir = join(tempRoot, "extract");
            await mkdir(extractDir, { recursive: true });
            if (spec.archive === "zip") {
                await extractZipFile(assetPath, extractDir);
            } else {
                await tar.x({ file: assetPath, cwd: extractDir });
            }
            if (!spec.archiveEntry) {
                throw new Error(`${spec.label} 安装包缺少目标文件信息`);
            }
            sourcePath = join(extractDir, ...spec.archiveEntry.split("/"));
        }

        await mkdir(getManagedBinDir(), { recursive: true });
        const staged = `${target}.${process.pid}.${randomUUID()}.tmp`;
        await copyFile(sourcePath, staged);
        if (process.platform !== "win32") {
            await chmod(staged, 0o755);
        }
        await replaceManagedBinary(staged, target, spec.label, spec.version);

        return {
            tool,
            label: spec.label,
            version: spec.version,
            path: target,
            installed: true,
        };
    } finally {
        await rm(tempRoot, { recursive: true, force: true }).catch(() => undefined);
    }
}

export async function ensureManagedTools(
    tools: ManagedToolName[],
): Promise<ManagedToolInstallResult[]> {
    const results: ManagedToolInstallResult[] = [];
    for (const tool of tools) {
        results.push(await ensureManagedTool(tool));
    }
    return results;
}

async function probeVersion(binary: string): Promise<string | undefined> {
    try {
        const { stdout, stderr } = await execFileAsync(binary, ["--version"], {
            windowsHide: true,
            timeout: 30_000,
        });
        return `${stdout}\n${stderr}`.trim();
    } catch {
        return undefined;
    }
}

async function downloadVerified(
    url: string,
    destination: string,
    expectedSha256: string,
): Promise<void> {
    const response = await safeHttpGet(url, {
        httpsOnly: true,
        timeoutMs: 600_000,
        maxRedirects: 6,
        maxBytes: 128 * 1024 * 1024,
        headers: { "user-agent": "codex-mcp-managed-tools" },
    });
    if (response.status !== 200) {
        throw new Error(`下载失败（HTTP ${response.status}）`);
    }
    const actual = createHash("sha256").update(response.body).digest("hex");
    if (actual !== expectedSha256) {
        throw new Error("下载文件校验失败，请重新尝试");
    }
    await writeFile(destination, response.body, { mode: 0o600 });
}

async function replaceManagedBinary(
    staged: string,
    target: string,
    label: string,
    expectedVersion: string,
): Promise<void> {
    const backup = `${target}.${process.pid}.${randomUUID()}.bak`;
    let backedUp = false;
    try {
        try {
            await copyFile(target, backup);
            backedUp = true;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }

        try {
            await rename(staged, target);
        } catch (error) {
            const code = (error as NodeJS.ErrnoException).code;
            if (process.platform !== "win32" || !["EACCES", "EEXIST", "EPERM"].includes(code ?? "")) {
                throw error;
            }
            await rm(target, { force: true });
            await rename(staged, target);
        }

        const installedVersion = await probeVersion(target);
        if (!installedVersion?.includes(expectedVersion)) {
            throw new Error(`${label} 安装后无法正常启动`);
        }
    } catch (error) {
        if (backedUp) {
            await copyFile(backup, target).catch(() => undefined);
        } else {
            await rm(target, { force: true }).catch(() => undefined);
        }
        throw error;
    } finally {
        await rm(staged, { force: true }).catch(() => undefined);
        await rm(backup, { force: true }).catch(() => undefined);
    }
}
