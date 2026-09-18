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

const CLOUDFLARE_LOGIN_REQUIRED_MESSAGE =
    "Cloudflare 登录凭据缺失或已失效。请在 Web 的连接页面重新选择 Cloudflare（会自动打开登录），" +
    "或运行 `codex-mcp setup` 并选择“重新登录 / 切换 Cloudflare 账号”。" +
    "codex-mcp 使用独立的 Cloudflare 凭据目录，不需要手工复制 ~/.cloudflared/cert.pem。";

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
        printSuccess("Cloudflare 登录已更新。");
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
    const tunnels = await withSpinner(
        "正在检查现有 Cloudflare Tunnel…",
        "Cloudflare Tunnel 检查完成",
        () => listTunnels(bin),
    );
    const exactMatches = tunnels.filter((item) => item.name === preferredName);
    if (exactMatches.length > 1) throw new Error(`Cloudflare 中存在多个同名 Tunnel（${preferredName}），无法安全判断该使用哪一个。请在 Cloudflare 控制台确认后再运行 \`codex-mcp setup\``);
    const reusable = selectReusableTunnel(
        tunnels,
        preferredName,
        (id) => hasMatchingCredential(id, accountId),
        knownId,
    );
    if (reusable) {
        if (reusable.name !== preferredName) {
            printInfo(`找到这台电脑之前使用过的 Cloudflare Tunnel：${reusable.name}`);
        }
        printSuccess(`继续使用现有 Tunnel：${reusable.name}`);
        return { id: reusable.id, name: reusable.name, created: false };
    }

    const existing = exactMatches[0]?.id;
    let name = preferredName;
    if (existing) {
        name = `${preferredName}-${randomUUID().slice(0, 8)}`;
        printWarning(
            `Cloudflare 上已有同名 Tunnel，但这台电脑没有它的连接凭据。为了不误删别的 Tunnel，程序会保留它并创建一个新的 Tunnel：${name}`,
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
                printWarning("创建命令的返回结果不完整，但已经通过 Cloudflare 远端状态和本机连接凭据确认 Tunnel 创建成功。");
            }
            printSuccess("Tunnel 已创建。");
            return { id: created, name, created: true };
        } catch (credentialError) {
            if (result.code !== 0) {
                throw new Error(
                    `创建 Cloudflare Tunnel 时命令报错，但远端又出现了同名 Tunnel，程序无法确认它是不是本次创建的。` +
                    `为了避免误删其它 Tunnel，没有自动删除：${readableError(credentialError)}。` +
                    "请先运行 `codex-mcp doctor` 查看状态；如果仍无法确认，再到 Cloudflare 控制台核对",
                );
            }
            const cleanupErrors: string[] = [];
            await cleanupCreatedTunnel(bin, created, cleanupErrors);
            throw new Error(
                `Cloudflare Tunnel 已创建，但这台电脑没有拿到可用的连接凭据：${readableError(credentialError)}` +
                (cleanupErrors.length > 0 ? `；${cleanupErrors.join("；")}` : "；已自动清理刚创建的远端 Tunnel，可以重新运行 setup"),
            );
        }
    }
    if (reconciliationError || result.code === 0) {
        throw new Error(
            `创建 Cloudflare Tunnel 后暂时无法确认最终结果（名称：${name}）：` +
            `${reconciliationError ? readableError(reconciliationError) : "Cloudflare 暂时还没有返回新 Tunnel"}。` +
            "Tunnel 可能其实已经创建成功，请先运行 `codex-mcp doctor` 查看状态，再决定是否重试",
        );
    }
    throw new Error(`创建 Cloudflare Tunnel 失败：${(result.stderr || result.stdout).trim()}。请检查网络和 Cloudflare 登录状态后重试`);
}

export function assertCredentialMatches(
    path: string,
    tunnelId: string,
    accountId?: string,
): void {
    const identity = readTunnelCredentialIdentity(path);
    if (identity.tunnelId !== tunnelId.toLowerCase()) {
        throw new Error(`本机 Cloudflare Tunnel 连接文件与当前配置不匹配：${path}。请运行 \`codex-mcp setup\` 重新配置 Cloudflare`);
    }
    if (accountId && identity.accountId !== accountId) {
        throw new Error(`本机 Cloudflare Tunnel 连接文件属于另一个 Cloudflare 账号：${path}。请运行 \`codex-mcp setup\` 并重新登录正确账号`);
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
        printWarning("已清理本次配置过程中刚创建、但尚未使用的 Cloudflare Tunnel。");
    } catch (error) {
        recoveryErrors.push(`本次配置中新建的 Cloudflare Tunnel 没有清理成功：${readableError(error)}`);
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

interface ListedTunnel {
    id: string;
    name: string;
}

export function selectReusableTunnel(
    tunnels: ListedTunnel[],
    preferredName: string,
    ownsCredential: (id: string) => boolean,
    knownId?: string,
): ListedTunnel | undefined {
    const owned = tunnels.filter((item) => ownsCredential(item.id));
    if (knownId) {
        const known = owned.find((item) => item.id === knownId);
        if (known) return known;
    }
    const family = owned.filter(
        (item) => item.name === preferredName || item.name.startsWith(`${preferredName}-`),
    );
    const exact = family.find((item) => item.name === preferredName);
    if (exact) return exact;
    if (family.length > 0) {
        // A suffixed name is created only when the default name was already occupied.
        // Matching local credentials prove the tunnel belongs to this codex-mcp home.
        return [...family].sort((left, right) => left.name.localeCompare(right.name) || left.id.localeCompare(right.id))[0];
    }
    // Hostnames can change (for example a Mac DHCP hostname), which changes the
    // default tunnel name. If this private codex-mcp home owns exactly one active
    // Tunnel in the account, that ownership proof is stronger than the display name.
    return owned.length === 1 ? owned[0] : undefined;
}

async function listTunnels(bin: string): Promise<ListedTunnel[]> {
    const jsonAttempt = await runCloudflared(
        bin,
        cloudflaredManagementArgs("list", "--output", "json"),
        { allowFailure: true, timeoutMs: 180_000 },
    );
    if (jsonAttempt.code !== 0) {
        throw new Error(formatCloudflaredManagementFailure(
            "无法读取 Cloudflare Tunnel 列表",
            jsonAttempt.stdout,
            jsonAttempt.stderr,
            jsonAttempt.code,
        ));
    }
    return parseCloudflaredTunnelList(jsonAttempt.stdout);
}

export function parseCloudflaredTunnelList(output: string): ListedTunnel[] {
    let rows: unknown;
    try {
        rows = JSON.parse(output);
    } catch {
        throw new Error(
            "cloudflared 返回的 Tunnel 列表不是可识别的 JSON。" +
            "请运行 `codex-mcp doctor` 检查 cloudflared 状态；如果问题仍存在，请重新登录 Cloudflare 后重试。",
        );
    }

    // cloudflared can encode an empty/nil Go slice as JSON null.
    if (rows === null) return [];

    if (!Array.isArray(rows) || rows.some((row) => !row || typeof row.id !== "string" || typeof row.name !== "string")) {
        const embeddedError = extractCloudflaredErrorMessage(rows);
        if (embeddedError) {
            throw new Error(formatCloudflaredManagementFailure(
                "无法读取 Cloudflare Tunnel 列表",
                embeddedError,
                "",
                0,
            ));
        }
        throw new Error(
            "cloudflared 返回了不受支持的 Tunnel 列表格式。" +
            "请运行 `codex-mcp doctor` 检查 cloudflared 状态；如果已是最新版本，请保留诊断日志再反馈。",
        );
    }
    return rows.map((row) => ({ id: row.id, name: row.name }));
}

async function findTunnelIdByName(
    bin: string,
    tunnelName: string,
): Promise<string | undefined> {
    const matches = (await listTunnels(bin)).filter((row) => row.name === tunnelName);
    if (matches.length > 1) throw new Error(`存在多个同名 Tunnel：${tunnelName}`);
    return matches[0]?.id;
}

function cloudflaredManagementArgs(...args: string[]): string[] {
    const command = ["tunnel", "--config", ensureCloudflaredManagementConfig()];
    if (args[0] !== "login") {
        if (!hasManagedCloudflareLogin()) {
            throw new Error(CLOUDFLARE_LOGIN_REQUIRED_MESSAGE);
        }
        command.push("--origincert", getCloudflareOriginCertPath());
    }
    return [...command, ...args];
}

export function formatCloudflaredManagementFailure(
    action: string,
    stdout: string,
    stderr: string,
    exitCode: number | null,
): string {
    const detail = [stderr, stdout]
        .map((value) => value.trim())
        .filter(Boolean)
        .join("\n");
    if (isOriginCertError(detail)) {
        return CLOUDFLARE_LOGIN_REQUIRED_MESSAGE;
    }
    return detail || `${action}（cloudflared 退出代码 ${exitCode ?? "未知"}）`;
}

function extractCloudflaredErrorMessage(value: unknown): string | undefined {
    if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
    const record = value as Record<string, unknown>;
    if (typeof record.message === "string" && record.message.trim()) return record.message.trim();
    if (typeof record.error === "string" && record.error.trim()) return record.error.trim();
    return undefined;
}

function isOriginCertError(detail: string): boolean {
    const normalized = detail.toLowerCase();
    return normalized.includes("origin certificate") ||
        normalized.includes("origin cert") ||
        normalized.includes("origincert");
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
