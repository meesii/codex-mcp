import { accessSync, constants, existsSync } from "node:fs";
import { hasAdminPassword } from "../auth/password-store.js";
import { findRipgrep } from "../lib/search/ripgrep.js";
import { runSubprocess } from "../lib/util/subprocess.js";
import { suggestCloudflaredBin, probeCloudflaredVersion } from "../tunnel/bin.js";
import {
    hasManagedCloudflareLogin,
    readManagedCloudflareOriginToken,
    readTunnelCredentialIdentity,
} from "../tunnel/cloudflare-account.js";
import { getCredentialsPath } from "../tunnel/yml.js";
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
        label: "工具与技能",
        level: "ok",
        detail: `${describeEnabledCapabilitySources(capabilityConfig)} · ${capabilityConfig.sync === "watch" ? "自动同步" : "仅启动读取"}`,
    });
    if (capabilityConfig.sources.codex.mcp) {
        checks.push(await checkCommand("Codex", "codex", ["--version"], false));
    }

    const publicAccess = userConfig?.publicAccess;
    const publicModeExpected = userConfig?.runtime?.mode === "public" || publicAccess !== undefined;
    try {
        const configured = await hasAdminPassword();
        checks.push({
            label: "连接密码",
            level: configured ? "ok" : publicModeExpected ? "error" : "warn",
            detail: configured
                ? "已设置"
                : publicModeExpected
                  ? "未设置；公网连接需要连接密码，请在 Web 控制台的“连接”页面设置，或运行 `codex-mcp auth`"
                  : "未设置；仅本机模式不需要，连接 ChatGPT 时再设置即可",
        });
    } catch (error) {
        checks.push({
            label: "连接密码",
            level: "error",
            detail: readableError(error),
        });
    }

    if (publicAccess) {
        checks.push({
            label: "公网地址",
            level: "ok",
            detail: `https://${publicAccess.domain}/mcp`,
        });
    } else {
        checks.push({
            label: "公网地址",
            level: userConfig?.runtime?.mode === "public" ? "error" : "warn",
            detail: userConfig?.runtime?.mode === "public"
                ? "未设置；当前默认启动是公网模式，请在 Web 控制台的“连接”页面配置，或运行 `codex-mcp setup`"
                : "未设置；当前仍可仅本机使用，需要连接 ChatGPT 时再配置即可",
        });
    }

    if (publicAccess?.kind === "external") {
        checks.push({
            label: "公网方式",
            level: "warn",
            detail: "当前使用你自己的 HTTPS 公网地址，codex-mcp 不会启动 Cloudflare Tunnel。请确认这个地址已经转发到本机 MCP 服务",
        });
    } else if (publicAccess?.kind === "cloudflare") {
        const cloudflaredBin = await suggestCloudflaredBin(publicAccess.cloudflaredBin);
        if (!cloudflaredBin) {
            checks.push({
                label: "Cloudflare 连接组件",
                level: "error",
                detail: "缺少 Cloudflare 连接组件。运行 `codex-mcp setup` 会自动准备并继续配置",
            });
        } else {
            try {
                const version = await probeCloudflaredVersion(cloudflaredBin);
                checks.push({ label: "Cloudflare 连接组件", level: "ok", detail: version });
            } catch (error) {
                checks.push({
                    label: "Cloudflare 连接组件",
                    level: "error",
                    detail: readableError(error),
                });
            }
        }

        const managedLogin = hasManagedCloudflareLogin();
        checks.push({
            label: "Cloudflare 授权",
            level: managedLogin ? "ok" : "warn",
            detail: managedLogin
                ? "已登录，可以管理当前 Cloudflare 配置"
                : "当前没有可用的 Cloudflare 登录。已经运行的 Tunnel 可能仍能继续使用，但修改配置或检查 Cloudflare 远端状态前需要重新登录；运行 `codex-mcp setup` 选择“重新登录 / 切换 Cloudflare 账号”",
        });

        const credentialsPath = getCredentialsPath(publicAccess.tunnelId);
        const managedCredentials = canRead(credentialsPath);
        if (managedCredentials) {
            try {
                const identity = readTunnelCredentialIdentity(credentialsPath);
                const mismatch = identity.tunnelId !== publicAccess.tunnelId ||
                    identity.accountId !== publicAccess.accountId;
                checks.push({
                    label: "Cloudflare Tunnel 凭据",
                    level: mismatch ? "error" : "ok",
                    detail: mismatch
                        ? "本机保存的 Tunnel 凭据与当前 Cloudflare 配置不匹配；请运行 `codex-mcp setup` 重新配置 Cloudflare"
                        : "本机 Tunnel 凭据与当前 Cloudflare 配置一致",
                });
            } catch (error) {
                checks.push({ label: "Cloudflare Tunnel 凭据", level: "error", detail: readableError(error) });
            }
        } else {
            checks.push({
                label: "Cloudflare Tunnel 凭据",
                level: "error",
                detail: `缺少当前 Tunnel 的本机凭据。请运行 \`codex-mcp setup\` 重新配置 Cloudflare。文件位置：${credentialsPath}`,
            });
        }

        try {
            await loadCommittedTunnelSetup(userConfig);
            checks.push({ label: "Cloudflare 本机配置", level: "ok", detail: "配置文件与当前 Tunnel 一致" });
        } catch (error) {
            checks.push({ label: "Cloudflare 本机配置", level: "error", detail: `${readableError(error)}；请运行 \`codex-mcp setup\` 重新配置 Cloudflare` });
        }

        if (managedLogin) {
            try {
                const login = readManagedCloudflareOriginToken();
                if (login.accountID !== publicAccess.accountId) {
                    checks.push({
                        label: "Cloudflare 账号",
                        level: "error",
                        detail: "当前登录的 Cloudflare 账号与这个 Tunnel 所属账号不同；运行 `codex-mcp setup` 并选择“重新登录 / 切换 Cloudflare 账号”",
                    });
                } else {
                    checks.push({ label: "Cloudflare 账号", level: "ok", detail: "当前登录账号与 Tunnel 所属账号一致" });
                }
            } catch (error) {
                checks.push({ label: "Cloudflare 账号", level: "error", detail: readableError(error) });
            }
            try {
                const [tunnel, dns] = await Promise.all([
                    inspectCloudflareTunnel(publicAccess.accountId, publicAccess.tunnelId),
                    snapshotCloudflareDns(publicAccess.zoneId, publicAccess.domain),
                ]);
                checks.push({
                    label: "Cloudflare Tunnel",
                    level: tunnel.exists ? (tunnel.status === "down" ? "warn" : "ok") : "error",
                    detail: tunnel.exists
                        ? describeRemoteTunnel(tunnel.status, tunnel.connectorCount)
                        : "Cloudflare 上已经找不到这个 Tunnel；请运行 `codex-mcp setup` 重新配置公网连接",
                });
                const dnsMatches = dnsSnapshotPointsToTunnel(dns, publicAccess.tunnelId);
                checks.push({
                    label: "Cloudflare DNS",
                    level: dnsMatches ? "ok" : "error",
                    detail: dnsMatches
                        ? `${publicAccess.domain} 已正确指向当前 Tunnel`
                        : `${publicAccess.domain} 没有指向当前 Tunnel；请运行 \`codex-mcp setup\` 检查并重新配置这个域名`,
                });
            } catch (error) {
                checks.push({
                    label: "Cloudflare 远端检查",
                    level: "warn",
                    detail: `暂时无法读取 Cloudflare 远端状态：${readableError(error)}。本机服务可能仍可使用；请先检查网络或稍后重试`,
                });
            }
        } else {
            checks.push({
                label: "Cloudflare 远端检查",
                level: "warn",
                detail: "当前没有 Cloudflare 登录，因此只能检查本机状态。运行 `codex-mcp setup` 重新登录后，可以继续检查远端 Tunnel 和 DNS",
            });
        }
    }

    const daemon = await contactRunningDaemon();
    if (daemon) {
        const status = await daemon.client.status();
        checks.push({
            label: "MCP 服务",
            level: "ok",
            detail: `正在运行 · ${status.mode === "local" ? "仅本机" : "公网"} · 版本 ${status.version}`,
        });
        if (publicAccess && status.mode === "public") {
            const expected = `https://${publicAccess.domain}/mcp`;
            if (status.publicMcpUrl !== expected) {
                checks.push({
                    label: "MCP 服务配置",
                    level: "error",
                    detail: `正在运行的服务仍使用 ${status.publicMcpUrl ?? "旧的公网设置"}，当前保存的是 ${expected}；请运行 \`codex-mcp restart\` 让新配置生效`,
                });
            } else {
                checks.push({ label: "MCP 服务配置", level: "ok", detail: "正在运行的服务与当前保存的公网配置一致" });
            }
            try {
                await verifyRunningPublicRoute(
                    publicAccess.domain,
                    userConfig?.host ?? "127.0.0.1",
                    userConfig?.port ?? 3920,
                );
                checks.push({ label: "公网连接", level: "ok", detail: "公网地址已经确认连接到这台电脑上的 codex-mcp" });
            } catch (error) {
                checks.push({ label: "公网连接", level: "error", detail: readableError(error) });
            }
        } else if (publicAccess) {
            checks.push({
                label: "MCP 服务配置",
                level: "warn",
                detail: "当前 MCP 服务只在本机运行。公网配置已经保存，下次切换到公网模式时会使用",
            });
        }
        if (
            publicAccess?.kind === "cloudflare" &&
            status.runtimeIntent.local === false &&
            status.runtimeIntent.noTunnel === false
        ) {
            checks.push({
                label: "Cloudflare 连接",
                level: status.tunnel.state === "connected" ? "ok" : "error",
                detail: describeRunningTunnel(status.tunnel.state, status.tunnel.detail),
            });
        } else if (
            publicAccess?.kind === "cloudflare" &&
            status.runtimeIntent.local === false &&
            status.runtimeIntent.noTunnel === true
        ) {
            checks.push({
                label: "Cloudflare 连接",
                level: "warn",
                detail: "当前公网模式设置为不启动内置 Cloudflare Tunnel。只有你已经自己准备了 HTTPS 公网入口时才应这样使用",
            });
        }
    } else {
        checks.push({ label: "MCP 服务", level: "warn", detail: "当前没有启动。项目和连接设置都还在，需要使用时运行 `codex-mcp start`" });
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
            detail: "文件搜索组件缺失；运行 `codex-mcp doctor --fix` 可以自动恢复",
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

function describeRemoteTunnel(status: string | undefined, connectorCount: number | undefined): string {
    const count = connectorCount ?? 0;
    if (status === "down") return `远端 Tunnel 当前没有可用连接（活动连接 ${count} 个）`;
    if (status) return `远端 Tunnel 状态正常（${status}，活动连接 ${count} 个）`;
    return `远端 Tunnel 存在，Cloudflare 暂未返回明确状态（活动连接 ${count} 个）`;
}

function describeRunningTunnel(state: string, detail?: string): string {
    const label = state === "connected"
        ? "已连接"
        : state === "starting"
          ? "正在连接 Cloudflare"
          : state === "degraded"
            ? "连接不稳定，正在自动恢复"
            : state === "exited"
              ? "Cloudflare 连接已经停止"
              : state === "off"
                ? "未启动 Cloudflare 连接"
                : `状态：${state}`;
    return detail ? `${label} · ${detail}` : label;
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
