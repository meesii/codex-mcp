import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveProjectRoot } from "../config/loader.js";
import type { DaemonStatusPayload, TunnelObservedStatus } from "../daemon/control.js";
import { writeRuntimeLog } from "../lib/runtime-log.js";
import {
    contactRunningController,
    ensureControllerRunning,
} from "../control/control.js";
import { addProject, getControlStatus, preferredRuntimeIntent, restartRuntime, stopRuntime } from "../control/services.js";
import {
    printInfo,
    printIntro,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "../lib/util/terminal.js";
import { canonicalProjectPath } from "../projects/identity.js";
import { verifyRunningPublicRoute } from "../tunnel/setup-verify.js";
import type { CliFlags } from "./args.js";

/** Register the selected project first, then ensure the control plane and Runtime are ready. */
export async function ensureDaemonAndRegister(flags: CliFlags): Promise<void> {
    const projectRoot = resolveProjectRoot(flags.root);
    const registered = await addProject(projectRoot);
    const controller = await ensureControllerRunning();
    printInfo("项目已注册，正在通过本机 Controller 准备 Runtime…");
    let result: Awaited<ReturnType<typeof controller.client.start>>;
    try {
        result = await controller.client.start({
            local: flags.local,
            noTunnel: flags.noTunnel,
            tunnelLogs: flags.tunnelLogs,
            intentSpecified: flags.runtimeIntentSpecified,
        });
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`${detail}\n项目已注册。可打开 Web Console 继续处理：http://127.0.0.1:${controller.state.port}/`);
    }
    const status = result.status.runtime;
    if (!status) throw new Error("Runtime 启动后没有返回运行状态");
    const canonicalRoot = canonicalProjectPath(projectRoot);
    const project = status.projects.find((item) => item.path === canonicalRoot) ?? registered;
    printRegistrationBanner(status, project, controller.state.port);
    writeRuntimeLog("info", "project_registered_cli", {
        project: project.id,
        daemonPid: status.pid,
        controllerPid: controller.state.pid,
    });
}

/** Ensure the persistent local control plane exists and open its Web Console. */
export async function runOpen(): Promise<void> {
    const controller = await ensureControllerRunning();
    const url = `http://127.0.0.1:${controller.state.port}/`;
    printSuccess(`Web Console：${url}`);
    if (process.env.CODEX_MCP_NO_BROWSER === "1") return;
    tryOpenBrowser(url);
}

export async function runStatus(flags: CliFlags): Promise<void> {
    const cliVersion = getPackageVersion();
    const controller = await contactRunningController();
    const controllerStatus = controller ? await controller.client.status() : undefined;
    const control = controllerStatus?.runtime ?? await getControlStatus();
    const status = control.runtime;
    const preferredIntent = preferredRuntimeIntent();
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
            preferredRuntimeIntent: preferredIntent,
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
            printInfo("本机 Controller 尚未运行；运行 codex-mcp open 打开控制台，或运行 codex-mcp start 启动当前项目。");
        }
        printInfo(`下次启动模式：${describeRuntimeIntent(preferredIntent)}`);
        if (control.projects.length > 0) {
            printInfo(`已保存 ${control.projects.length} 个项目注册记录；Runtime 启动后可继续使用。`);
        }
        printOutro("状态检查完成");
        return;
    }

    printSummary("本机控制面", [
        { label: "Controller", value: controllerStatus ? `pid ${controllerStatus.pid} · ${controllerStatus.version}` : "未运行" },
        { label: "Web Console", value: controllerStatus?.panelUrl ?? "未运行" },
        { label: "Runtime", value: `pid ${status.pid} · ${status.mode === "local" ? "本机" : "公网"}` },
        { label: "默认启动", value: describeRuntimeIntent(preferredIntent) },
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
    const controller = await contactRunningController();
    printInfo("正在停止 MCP Runtime（Tunnel、托管进程和 MCP 服务会一起关闭）…");
    if (!controller) {
        const stopped = await stopRuntime();
        if (!stopped) {
            printWarning("MCP Runtime 没有在运行；本机 Controller 也未启动。");
            return;
        }
        printSuccess("MCP Runtime 已停止；项目注册状态已保留。Controller 原本没有运行。");
        return;
    }
    const result = await controller.client.stop();
    if (!result.stopped) {
        printWarning("MCP Runtime 没有在运行；本机 Controller 保持在线。");
        return;
    }
    printSuccess(`MCP Runtime 已停止；项目注册状态已保留。Web Console：http://127.0.0.1:${controller.state.port}/`);
}

/** Stop the whole local control plane, including any running Runtime. */
export async function runShutdown(): Promise<void> {
    const controller = await contactRunningController();
    if (!controller) {
        const control = await getControlStatus();
        if (control.running) {
            await stopRuntime();
            printSuccess("MCP Runtime 已停止；没有运行中的 Controller。");
        } else {
            printWarning("Controller 和 MCP Runtime 都没有在运行。");
        }
        return;
    }
    printInfo("正在关闭 MCP Runtime 和本机 Controller…");
    await controller.client.shutdown();
    await waitForProcessExit(controller.state.pid, 30_000);
    printSuccess("codex-mcp 已完全关闭。");
}

/** Restart a running Runtime in the same mode through the persistent Controller. */
export async function runRestart(): Promise<void> {
    const existing = await contactRunningController();
    printInfo("正在按原运行参数重启 Runtime…");
    const control = existing
        ? (await (await ensureControllerRunning()).client.restart()).status
        : await restartRuntime();
    const status = control.runtime;
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
        { label: "MCP Runtime", value: `pid ${status.pid} · 已运行 ${formatUptime(status.uptimeMs)}` },
        { label: "运行方式", value: status.mode === "local" ? "仅本机" : "公网" },
        { label: "本机地址", value: status.localUrl },
        { label: "Web Console", value: `http://127.0.0.1:${controllerPort}/` },
        { label: "公网地址", value: status.publicMcpUrl ?? "未启用" },
        { label: "当前项目", value: project.name },
        { label: "已注册项目", value: `${status.projects.length} 个` },
    ]);
    printInfo(`在 ChatGPT 里说“切换到 ${project.name} 项目”即可开始使用。`);
    printOutro("管理和排查：codex-mcp open · 停止服务：codex-mcp stop");
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

function describeRuntimeIntent(intent: { local: boolean; noTunnel: boolean; tunnelLogs: boolean }): string {
    if (intent.local) return "本机模式";
    return intent.noTunnel ? "公网模式（外部入口）" : "公网模式（托管 Tunnel）";
}

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<void> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
        try {
            process.kill(pid, 0);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ESRCH") return;
            if ((error as NodeJS.ErrnoException).code !== "EPERM") return;
        }
        await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`Controller pid ${pid} 在 ${timeoutMs}ms 内没有退出`);
}

function tryOpenBrowser(url: string): void {
    const command = process.platform === "darwin"
        ? { bin: "open", args: [url] }
        : process.platform === "win32"
          ? { bin: "cmd.exe", args: ["/c", "start", "", url] }
          : { bin: "xdg-open", args: [url] };
    try {
        const child = spawn(command.bin, command.args, {
            detached: true,
            stdio: "ignore",
            windowsHide: true,
        });
        child.once("error", () => undefined);
        child.unref();
    } catch {
        printInfo("浏览器没有自动打开，请复制上面的 Web Console 地址。");
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
