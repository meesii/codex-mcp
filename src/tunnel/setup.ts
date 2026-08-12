import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { homedir, hostname as osHostname } from "node:os";
import { resolveCname } from "node:dns/promises";
import { printInfo, printSuccess, printWarning } from "../lib/util/terminal.js";
import { ensureManagedTool } from "../managed-tools/install.js";
import {
    ensureStarterUserConfig,
    ensureUserConfigDirs,
    getUserConfigPath,
    loadUserConfig,
    normalizeHostname,
    saveUserConfig,
    type UserConfig,
} from "../config/user-config.js";
import {
    probeCloudflaredVersion,
    suggestCloudflaredBin,
} from "./bin.js";
import {
    discoverCloudflareZones,
    getCloudflareOriginCertPath,
} from "./cloudflare-account.js";
import { runCloudflared, runCloudflaredInherit } from "./exec.js";
import {
    requireDnsOverwriteConfirmation,
    requireTunnelDeleteConfirmation,
} from "./confirm.js";
import { askLine, askSelect, askYesNo, canPromptInteractively, withSpinner } from "./prompt.js";
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
        if (userConfig.useCloudflared === true && userConfig.tunnelId) {
            return await finalizeCloudflared(userConfig, host, port);
        }
        // Domain saved but tunnel setup was interrupted → resume wizard.
    }

    if (!canPromptInteractively()) {
        throw new Error("还没有设置公网地址，请先在终端运行 `codex-mcp setup`");
    }

    return await runConfigWizard(userConfig, host, port);
}

export async function runTunnelWizard(): Promise<TunnelSetupResult> {
    return ensureTunnelSetup({ force: true });
}

export function isPublicSetupConfigured(userConfig: UserConfig): boolean {
    if (!userConfig.domain) return false;
    if (userConfig.useCloudflared === false) return true;
    return Boolean(userConfig.tunnelId);
}

async function runConfigWizard(
    userConfig: UserConfig,
    host: string,
    port: number,
): Promise<TunnelSetupResult> {
    const configPath = getUserConfigPath();
    const existingYml = tryReadExistingYml();

    printInfo("设置公网连接");
    printInfo(`配置保存在：${configPath}`);

    // 1) Choose whether codex-mcp should manage the public Cloudflare entry.
    const useCloudflared = await askYesNo(
        "要让 codex-mcp 自动配置 Cloudflare Tunnel 吗？",
        true,
    );
    if (!useCloudflared) {
        const domain = await askPublicDomain(
            userConfig.domain ?? existingYml?.hostname,
        );
        userConfig = saveUserConfig({ host, port, domain, useCloudflared: false });
        printSuccess(`域名已保存：${domain}`);
        printSuccess("域名已保存。请你自己准备 HTTPS 公网入口；需要自动配置时可重新运行 `codex-mcp tunnel`。");
        return { userConfig, domain, useCloudflared: false };
    }

    // 2) Prepare + login first so the wizard can discover usable Cloudflare zones.
    const bin = await withSpinner(
        "正在准备 Cloudflare 连接组件…",
        "Cloudflare 连接组件已就绪",
        () => resolveOrInstallCloudflaredBin(userConfig.cloudflaredBin),
    );
    await ensureLogin(bin);

    const discovery = await withSpinner(
        "正在读取 Cloudflare 账号中的域名…",
        "Cloudflare 域名读取完成",
        () => discoverCloudflareZones(),
    );
    const zones = discovery.zones;
    if (zones.length === 0) {
        throw new Error(
            "Cloudflare 账号里没有可用于公网 hostname 的域名。Named Tunnel 的 <UUID>.cfargotunnel.com 只能作为你自己 DNS 记录的 CNAME 目标，不能直接作为 ChatGPT 连接地址；请先把一个域名接入 Cloudflare 后重试。",
        );
    }
    printSuccess(`已检测到 ${zones.length} 个可用 Cloudflare 域名。`);
    if (!discovery.complete) {
        printWarning("Cloudflare 没有允许列出全部域名，当前只使用登录时选中的域名。");
    }

    // 3) Select the Cloudflare zone, then choose the subdomain prefix.
    const previousDomain = userConfig.domain ?? existingYml?.hostname;
    const preferredZone = findMatchingZone(previousDomain, zones) ?? zones[0];
    const zone =
        zones.length === 1
            ? zones[0]
            : await askSelect(
                  "请选择用于 codex-mcp 的 Cloudflare 域名",
                  zones.map((value) => ({ value, label: value })),
                  preferredZone,
              );
    if (zones.length === 1) {
        printSuccess(`使用 Cloudflare 域名：${zone}`);
    }

    const previousPrefix = subdomainPrefixForZone(previousDomain, zone);
    const prefixDefault =
        previousPrefix && !previousPrefix.includes(".") ? previousPrefix : "codex-mcp";
    const domain = await askCloudflareHostname(zone, prefixDefault);
    userConfig = saveUserConfig({ host, port, domain });
    printSuccess(`域名已保存：${domain}`);

    // 4) Create/reuse a stable machine-specific named Tunnel and route the hostname.
    const tunnelName = userConfig.tunnelName ?? defaultTunnelName();
    if (!userConfig.tunnelName) {
        userConfig = saveUserConfig({ tunnelName });
    }

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

    return {
        userConfig,
        domain,
        useCloudflared: true,
        bin,
        tunnelId,
        configPath: cloudflaredConfigPath,
    };
}

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

function localServiceUrl(host: string, port: number): string {
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    return `http://${localHost}:${port}`;
}

async function ensureLogin(bin: string): Promise<void> {
    const certPath = getCloudflareOriginCertPath();
    if (existsSync(certPath)) {
        printSuccess("已登录 Cloudflare，无需重复登录。");
        return;
    }
    printInfo("正在打开浏览器，请登录 Cloudflare 并完成授权…");
    const code = await runCloudflaredInherit(bin, ["tunnel", "login"]);
    if (code !== 0) {
        throw new Error(
            "Cloudflare 登录没有完成。Named Tunnel 登录需要账号中至少有一个已接入 Cloudflare 的域名；如果账号没有域名，<UUID>.cfargotunnel.com 也不能直接作为 ChatGPT 连接地址。",
        );
    }
    if (!existsSync(certPath)) {
        throw new Error(`Cloudflare 登录完成了，但没有找到登录凭据：${certPath}`);
    }
}

async function ensureTunnelCreated(
    bin: string,
    tunnelName: string,
    knownId?: string,
): Promise<string> {
    const existing = await withSpinner(
        "正在检查现有 Cloudflare Tunnel…",
        "Cloudflare Tunnel 检查完成",
        () => findTunnelIdByName(bin, tunnelName),
    );
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
        await withSpinner(
            "正在删除无法复用的旧 Tunnel…",
            "旧 Tunnel 已删除",
            () => deleteTunnel(bin, tunnelName, existing),
        );
    }

    const result = await withSpinner(
        "正在创建 Cloudflare Tunnel…",
        "Cloudflare Tunnel 创建请求完成",
        () =>
            runCloudflared(
                bin,
                ["tunnel", "create", tunnelName],
                { allowFailure: true },
            ),
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

async function resolveOrInstallCloudflaredBin(
    configured?: string,
): Promise<string> {
    const existing = await suggestCloudflaredBin(configured);
    if (existing) {
        await probeCloudflaredVersion(existing);
        return existing;
    }

    try {
        const installed = await ensureManagedTool("cloudflared");
        await probeCloudflaredVersion(installed.path);
        return installed.path;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`公网连接组件准备失败：${detail}`);
    }
}

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

async function ensureDnsRoute(
    bin: string,
    tunnelName: string,
    domain: string,
    tunnelId: string,
): Promise<void> {
    const create = await withSpinner(
        `正在把域名 ${domain} 连接到 Tunnel…`,
        "DNS 路由请求完成",
        () =>
            runCloudflared(
                bin,
                ["tunnel", "route", "dns", tunnelName, domain],
                { allowFailure: true, timeoutMs: 120_000 },
            ),
    );
    if (create.code === 0) {
        printSuccess("域名连接已配置。");
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
    const overwrite = await withSpinner(
        "正在更新 Cloudflare DNS…",
        "DNS 更新请求完成",
        () =>
            runCloudflared(
                bin,
                ["tunnel", "route", "dns", "--overwrite-dns", tunnelName, domain],
                { allowFailure: true, timeoutMs: 120_000 },
            ),
    );
    if (overwrite.code === 0) {
        printSuccess("DNS 已更新。");
        return;
    }
    throw new Error(`更新域名 DNS 失败：${(overwrite.stderr || overwrite.stdout).trim()}`);
}

function isDnsRecordConflict(stderr: string, stdout: string): boolean {
    const detail = `${stderr}\n${stdout}`.toLowerCase();
    return (
        detail.includes("already exists") ||
        detail.includes("record with that host already exists") ||
        detail.includes("code: 1003")
    );
}

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

async function askPublicDomain(
    defaultValue?: string,
    allowedZones?: string[],
): Promise<string> {
    while (true) {
        const domainRaw = (
            await askLine(
                "给 ChatGPT 使用的域名（例如 mcp.example.com）",
                defaultValue,
            )
        ).trim();
        if (!domainRaw) {
            printWarning("需要填写一个域名。没有域名时可用 `codex-mcp --local` 只在本机运行。");
            continue;
        }
        let domain: string;
        try {
            domain = normalizeHostname(domainRaw);
        } catch (error) {
            printWarning(error instanceof Error ? error.message : String(error));
            continue;
        }
        if (allowedZones && !hostnameBelongsToZones(domain, allowedZones)) {
            printWarning(`这个域名不属于当前 Cloudflare 账号检测到的域名：${allowedZones.join("、")}`);
            continue;
        }
        return domain;
    }
}

export function hostnameBelongsToZones(hostname: string, zones: string[]): boolean {
    const normalized = normalizeHostname(hostname);
    return zones.some((zone) => normalized === zone || normalized.endsWith(`.${zone}`));
}

export function findMatchingZone(
    hostname: string | undefined,
    zones: string[],
): string | undefined {
    if (!hostname) return undefined;
    const normalized = normalizeHostname(hostname);
    return [...zones]
        .sort((left, right) => right.length - left.length)
        .find((zone) => normalized === zone || normalized.endsWith(`.${zone}`));
}

export function subdomainPrefixForZone(
    hostname: string | undefined,
    zone: string,
): string | undefined {
    if (!hostname) return undefined;
    const normalized = normalizeHostname(hostname);
    if (normalized === zone) return undefined;
    const suffix = `.${zone}`;
    if (!normalized.endsWith(suffix)) return undefined;
    return normalized.slice(0, -suffix.length) || undefined;
}

export function defaultTunnelName(
    machineHostname: string = osHostname(),
    homeDirectory: string = homedir(),
): string {
    const slug =
        machineHostname
            .toLowerCase()
            .replace(/[^a-z0-9]+/g, "-")
            .replace(/^-+|-+$/g, "")
            .slice(0, 28) || "host";
    const suffix = createHash("sha256")
        .update(`${machineHostname}\0${homeDirectory}`, "utf8")
        .digest("hex")
        .slice(0, 6);
    return `codex-mcp-${slug}-${suffix}`;
}

export function cloudflareManagedHostname(zone: string, prefix: string): string {
    const normalizedPrefix = prefix.trim();
    if (!normalizedPrefix) {
        throw new Error("需要填写子域名前缀，例如 codex-mcp。");
    }
    if (normalizedPrefix.includes(".")) {
        throw new Error(
            "Cloudflare 默认 Universal SSL 只覆盖所选域名的一级子域名。请使用不含点号的前缀，例如 codex-mcp；如确实需要多级子域名，请先在 Cloudflare 配置覆盖该 hostname 的 Edge Certificate。",
        );
    }
    const hostname = normalizeHostname(`${normalizedPrefix}.${zone}`);
    if (findMatchingZone(hostname, [zone]) !== zone) {
        throw new Error("子域名不属于所选 Cloudflare 域名");
    }
    return hostname;
}

async function askCloudflareHostname(zone: string, defaultPrefix: string): Promise<string> {
    while (true) {
        const prefix = (await askLine("子域名前缀", defaultPrefix)).trim();
        try {
            return cloudflareManagedHostname(zone, prefix);
        } catch (error) {
            printWarning(error instanceof Error ? error.message : String(error));
        }
    }
}
