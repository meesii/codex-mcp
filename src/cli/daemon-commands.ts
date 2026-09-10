import { readFileSync } from "node:fs";
import { resolveProjectRoot } from "../config/loader.js";
import { loadUserConfig } from "../config/user-config.js";
import type { DaemonStatusPayload, TunnelObservedStatus } from "../daemon/control.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import {
    contactRunningController,
    ensureControllerRunning,
    type ControllerContact,
} from "../control/control.js";
import { getControlStatus } from "../control/services.js";
import {
    printInfo,
    printIntro,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "../lib/util/terminal.js";
import { canonicalProjectPath } from "../projects/identity.js";
import { ensureAdminPasswordConfigured } from "./setup-commands.js";
import { configurePublicAccess } from "../tunnel/public-access-manager.js";
import { verifyRunningPublicRoute } from "../tunnel/setup-verify.js";
import type { CliFlags } from "./args.js";

/** Ensure the Controller exists, then register/start the selected project through its shared service. */
export async function ensureDaemonAndRegister(flags: CliFlags): Promise<void> {
    const projectRoot = resolveProjectRoot(flags.root);
    const controller = await ensureControllerForRuntime(flags);
    printInfo("正在通过本机 Controller 准备 Runtime…");
    const result = await controller.client.start({
        local: flags.local,
        noTunnel: flags.noTunnel,
        tunnelLogs: flags.tunnelLogs,
        intentSpecified: flags.runtimeIntentSpecified,
        projectPath: projectRoot,
    });
    const status = result.status.runtime;
    if (!status) throw new Error("Runtime 启动后没有返回运行状态");
    const canonicalRoot = canonicalProjectPath(projectRoot);
    const project = status.projects.find((item) => item.path === canonicalRoot);
    if (!project) throw new Error(`Runtime 已启动，但没有找到刚注册的项目：${projectRoot}`);
    printRegistrationBanner(status, project, controller.state.port);
    writeRuntimeLog("info", "project_registered_cli", {
        project: project.id,
        daemonPid: status.pid,
        controllerPid: controller.state.pid,
    });
}

/** Start the persistent local Controller and preserve the old CLI first-run setup behavior. */
export async function ensureControllerForRuntime(
    flags: Pick<CliFlags, "local" | "noTunnel" | "tunnelLogs" | "runtimeIntentSpecified">,
): Promise<ControllerContact> {
    const controller = await ensureControllerRunning();
    const current = await controller.client.status();
    if (!current.runtime.running || flags.runtimeIntentSpecified) {
        if (!flags.local && !loadUserConfig().publicAccess) {
            await configurePublicAccess({ forceWizard: false });
        }
        if (!flags.local) await ensureAdminPasswordConfigured();
    }
    return controller;
}

export async function runStatus(flags: CliFlags): Promise<void> {
    const cliVersion = getPackageVersion();
    const controller = await contactRunningController();
    const controllerStatus = controller ? await controller.client.status() : undefined;
    const control = controllerStatus?.runtime ?? await getControlStatus();
    const status = control.runtime;
    const daemonVersion = status?.version ?? null;
    const versionMismatch = Boolean(
        (daemonVersion && daemonVersion !== cliVersion) ||
        (controllerStatus && controllerStatus.version !== cliVersion),
    );
    const controllerJson = controllerStatus ? {
        apiVersion: controllerStatus.apiVersion,
        pid: controllerStatus.pid,
        version: controllerStatus.version,
        startedAt: controllerStatus.startedAt,
        uptimeMs: controllerStatus.uptimeMs,
        panelUrl: controllerStatus.panelUrl,
    } : null;

    if (flags.json) {
        console.log(JSON.stringify({
            schemaVersion: 1,
            running: control.running,
            cliVersion,
            daemonVersion,
            versionMismatch,
            controller: controllerJson,
            daemon: status ? {
                controlApiVersion: status.controlApiVersion,
                pid: status.pid,
                mode: status.mode,
                startedAt: status.startedAt,
                uptimeMs: status.uptimeMs,
                localUrl: status.localUrl,
                publicMcpUrl: status.publicMcpUrl ?? null,
                runtimeIntent: status.runtimeIntent,
                tunnelRunning: status.tunnel.running,
                tunnel: status.tunnel,
                auth: status.auth,
            } : null,
            projects: control.projects,
        }, null, 2));
        return;
    }

    printIntro("codex-mcp status");
    if (!status) {
        printWarning("MCP Runtime 没有在运行。");
        if (controllerStatus) {
            printInfo(`本机 Controller 仍在运行：pid ${controllerStatus.pid} · ${controllerStatus.panelUrl}`);
        } else {
            printInfo("本机 Controller 尚未运行；执行 codex-mcp start 后会自动启动。");
        }
        if (control.projects.length > 0) {
            printInfo(`已保存 ${control.projects.length} 个项目注册记录；Runtime 重启后可继续使用。`);
        }
        printOutro("状态检查完成");
        return;
    }

    printSummary("本机控制面", [
        { label: "Controller", value: controllerStatus ? `pid ${controllerStatus.pid} · ${controllerStatus.version}` : "未运行" },
        { label: "Web Console", value: controllerStatus?.panelUrl ?? "未运行" },
        { label: "Runtime", value: `pid ${status.pid} · ${status.mode === "local" ? "本机" : "公网"}` },
        { label: "运行时长", value: formatUptime(status.uptimeMs) },
        { label: "CLI 版本", value: cliVersion },
        { label: "Runtime 版本", value: status.version },
        { label: "本机 MCP", value: status.localUrl },
        { label: "OAuth", value: status.auth.required ? (status.auth.configured ? "已配置" : "未配置") : "未启用" },
        { label: "公网地址", value: status.publicMcpUrl ?? "未启用" },
        { label: "公网连接", value: describeTunnelStatus(status.tunnel) },
    ]);

    if (versionMismatch) {
        printWarning("CLI、Controller 或 Runtime 版本不一致。先运行 codex-mcp update，再运行 codex-mcp restart。" );
    }

    const active = status.projects.filter((item) => item.active);
    if (status.projects.length === 0) {
        printInfo("还没有注册项目。进入项目目录运行 codex-mcp start 注册第一个项目。");
    } else {
        printInfo("已注册项目：");
        for (const item of status.projects) {
            printInfo(`- ${item.name}${item.active ? "" : "（已停用）"} ${item.path} · ${item.boundSessions} 个会话绑定`);
        }
        if (active.length === 0) printWarning("没有活动项目。运行 codex-mcp project add [目录] 重新启用。");
    }

    if (status.publicMcpUrl && !(await checkPublicHealthz(status.localUrl, status.publicMcpUrl))) {
        printWarning(`公网地址暂时无法验证（${status.publicMcpUrl}）。请运行 codex-mcp doctor 检查公网连接。`);
    }
    printOutro("状态检查完成");
}

/** Stop only the MCP Runtime; the persistent local Controller and Web Console stay online. */
export async function runStop(): Promise<void> {
    let controller = await contactRunningController();
    if (!controller) {
        const control = await getControlStatus();
        if (!control.running) {
            printWarning("MCP Runtime 没有在运行；本机 Controller 也未启动。");
            return;
        }
        controller = await ensureControllerRunning();
    }
    printInfo("正在停止 MCP Runtime（Tunnel、托管进程和 MCP 服务会一起关闭）…");
    const result = await controller.client.stop();
    if (!result.stopped) {
        printWarning("MCP Runtime 没有在运行；本机 Controller 保持在线。");
        return;
    }
    printSuccess(`MCP Runtime 已停止；项目注册状态已保留。Web Console：http://127.0.0.1:${controller.state.port}/`);
}

/** Restart a running Runtime in the same mode through the persistent Controller. */
export async function runRestart(): Promise<void> {
    const controller = await ensureControllerRunning();
    printInfo("正在通过本机 Controller 按原运行参数重启 Runtime…");
    const result = await controller.client.restart();
    const status = result.status.runtime;
    if (!status) throw new Error("Runtime 重启后没有返回运行状态");
    printSuccess(`Runtime 已重启：pid ${status.pid} · ${status.version} · ${status.projects.filter((item) => item.active).length} 个活动项目。`);
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

function printRegistrationBanner(
    status: DaemonStatusPayload,
    project: { id: string; name: string; path: string },
    controllerPort: number,
): void {
    printIntro("codex-mcp");
    printSummary("已就绪", [
        { label: "守护进程", value: `pid ${status.pid} · 已运行 ${formatUptime(status.uptimeMs)}` },
        { label: "本机地址", value: status.localUrl },
        { label: "Web Console", value: `http://127.0.0.1:${controllerPort}/` },
        { label: "公网地址", value: status.publicMcpUrl ?? "未启用" },
        { label: "公网连接", value: describeTunnelStatus(status.tunnel) },
        { label: "当前项目", value: `${project.name}（${project.path}）` },
        { label: "已注册项目", value: `${status.projects.length} 个` },
    ]);
    printInfo(`在 ChatGPT 中使用 project_control(action=select, project_id=${project.id}) 绑定这个项目；升级后请 Refresh / 重新发布 MCP app actions。`);
    printOutro("如需停止后台服务：codex-mcp stop");
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
    localMcpUrl: string,
    publicMcpUrl: string,
): Promise<boolean> {
    try {
        const local = new URL(localMcpUrl);
        await verifyRunningPublicRoute(new URL(publicMcpUrl).hostname, local.hostname, Number(local.port));
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
