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
} from "../tunnel/cloudflare-account.js";
import { getCloudflaredConfigPath, getCredentialsPath } from "../tunnel/yml.js";
import { getUserConfigPath, loadUserConfig } from "../config/user-config.js";
import { describeEnabledCapabilitySources, resolveCapabilitiesConfig } from "../capabilities/config.js";

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

    if (userConfig?.domain) {
        checks.push({
            label: "公网地址",
            level: "ok",
            detail: `https://${userConfig.domain}/mcp`,
        });
    } else {
        checks.push({
            label: "公网地址",
            level: "error",
            detail: "未设置。要从 ChatGPT 连接，需要先运行 `codex-mcp setup`",
        });
    }

    if (userConfig?.useCloudflared === false) {
        checks.push({
            label: "Cloudflare Tunnel",
            level: "warn",
            detail: "已关闭。请确认你自己准备了可用的 HTTPS 公网入口",
        });
    } else {
        const cloudflaredBin = await suggestCloudflaredBin(userConfig?.cloudflaredBin);
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
            userConfig?.tunnelId &&
            canRead(getLegacyCloudflareOriginCertPath()) &&
            canRead(getLegacyTunnelCredentialsPath(userConfig.tunnelId)),
        );
        if (userConfig?.domain || userConfig?.tunnelId) {
            const managedLoginPath = getCloudflareOriginCertPath();
            const managedLogin = hasManagedCloudflareLogin();
            checks.push({
                label: "Cloudflare 登录",
                level: managedLogin ? "ok" : "warn",
                detail: managedLogin
                    ? `codex-mcp 私有登录：${managedLoginPath}`
                    : legacyTunnelStatePending
                      ? "检测到旧 ~/.cloudflared 登录和 Tunnel 凭据；下次启动或 setup 会在账号匹配后安全迁移"
                      : "没有可用的 codex-mcp 私有登录；Tunnel 仍可运行，但修改 Cloudflare 配置时需要重新登录",
            });
        }

        if (userConfig?.tunnelId) {
            const credentialsPath = getCredentialsPath(userConfig.tunnelId);
            const managedCredentials = canRead(credentialsPath);
            checks.push({
                label: "Tunnel 凭据",
                level: managedCredentials ? "ok" : legacyTunnelStatePending ? "warn" : "error",
                detail: managedCredentials
                    ? "已找到"
                    : legacyTunnelStatePending
                      ? "检测到旧 ~/.cloudflared Tunnel 凭据；下次启动或 setup 会在账号匹配后迁移"
                      : `缺少本机凭据：${credentialsPath}`,
            });
        } else {
            checks.push({
                label: "Tunnel 配置",
                level: "error",
                detail: "还没有创建 Tunnel，运行 `codex-mcp setup` 即可",
            });
        }

        checks.push({
            label: "Tunnel 配置文件",
            level: canRead(getCloudflaredConfigPath()) ? "ok" : "error",
            detail: canRead(getCloudflaredConfigPath())
                ? getCloudflaredConfigPath()
                : "没有找到，请重新运行 `codex-mcp setup`",
        });
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
            timeoutMs: 10_000,
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
            timeoutMs: 10_000,
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
