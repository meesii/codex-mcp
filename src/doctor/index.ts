import { accessSync, constants, existsSync } from "node:fs";
import { hasAdminPassword } from "../auth/password-store.js";
import { findRipgrep } from "../lib/search/ripgrep.js";
import { runSubprocess } from "../lib/util/subprocess.js";
import { suggestCloudflaredBin, probeCloudflaredVersion } from "../tunnel/bin.js";
import {
    getCloudflareOriginCertPath,
    getLegacyCloudflareOriginCertPath,
    getLegacyTunnelCredentialsPath,
    hasManagedCloudflareLogin,
    readManagedCloudflareOriginToken,
    readTunnelCredentialIdentity,
} from "../tunnel/cloudflare-account.js";
import { getCredentialsPath, resolveCloudflaredRuntimeConfigPath } from "../tunnel/yml.js";
import { getUserConfigPath, loadUserConfig } from "../config/user-config.js";
import { describeEnabledCapabilitySources, resolveCapabilitiesConfig } from "../capabilities/config.js";
import { dnsSnapshotPointsToTunnel, inspectCloudflareTunnel, snapshotCloudflareDns } from "../tunnel/cloudflare-api.js";
import { contactRunningDaemon } from "../daemon/control.js";
import { loadCommittedTunnelSetup } from "../tunnel/setup.js";
import { verifyRunningPublicRoute } from "../tunnel/setup-verify.js";

export type DoctorLevel = "ok" | "warn" | "error";

export interface DoctorCheck {
    label: string;
    level: DoctorLevel;
    detail: string;
}

export interface DoctorReport {
    checks: DoctorCheck[];
    errors: number;
    warnings: number;
}

export async function runDoctorChecks(): Promise<DoctorReport> {
    const checks: DoctorCheck[] = [];

    const nodeMajor = Number.parseInt(process.versions.node.split(".")[0] ?? "0", 10);
    checks.push({
        label: "Node.js",
        level: nodeMajor >= 22 ? "ok" : "error",
        detail:
            nodeMajor >= 22
                ? `版本 ${process.versions.node}`
                : `当前是 ${process.versions.node}，需要 22 或更高版本`,
    });

    checks.push(await checkCommand("Git", "git", ["--version"], false));
    checks.push(await checkRipgrep());

    let userConfig: ReturnType<typeof loadUserConfig> | undefined;
    try {
        userConfig = loadUserConfig();
        checks.push({
            label: "配置文件",
            level: existsSync(getUserConfigPath()) ? "ok" : "warn",
            detail: existsSync(getUserConfigPath())
                ? getUserConfigPath()
                : "还没有配置，运行 `codex-mcp setup` 即可",
        });
    } catch (error) {
        checks.push({
            label: "配置文件",
            level: "error",
            detail: readableError(error),
        });
    }

    const capabilityConfig = resolveCapabilitiesConfig(userConfig?.capabilities);
    checks.push({
        label: "外部能力",
        level: "ok",
        detail: `${describeEnabledCapabilitySources(capabilityConfig)} · ${capabilityConfig.sync === "watch" ? "自动同步" : "仅启动读取"}`,
    });
    if (capabilityConfig.sources.codex.mcp) {
        checks.push(await checkCommand("Codex", "codex", ["--version"], false));
    }

    try {
        const configured = await hasAdminPassword();
        checks.push({
            label: "连接密码",
            level: configured ? "ok" : "error",
            detail: configured ? "已设置" : "未设置，运行 `codex-mcp setup` 即可",
        });
    } catch (error) {
        checks.push({
            label: "连接密码",
            level: "error",
            detail: readableError(error),
        });
    }

    const publicAccess = userConfig?.publicAccess;
    if (publicAccess) {
        checks.push({
            label: "公网地址",
            level: "ok",
            detail: `https://${publicAccess.domain}/mcp`,
        });
    } else {
        checks.push({
            label: "公网地址",
            level: "error",
            detail: "未设置。要从 ChatGPT 连接，需要先运行 `codex-mcp setup`",
        });
    }

    if (publicAccess?.kind === "external") {
        checks.push({
            label: "Cloudflare Tunnel",
            level: "warn",
            detail: "已关闭。请确认你自己准备了可用的 HTTPS 公网入口",
        });
    } else if (publicAccess?.kind === "cloudflare") {
        const cloudflaredBin = await suggestCloudflaredBin(publicAccess.cloudflaredBin);
        if (!cloudflaredBin) {
            checks.push({
                label: "cloudflared",
                level: "error",
                detail: "没有找到 cloudflared。重新运行 `codex-mcp setup` 可以继续配置",
            });
        } else {
            try {
                const version = await probeCloudflaredVersion(cloudflaredBin);
                checks.push({ label: "cloudflared", level: "ok", detail: version });
            } catch (error) {
                checks.push({
                    label: "cloudflared",
                    level: "error",
                    detail: readableError(error),
                });
            }
        }

        const legacyTunnelStatePending = Boolean(
            publicAccess.tunnelId &&
            canRead(getLegacyCloudflareOriginCertPath()) &&
            canRead(getLegacyTunnelCredentialsPath(publicAccess.tunnelId)),
        );
        const managedLoginPath = getCloudflareOriginCertPath();
        const managedLogin = hasManagedCloudflareLogin();
        checks.push({
            label: "Cloudflare 登录",
            level: managedLogin ? "ok" : "warn",
            detail: managedLogin
                ? `codex-mcp 私有登录：${managedLoginPath}`
                : legacyTunnelStatePending
                  ? "检测到旧 ~/.cloudflared 登录和 Tunnel 凭据；下次 setup 会在账号匹配后安全迁移"
                  : "没有可用的 codex-mcp 私有登录；Tunnel 仍可运行，但修改或远端诊断时需要重新登录",
        });

        const credentialsPath = getCredentialsPath(publicAccess.tunnelId);
        const managedCredentials = canRead(credentialsPath);
        if (managedCredentials) {
            try {
                const identity = readTunnelCredentialIdentity(credentialsPath);
                const mismatch = identity.tunnelId !== publicAccess.tunnelId ||
                    (publicAccess.accountId !== undefined && identity.accountId !== publicAccess.accountId);
                checks.push({
                    label: "Tunnel 凭据",
                    level: mismatch ? "error" : "ok",
                    detail: mismatch
                        ? "credential 的 TunnelID / AccountTag 与已提交配置不一致"
                        : publicAccess.accountId
                          ? `${credentialsPath} · Tunnel / 账号一致`
                          : `${credentialsPath} · Tunnel ID 一致（旧配置未记录账号 ID）`,
                });
            } catch (error) {
                checks.push({ label: "Tunnel 凭据", level: "error", detail: readableError(error) });
            }
        } else {
            checks.push({
                label: "Tunnel 凭据",
                level: legacyTunnelStatePending ? "warn" : "error",
                detail: legacyTunnelStatePending
                    ? "检测到旧 ~/.cloudflared Tunnel 凭据；下次 setup 会在账号匹配后迁移"
                    : `缺少本机凭据：${credentialsPath}`,
            });
        }

        const runtimeConfigPath = resolveCloudflaredRuntimeConfigPath(publicAccess);
        try {
            await loadCommittedTunnelSetup(userConfig);
            checks.push({ label: "Tunnel 配置一致性", level: "ok", detail: runtimeConfigPath });
        } catch (error) {
            checks.push({ label: "Tunnel 配置一致性", level: "error", detail: readableError(error) });
        }

        if (managedLogin && publicAccess.accountId && publicAccess.zoneId) {
            try {
                const login = readManagedCloudflareOriginToken();
                if (login.accountID !== publicAccess.accountId) {
                    checks.push({
                        label: "Cloudflare 账号一致性",
                        level: "error",
                        detail: "当前私有登录账号与已提交 Tunnel 账号不同；运行 setup 重新选择账号",
                    });
                } else {
                    checks.push({ label: "Cloudflare 账号一致性", level: "ok", detail: publicAccess.accountId });
                }
            } catch (error) {
                checks.push({ label: "Cloudflare 账号一致性", level: "error", detail: readableError(error) });
            }
            try {
                const [tunnel, dns] = await Promise.all([
                    inspectCloudflareTunnel(publicAccess.accountId, publicAccess.tunnelId),
                    snapshotCloudflareDns(publicAccess.zoneId, publicAccess.domain),
                ]);
                checks.push({
                    label: "Cloudflare Tunnel 远端状态",
                    level: tunnel.exists ? (tunnel.status === "down" ? "warn" : "ok") : "error",
                    detail: tunnel.exists
                        ? `${tunnel.status ?? "状态未知"} · ${tunnel.connectorCount ?? 0} 个 connector`
                        : "远端 Tunnel 不存在",
                });
                const dnsMatches = dnsSnapshotPointsToTunnel(dns, publicAccess.tunnelId);
                checks.push({
                    label: "Cloudflare DNS 一致性",
                    level: dnsMatches ? "ok" : "error",
                    detail: dnsMatches
                        ? `${publicAccess.domain} → ${publicAccess.tunnelId}.cfargotunnel.com`
                        : `${publicAccess.domain} 没有唯一指向已提交 Tunnel`,
                });
            } catch (error) {
                checks.push({
                    label: "Cloudflare 远端诊断",
                    level: "warn",
                    detail: `只读 API 检查失败：${readableError(error)}`,
                });
            }
        } else {
            checks.push({
                label: "Cloudflare 远端诊断",
                level: "warn",
                detail: "旧配置缺少 accountId / zoneId，运行一次 setup 后可启用远端一致性检查",
            });
        }
    }

    const daemon = await contactRunningDaemon();
    if (daemon) {
        const status = await daemon.client.status();
        checks.push({
            label: "守护进程",
            level: "ok",
            detail: `pid ${status.pid} · ${status.mode === "local" ? "本机" : "公网"} · ${status.version}`,
        });
        if (publicAccess && status.mode === "public") {
            const expected = `https://${publicAccess.domain}/mcp`;
            if (status.publicMcpUrl !== expected) {
                checks.push({
                    label: "Daemon 配置一致性",
                    level: "error",
                    detail: `daemon 使用 ${status.publicMcpUrl ?? "无公网地址"}，已提交配置是 ${expected}；请重启`,
                });
            } else {
                checks.push({ label: "Daemon 配置一致性", level: "ok", detail: expected });
            }
            try {
                await verifyRunningPublicRoute(
                    publicAccess.domain,
                    userConfig?.host ?? "127.0.0.1",
                    userConfig?.port ?? 3920,
                );
                checks.push({ label: "公网实例一致性", level: "ok", detail: "公网与本机返回相同 instance" });
            } catch (error) {
                checks.push({ label: "公网实例一致性", level: "error", detail: readableError(error) });
            }
        } else if (publicAccess) {
            checks.push({
                label: "Daemon 配置一致性",
                level: "warn",
                detail: "daemon 当前以本机模式运行；已提交公网配置会在下次公网启动时使用",
            });
        }
        if (
            publicAccess?.kind === "cloudflare" &&
            status.runtimeIntent.local === false &&
            status.runtimeIntent.noTunnel === false
        ) {
            checks.push({
                label: "Tunnel 运行状态",
                level: status.tunnel.state === "connected" ? "ok" : "error",
                detail: `${status.tunnel.state}${status.tunnel.detail ? ` · ${status.tunnel.detail}` : ""}`,
            });
        } else if (
            publicAccess?.kind === "cloudflare" &&
            status.runtimeIntent.local === false &&
            status.runtimeIntent.noTunnel === true
        ) {
            checks.push({
                label: "Tunnel 运行状态",
                level: "warn",
                detail: "daemon 使用 --no-tunnel，managed sidecar 未启动",
            });
        }
    } else {
        checks.push({ label: "守护进程", level: "warn", detail: "未运行；项目注册和公网配置仍保留" });
    }

    const errors = checks.filter((item) => item.level === "error").length;
    const warnings = checks.filter((item) => item.level === "warn").length;
    return { checks, errors, warnings };
}

async function checkRipgrep(): Promise<DoctorCheck> {
    const binary = await findRipgrep();
    if (!binary) {
        return {
            label: "文件搜索",
            level: "error",
            detail: "文件搜索组件缺失；重新运行安装脚本可以自动恢复",
        };
    }
    try {
        const result = await runSubprocess(binary, ["--version"], {
            timeoutMs: 30_000,
            maxStdoutBytes: 16 * 1024,
            maxStderrBytes: 16 * 1024,
            maxTotalBytes: 32 * 1024,
        });
        const firstLine = `${result.stdout}\n${result.stderr}`
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        return {
            label: "文件搜索",
            level: result.exitCode === 0 ? "ok" : "error",
            detail:
                result.exitCode === 0
                    ? firstLine ?? "已安装"
                    : "文件搜索组件存在，但无法正常启动",
        };
    } catch {
        return {
            label: "文件搜索",
            level: "error",
            detail: "文件搜索组件存在，但无法正常启动",
        };
    }
}

async function checkCommand(
    label: string,
    command: string,
    args: string[],
    required: boolean,
): Promise<DoctorCheck> {
    try {
        const result = await runSubprocess(command, args, {
            timeoutMs: 30_000,
            maxStdoutBytes: 16 * 1024,
            maxStderrBytes: 16 * 1024,
            maxTotalBytes: 32 * 1024,
        });
        if (result.exitCode !== 0) {
            return {
                label,
                level: required ? "error" : "warn",
                detail: `${command} 可以启动，但返回了错误`,
            };
        }
        const firstLine = `${result.stdout}\n${result.stderr}`
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find(Boolean);
        return {
            label,
            level: "ok",
            detail: firstLine ?? "已安装",
        };
    } catch {
        return {
            label,
            level: required ? "error" : "warn",
            detail:
                label === "Codex"
                    ? "没有找到；核心功能仍可用，但不会自动继承 Codex 的 MCP"
                    : label === "Git"
                      ? "没有找到；Git 状态、历史和差异相关功能不可用"
                      : "没有找到",
        };
    }
}

function canRead(path: string): boolean {
    try {
        accessSync(path, constants.R_OK);
        return true;
    } catch {
        return false;
    }
}

function readableError(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
