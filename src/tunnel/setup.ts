import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { loopbackHost } from "../lib/http/listen-address.js";
import { homedir, hostname as osHostname } from "node:os";
import { printInfo, printSuccess, printWarning } from "../lib/util/terminal.js";
import { ensureManagedTool } from "../managed-tools/install.js";
import {
    ensureStarterUserConfig,
    ensureUserConfigDirs,
    getUserConfigPath,
    loadUserConfig,
    normalizeHostname,
    type CloudflarePublicAccessConfig,
    type PublicAccessConfig,
    type UserConfig,
} from "../config/user-config.js";
import { probeCloudflaredVersion, suggestCloudflaredBin } from "./bin.js";
import {
    discoverCloudflareZones,
} from "./cloudflare-account.js";
import {
    assertCredentialMatches,
    cleanupCreatedTunnel,
    ensureLogin,
    ensureTunnelCreated,
} from "./cloudflare-session.js";
import { askLine, askSelect, askYesNo, canPromptInteractively, withSpinner } from "./prompt.js";
import type { SetupPublicVerificationResult } from "./setup-verify.js";
import {
    getCredentialsPath,
    readCloudflaredYml,
    resolveCloudflaredRuntimeConfigPath,
    writeCloudflaredRevision,
} from "./yml.js";

export interface TunnelSetupResult {
    userConfig: UserConfig;
    publicAccess: PublicAccessConfig;
    domain: string;
    useCloudflared: boolean;
    bin?: string;
    tunnelId?: string;
    configPath?: string;
    configRevision?: string;
    previousConfigRevision?: string;
    zoneId?: string;
    /** Present only for artifacts prepared by the current uncommitted wizard session. */
    candidateSession?: { createdTunnel: boolean };
}

export interface AppliedTunnelSetup {
    result: TunnelSetupResult;
    verification: SetupPublicVerificationResult;
}

export interface TunnelSetupOptions {
    /** Force the interactive question flow even when public access exists. */
    force?: boolean;
    /** Authenticate to Cloudflare again without deleting the old cert first. */
    forceCloudflareLogin?: boolean;
    host?: string;
    port?: number;
}

export interface CloudflareSetupDiscoveryResult {
    zones: string[];
    complete: boolean;
    currentDomain?: string;
    preferredZone?: string;
    defaultPrefix: string;
    tunnelName: string;
}

export interface ProgrammaticTunnelSetupOptions {
    host?: string;
    port?: number;
}

/** Resolve committed public state. This path is read-only and safe for runtime startup. */
export async function ensureTunnelSetup(
    options: TunnelSetupOptions = {},
): Promise<TunnelSetupResult> {
    const userConfig = loadUserConfig();
    const host = options.host ?? userConfig.host ?? "127.0.0.1";
    const port = options.port ?? userConfig.port ?? 3920;
    if (!options.force && userConfig.publicAccess) {
        return await loadCommittedTunnelSetup(userConfig, host, port);
    }
    if (!canPromptInteractively()) {
        throw new Error("还没有设置公网地址，请先在终端运行 `codex-mcp setup`");
    }
    ensureUserConfigDirs();
    const starter = ensureStarterUserConfig(host, port);
    return await runConfigWizard(starter, host, port, options.forceCloudflareLogin === true);
}

export async function runTunnelWizard(
    options: { forceCloudflareLogin?: boolean; host?: string; port?: number } = {},
): Promise<TunnelSetupResult> {
    return await ensureTunnelSetup({
        force: true,
        forceCloudflareLogin: options.forceCloudflareLogin,
        host: options.host,
        port: options.port,
    });
}

export function isPublicSetupConfigured(userConfig: UserConfig): boolean {
    return userConfig.publicAccess !== undefined;
}

/** Build an external-HTTPS candidate without terminal prompts. */
export function prepareExternalTunnelSetup(
    domainValue: string,
    options: ProgrammaticTunnelSetupOptions = {},
): TunnelSetupResult {
    const userConfig = loadUserConfig();
    const host = options.host ?? userConfig.host ?? "127.0.0.1";
    const port = options.port ?? userConfig.port ?? 3920;
    const domain = normalizeHostname(domainValue);
    const publicAccess: PublicAccessConfig = { kind: "external", domain };
    return {
        userConfig: { ...userConfig, host, port, publicAccess },
        publicAccess,
        domain,
        useCloudflared: false,
        ...(userConfig.publicAccess?.kind === "cloudflare" && userConfig.publicAccess.configRevision
            ? { previousConfigRevision: userConfig.publicAccess.configRevision }
            : {}),
    };
}

/** Login when needed and return the selectable Cloudflare zones without exposing credentials. */
export async function discoverCloudflareSetup(
    options: ProgrammaticTunnelSetupOptions & {
        forceLogin?: boolean;
        signal?: AbortSignal;
        onLoginOutput?: (text: string) => void;
    } = {},
): Promise<CloudflareSetupDiscoveryResult> {
    const userConfig = loadUserConfig();
    const previousManaged = userConfig.publicAccess?.kind === "cloudflare" ? userConfig.publicAccess : undefined;
    const bin = await resolveOrInstallCloudflaredBin(previousManaged?.cloudflaredBin);
    await ensureLogin(bin, options.forceLogin === true, {
        signal: options.signal,
        onOutput: options.onLoginOutput,
    });
    const discovery = await discoverCloudflareZones();
    if (discovery.zones.length === 0) {
        throw new Error(
            "Cloudflare 账号里没有可用于公网 hostname 的域名。Named Tunnel 的 <UUID>.cfargotunnel.com 只能作为 CNAME 目标。",
        );
    }
    const currentDomain = userConfig.publicAccess?.domain;
    const preferredZone = findMatchingZone(currentDomain, discovery.zones) ?? discovery.zones[0];
    const previousPrefix = preferredZone ? subdomainPrefixForZone(currentDomain, preferredZone) : undefined;
    return {
        zones: discovery.zones,
        complete: discovery.complete,
        ...(currentDomain ? { currentDomain } : {}),
        ...(preferredZone ? { preferredZone } : {}),
        defaultPrefix: previousPrefix && !previousPrefix.includes(".") ? previousPrefix : "codex-mcp",
        tunnelName: previousManaged?.tunnelName ?? defaultTunnelName(),
    };
}

/** Build a managed Cloudflare candidate from explicit Web/CLI selections, without terminal prompts. */
export async function prepareCloudflareTunnelSetup(
    input: ProgrammaticTunnelSetupOptions & {
        zone: string;
        prefix: string;
        forceLogin?: boolean;
    },
): Promise<TunnelSetupResult> {
    const userConfig = loadUserConfig();
    const host = input.host ?? userConfig.host ?? "127.0.0.1";
    const port = input.port ?? userConfig.port ?? 3920;
    ensureUserConfigDirs();
    ensureStarterUserConfig(host, port);
    const previousManaged = userConfig.publicAccess?.kind === "cloudflare" ? userConfig.publicAccess : undefined;
    const bin = await resolveOrInstallCloudflaredBin(previousManaged?.cloudflaredBin);
    const login = await ensureLogin(bin, input.forceLogin === true);
    const discovery = await discoverCloudflareZones();
    const zone = normalizeHostname(input.zone);
    if (!discovery.zones.includes(zone)) {
        throw new Error(`Cloudflare 账号中没有可用域名：${zone}`);
    }
    const zoneId = discovery.zoneIds[zone];
    if (!zoneId) throw new Error(`无法确定 Cloudflare zone ID：${zone}`);
    const domain = cloudflareManagedHostname(zone, input.prefix);
    const preferredTunnelName = previousManaged?.tunnelName ?? defaultTunnelName();
    const tunnel = await ensureTunnelCreated(
        bin,
        preferredTunnelName,
        login.accountID,
        previousManaged?.tunnelId,
    );
    try {
        const credentialsFile = getCredentialsPath(tunnel.id);
        if (!existsSync(credentialsFile)) throw new Error(`没有找到 Tunnel 凭据：${credentialsFile}`);
        assertCredentialMatches(credentialsFile, tunnel.id, login.accountID);
        const generated = writeCloudflaredRevision({
            tunnelId: tunnel.id,
            credentialsFile,
            hostname: domain,
            serviceUrl: localServiceUrl(host, port),
        });
        const publicAccess: CloudflarePublicAccessConfig = {
            kind: "cloudflare",
            domain,
            cloudflaredBin: bin,
            tunnelName: tunnel.name,
            tunnelId: tunnel.id,
            configRevision: generated.revision,
            accountId: login.accountID,
            zoneId,
        };
        return {
            userConfig: { ...userConfig, host, port, publicAccess },
            publicAccess,
            domain,
            useCloudflared: true,
            bin,
            tunnelId: tunnel.id,
            configPath: generated.path,
            configRevision: generated.revision,
            ...(previousManaged?.configRevision ? { previousConfigRevision: previousManaged.configRevision } : {}),
            zoneId,
            candidateSession: { createdTunnel: tunnel.created },
        };
    } catch (error) {
        if (!tunnel.created) throw error;
        const cleanupErrors: string[] = [];
        await cleanupCreatedTunnel(bin, tunnel.id, cleanupErrors);
        if (cleanupErrors.length > 0) throw new Error(`${readableError(error)}；${cleanupErrors.join("；")}`);
        throw error;
    }
}

export async function loadCommittedTunnelSetup(
    userConfig: UserConfig = loadUserConfig(),
    host: string = userConfig.host ?? "127.0.0.1",
    port: number = userConfig.port ?? 3920,
): Promise<TunnelSetupResult> {
    const access = userConfig.publicAccess;
    if (!access) {
        throw new Error("还没有设置公网地址，请先运行 `codex-mcp setup`");
    }
    if (access.kind === "external") {
        return {
            userConfig,
            publicAccess: access,
            domain: access.domain,
            useCloudflared: false,
        };
    }

    const bin = await suggestCloudflaredBin(access.cloudflaredBin);
    if (!bin) {
        throw new Error("已配置 Cloudflare Tunnel，但找不到 cloudflared；请运行 `codex-mcp doctor`");
    }
    const credentialsFile = getCredentialsPath(access.tunnelId);
    if (!existsSync(credentialsFile)) {
        throw new Error(`缺少 Tunnel 凭据：${credentialsFile}。请运行 \`codex-mcp setup\` 重新设置`);
    }
    assertCredentialMatches(credentialsFile, access.tunnelId, access.accountId);
    const configPath = resolveCloudflaredRuntimeConfigPath(access);
    const parsed = readCloudflaredYml(configPath);
    const expectedService = localServiceUrl(host, port);
    if (
        parsed.tunnelId !== access.tunnelId ||
        parsed.hostname !== access.domain ||
        parsed.credentialsFile !== credentialsFile ||
        parsed.serviceUrl !== expectedService
    ) {
        throw new Error(
            `已提交公网配置与 Tunnel 运行文件不一致：${configPath}。` +
            "运行时不会自动重写，请先运行 `codex-mcp doctor`，再通过 setup 修复。",
        );
    }
    return {
        userConfig,
        publicAccess: access,
        domain: access.domain,
        useCloudflared: true,
        bin,
        tunnelId: access.tunnelId,
        configPath,
        configRevision: access.configRevision,
        zoneId: access.zoneId,
    };
}

async function runConfigWizard(
    userConfig: UserConfig,
    host: string,
    port: number,
    forceCloudflareLogin: boolean,
): Promise<TunnelSetupResult> {
    printInfo("设置公网连接");
    printInfo(`验证成功后才会提交到：${getUserConfigPath()}`);

    const useCloudflared = await askYesNo(
        "要让 codex-mcp 自动配置 Cloudflare Tunnel 吗？",
        userConfig.publicAccess?.kind !== "external",
    );
    if (!useCloudflared) {
        const domain = await askPublicDomain(
            userConfig.publicAccess?.domain,
        );
        const publicAccess: PublicAccessConfig = { kind: "external", domain };
        return {
            userConfig: { ...userConfig, host, port, publicAccess },
            publicAccess,
            domain,
            useCloudflared: false,
            ...(userConfig.publicAccess?.kind === "cloudflare" && userConfig.publicAccess.configRevision
                ? { previousConfigRevision: userConfig.publicAccess.configRevision }
                : {}),
        };
    }

    const previousManaged = userConfig.publicAccess?.kind === "cloudflare"
        ? userConfig.publicAccess
        : undefined;
    const bin = await withSpinner(
        "正在准备 Cloudflare 连接组件…",
        "Cloudflare 连接组件已就绪",
        () => resolveOrInstallCloudflaredBin(previousManaged?.cloudflaredBin),
    );
    const login = await ensureLogin(bin, forceCloudflareLogin);

    const discovery = await withSpinner(
        "正在读取 Cloudflare 账号中的域名…",
        "Cloudflare 域名读取完成",
        () => discoverCloudflareZones(),
    );
    if (discovery.zones.length === 0) {
        throw new Error(
            "Cloudflare 账号里没有可用于公网 hostname 的域名。" +
            "Named Tunnel 的 <UUID>.cfargotunnel.com 只能作为 CNAME 目标，不能直接作为 ChatGPT 地址。",
        );
    }
    printSuccess(`已检测到 ${discovery.zones.length} 个可用 Cloudflare 域名。`);
    if (!discovery.complete) {
        printWarning("Cloudflare 没有允许列出全部域名，当前只使用登录时选中的域名。");
    }

    const previousDomain = userConfig.publicAccess?.domain;
    const preferredZone = findMatchingZone(previousDomain, discovery.zones) ?? discovery.zones[0];
    const zone = discovery.zones.length === 1
        ? discovery.zones[0]!
        : await askSelect(
              "请选择用于 codex-mcp 的 Cloudflare 域名",
              discovery.zones.map((value) => ({ value, label: value })),
              preferredZone,
          );
    if (discovery.zones.length === 1) printSuccess(`使用 Cloudflare 域名：${zone}`);
    const zoneId = discovery.zoneIds[zone];
    if (!zoneId) throw new Error(`无法确定 Cloudflare zone ID：${zone}`);

    const previousPrefix = subdomainPrefixForZone(previousDomain, zone);
    const prefixDefault = previousPrefix && !previousPrefix.includes(".") ? previousPrefix : "codex-mcp";
    const domain = await askCloudflareHostname(zone, prefixDefault);

    const preferredTunnelName = previousManaged?.tunnelName ?? defaultTunnelName();
    const tunnel = await ensureTunnelCreated(
        bin,
        preferredTunnelName,
        login.accountID,
        previousManaged?.tunnelId,
    );
    try {
        const credentialsFile = getCredentialsPath(tunnel.id);
        if (!existsSync(credentialsFile)) {
            throw new Error(`没有找到 Tunnel 凭据：${credentialsFile}`);
        }
        assertCredentialMatches(credentialsFile, tunnel.id, login.accountID);
        const generated = writeCloudflaredRevision({
            tunnelId: tunnel.id,
            credentialsFile,
            hostname: domain,
            serviceUrl: localServiceUrl(host, port),
        });
        printSuccess(`candidate Tunnel 配置已准备：${generated.path}`);

        const publicAccess: CloudflarePublicAccessConfig = {
            kind: "cloudflare",
            domain,
            cloudflaredBin: bin,
            tunnelName: tunnel.name,
            tunnelId: tunnel.id,
            configRevision: generated.revision,
            accountId: login.accountID,
            zoneId,
        };
        return {
            userConfig: { ...userConfig, host, port, publicAccess },
            publicAccess,
            domain,
            useCloudflared: true,
            bin,
            tunnelId: tunnel.id,
            configPath: generated.path,
            configRevision: generated.revision,
            ...(previousManaged?.configRevision
                ? { previousConfigRevision: previousManaged.configRevision }
                : {}),
            zoneId,
            candidateSession: { createdTunnel: tunnel.created },
        };
    } catch (error) {
        if (!tunnel.created) throw error;
        const cleanupErrors: string[] = [];
        await cleanupCreatedTunnel(bin, tunnel.id, cleanupErrors);
        if (cleanupErrors.length > 0) {
            throw new Error(`${readableError(error)}；${cleanupErrors.join("；")}`);
        }
        throw error;
    }
}

export async function resolveOrInstallCloudflaredBin(configured?: string): Promise<string> {
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
        throw new Error(`公网连接组件准备失败：${readableError(error)}`);
    }
}

function localServiceUrl(host: string, port: number): string {
    return `http://${loopbackHost(host)}:${port}`;
}

async function askPublicDomain(
    defaultValue?: string,
    allowedZones?: string[],
): Promise<string> {
    while (true) {
        const domainRaw = (await askLine(
            "给 ChatGPT 使用的域名（例如 mcp.example.com）",
            defaultValue,
        )).trim();
        if (!domainRaw) {
            printWarning("需要填写一个域名。没有域名时可用 `codex-mcp start --local` 只在本机运行。");
            continue;
        }
        let domain: string;
        try {
            domain = normalizeHostname(domainRaw);
        } catch (error) {
            printWarning(readableError(error));
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
    const slug = machineHostname
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
            "Cloudflare 默认 Universal SSL 只覆盖所选域名的一级子域名。" +
            "请使用不含点号的前缀；多级子域名需要先配置对应 Edge Certificate。",
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
            printWarning(readableError(error));
        }
    }
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
