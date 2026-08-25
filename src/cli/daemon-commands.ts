import { readFileSync } from "node:fs";
import { resolveProjectRoot } from "../config/loader.js";
import { loadUserConfig } from "../config/user-config.js";
import {
    cleanStaleDaemonState,
    contactRunningDaemon,
    spawnDaemonProcess,
    startDaemonForIntent,
    stopDaemonContact,
    waitForDaemonStart,
    withDaemonLifecycleLock,
    withDaemonStartLock,
    type DaemonContact,
    type DaemonStatusPayload,
    type TunnelObservedStatus,
} from "../daemon/control.js";
import { loadProjectsFile } from "../daemon/state.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import {
    printInfo,
    printIntro,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "../lib/util/terminal.js";
import { detectProjectDisplayName } from "../projects/identity.js";
import { ensureAdminPasswordConfigured } from "./setup-commands.js";
import { configurePublicAccess } from "../tunnel/public-access-manager.js";
import { verifyRunningPublicRoute } from "../tunnel/setup-verify.js";
import type { CliFlags } from "./args.js";

/** Ensure the daemon is running, register the selected project, and print status. */
export async function ensureDaemonAndRegister(flags: CliFlags): Promise<void> {
    const projectRoot = resolveProjectRoot(flags.root);
    const displayName = detectProjectDisplayName(projectRoot);
    const daemon = await ensureDaemonRunning(flags);
    const project = await daemon.client.registerProject({
        path: projectRoot,
        name: displayName,
    });
    const status = await daemon.client.status();
    printRegistrationBanner(status, project);
    writeRuntimeLog("info", "project_registered_cli", {
        project: project.id,
        daemonPid: status.pid,
    });
}

/** Find or start the background daemon, running first-time setup when needed. */
export async function ensureDaemonRunning(
    flags: Pick<CliFlags, "local" | "noTunnel" | "tunnelLogs" | "runtimeIntentSpecified">,
): Promise<DaemonContact> {
    const desiredIntent = {
        local: flags.local,
        noTunnel: flags.noTunnel,
        tunnelLogs: flags.tunnelLogs,
    };
    const existing = await contactRunningDaemon();
    if (existing && !flags.runtimeIntentSpecified) return existing;
    if (existing && runtimeIntentMatches(existing.state.runtimeIntent, desiredIntent)) return existing;
    if (existing) {
        return await withDaemonLifecycleLock(async () => {
            const current = await contactRunningDaemon();
            if (current && runtimeIntentMatches(current.state.runtimeIntent, desiredIntent)) return current;
            if (current) await stopDaemonContact(current);
            return await startDaemonForIntent(desiredIntent);
        });
    }

    cleanStaleDaemonState();

    if (!flags.local && !loadUserConfig().publicAccess) {
        await configurePublicAccess({ forceWizard: false });
    }

    if (!flags.local) {
        await ensureAdminPasswordConfigured();
    }

    const daemon = await withDaemonStartLock(async () => {
        const again = await contactRunningDaemon();
        if (again && !flags.runtimeIntentSpecified) return again;
        if (again && runtimeIntentMatches(again.state.runtimeIntent, desiredIntent)) return again;
        if (again) await stopDaemonContact(again);

        const spawned = spawnDaemonProcess({ ...desiredIntent });
        const { pid } = spawned;
        printInfo(`守护进程正在启动（pid ${pid}）…`);
        return await waitForDaemonStart(pid, spawned.exited);
    });
    if (!daemon) {
        throw new Error("守护进程启动失败，请查看 ~/.codex-mcp/logs 下的日志。");
    }
    writeRuntimeLog("info", "daemon_started_via_cli", { pid: daemon.state.pid });
    return daemon;
}

export async function runStatus(flags: CliFlags): Promise<void> {
    const cliVersion = getPackageVersion();
    const daemon = await contactRunningDaemon();
    if (!daemon) {
        cleanStaleDaemonState();
        const projects = loadProjectsFile();
        if (flags.json) {
            console.log(JSON.stringify({
                schemaVersion: 1,
                running: false,
                cliVersion,
                daemonVersion: null,
                versionMismatch: false,
                daemon: null,
                projects: projects.map((item) => ({ ...item, boundSessions: null })),
            }, null, 2));
            return;
        }
        printIntro("codex-mcp status");
        printWarning("守护进程没有在运行。");
        if (projects.length > 0) {
            printInfo(`已保存 ${projects.length} 个项目注册记录；进入任一项目目录运行 codex-mcp 即可重新启动后台服务。`);
        } else {
            printInfo("进入项目目录运行 codex-mcp 即可启动；查看帮助运行 codex-mcp help。");
        }
        printOutro("状态检查完成");
        return;
    }

    const status = await daemon.client.status();
    const versionMismatch = cliVersion !== status.version;
    if (flags.json) {
        console.log(JSON.stringify({
            schemaVersion: 1,
            running: true,
            cliVersion,
            daemonVersion: status.version,
            versionMismatch,
            daemon: {
                pid: status.pid,
                mode: status.mode,
                startedAt: status.startedAt,
                uptimeMs: status.uptimeMs,
                localUrl: status.localUrl,
                publicMcpUrl: status.publicMcpUrl ?? null,
                runtimeIntent: status.runtimeIntent,
                tunnelRunning: status.tunnel.running,
                tunnel: status.tunnel,
            },
            projects: status.projects,
        }, null, 2));
        return;
    }

    printIntro("codex-mcp status");
    printSummary("守护进程", [
        { label: "状态", value: `pid ${status.pid} · ${status.mode === "local" ? "本机" : "公网"}` },
        { label: "运行时长", value: formatUptime(status.uptimeMs) },
        { label: "CLI 版本", value: cliVersion },
        { label: "Daemon 版本", value: status.version },
        { label: "本机地址", value: status.localUrl },
        { label: "公网地址", value: status.publicMcpUrl ?? "未启用" },
        { label: "公网连接", value: describeTunnelStatus(status.tunnel) },
    ]);

    if (versionMismatch) {
        printWarning(`CLI 是 ${cliVersion}，但正在运行的 daemon 是 ${status.version}。运行 codex-mcp restart 载入当前版本。`);
    }

    const active = status.projects.filter((item) => item.active);
    if (status.projects.length === 0) {
        printInfo("还没有注册项目。进入项目目录运行 codex-mcp 注册第一个项目。");
    } else {
        printInfo("已注册项目：");
        for (const item of status.projects) {
            printInfo(
                `- ${item.name}${item.active ? "" : "（已停用）"} ${item.path} · ${item.boundSessions} 个会话绑定`,
            );
        }
        if (active.length === 0) {
            printWarning("没有活动项目。进入项目目录运行 codex-mcp 即可重新注册。");
        }
    }

    if (status.publicMcpUrl) {
        const reachable = await checkPublicHealthz(
            daemon.state.host,
            daemon.state.port,
            status.publicMcpUrl,
        );
        if (!reachable) {
            printWarning(
                `公网地址暂时无法验证（${status.publicMcpUrl}）。请运行 codex-mcp doctor 检查公网连接。`,
            );
        }
    }
    printOutro("状态检查完成");
}

/** Stop the daemon without changing persisted project active state. */
export async function runStop(): Promise<void> {
    const stopped = await withDaemonLifecycleLock(async () => {
        const daemon = await contactRunningDaemon();
        if (!daemon) {
            cleanStaleDaemonState();
            return false;
        }
        printInfo("正在停止后台服务（Tunnel、托管进程和 MCP 服务会一起关闭）…");
        await stopDaemonContact(daemon);
        return true;
    });
    if (!stopped) {
        printWarning("守护进程没有在运行。");
        return;
    }
    printSuccess("后台服务已停止；项目注册状态已保留。");
}

/** Restart a running daemon in the same local/public mode while preserving projects. */
export async function runRestart(): Promise<void> {
    const daemon = await withDaemonLifecycleLock(async () => {
        const existing = await contactRunningDaemon();
        if (!existing) {
            cleanStaleDaemonState();
            throw new Error("守护进程没有在运行，无法重启。进入项目目录运行 `codex-mcp` 启动；只在本机使用时运行 `codex-mcp --local`。");
        }
        const intent = existing.state.runtimeIntent;
        printInfo("正在按原运行参数重启后台服务…");
        await stopDaemonContact(existing);
        return await startDaemonForIntent(intent);
    });
    const status = await daemon.client.status();
    printSuccess(`后台服务已重启：pid ${status.pid} · ${status.version} · ${status.projects.filter((item) => item.active).length} 个活动项目。`);
}

export function getPackageVersion(): string {
    try {
        const raw = JSON.parse(
            readFileSync(new URL("../../package.json", import.meta.url), "utf8"),
        ) as { version?: unknown };
        return typeof raw.version === "string" ? raw.version : "未知版本";
    } catch {
        return "未知版本";
    }
}

function runtimeIntentMatches(
    left: { local: boolean; noTunnel: boolean; tunnelLogs: boolean },
    right: { local: boolean; noTunnel: boolean; tunnelLogs: boolean },
): boolean {
    return left.local === right.local &&
        left.noTunnel === right.noTunnel &&
        left.tunnelLogs === right.tunnelLogs;
}

function printRegistrationBanner(
    status: DaemonStatusPayload,
    project: { id: string; name: string; path: string },
): void {
    printIntro("codex-mcp");
    printSummary("已就绪", [
        { label: "守护进程", value: `pid ${status.pid} · 已运行 ${formatUptime(status.uptimeMs)}` },
        { label: "本机地址", value: status.localUrl },
        { label: "公网地址", value: status.publicMcpUrl ?? "未启用" },
        { label: "公网连接", value: describeTunnelStatus(status.tunnel) },
        { label: "当前项目", value: `${project.name}（${project.path}）` },
        { label: "已注册项目", value: `${status.projects.length} 个` },
    ]);
    printInfo(`在 ChatGPT 中使用 project_control(action=select, project_id=${project.id}) 绑定这个项目；升级后请 Refresh / 重新发布 MCP app actions。`);
    printOutro("如需停止当前项目：codex-mcp exit");
}

function formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
}

async function checkPublicHealthz(
    localHost: string,
    localPort: number,
    publicMcpUrl: string,
): Promise<boolean> {
    try {
        await verifyRunningPublicRoute(new URL(publicMcpUrl).hostname, localHost, localPort);
        return true;
    } catch {
        return false;
    }
}

function describeTunnelStatus(status: TunnelObservedStatus): string {
    if (status.state === "off") return "未托管";
    if (status.state === "connected") return status.restartCount
        ? `已连接 · 重启 ${status.restartCount} 次`
        : "已连接";
    const labels = {
        starting: "正在连接",
        degraded: "连接降级",
        exited: "连接已退出",
    } as const;
    return `${labels[status.state]}${status.detail ? ` · ${status.detail}` : ""}`;
}
