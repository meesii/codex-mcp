import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { isIP } from "node:net";
import { homedir, hostname as osHostname } from "node:os";
import { printInfo, printSuccess, printWarning } from "../lib/util/terminal.js";
import { ensureManagedTool } from "../managed-tools/install.js";
import {
    ensureStarterUserConfig,
    ensureUserConfigDirs,
    getUserConfigPath,
    loadUserConfig,
    normalizeHostname,
    saveUserConfig,
    type CloudflarePublicAccessConfig,
    type PublicAccessConfig,
    type UserConfig,
} from "../config/user-config.js";
import { probeCloudflaredVersion, suggestCloudflaredBin } from "./bin.js";
import {
    discoverCloudflareZones,
    migrateLegacyCloudflareState,
} from "./cloudflare-account.js";
import {
    cutoverCloudflareDns,
    dnsSnapshotReferencesTunnel,
    dnsSnapshotPointsToTunnel,
    restoreCloudflareDns,
    snapshotCloudflareDns,
    type CloudflareDnsSnapshot,
} from "./cloudflare-api.js";
import { requireDnsOverwriteConfirmation } from "./confirm.js";
import {
    assertCredentialMatches,
    cleanupCreatedTunnel,
    ensureLogin,
    ensureTunnelCreated,
} from "./cloudflare-session.js";
import { askLine, askSelect, askYesNo, canPromptInteractively, withSpinner } from "./prompt.js";
import {
    assertSetupPortAvailable,
    verifySetupPublicRoute,
    type SetupPublicVerificationResult,
} from "./setup-verify.js";
import {
    getCloudflaredConfigPath,
    getCredentialsPath,
    readCloudflaredYml,
    removeCloudflaredRevision,
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

/** Verify a candidate, compensate remote changes on failure, then commit locally. */
export async function applyTunnelSetup(candidate: TunnelSetupResult): Promise<AppliedTunnelSetup> {
    const host = candidate.userConfig.host ?? "127.0.0.1";
    const port = candidate.userConfig.port ?? 3920;
    const cancellation = installSetupCancellationGuard();

    let dnsSnapshot: CloudflareDnsSnapshot | undefined;
    let committedDns: CloudflareDnsSnapshot | undefined;
    let dnsChanged = false;
    let phase = "本机端口预检";
    try {
        await assertSetupPortAvailable(host, port);
        cancellation.throwIfRequested();
        phase = candidate.useCloudflared ? "candidate connector 启动" : "公网验证";
        const verification = await verifySetupPublicRoute(candidate, host, port, {
            totalTimeoutMs: 300_000,
            signal: cancellation.signal,
            beforePublicVerify: candidate.useCloudflared
                ? async () => {
                      cancellation.throwIfRequested();
                      phase = "DNS 快照";
                      if (!candidate.zoneId || !candidate.tunnelId) {
                          throw new Error("Cloudflare DNS 配置缺少 zone 或 Tunnel ID");
                      }
                      dnsSnapshot = await snapshotCloudflareDns(candidate.zoneId, candidate.domain);
                      if (
                          dnsSnapshot.records.length > 0 &&
                          !dnsSnapshotPointsToTunnel(dnsSnapshot, candidate.tunnelId)
                      ) {
                          printWarning(`域名 ${candidate.domain} 已经有其它 DNS 记录，需要确认是否替换。`);
                          await requireDnsOverwriteConfirmation(candidate.domain);
                      }
                      cancellation.throwIfRequested();
                      phase = "DNS cutover";
                      const cutover = await withSpinner(
                          `正在把域名 ${candidate.domain} 连接到已就绪的 Tunnel…`,
                          "DNS 路由切换完成",
                          () => cutoverCloudflareDns(dnsSnapshot!, candidate.tunnelId!),
                      );
                      dnsChanged = cutover.changed;
                      committedDns = cutover.committed;
                      cancellation.throwIfRequested();
                      phase = "公网验证";
                  }
                : undefined,
        });

        cancellation.throwIfRequested();
        phase = "本机配置提交";
        const committedConfig = saveUserConfig({
            host,
            port,
            publicAccess: candidate.publicAccess,
        });
        if (
            candidate.previousConfigRevision &&
            candidate.previousConfigRevision !== candidate.configRevision
        ) {
            try {
                removeCloudflaredRevision(candidate.previousConfigRevision);
            } catch (error) {
                printWarning(`旧 Tunnel 配置 revision 清理失败，可稍后手动检查：${readableError(error)}`);
            }
        }
        printSuccess(`codex-mcp 配置已原子提交：${getUserConfigPath()}`);
        return {
            result: { ...candidate, userConfig: committedConfig },
            verification,
        };
    } catch (error) {
        const recoveryErrors: string[] = [];
        let mayDeleteCreatedTunnel = !dnsSnapshot ||
            !candidate.tunnelId ||
            !dnsSnapshotPointsToTunnel(dnsSnapshot, candidate.tunnelId);
        if (dnsSnapshot && committedDns && dnsChanged) {
            mayDeleteCreatedTunnel = false;
            try {
                await restoreCloudflareDns(dnsSnapshot, committedDns);
                mayDeleteCreatedTunnel = true;
                printWarning("公网验证失败，已恢复修改前的 DNS 记录。");
            } catch (restoreError) {
                recoveryErrors.push(`DNS 恢复失败：${readableError(restoreError)}`);
            }
        }
        if (
            dnsSnapshot &&
            candidate.candidateSession?.createdTunnel &&
            candidate.zoneId &&
            candidate.tunnelId
        ) {
            try {
                const latestDns = await snapshotCloudflareDns(candidate.zoneId, candidate.domain);
                if (dnsSnapshotReferencesTunnel(latestDns, candidate.tunnelId)) {
                    mayDeleteCreatedTunnel = false;
                }
            } catch (inspectError) {
                mayDeleteCreatedTunnel = false;
                recoveryErrors.push(`candidate DNS 引用检查失败：${readableError(inspectError)}`);
            }
        }
        await cleanupFailedCandidate(candidate, recoveryErrors, mayDeleteCreatedTunnel);
        if (recoveryErrors.length > 0) {
            throw new Error(
                `公网配置失败（阶段：${phase}）：${readableError(error)}；${recoveryErrors.join("；")}。` +
                "Cloudflare 可能处于部分变更状态，请先运行 `codex-mcp doctor`，不要重复覆盖 DNS。",
            );
        }
        throw new Error(`公网配置失败（阶段：${phase}）：${readableError(error)}`, {
            cause: error,
        });
    } finally {
        cancellation.dispose();
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
    const existingYml = tryReadExistingYml(userConfig);
    printInfo("设置公网连接");
    printInfo(`验证成功后才会提交到：${getUserConfigPath()}`);

    const useCloudflared = await askYesNo(
        "要让 codex-mcp 自动配置 Cloudflare Tunnel 吗？",
        userConfig.publicAccess?.kind !== "external",
    );
    if (!useCloudflared) {
        const domain = await askPublicDomain(
            userConfig.publicAccess?.domain ?? existingYml?.hostname,
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
    const knownTunnelId = previousManaged?.tunnelId ?? existingYml?.tunnelId;
    if (!forceCloudflareLogin) {
        reportLegacyCloudflareMigration(migrateLegacyCloudflareState(knownTunnelId));
    }
    const login = await ensureLogin(bin, forceCloudflareLogin);
    if (forceCloudflareLogin) {
        reportLegacyCloudflareMigration(migrateLegacyCloudflareState(knownTunnelId));
    }

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

    const previousDomain = userConfig.publicAccess?.domain ?? existingYml?.hostname;
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
        previousManaged?.tunnelId ?? existingYml?.tunnelId,
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

export async function discardTunnelSetupCandidate(candidate: TunnelSetupResult): Promise<void> {
    const recoveryErrors: string[] = [];
    await cleanupFailedCandidate(candidate, recoveryErrors, true);
    if (recoveryErrors.length > 0) {
        throw new Error(recoveryErrors.join("；"));
    }
}

async function cleanupFailedCandidate(
    candidate: TunnelSetupResult,
    recoveryErrors: string[],
    mayDeleteCreatedTunnel: boolean,
): Promise<void> {
    if (candidate.candidateSession && candidate.configRevision) {
        try {
            removeCloudflaredRevision(candidate.configRevision);
        } catch (error) {
            recoveryErrors.push(`candidate YAML 清理失败：${readableError(error)}`);
        }
    }
    if (!candidate.candidateSession?.createdTunnel || !candidate.bin || !candidate.tunnelId) return;
    if (!mayDeleteCreatedTunnel) {
        recoveryErrors.push(
            "candidate Tunnel 仍可能被 DNS 引用，为避免扩大故障未自动删除",
        );
        return;
    }
    await cleanupCreatedTunnel(candidate.bin, candidate.tunnelId, recoveryErrors);
}

function tryReadExistingYml(
    userConfig: UserConfig,
): { hostname: string; tunnelId: string } | undefined {
    const access = userConfig.publicAccess;
    const configPath = access?.kind === "cloudflare"
        ? resolveCloudflaredRuntimeConfigPath(access)
        : getCloudflaredConfigPath();
    if (!existsSync(configPath)) return undefined;
    try {
        const parsed = readCloudflaredYml(configPath);
        return { hostname: parsed.hostname, tunnelId: parsed.tunnelId };
    } catch {
        return undefined;
    }
}

async function resolveOrInstallCloudflaredBin(configured?: string): Promise<string> {
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
    const localHost = host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host;
    const formatted = isIP(localHost) === 6 ? `[${localHost}]` : localHost;
    return `http://${formatted}:${port}`;
}

function reportLegacyCloudflareMigration(
    result: ReturnType<typeof migrateLegacyCloudflareState>,
): void {
    if (!result.certMigrated && !result.credentialsMigrated) return;
    const migrated = [
        result.certMigrated ? "登录凭据" : undefined,
        result.credentialsMigrated ? "Tunnel 凭据" : undefined,
    ].filter((value): value is string => Boolean(value));
    printInfo(`已把旧 ~/.cloudflared 的${migrated.join("和")}迁移到 codex-mcp 私有目录。`);
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
            printWarning("需要填写一个域名。没有域名时可用 `codex-mcp --local` 只在本机运行。");
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

function installSetupCancellationGuard(): {
    signal: AbortSignal;
    throwIfRequested: () => void;
    dispose: () => void;
} {
    const controller = new AbortController();
    let announced = false;
    const onSigint = (): void => {
        if (!controller.signal.aborted) {
            controller.abort(new Error("已取消公网配置"));
        }
        if (!announced) {
            announced = true;
            printWarning("收到 Ctrl+C，正在安全结束本次公网配置；如已修改 DNS 会先尝试恢复。");
        }
    };
    process.on("SIGINT", onSigint);
    return {
        signal: controller.signal,
        throwIfRequested: () => {
            if (controller.signal.aborted) {
                throw controller.signal.reason instanceof Error
                    ? controller.signal.reason
                    : new Error("已取消公网配置");
            }
        },
        dispose: () => process.off("SIGINT", onSigint),
    };
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
