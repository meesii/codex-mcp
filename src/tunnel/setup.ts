import { existsSync } from "node:fs";
import { resolveCname } from "node:dns/promises";
import { expandHomePath } from "../config.js";
import { printInfo, printSuccess, printWarning } from "../lib/terminal.js";
import { ensureManagedTool } from "../managed-tools/install.js";
import {
    ensureStarterUserConfig,
    ensureUserConfigDirs,
    getUserConfigPath,
    loadUserConfig,
    normalizeHostname,
    saveUserConfig,
    type UserConfig,
} from "../user-config.js";
import {
    probeCloudflaredVersion,
    suggestCloudflaredBin,
} from "./bin.js";
import { runCloudflared, runCloudflaredInherit } from "./exec.js";
import {
    requireDnsOverwriteConfirmation,
    requireTunnelDeleteConfirmation,
} from "./confirm.js";
import { askLine, askYesNo, canPromptInteractively } from "./prompt.js";
import {
    getCloudflaredConfigPath,
    getCredentialsPath,
    readCloudflaredYml,
    writeCloudflaredYml,
} from "./yml.js";

const TUNNEL_ID_RE =
    /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

export interface TunnelSetupResult {
    userConfig: UserConfig;
    domain: string;
    useCloudflared: boolean;
    bin?: string;
    tunnelId?: string;
    configPath?: string;
}

export interface TunnelSetupOptions {
    /** Force the interactive question flow even when domain exists. */
    force?: boolean;
    host?: string;
    port?: number;
}

/**
 * Ensure machine config exists; run the first-time wizard when needed.
 *
 * Flow:
 * 1. Create `~/.codex-mcp/config.json` if missing
 * 2. Ask for public domain
 * 3. Ask whether to use cloudflared
 * 4. If yes: prepare cloudflared automatically, then login / create / DNS / write yml
 *
 * @param options - Force / bind hints
 * @returns Resolved settings (sidecar fields only when useCloudflared)
 */
export async function ensureTunnelSetup(
    options: TunnelSetupOptions = {},
): Promise<TunnelSetupResult> {
    const host = options.host ?? loadUserConfig().host ?? "127.0.0.1";
    const port = options.port ?? loadUserConfig().port ?? 3920;

    ensureUserConfigDirs();
    let userConfig = ensureStarterUserConfig(host, port);

    if (!options.force && userConfig.domain) {
        if (userConfig.useCloudflared === false) {
            return {
                userConfig,
                domain: userConfig.domain,
                useCloudflared: false,
            };
        }
        // Fully configured cloudflared → just refresh yml / resolve bin.
        if (
            userConfig.useCloudflared === true &&
            userConfig.cloudflaredBin &&
            userConfig.tunnelId
        ) {
            return await finalizeCloudflared(userConfig, host, port);
        }
        // Domain saved but tunnel setup was interrupted → resume wizard.
    }

    if (!canPromptInteractively()) {
        throw new Error("还没有设置公网地址，请先在终端运行 `codex-mcp setup`");
    }

    return await runConfigWizard(userConfig, host, port);
}

/**
 * Re-run the full interactive wizard (`codex-mcp tunnel`).
 *
 * @returns Setup result
 */
export async function runTunnelWizard(): Promise<TunnelSetupResult> {
    return ensureTunnelSetup({ force: true });
}

/**
 * @param userConfig - Current config (starter file already on disk)
 * @param host - Bind host
 * @param port - Bind port
 * @returns Wizard result
 */
async function runConfigWizard(
    userConfig: UserConfig,
    host: string,
    port: number,
): Promise<TunnelSetupResult> {
    const configPath = getUserConfigPath();
    const existingYml = tryReadExistingYml();

    console.log("");
    printInfo("设置公网连接");
    printInfo(`配置保存在：${configPath}`);
    console.log("");

    // 1) Domain first — always.
    const domainDefault =
        userConfig.domain ?? existingYml?.hostname ?? undefined;
    let domainRaw = "";
    while (!domainRaw) {
        domainRaw = (
            await askLine(
                "给 ChatGPT 使用的域名（例如 mcp.example.com）",
                domainDefault,
            )
        ).trim();
        if (!domainRaw) {
            printWarning("需要填写一个域名。没有域名时可用 `codex-mcp --local` 只在本机运行。");
        }
    }
    const domain = normalizeHostname(domainRaw);

    userConfig = saveUserConfig({
        host,
        port,
        domain,
    });
    printSuccess(`域名已保存：${domain}`);
    console.log("");

    // 2) Optional cloudflared.
    const useCloudflared = await askYesNo(
        "要让 codex-mcp 自动配置 Cloudflare Tunnel 吗？",
        true,
    );
    if (!useCloudflared) {
        userConfig = saveUserConfig({ useCloudflared: false });
        printSuccess("域名已保存。请你自己准备 HTTPS 公网入口；需要自动配置时可重新运行 `codex-mcp tunnel`。");
        console.log("");
        return { userConfig, domain, useCloudflared: false };
    }

    // 3) Prepare cloudflared, then tunnel ops.
    const bin = await resolveOrInstallCloudflaredBin(userConfig.cloudflaredBin);
    const tunnelName =
        (
            await askLine(
                "Tunnel 名称",
                userConfig.tunnelName ?? "codex-mcp",
            )
        ).trim() || "codex-mcp";

    await ensureLogin(bin);
    const tunnelId = await ensureTunnelCreated(
        bin,
        tunnelName,
        userConfig.tunnelId ?? existingYml?.tunnelId,
    );
    await ensureDnsRoute(bin, tunnelName, domain, tunnelId);

    const credentialsFile = getCredentialsPath(tunnelId);
    if (!existsSync(credentialsFile)) {
        throw new Error(`没有找到 Tunnel 凭据：${credentialsFile}。请重新运行 \`codex-mcp tunnel\``);
    }

    const serviceUrl = localServiceUrl(host, port);
    const cloudflaredConfigPath = getCloudflaredConfigPath();
    writeCloudflaredYml(
        {
            tunnelId,
            credentialsFile,
            hostname: domain,
            serviceUrl,
        },
        cloudflaredConfigPath,
    );
    printSuccess(`Tunnel 配置已保存：${cloudflaredConfigPath}`);

    userConfig = saveUserConfig({
        useCloudflared: true,
        cloudflaredBin: bin,
        tunnelName,
        tunnelId,
    });
    printSuccess(`codex-mcp 配置已保存：${configPath}`);
    console.log("");

    return {
        userConfig,
        domain,
        useCloudflared: true,
        bin,
        tunnelId,
        configPath: cloudflaredConfigPath,
    };
}

/**
 * Refresh yml / resolve bin for an already-configured cloudflared setup.
 *
 * @param userConfig - Saved config with domain + tunnel
 * @param host - Bind host
 * @param port - Bind port
 * @returns Sidecar-ready result
 */
async function finalizeCloudflared(
    userConfig: UserConfig,
    host: string,
    port: number,
): Promise<TunnelSetupResult> {
    const domain = userConfig.domain!;
    let bin = await suggestCloudflaredBin(userConfig.cloudflaredBin);
    if (!bin) {
        try {
            bin = (await ensureManagedTool("cloudflared")).path;
        } catch (error) {
            const detail = error instanceof Error ? error.message : String(error);
            throw new Error(`公网连接组件缺失且自动恢复失败：${detail}`);
        }
    }
    if (bin !== userConfig.cloudflaredBin) {
        userConfig = saveUserConfig({ cloudflaredBin: bin });
    }
    const configPath = getCloudflaredConfigPath();

    let tunnelId = userConfig.tunnelId;
    if (!tunnelId) {
        if (!existsSync(configPath)) {
            throw new Error(`已经设置了域名，但缺少 Tunnel 配置：${configPath}。请运行 \`codex-mcp tunnel\` 重新设置`);
        }
        tunnelId = readCloudflaredYml(configPath).tunnelId;
        saveUserConfig({ tunnelId });
    }

    const credentialsFile = getCredentialsPath(tunnelId);
    if (!existsSync(credentialsFile)) {
        throw new Error(`缺少 Tunnel 凭据：${credentialsFile}。请运行 \`codex-mcp tunnel\` 重新设置`);
    }

    writeCloudflaredYml(
        {
            tunnelId,
            credentialsFile,
            hostname: domain,
            serviceUrl: localServiceUrl(host, port),
        },
        configPath,
    );

    return {
        userConfig: { ...userConfig, tunnelId, useCloudflared: true },
        domain,
        useCloudflared: true,
        bin,
        tunnelId,
        configPath,
    };
}

/**
 * @param host - Bind host
 * @param port - Bind port
 * @returns Local upstream URL for ingress
 */
function localServiceUrl(host: string, port: number): string {
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${localHost}:${port}`;
}

/**
 * @param bin - cloudflared path
 */
async function ensureLogin(bin: string): Promise<void> {
    const certPath = expandHomePath("~/.cloudflared/cert.pem");
    if (existsSync(certPath)) {
        printSuccess("已登录 Cloudflare，无需重复登录。");
        return;
    }
    printInfo("正在打开浏览器，请登录 Cloudflare 并完成授权…");
    const code = await runCloudflaredInherit(bin, ["tunnel", "login"]);
    if (code !== 0) {
        throw new Error("Cloudflare 登录没有完成，请重新运行 `codex-mcp tunnel`");
    }
    if (!existsSync(certPath)) {
        throw new Error(`Cloudflare 登录完成了，但没有找到登录凭据：${certPath}`);
    }
}

/**
 * Resolve a tunnel UUID that has local credentials under `~/.cloudflared`.
 *
 * Cloudflare may list a tunnel by name while the credentials JSON is gone
 * (other machine, deleted file, interrupted create). In that case we delete
 * and recreate so `tunnel create` downloads a fresh `*.json`.
 *
 * @param bin - cloudflared path
 * @param tunnelName - Tunnel name
 * @param knownId - Previously saved UUID
 * @returns Tunnel UUID with local credentials present
 */
async function ensureTunnelCreated(
    bin: string,
    tunnelName: string,
    knownId?: string,
): Promise<string> {
    const existing = await findTunnelIdByName(bin, tunnelName);
    if (knownId && existing === knownId && existsSync(getCredentialsPath(knownId))) {
        printSuccess(`继续使用现有 Tunnel：${tunnelName}`);
        return knownId;
    }
    if (knownId && existsSync(getCredentialsPath(knownId)) && existing !== knownId) {
        printWarning("本机保存的 Tunnel 和 Cloudflare 上的记录不一致，将重新确认配置。");
    }

    if (existing && existsSync(getCredentialsPath(existing))) {
        printSuccess(`继续使用现有 Tunnel：${tunnelName}`);
        return existing;
    }

    if (existing) {
        printWarning("Cloudflare 上已经有同名 Tunnel，但这台电脑缺少它的凭据。");
        await requireTunnelDeleteConfirmation(tunnelName);
        await deleteTunnel(bin, tunnelName, existing);
    }

    printInfo(`正在创建 Tunnel：${tunnelName}…`);
    const result = await runCloudflared(
        bin,
        ["tunnel", "create", tunnelName],
        { allowFailure: true },
    );
    const combined = `${result.stdout}\n${result.stderr}`;
    const created = combined.match(TUNNEL_ID_RE)?.[0];
    if (result.code === 0 && created) {
        if (!existsSync(getCredentialsPath(created))) {
            throw new Error("Tunnel 已创建，但这台电脑没有拿到对应凭据。请重新运行 `codex-mcp tunnel`");
        }
        printSuccess("Tunnel 已创建。");
        return created;
    }

    const again = await findTunnelIdByName(bin, tunnelName);
    if (again && existsSync(getCredentialsPath(again))) {
        printSuccess(`使用现有 Tunnel：${tunnelName}`);
        return again;
    }

    throw new Error(`创建 Tunnel 失败：${(result.stderr || result.stdout).trim()}`);
}

/**
 * Force-delete a tunnel by name, then by id if needed.
 *
 * @param bin - cloudflared path
 * @param tunnelName - Tunnel name
 * @param tunnelId - Tunnel UUID
 */
async function deleteTunnel(
    bin: string,
    tunnelName: string,
    tunnelId: string,
): Promise<void> {
    const byName = await runCloudflared(
        bin,
        ["tunnel", "delete", "-f", tunnelName],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (byName.code === 0) {
        return;
    }
    const byId = await runCloudflared(
        bin,
        ["tunnel", "delete", "-f", tunnelId],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (byId.code !== 0) {
        const detail = (byId.stderr || byName.stderr || byId.stdout || byName.stdout).trim();
        throw new Error(
            `Could not delete tunnel ${tunnelName} (${tunnelId}) to recreate credentials: ${detail}`,
        );
    }
}

/**
 * @param bin - cloudflared path
 * @param tunnelName - Name to resolve
 * @returns UUID or undefined
 */
async function findTunnelIdByName(
    bin: string,
    tunnelName: string,
): Promise<string | undefined> {
    const jsonAttempt = await runCloudflared(
        bin,
        ["tunnel", "list", "--output", "json"],
        { allowFailure: true, timeoutMs: 60_000 },
    );
    if (jsonAttempt.code === 0 && jsonAttempt.stdout.trim()) {
        try {
            const rows = JSON.parse(jsonAttempt.stdout) as Array<{
                id?: string;
                name?: string;
            }>;
            const hit = rows.find((row) => row.name === tunnelName);
            if (hit?.id) {
                return hit.id;
            }
        } catch {
            // fall through to text table
        }
    }

    const list = await runCloudflared(bin, ["tunnel", "list"], {
        allowFailure: true,
        timeoutMs: 60_000,
    });
    return findTunnelIdInListText(`${list.stdout}\n${list.stderr}`, tunnelName);
}

/** Resolve an exact tunnel name from cloudflared's text-table fallback. */
export function findTunnelIdInListText(
    text: string,
    tunnelName: string,
): string | undefined {
    const exactName = new RegExp(`(?:^|\\s)${escapeRegExp(tunnelName)}(?:\\s|$)`);
    for (const line of text.split(/\r?\n/)) {
        if (!exactName.test(line)) continue;
        const id = line.match(TUNNEL_ID_RE)?.[0];
        if (id) return id;
    }
    return undefined;
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Reuse an existing cloudflared binary or install codex-mcp's pinned copy.
 *
 * @param configured - Existing cloudflaredBin from user config
 * @returns Absolute validated binary path
 */
async function resolveOrInstallCloudflaredBin(
    configured?: string,
): Promise<string> {
    const existing = await suggestCloudflaredBin(configured);
    if (existing) {
        const version = await probeCloudflaredVersion(existing);
        printSuccess(`公网连接组件已就绪：${version}`);
        return existing;
    }

    printInfo("正在准备公网连接组件…");
    try {
        const installed = await ensureManagedTool("cloudflared");
        const version = await probeCloudflaredVersion(installed.path);
        printSuccess(`公网连接组件已准备：${version}`);
        return installed.path;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`公网连接组件准备失败：${detail}`);
    }
}

/**
 * @returns Parsed yml when present and valid
 */
function tryReadExistingYml():
    | { hostname: string; tunnelId: string }
    | undefined {
    const configPath = getCloudflaredConfigPath();
    if (!existsSync(configPath)) {
        return undefined;
    }
    try {
        const parsed = readCloudflaredYml(configPath);
        return { hostname: parsed.hostname, tunnelId: parsed.tunnelId };
    } catch {
        return undefined;
    }
}

/**
 * Ensure hostname DNS routes to this tunnel.
 *
 * cloudflared has no "list hostname routes" command, so we:
 * 1. Try `route dns` without overwrite
 * 2. On conflict, resolve public CNAME — skip if it already targets this tunnel
 * 3. Otherwise require explicit user confirmation before `--overwrite-dns`
 *
 * @param bin - cloudflared path
 * @param tunnelName - Tunnel name
 * @param domain - Public hostname
 * @param tunnelId - Tunnel UUID (for CNAME target check)
 */
async function ensureDnsRoute(
    bin: string,
    tunnelName: string,
    domain: string,
    tunnelId: string,
): Promise<void> {
    printInfo(`正在把域名 ${domain} 连接到 Tunnel…`);
    const create = await runCloudflared(
        bin,
        ["tunnel", "route", "dns", tunnelName, domain],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (create.code === 0) {
        printSuccess("域名连接已配置。启动时会再做一次真实连通检查。");
        return;
    }

    if (!isDnsRecordConflict(create.stderr, create.stdout)) {
        throw new Error(`配置域名失败：${(create.stderr || create.stdout).trim()}`);
    }

    const pointsHere = await dnsPointsToTunnel(domain, tunnelId);
    if (pointsHere) {
        printSuccess("这个域名已经连接到当前 Tunnel。");
        return;
    }

    printWarning(`域名 ${domain} 已经有其它 DNS 记录，需要确认是否替换。`);
    await requireDnsOverwriteConfirmation(domain);
    const overwrite = await runCloudflared(
        bin,
        ["tunnel", "route", "dns", "--overwrite-dns", tunnelName, domain],
        { allowFailure: true, timeoutMs: 120_000 },
    );
    if (overwrite.code === 0) {
        printSuccess("DNS 已更新。启动时会再做一次真实连通检查。");
        return;
    }
    throw new Error(`更新域名 DNS 失败：${(overwrite.stderr || overwrite.stdout).trim()}`);
}

/**
 * @param stderr - Command stderr
 * @param stdout - Command stdout
 * @returns True when Cloudflare reports the hostname record already exists
 */
function isDnsRecordConflict(stderr: string, stdout: string): boolean {
    const detail = `${stderr}\n${stdout}`.toLowerCase();
    return (
        detail.includes("already exists") ||
        detail.includes("record with that host already exists") ||
        detail.includes("code: 1003")
    );
}

/**
 * Best-effort public DNS check. Proxied Cloudflare CNAMEs are often flattened
 * to A records, in which case this returns false and the caller overwrites.
 *
 * @param domain - Public hostname
 * @param tunnelId - Expected tunnel UUID
 * @returns True when a CNAME target is `<tunnelId>.cfargotunnel.com`
 */
async function dnsPointsToTunnel(
    domain: string,
    tunnelId: string,
): Promise<boolean> {
    const expected = `${tunnelId}.cfargotunnel.com`.toLowerCase();
    try {
        const names = await resolveCname(domain);
        return names.some(
            (name) => name.toLowerCase().replace(/\.$/, "") === expected,
        );
    } catch {
        return false;
    }
}
