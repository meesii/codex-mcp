import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { copyPrivateFileAtomic } from "../lib/fs/atomic-file.js";
import { printInfo, printSuccess, printWarning } from "../lib/util/terminal.js";
import {
    getCloudflareOriginCertPath,
    hasManagedCloudflareLogin,
    parseCloudflareOriginToken,
    readManagedCloudflareOriginToken,
    readTunnelCredentialIdentity,
    type CloudflareOriginToken,
} from "./cloudflare-account.js";
import { runCloudflared, runCloudflaredInherit } from "./exec.js";
import { withSpinner } from "./prompt.js";
import {
    ensureCloudflaredManagementConfig,
    getCredentialsPath,
    getManagedCloudflareDir,
} from "./yml.js";

const TUNNEL_ID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export async function ensureLogin(
    bin: string,
    force: boolean,
    options: { signal?: AbortSignal; onOutput?: (text: string) => void } = {},
): Promise<CloudflareOriginToken> {
    if (!force && hasManagedCloudflareLogin()) {
        printSuccess("已登录 Cloudflare，无需重复登录。");
        return readManagedCloudflareOriginToken();
    }
    if (force) {
        printInfo("将在临时目录重新登录；新凭据验证成功前会保留旧登录。");
    } else if (existsSync(getCloudflareOriginCertPath())) {
        printWarning("codex-mcp 保存的 Cloudflare 登录凭据无效，将安全地重新登录。");
    }

    mkdirSync(getManagedCloudflareDir(), { recursive: true });
    const candidateHome = mkdtempSync(join(getManagedCloudflareDir(), ".login-"));
    const candidateCert = join(candidateHome, ".cloudflared", "cert.pem");
    try {
        printInfo("正在打开浏览器，请登录 Cloudflare 并完成授权…");
        const code = options.signal || options.onOutput
            ? (await runCloudflared(
                  bin,
                  cloudflaredManagementArgs("login"),
                  {
                      managedHome: candidateHome,
                      allowFailure: true,
                      signal: options.signal,
                      onOutput: options.onOutput,
                  },
              )).code ?? 1
            : await runCloudflaredInherit(
                  bin,
                  cloudflaredManagementArgs("login"),
                  { managedHome: candidateHome },
              );
        if (code !== 0 || !existsSync(candidateCert)) {
            throw new Error("Cloudflare 登录没有完成；旧登录保持不变");
        }
        const token = parseCloudflareOriginToken(readFileSync(candidateCert, "utf8"));
        copyPrivateFileAtomic(candidateCert, getCloudflareOriginCertPath());
        printSuccess("Cloudflare 登录凭据已安全更新。");
        return token;
    } finally {
        rmSync(candidateHome, { recursive: true, force: true });
    }
}

export async function ensureTunnelCreated(
    bin: string,
    preferredName: string,
    accountId: string,
    knownId?: string,
): Promise<{ id: string; name: string; created: boolean }> {
    const existing = await withSpinner(
        "正在检查现有 Cloudflare Tunnel…",
        "Cloudflare Tunnel 检查完成",
        () => findTunnelIdByName(bin, preferredName),
    );
    if (knownId && existing === knownId && hasMatchingCredential(knownId, accountId)) {
        printSuccess(`继续使用现有 Tunnel：${preferredName}`);
        return { id: knownId, name: preferredName, created: false };
    }
    if (existing && hasMatchingCredential(existing, accountId)) {
        printSuccess(`继续使用现有 Tunnel：${preferredName}`);
        return { id: existing, name: preferredName, created: false };
    }

    let name = preferredName;
    if (existing) {
        name = `${preferredName}-${randomUUID().slice(0, 8)}`;
        printWarning(
            `Cloudflare 上已有同名 Tunnel，但本机没有它的凭据；不会删除远端资源，将创建替代 Tunnel：${name}`,
        );
    }
    const result = await withSpinner(
        "正在创建 Cloudflare Tunnel…",
        "Cloudflare Tunnel 创建请求完成",
        () => runCloudflared(bin, cloudflaredManagementArgs("create", name), { allowFailure: true }),
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    const outputId = result.code === 0 ? combined.match(TUNNEL_ID_RE)?.[0] : undefined;
    let created = outputId;
    let reconciliationError: unknown;
    if (!created) {
        try {
            created = await findTunnelIdByName(bin, name);
        } catch (error) {
            reconciliationError = error;
        }
    }
    if (created) {
        try {
            assertCredentialMatches(getCredentialsPath(created), created, accountId);
            if (result.code !== 0 || !outputId) {
                printWarning("Tunnel 创建结果已通过远端列表与本机凭据核对。");
            }
            printSuccess("Tunnel 已创建。");
            return { id: created, name, created: true };
        } catch (credentialError) {
            if (result.code !== 0) {
                throw new Error(
                    `Tunnel 创建命令失败后发现同名远端资源，但无法证明它属于本次请求；` +
                    `为避免删除并发创建的 Tunnel，未自动清理：${readableError(credentialError)}。` +
                    "请先运行 `codex-mcp doctor` 并在 Cloudflare 控制台核对",
                );
            }
            const cleanupErrors: string[] = [];
            await cleanupCreatedTunnel(bin, created, cleanupErrors);
            throw new Error(
                `Tunnel 已在远端创建，但本机凭据不可用：${readableError(credentialError)}` +
                (cleanupErrors.length > 0 ? `；${cleanupErrors.join("；")}` : "；已清理远端 Tunnel"),
            );
        }
    }
    if (reconciliationError || result.code === 0) {
        throw new Error(
            `Tunnel 创建请求后无法确认远端状态（名称：${name}）：` +
            `${reconciliationError ? readableError(reconciliationError) : "远端列表暂未返回新 Tunnel"}。` +
            "Cloudflare 可能已创建资源，请先运行 `codex-mcp doctor` 后再重试",
        );
    }
    throw new Error(`创建 Tunnel 失败：${(result.stderr || result.stdout).trim()}`);
}

export function assertCredentialMatches(
    path: string,
    tunnelId: string,
    accountId?: string,
): void {
    const identity = readTunnelCredentialIdentity(path);
    if (identity.tunnelId !== tunnelId.toLowerCase()) {
        throw new Error(`Tunnel 凭据 ID 与已提交配置不一致：${path}`);
    }
    if (accountId && identity.accountId !== accountId) {
        throw new Error(`Tunnel 凭据账号与已提交配置不一致：${path}`);
    }
}

export async function cleanupCreatedTunnel(
    bin: string,
    tunnelId: string,
    recoveryErrors: string[],
): Promise<void> {
    try {
        await deleteTunnel(bin, tunnelId);
        rmSync(getCredentialsPath(tunnelId), { force: true });
        printWarning("已清理本次新建且未提交的 Tunnel。");
    } catch (error) {
        recoveryErrors.push(`candidate Tunnel 清理失败：${readableError(error)}`);
    }
}

function hasMatchingCredential(tunnelId: string, accountId: string): boolean {
    const path = getCredentialsPath(tunnelId);
    if (!existsSync(path)) return false;
    try {
        assertCredentialMatches(path, tunnelId, accountId);
        return true;
    } catch {
        return false;
    }
}

async function deleteTunnel(bin: string, tunnelId: string): Promise<void> {
    const result = await runCloudflared(
        bin,
        cloudflaredManagementArgs("delete", "-f", tunnelId),
        { allowFailure: true, timeoutMs: 180_000 },
    );
    if (result.code !== 0) {
        throw new Error((result.stderr || result.stdout).trim() || `退出代码 ${result.code}`);
    }
}

async function findTunnelIdByName(
    bin: string,
    tunnelName: string,
): Promise<string | undefined> {
    const jsonAttempt = await runCloudflared(
        bin,
        cloudflaredManagementArgs("list", "--output", "json"),
        { allowFailure: true, timeoutMs: 180_000 },
    );
    if (jsonAttempt.code !== 0) {
        throw new Error((jsonAttempt.stderr || jsonAttempt.stdout).trim() || `无法读取 Cloudflare Tunnel 列表（退出代码 ${jsonAttempt.code}）`);
    }
    const rows: unknown = JSON.parse(jsonAttempt.stdout);
    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.id !== "string" || typeof row.name !== "string")) {
        throw new Error("cloudflared 返回了无效的 Tunnel JSON 列表；请更新 cloudflared");
    }
    const matches = rows.filter((row) => row.name === tunnelName);
    if (matches.length > 1) throw new Error(`存在多个同名 Tunnel：${tunnelName}`);
    return matches[0]?.id;
}

function cloudflaredManagementArgs(...args: string[]): string[] {
    const command = ["tunnel", "--config", ensureCloudflaredManagementConfig()];
    if (args[0] !== "login" && hasManagedCloudflareLogin()) {
        command.push("--origincert", getCloudflareOriginCertPath());
    }
    return [...command, ...args];
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
