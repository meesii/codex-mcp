import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolveProjectRoot } from "../config/loader.js";
import { loadUserConfig, resolveTunnelProtocol } from "../config/user-config.js";
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
    printInfo("项目已添加，正在启动 MCP 服务…");
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
        throw new Error(`${detail}\n项目已经添加。可以打开 Web 控制台继续处理：http://127.0.0.1:${controller.state.port}/`);
    }
    const status = result.status.runtime;
    if (!status) throw new Error("MCP 服务启动后没有返回运行状态。请运行 `codex-mcp status` 检查；如果仍未运行，再执行 `codex-mcp doctor`");
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
    printSuccess(`Web 控制台：${url}`);
    if (process.env.CODEX_MCP_NO_BROWSER === "1") return;
    tryOpenBrowser(url);
}

export async function runStatus(flags: CliFlags): Promise<void> {
    const cliVersion = getPackageVersion();
    const controller = await contactRunningController();
    const controllerStatus = controller ? await controller.client.status() : undefined;
    const control = controllerStatus?.runtime ?? await getControlStatus();
    const status = control.runtime;
    const userConfig = loadUserConfig();
    const preferredIntent = preferredRuntimeIntent(userConfig);
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
                tunnelProtocol: userConfig.publicAccess?.kind === "cloudflare"
                    ? resolveTunnelProtocol(userConfig.runtime?.tunnelProtocol)
                    : null,
                tunnel: status.tunnel,
                auth: status.auth,
            } : null,
            projects: control.projects,
        }, null, 2));
        return;
    }

    printIntro("codex-mcp status");
    if (!status) {
        printWarning("MCP 服务当前没有运行。");
        if (controllerStatus) {
            printInfo(`Web 控制台仍可使用：${controllerStatus.panelUrl}`);
        } else {
            printInfo("Web 控制台也没有运行。运行 `codex-mcp open` 打开控制台，或在项目目录运行 `codex-mcp start` 启动服务。");
        }
        printInfo(`下次启动模式：${describeRuntimeIntent(preferredIntent)}`);
        if (control.projects.length > 0) {
            printInfo(`已经保存 ${control.projects.length} 个项目；下次启动 MCP 服务后可继续使用。`);
        }
        printOutro("状态检查完成");
        return;
    }

    printSummary("当前状态", [
        { label: "MCP 服务", value: `运行中 · ${status.mode === "local" ? "仅本机" : "公网"}` },
        { label: "Web 控制台", value: controllerStatus?.panelUrl ?? "未运行" },
        { label: "默认启动", value: describeRuntimeIntent(preferredIntent) },
        { label: "运行时长", value: formatUptime(status.uptimeMs) },
        { label: "CLI 版本", value: cliVersion },
        { label: "服务版本", value: status.version },
        { label: "本机地址", value: status.localUrl },
        { label: "登录保护", value: status.auth.required ? (status.auth.configured ? "已启用" : "缺少连接密码") : "仅本机，无需登录" },
        { label: "ChatGPT 地址", value: status.publicMcpUrl ?? "未启用" },
        ...(userConfig.publicAccess?.kind === "cloudflare" ? [{
            label: "Cloudflare 协议",
            value: resolveTunnelProtocol(userConfig.runtime?.tunnelProtocol) === "http2" ? "HTTP/2" : "QUIC",
        }] : []),
        { label: "公网方式", value: userConfig.publicAccess?.kind === "cloudflare" ? `Cloudflare · ${describeTunnelStatus(status.tunnel)}` : userConfig.publicAccess?.kind === "external" ? "自有 HTTPS" : "未配置" },
    ]);

    if (versionMismatch) {
        printWarning("正在运行的 codex-mcp 与当前命令行版本不一致。先运行 `codex-mcp update`，再运行 `codex-mcp restart` 让新版本完全生效。" );
    }

    const active = status.projects.filter((item) => item.active);
    if (status.projects.length === 0) {
        printInfo("还没有添加项目。进入项目目录运行 `codex-mcp start`，或运行 `codex-mcp project add [目录]` 添加第一个项目。");
    } else {
        printInfo("已添加项目：");
        for (const item of status.projects) {
            printInfo(`- ${item.name}${item.active ? "" : "（已停用）"} ${item.path} · ${item.boundSessions} 个 ChatGPT 会话关联`);
        }
        if (active.length === 0) printWarning("当前没有可用项目。运行 `codex-mcp project add [目录]` 添加或重新启用项目。");
    }

    if (status.publicMcpUrl && !(await checkPublicHealthz(status.localUrl, status.publicMcpUrl))) {
        printWarning(`ChatGPT 公网地址暂时无法确认是否连接到这台电脑（${status.publicMcpUrl}）。请运行 \`codex-mcp doctor\` 查看具体原因。`);
    }
    printOutro("状态检查完成");
}

/** Stop only the MCP Runtime; the persistent local Controller and Web Console stay online. */
export async function runStop(): Promise<void> {
    const controller = await contactRunningController();
    printInfo("正在停止 MCP 服务；如果正在使用 Cloudflare 公网连接，也会一起停止…");
    if (!controller) {
        const stopped = await stopRuntime();
        if (!stopped) {
            printWarning("MCP 服务本来就没有运行，Web 控制台也没有启动。");
            return;
        }
        printSuccess("MCP 服务已停止；项目设置已保留。Web 控制台原本没有运行。");
        return;
    }
    const result = await controller.client.stop();
    if (!result.stopped) {
        printWarning("MCP 服务本来就没有运行；Web 控制台仍然可以使用。");
        return;
    }
    printSuccess(`MCP 服务已停止；项目设置已保留。Web 控制台仍可使用：http://127.0.0.1:${controller.state.port}/`);
}

/** Stop the whole local control plane, including any running Runtime. */
export async function runShutdown(): Promise<void> {
    const controller = await contactRunningController();
    if (!controller) {
        const control = await getControlStatus();
        if (control.running) {
            await stopRuntime();
            printSuccess("MCP 服务已停止；Web 控制台没有运行。");
        } else {
            printWarning("MCP 服务和 Web 控制台都没有在运行。");
        }
        return;
    }
    printInfo("正在完全关闭 MCP 服务和 Web 控制台…");
    await controller.client.shutdown();
    await waitForProcessExit(controller.state.pid, 30_000);
    printSuccess("codex-mcp 已完全关闭。");
}

/** Restart a running Runtime in the same mode through the persistent Controller. */
export async function runRestart(): Promise<void> {
    const existing = await contactRunningController();
    printInfo("正在按原来的运行方式重启 MCP 服务…");
    const control = existing
        ? (await (await ensureControllerRunning()).client.restart()).status
        : await restartRuntime();
    const status = control.runtime;
    if (!status) throw new Error("MCP 服务重启后没有返回运行状态；请运行 `codex-mcp status` 检查，如果仍未运行再执行 `codex-mcp doctor`");
    printSuccess(`MCP 服务已重启 · 版本 ${status.version} · ${status.projects.filter((item) => item.active).length} 个可用项目。`);
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
        { label: "MCP 服务", value: `已运行 ${formatUptime(status.uptimeMs)}` },
        { label: "运行方式", value: status.mode === "local" ? "仅本机" : "公网" },
        { label: "本机地址", value: status.localUrl },
        { label: "Web 控制台", value: `http://127.0.0.1:${controllerPort}/` },
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
    return intent.noTunnel ? "公网模式（自有 HTTPS）" : "公网模式（Cloudflare）";
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
    throw new Error("Web 控制台后台服务没有正常退出；请稍后再试，如果一直存在请运行 `codex-mcp doctor`");
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
        printInfo("浏览器没有自动打开，请复制上面的 Web 控制台地址到浏览器。");
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
