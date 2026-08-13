import { createHash, randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { createWriteStream } from "node:fs";
import {
    chmod,
    copyFile,
    mkdir,
    mkdtemp,
    rename,
    rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pipeline } from "node:stream/promises";
import { promisify } from "node:util";
import { get as httpsGet } from "node:https";
import { HttpsProxyAgent } from "https-proxy-agent";
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
        await rm(target, { force: true });
        await rename(staged, target);

        const installedVersion = await probeVersion(target);
        if (!installedVersion?.includes(spec.version)) {
            await rm(target, { force: true });
            throw new Error(`${spec.label} 安装后无法正常启动`);
        }

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
            timeout: 10_000,
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
    redirects = 0,
): Promise<void> {
    if (redirects > 6) {
        throw new Error("下载重定向次数过多");
    }
    await mkdir(dirname(destination), { recursive: true });

    await new Promise<void>((resolve, reject) => {
        const proxyUrl = process.env.HTTPS_PROXY ?? process.env.https_proxy;
        const agent = proxyUrl ? new HttpsProxyAgent(proxyUrl) : undefined;
        const request = httpsGet(
            url,
            {
                agent,
                headers: { "user-agent": "codex-mcp-managed-tools" },
            },
            (response) => {
                const status = response.statusCode ?? 0;
                const location = response.headers.location;
                if (status >= 300 && status < 400 && location) {
                    response.resume();
                    const nextUrl = new URL(location, url).href;
                    void downloadVerified(nextUrl, destination, expectedSha256, redirects + 1)
                        .then(resolve, reject);
                    return;
                }
                if (status !== 200) {
                    response.resume();
                    reject(new Error(`下载失败（HTTP ${status}）`));
                    return;
                }

                const hash = createHash("sha256");
                response.on("data", (chunk: Buffer) => hash.update(chunk));
                void pipeline(response, createWriteStream(destination, { mode: 0o600 }))
                    .then(() => {
                        const actual = hash.digest("hex");
                        if (actual !== expectedSha256) {
                            reject(new Error("下载文件校验失败，请重新尝试"));
                            return;
                        }
                        resolve();
                    })
                    .catch(reject);
            },
        );
        request.setTimeout(30_000, () => {
            request.destroy(new Error("下载超时，请检查网络后重试"));
        });
        request.on("error", reject);
    });
}
