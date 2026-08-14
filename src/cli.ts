#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig, resolveProjectRoot, type ServerConfig } from "./config/loader.js";
import { runDoctorChecks, type DoctorLevel } from "./doctor/index.js";
import {
    generateAdminPassword,
    hasAdminPassword,
    setAdminPassword,
    verifyAdminPassword,
} from "./auth/password-store.js";
import { DownstreamMcpHub } from "./downstream/hub.js";
import { CapabilityManager } from "./capabilities/manager.js";
import { CapabilityWatcher } from "./capabilities/runtime.js";
import type { SkillRegistry } from "./skills/registry.js";
import { resolveAllowedTools } from "./capabilities/policy.js";
import { createHttpServer } from "./server/http-server.js";
import { isToolLogEnabled } from "./lib/tool/log.js";
import {
    closeRuntimeLog,
    initializeRuntimeLog,
    writeRuntimeLog,
} from "./lib/runtime-log.js";
import {
    printError,
    printInfo,
    printIntro,
    printNote,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "./lib/util/terminal.js";
import { configureCapabilitySources, describeCapabilitiesConfig } from "./capabilities/setup.js";
import { askSecret, askSelect, canPromptInteractively, withSpinner } from "./tunnel/prompt.js";
import { CloudflaredSidecar } from "./tunnel/sidecar.js";
import { verifyTunnelRoute } from "./tunnel/verify.js";
import {
    ensureTunnelSetup,
    isPublicSetupConfigured,
    runTunnelWizard,
    type TunnelSetupResult,
} from "./tunnel/setup.js";
import { verifySetupPublicRoute } from "./tunnel/setup-verify.js";
import { withPublicSetupTransaction } from "./tunnel/setup-transaction.js";
import { ensureUserConfigDirs, loadUserConfig } from "./config/user-config.js";
import { runSelfUpdate } from "./doctor/update.js";
import { randomBytes } from "node:crypto";
import {
    cleanStaleDaemonState,
    contactRunningDaemon,
    DaemonControlClient,
    isProcessAlive,
    spawnDaemonProcess,
    waitForDaemonStart,
    withDaemonStartLock,
    type DaemonContact,
    type DaemonStatusPayload,
} from "./daemon/control.js";
import {
    loadDaemonState,
    loadProjectsFile,
    removeDaemonState,
    saveDaemonState,
    saveProjectsFile,
    type RegisteredProject,
} from "./daemon/state.js";
import {
    canonicalProjectPath,
    detectProjectDisplayName,
} from "./projects/identity.js";
import { BindingStore } from "./projects/bindings.js";
import { ProjectRegistry } from "./projects/registry.js";
import { ProjectRuntimeManager } from "./projects/runtime.js";
import { PACKAGE_VERSION } from "./server/version.js";
import { parseCliArgs, type CliFlags } from "./cli/args.js";
import { followLogFile, readRecentLogLines } from "./cli/logs.js";

/** Print CLI usage. */
function printUsage(): void {
    printIntro("codex-mcp");
    printNote(
        "常用命令",
        [
            "codex-mcp                         注册当前项目并确保后台服务运行",
            "codex-mcp status                  查看服务、版本、Tunnel 和项目状态",
            "codex-mcp restart                 重启后台服务并保留项目注册状态",
            "codex-mcp stop                    停止后台服务",
            "codex-mcp project list            查看已注册项目",
            "codex-mcp project add [目录]      注册项目（默认当前目录）",
            "codex-mcp project remove [项目]   停用项目（默认当前目录）",
            "codex-mcp project info [项目]     查看项目详情",
            "codex-mcp logs [--lines N]        查看最近运行日志",
            "codex-mcp logs -f                 持续跟随运行日志",
            "codex-mcp setup                   设置 / 管理公网连接",
            "codex-mcp doctor [--fix]          检查配置；--fix 只做安全本机修复",
            "codex-mcp auth                    修改连接密码",
            "codex-mcp update                  更新到最新版本",
        ].join("\n"),
    );
    printNote(
        "其他",
        [
            "codex-mcp status --json           输出机器可读状态",
            "codex-mcp --local                 注册当前项目并以本机模式启动",
            "codex-mcp --root <目录>           指定默认 serve 的项目目录",
            "codex-mcp serve --foreground      以前台方式启动（调试用）",
            "codex-mcp tunnel                  setup 公网连接的兼容快捷入口",
            "codex-mcp exit                    兼容入口：停用当前项目",
            "codex-mcp exit -a                 兼容入口：停止后台服务",
            "codex-mcp --version               查看版本",
        ].join("\n"),
    );
    printInfo("多数情况下：进入项目目录运行 codex-mcp；排查问题先看 status 和 logs。");
    printOutro("首次使用：运行 codex-mcp setup");
}

/**
 * Clear the terminal when stdout is an interactive TTY.
 */
function clearTerminal(): void {
    if (process.stdout.isTTY !== true) return;
    console.clear();
}

/**
 * Print the post-listen startup summary.
 *
 * @param input - URLs, root, and tunnel/log status
 */
function printStartupBanner(input: {
    mcpUrl: string;
    localUrl: string;
    projectRoot: string;
    logDirectory?: string;
    logsOn: boolean;
    downstream: string[];
    skillCount: number;
    tunnel:
        | { protocol?: string; location?: string }
        | "off"
        | undefined;
}): void {
    clearTerminal();
    const rows = [{ label: "连接地址", value: input.mcpUrl }];
    if (input.localUrl !== input.mcpUrl) {
        rows.push({ label: "本机地址", value: input.localUrl });
    }
    rows.push({ label: "项目目录", value: input.projectRoot });

    if (input.tunnel === "off") {
        rows.push({ label: "公网连接", value: "未启动" });
    } else if (input.tunnel) {
        const bits = [input.tunnel.protocol, input.tunnel.location].filter(
            (part): part is string => Boolean(part),
        );
        rows.push({
            label: "公网连接",
            value: bits.length > 0 ? bits.join(" · ") : "已连接",
        });
    }

    if (input.downstream.length > 0) {
        rows.push({ label: "外部 MCP", value: input.downstream.join(", ") });
    }
    if (input.skillCount > 0) {
        rows.push({ label: "Skills", value: String(input.skillCount) });
    }

    rows.push({
        label: "文件日志",
        value: input.logDirectory ?? "不可用",
    });
    rows.push({ label: "工具日志", value: input.logsOn ? "已开启" : "未开启" });
    printIntro("codex-mcp");
    printSummary("已启动", rows);
    printInfo("按 Ctrl+C 停止服务");
}


/**
 * CLI entrypoint.
 *
 * @param argv - Process arguments excluding node/executable
 */
async function main(argv: string[]): Promise<void> {
    const flags = parseCliArgs(argv);
    if (flags.command === "help") {
        printUsage();
        return;
    }

    if (flags.command === "version") {
        console.log(getPackageVersion());
        return;
    }

    if (flags.command === "doctor") {
        await printDoctorReport(flags.fix);
        return;
    }

    if (flags.command === "setup") {
        await runFirstTimeSetup();
        return;
    }

    if (flags.command === "auth") {
        await configureAdminPassword();
        return;
    }

    if (flags.command === "update") {
        await runSelfUpdate();
        return;
    }

    if (flags.command === "tunnel") {
        const result = await withPublicSetupTransaction(async () => {
            const candidate = await runTunnelWizard();
            await verifySetupResult(candidate);
            return candidate;
        });
        printSuccess(`公网连接已验证：https://${result.domain}/mcp`);
        printOutro("接下来进入项目目录，运行 codex-mcp 即可启动");
        return;
    }

    if (flags.command === "status") {
        await runStatus(flags);
        return;
    }

    if (flags.command === "stop") {
        await runStop();
        return;
    }

    if (flags.command === "restart") {
        await runRestart();
        return;
    }

    if (flags.command === "logs") {
        await runLogs(flags);
        return;
    }

    if (flags.command === "project") {
        await runProjectCommand(flags);
        return;
    }

    if (flags.command === "exit") {
        await runExit(flags);
        return;
    }

    if (flags.command === "daemon") {
        await runDaemonProcess(flags);
        return;
    }

    await runServe(flags);
}

/**
 * `codex-mcp` without a subcommand: ensure the daemon is running, register the
 * current project, and print status. `--foreground` keeps the old direct serve
 * behavior for debugging.
 */
async function runServe(flags: CliFlags): Promise<void> {
    if (flags.foreground) {
        await runForegroundServe(flags);
        return;
    }
    await ensureDaemonAndRegister(flags);
}

interface StartedServices {
    config: ServerConfig;
    server: ReturnType<typeof createHttpServer>;
    hub: DownstreamMcpHub;
    skills: SkillRegistry;
    capabilityWatcher: CapabilityWatcher;
    sidecar?: CloudflaredSidecar;
    tunnelReady?: { protocol?: string; location?: string };
    logDirectory?: string;
    userConfig: ReturnType<typeof loadUserConfig>;
}

interface DaemonStartContext {
    registry: ProjectRegistry;
    bindings: BindingStore;
    runtimes: ProjectRuntimeManager;
    controlToken: string;
    onShutdown: () => Promise<void>;
}

interface StartServicesOptions {
    flags: CliFlags;
    userConfig: ReturnType<typeof loadUserConfig>;
    daemon?: DaemonStartContext;
    tunnelStatus: () => { running: boolean };
}

/**
 * Start the HTTP MCP server plus the shared hub/skills/watcher, and optionally
 * the Cloudflare sidecar. Used by both the foreground serve and the daemon.
 */
async function startServices(options: StartServicesOptions): Promise<StartedServices> {
    const { flags, userConfig } = options;
    const allowSidecar = !flags.local && !flags.noTunnel;

    const config = loadConfig({
        projectRoot: flags.root,
        userConfig,
        local: flags.local,
    });

    if (!flags.local && config.allowedHosts.length === 0) {
        throw new Error("还没有设置公网地址，请先运行 `codex-mcp setup`；只在本机使用可加 `--local`");
    }

    let logDirectory: string | undefined;
    try {
        const info = await initializeRuntimeLog({
            onError: (error) => {
                printWarning(`文件日志已停止：${error.message}`);
            },
        });
        logDirectory = info.directory;
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        printWarning(`文件日志不可用，服务将继续启动：${detail}`);
    }

    let tunnelSetup: TunnelSetupResult | undefined;
    const wantSidecar =
        allowSidecar && userConfig.useCloudflared !== false && !!userConfig.domain;
    if (wantSidecar) {
        tunnelSetup = await ensureTunnelSetup({
            host: config.host,
            port: config.port,
        });
        if (!tunnelSetup.useCloudflared) {
            tunnelSetup = undefined;
        }
    }

    const capabilities = new CapabilityManager(config.projectRoot);
    const hub = await DownstreamMcpHub.connectFromDefaultConfig({
        loadConfig: () => capabilities.loadMcpConfig(),
    });
    if (hub.getImportError()) {
        printWarning(`外部 MCP 配置加载失败；核心服务会继续启动：${hub.getImportError()}`);
    }
    const skills = capabilities.createSkillRegistry();
    for (const diagnostic of capabilities.getDiagnostics(skills)) {
        for (const warning of diagnostic.warnings) {
            printWarning(`${diagnostic.source} 能力源：${warning}`);
        }
    }
    const server = createHttpServer(config, {
        hub,
        skills,
        capabilities,
        allowedToolsResolver: resolveAllowedTools,
        ...(options.daemon
            ? {
                  daemon: {
                      registry: options.daemon.registry,
                      bindings: options.daemon.bindings,
                      runtimes: options.daemon.runtimes,
                      controlToken: options.daemon.controlToken,
                      tunnelStatus: options.tunnelStatus,
                      onShutdown: options.daemon.onShutdown,
                  },
              }
            : {}),
    });
    await server.listen();
    const capabilityWatcher = new CapabilityWatcher(capabilities, hub, skills);
    capabilityWatcher.start();

    let sidecar: CloudflaredSidecar | undefined;
    let tunnelReady: { protocol?: string; location?: string } | undefined;
    const publicUrl =
        config.allowedHosts[0] !== undefined
            ? `https://${config.allowedHosts[0]}/mcp`
            : undefined;

    if (
        tunnelSetup?.useCloudflared &&
        tunnelSetup.bin &&
        tunnelSetup.tunnelId &&
        tunnelSetup.configPath
    ) {
        sidecar = new CloudflaredSidecar({
            bin: tunnelSetup.bin,
            tunnelId: tunnelSetup.tunnelId,
            configPath: tunnelSetup.configPath,
            mirrorLogs: flags.tunnelLogs,
        });
        try {
            tunnelReady = await sidecar.start();
            if (publicUrl) {
                await verifyTunnelRoute(publicUrl, server.getTunnelProbe());
            }
        } catch (error) {
            capabilityWatcher.close();
            await sidecar.stop().catch(() => undefined);
            await server.close();
            throw error;
        }
    }

    return { config, server, hub, skills, capabilityWatcher, sidecar, tunnelReady, logDirectory, userConfig };
}

/**
 * Foreground debug serve: the historical behavior where this process binds the
 * server and stays in the terminal. Never writes daemon state.
 */
async function runForegroundServe(flags: CliFlags): Promise<void> {
    let userConfig = loadUserConfig();

    if (!flags.local && !userConfig.domain) {
        const result = await withPublicSetupTransaction(async () => {
            const candidate = await ensureTunnelSetup({
                host: userConfig.host,
                port: userConfig.port,
            });
            await verifySetupResult(candidate);
            return candidate;
        });
        userConfig = result.userConfig;
    }

    if (!flags.local) {
        await ensureAdminPasswordConfigured();
    }

    let tunnelRunning = false;
    const services = await startServices({ flags, userConfig, tunnelStatus: () => ({ running: tunnelRunning }) });
    tunnelRunning = services.sidecar !== undefined;
    const { config, server, hub, skills, sidecar, tunnelReady, logDirectory } = services;

    const downstream = hub.listServers().map((item) =>
        item.status === "ready" ? item.name : `${item.name}!`,
    );

    printStartupBanner({
        mcpUrl:
            config.allowedHosts[0] !== undefined
                ? `https://${config.allowedHosts[0]}/mcp`
                : server.getMcpUrl(),
        localUrl: server.getMcpUrl(),
        projectRoot: config.projectRoot,
        logDirectory,
        logsOn: isToolLogEnabled(),
        downstream,
        skillCount: skills.list().length,
        tunnel: sidecar
            ? (tunnelReady ?? { protocol: undefined, location: undefined })
            : config.allowedHosts[0] !== undefined && !flags.noTunnel
              ? "off"
              : undefined,
    });
    writeRuntimeLog("info", "server_started", {
        mode: flags.local ? "local" : "public",
        tunnel: sidecar !== undefined,
        downstreamCount: downstream.length,
        skillCount: skills.list().length,
        toolLogs: isToolLogEnabled(),
    });

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        writeRuntimeLog("info", "server_stopping");
        let exitCode = 0;
        try {
            services.capabilityWatcher.close();
            if (sidecar) {
                await sidecar.stop();
            }
            await server.close();
            writeRuntimeLog("info", "server_stopped");
        } catch (error) {
            exitCode = 1;
            const detail = error instanceof Error ? error.message : String(error);
            printError(`停止服务时发生错误：${detail}`);
            writeRuntimeLog("error", "server_stop_failed", { error: detail });
        } finally {
            try {
                closeRuntimeLog();
            } catch (error) {
                const detail = error instanceof Error ? error.message : String(error);
                printWarning(`文件日志关闭失败：${detail}`);
            }
            process.exit(exitCode);
        }
    };

    process.once("SIGINT", () => {
        void shutdown();
    });
    process.once("SIGTERM", () => {
        void shutdown();
    });
}

/**
 * Internal daemon entrypoint (spawned detached by the CLI). Owns the MCP
 * server, the Cloudflare sidecar, and the durable daemon state.
 */
async function runDaemonProcess(flags: CliFlags): Promise<void> {
    let userConfig = loadUserConfig();

    if (!flags.local && !userConfig.domain) {
        const result = await withPublicSetupTransaction(async () => {
            const candidate = await ensureTunnelSetup({
                host: userConfig.host,
                port: userConfig.port,
            });
            await verifySetupResult(candidate);
            return candidate;
        });
        userConfig = result.userConfig;
    }

    if (!flags.local) {
        await ensureAdminPasswordConfigured();
    }

    const registry = new ProjectRegistry();
    const bindings = new BindingStore();
    const runtimes = new ProjectRuntimeManager();
    const controlToken = randomBytes(32).toString("base64url");

    let services: StartedServices | undefined;
    let tunnelRunning = false;
    let shuttingDown = false;

    const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        writeRuntimeLog("info", "daemon_stopping");
        let exitCode = 0;
        try {
            await removeDaemonState().catch(() => undefined);
            services?.capabilityWatcher.close();
            if (services?.sidecar) {
                await services.sidecar.stop().catch(() => undefined);
            }
            if (services) {
                await services.server.close();
            }
            writeRuntimeLog("info", "daemon_stopped");
        } catch (error) {
            exitCode = 1;
            writeRuntimeLog("error", "daemon_stop_failed", {
                error: error instanceof Error ? error.message : String(error),
            });
        } finally {
            try {
                closeRuntimeLog();
            } catch {
                // best effort
            }
            process.exit(exitCode);
        }
    };

    services = await startServices({
        flags,
        userConfig,
        daemon: {
            registry,
            bindings,
            runtimes,
            controlToken,
            onShutdown: shutdown,
        },
        tunnelStatus: () => ({ running: tunnelRunning }),
    });
    tunnelRunning = services.sidecar !== undefined;

    await saveDaemonState({
        pid: process.pid,
        host: services.config.host,
        port: services.config.port,
        controlToken,
        ...(services.config.publicMcpUrl ? { publicMcpUrl: services.config.publicMcpUrl } : {}),
        startedAt: new Date().toISOString(),
        version: PACKAGE_VERSION,
        mode: flags.local ? "local" : "public",
    });
    writeRuntimeLog("info", "daemon_started", {
        pid: process.pid,
        mode: flags.local ? "local" : "public",
        tunnel: services.sidecar !== undefined,
    });

    process.once("SIGINT", () => {
        void shutdown();
    });
    process.once("SIGTERM", () => {
        void shutdown();
    });
}

/**
 * `codex-mcp` default flow: ensure the daemon is running (starting it when
 * needed), register the current project, and print status.
 */
async function ensureDaemonAndRegister(flags: CliFlags): Promise<void> {
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
async function ensureDaemonRunning(
    flags: Pick<CliFlags, "local" | "noTunnel" | "tunnelLogs">,
): Promise<DaemonContact> {
    const existing = await contactRunningDaemon();
    if (existing) return existing;

    cleanStaleDaemonState();

    let userConfig = loadUserConfig();
    if (!flags.local && !userConfig.domain) {
        const result = await withPublicSetupTransaction(async () => {
            const candidate = await ensureTunnelSetup({
                host: userConfig.host,
                port: userConfig.port,
            });
            await verifySetupResult(candidate);
            return candidate;
        });
        userConfig = result.userConfig;
    }

    if (!flags.local) {
        await ensureAdminPasswordConfigured();
    }

    const daemon = await withDaemonStartLock(async () => {
        const again = await contactRunningDaemon();
        if (again) return again;

        const { pid } = spawnDaemonProcess({
            local: flags.local,
            noTunnel: flags.noTunnel,
            tunnelLogs: flags.tunnelLogs,
        });
        printInfo(`守护进程正在启动（pid ${pid}）…`);
        return await waitForDaemonStart(pid);
    });
    if (!daemon) {
        throw new Error("守护进程启动失败，请查看 ~/.codex-mcp/logs 下的日志。");
    }
    writeRuntimeLog("info", "daemon_started_via_cli", { pid: daemon.state.pid });
    return daemon;
}

/** Print the registration banner after `codex-mcp` registers a project. */
function printRegistrationBanner(status: DaemonStatusPayload, project: { id: string; name: string; path: string }): void {
    printIntro("codex-mcp");
    printSummary("已就绪", [
        { label: "守护进程", value: `pid ${status.pid} · 已运行 ${formatUptime(status.uptimeMs)}` },
        { label: "本机地址", value: status.localUrl },
        { label: "公网地址", value: status.publicMcpUrl ?? "未启用" },
        { label: "公网连接", value: status.tunnel.running ? "已连接" : "未启动" },
        { label: "当前项目", value: `${project.name}（${project.path}）` },
        { label: "已注册项目", value: `${status.projects.length} 个` },
    ]);
    printInfo(`在 ChatGPT 中优先用 project_select 选择 ${project.id}；只有已批准的 workspace_projects schema 明确包含 project_id 时才能用它兼容绑定，否则请 Refresh / 重新发布 MCP app actions。`);
    printOutro("如需停止当前项目：codex-mcp exit");
}

/** `codex-mcp status`: print daemon, tunnel, version and project status. */
async function runStatus(flags: CliFlags): Promise<void> {
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
                tunnelRunning: status.tunnel.running,
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
        { label: "公网连接", value: status.tunnel.running ? "已连接" : "未启动" },
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

    if (status.publicMcpUrl && status.tunnel.running) {
        const reachable = await checkPublicHealthz(status.publicMcpUrl);
        if (!reachable) {
            printWarning(
                `公网地址暂时无法验证（${status.publicMcpUrl}）。请运行 codex-mcp doctor 检查公网连接。`,
            );
        }
    }
    printOutro("状态检查完成");
}

/** Stop the daemon without changing persisted project active state. */
async function runStop(): Promise<void> {
    const state = loadDaemonState();
    if (!state || !isProcessAlive(state.pid)) {
        cleanStaleDaemonState();
        printWarning("守护进程没有在运行。");
        return;
    }
    const client = new DaemonControlClient(state.port, state.controlToken);
    printInfo("正在停止后台服务（Tunnel、托管进程和 MCP 服务会一起关闭）…");
    try {
        await client.shutdown();
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        printWarning(`请求关闭失败：${detail}`);
    }
    const deadline = Date.now() + 20_000;
    while (isProcessAlive(state.pid) && Date.now() < deadline) {
        await sleep(200);
    }
    if (isProcessAlive(state.pid)) {
        throw new Error("守护进程仍在运行，请稍后重试或手动结束该进程。");
    }
    printSuccess("后台服务已停止；项目注册状态已保留。");
}

/** Restart a running daemon in the same local/public mode while preserving projects. */
async function runRestart(): Promise<void> {
    const existing = await contactRunningDaemon();
    if (!existing) {
        cleanStaleDaemonState();
        throw new Error("守护进程没有在运行，无法重启。进入项目目录运行 `codex-mcp` 启动；只在本机使用时运行 `codex-mcp --local`。");
    }
    const previousMode = (await existing.client.status()).mode;
    await runStop();
    const daemon = await ensureDaemonRunning({
        local: previousMode === "local",
        noTunnel: false,
        tunnelLogs: false,
    });
    const status = await daemon.client.status();
    printSuccess(`后台服务已重启：pid ${status.pid} · ${status.version} · ${status.projects.filter((item) => item.active).length} 个活动项目。`);
}

async function runLogs(flags: CliFlags): Promise<void> {
    const recent = readRecentLogLines(flags.lines);
    if (!recent.text) {
        if (flags.follow) {
            throw new Error(`还没有运行日志：${recent.path}`);
        }
        printWarning(`还没有运行日志：${recent.path}`);
        return;
    }
    process.stdout.write(`${recent.text}\n`);
    if (flags.follow) {
        await followLogFile(recent.path);
    }
}

async function runProjectCommand(flags: CliFlags): Promise<void> {
    const action = flags.projectAction ?? "list";
    if (action === "add") {
        const projectRoot = resolveProjectRoot(flags.target);
        const daemon = await ensureDaemonRunning(flags);
        const project = await daemon.client.registerProject({
            path: projectRoot,
            name: detectProjectDisplayName(projectRoot),
        });
        printSuccess(`已注册项目 ${project.name}（${project.path}）。`);
        printInfo(`项目 ID：${project.id}`);
        return;
    }

    const daemon = await contactRunningDaemon();
    const status = daemon ? await daemon.client.status() : undefined;
    const projects = status?.projects ?? loadProjectsFile();

    if (action === "list") {
        printProjectList(projects);
        return;
    }

    const project = resolveProjectSelection(projects, flags.target);
    if (!project) {
        throw new Error(flags.target ? `没有找到项目：${flags.target}` : "当前目录没有注册为项目");
    }

    if (action === "info") {
        const live = status?.projects.find((item) => item.id === project.id);
        printIntro("codex-mcp project info");
        printSummary("项目", [
            { label: "名称", value: project.name },
            { label: "ID", value: project.id },
            { label: "目录", value: project.path },
            { label: "状态", value: project.active ? "活动" : "已停用" },
            { label: "会话绑定", value: live ? String(live.boundSessions) : "daemon 未运行" },
            { label: "最后使用", value: project.lastSeenAt },
        ]);
        printOutro("项目详情");
        return;
    }

    if (daemon) {
        const result = await daemon.client.deactivateProject(project.id, project.path);
        if (!result.removed) {
            printWarning(`项目 ${project.name} 已经是停用状态。`);
            return;
        }
    } else if (project.active) {
        await saveProjectsFile(projects.map((item) => item.id === project.id ? { ...item, active: false } : item));
    } else {
        printWarning(`项目 ${project.name} 已经是停用状态。`);
        return;
    }
    printSuccess(`已停用项目 ${project.name}（${project.path}）。`);
}

function printProjectList(projects: Array<RegisteredProject & { boundSessions?: number }>): void {
    printIntro("codex-mcp project list");
    if (projects.length === 0) {
        printInfo("还没有注册项目。运行 `codex-mcp project add [目录]` 添加。");
        printOutro("项目列表");
        return;
    }
    for (const project of projects) {
        const sessions = project.boundSessions === undefined ? "" : ` · ${project.boundSessions} 个会话绑定`;
        printInfo(`- ${project.name}${project.active ? "" : "（已停用）"} · ${project.id} · ${project.path}${sessions}`);
    }
    printOutro(`${projects.length} 个项目`);
}

function resolveProjectSelection(
    projects: RegisteredProject[],
    target?: string,
): RegisteredProject | undefined {
    if (!target) {
        let current: string;
        try {
            current = canonicalProjectPath(resolveProjectRoot(undefined));
        } catch {
            return undefined;
        }
        return projects.find((item) => item.path === current);
    }
    const byId = projects.find((item) => item.id === target);
    if (byId) return byId;
    const byName = projects.filter((item) => item.name === target);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
        throw new Error(`项目名 ${target} 不唯一，请改用项目 ID 或完整目录。`);
    }
    try {
        const path = canonicalProjectPath(target);
        return projects.find((item) => item.path === path);
    } catch {
        return undefined;
    }
}

/** `codex-mcp exit`: compatibility alias for project remove; `exit -a` aliases stop. */
async function runExit(flags: CliFlags): Promise<void> {
    if (flags.all) {
        await runStop();
        return;
    }
    await runProjectCommand({
        ...flags,
        command: "project",
        projectAction: "remove",
        ...(flags.root ? { target: flags.root } : {}),
    });
    printInfo("兼容提示：以后可使用 `codex-mcp project remove [项目]`。");
}

function formatUptime(uptimeMs: number): string {
    const seconds = Math.floor(uptimeMs / 1000);
    if (seconds < 60) return `${seconds} 秒`;
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) return `${minutes} 分 ${seconds % 60} 秒`;
    const hours = Math.floor(minutes / 60);
    return `${hours} 小时 ${minutes % 60} 分`;
}

async function checkPublicHealthz(publicMcpUrl: string): Promise<boolean> {
    try {
        const url = publicMcpUrl.replace(/\/mcp\/?$/, "/healthz");
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8_000);
        const response = await fetch(url, { signal: controller.signal });
        clearTimeout(timer);
        if (!response.ok) return false;
        const payload = (await response.json()) as { ok?: unknown };
        return payload.ok === true;
    } catch {
        return false;
    }
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Run first-time setup or manage an already configured installation. */
async function runFirstTimeSetup(): Promise<void> {
    if (!canPromptInteractively()) {
        throw new Error("首次设置需要在可以输入内容的终端里运行");
    }

    const current = loadUserConfig();
    const passwordConfigured = await hasAdminPassword();
    if (isPublicSetupConfigured(current) && passwordConfigured) {
        await runSetupManager(current);
        return;
    }

    printIntro("设置 codex-mcp");
    printInfo("先完成并验证公网连接，成功后再生成 ChatGPT 连接密码。");

    const { result, verification } = await withPublicSetupTransaction(async () => {
        const candidate = await ensureTunnelSetup({
            host: current.host,
            port: current.port,
        });
        const verified = await verifySetupResult(candidate);
        return { result: candidate, verification: verified };
    });
    await configureCapabilitySources();
    const generatedPassword = await ensureGeneratedAdminPassword({ display: false });
    printCompletedSetup(result, verification, generatedPassword);
}

async function runSetupManager(current: ReturnType<typeof loadUserConfig>): Promise<void> {
    printIntro("codex-mcp setup");
    printSummary("当前配置", [
        { label: "公网地址", value: `https://${current.domain}/mcp` },
        {
            label: "公网方式",
            value: current.useCloudflared === false ? "自定义 HTTPS" : "Cloudflare Tunnel",
        },
        ...(current.tunnelName ? [{ label: "Tunnel", value: current.tunnelName }] : []),
        { label: "连接密码", value: "已设置" },
        { label: "外部能力", value: describeCapabilitiesConfig(current.capabilities) },
    ]);

    const action = await askSelect(
        "请选择要执行的操作",
        [
            { value: "check", label: "检查当前配置", hint: "验证公网地址是否确实到达这台电脑" },
            { value: "public", label: "修改公网连接", hint: "重新选择域名或 Cloudflare 配置" },
            ...(current.useCloudflared === false
                ? []
                : [
                      {
                          value: "cloudflare",
                          label: "重新登录 / 切换 Cloudflare 账号",
                          hint: "只重置 codex-mcp 私有登录，不修改系统 ~/.cloudflared",
                      },
                  ]),
            { value: "password", label: "修改连接密码" },
            { value: "capabilities", label: "管理外部能力", hint: "Codex / Claude Code / Agent Skills" },
            { value: "exit", label: "退出，不做修改" },
        ],
        "check",
    );

    if (action === "exit") {
        printOutro("未修改配置");
        return;
    }
    if (action === "password") {
        await configureAdminPassword();
        return;
    }
    if (action === "capabilities") {
        const result = await configureCapabilitySources();
        printOutro(result.changed ? "外部能力设置已保存" : "外部能力设置保持不变");
        return;
    }

    const { result, verification } = await withPublicSetupTransaction(async () => {
        const candidate =
            action === "public"
                ? await runTunnelWizard()
                : action === "cloudflare"
                  ? await runTunnelWizard({ forceCloudflareLogin: true })
                  : await ensureTunnelSetup({ host: current.host, port: current.port });
        const verified = await verifySetupResult(candidate);
        return { result: candidate, verification: verified };
    });
    printCompletedSetup(result, verification);
}

async function verifySetupResult(
    result: TunnelSetupResult,
): Promise<Awaited<ReturnType<typeof verifySetupPublicRoute>>> {
    const host = result.userConfig.host ?? "127.0.0.1";
    const port = result.userConfig.port ?? 3920;
    return withSpinner(
        "正在验证公网连接是否确实到达这台电脑…",
        "公网连接验证成功",
        () => verifySetupPublicRoute(result, host, port),
    );
}

function printCompletedSetup(
    result: TunnelSetupResult,
    verification: Awaited<ReturnType<typeof verifySetupPublicRoute>>,
    generatedPassword?: string,
): void {
    const tunnelBits = [verification.tunnel?.protocol, verification.tunnel?.location].filter(
        (value): value is string => Boolean(value),
    );
    const rows = [
        { label: "公网地址", value: verification.publicMcpUrl },
        {
            label: "公网连接",
            value: tunnelBits.length > 0 ? `已验证 · ${tunnelBits.join(" · ")}` : "已验证",
        },
    ];
    if (result.useCloudflared && result.userConfig.tunnelName) {
        rows.push({ label: "Tunnel", value: result.userConfig.tunnelName });
    }
    rows.push({
        label: "连接密码",
        value: generatedPassword ?? "已设置（保持不变）",
    });

    printSummary("Setup 完成", rows);
    if (generatedPassword) {
        printWarning("请保存上面的连接密码；电脑只保存密码哈希，忘记后需要重新设置。");
    }
    printInfo("下一步：进入你的项目目录，运行 codex-mcp。");
    printOutro("设置完成");
}

/** Print installation/configuration report; --fix only performs whitelisted local repairs. */
async function printDoctorReport(fix: boolean): Promise<void> {
    printIntro("codex-mcp 检查");

    if (fix) {
        const state = loadDaemonState();
        const removedStaleDaemon = Boolean(state && !isProcessAlive(state.pid));
        ensureUserConfigDirs();
        cleanStaleDaemonState();
        printSuccess("已确保 ~/.codex-mcp 和日志目录存在。");
        if (removedStaleDaemon) {
            printSuccess("已清理失效的 daemon 状态文件。");
        }
        printInfo("--fix 不会修改 Cloudflare DNS、OAuth 身份、连接密码或项目文件。");
    }

    const report = await runDoctorChecks();
    for (const check of report.checks) {
        printDoctorMessage(check.level, `${check.label}：${check.detail}`);
    }

    if (report.errors > 0) {
        printError(
            `发现 ${report.errors} 个需要处理的问题。按上面的提示修复后，再运行一次 codex-mcp doctor。`,
        );
    } else if (report.warnings > 0) {
        printWarning(`可以正常使用。有 ${report.warnings} 个可选项目没有安装。`);
    } else {
        printSuccess("安装和配置看起来都正常。");
    }
    printInfo("启动 codex-mcp 时还会自动检查公网连接是否真的可用。");
    printOutro("检查完成");
}

function printDoctorMessage(level: DoctorLevel, text: string): void {
    if (level === "ok") {
        printSuccess(text);
    } else if (level === "warn") {
        printWarning(text);
    } else {
        printError(text);
    }
}

function getPackageVersion(): string {
    try {
        const raw = JSON.parse(
            readFileSync(new URL("../package.json", import.meta.url), "utf8"),
        ) as { version?: unknown };
        return typeof raw.version === "string" ? raw.version : "未知版本";
    } catch {
        return "未知版本";
    }
}

/** Configure or replace the public access password manually. */
async function configureAdminPassword(): Promise<void> {
    if (!canPromptInteractively()) {
        throw new Error("修改连接密码需要在可以输入内容的终端里运行");
    }
    printIntro("修改连接密码");
    printInfo("修改连接密码。");
    printWarning("密码要求：至少 12 个字符。");
    const password = await askSecret("新密码");
    const confirmation = await askSecret("再输入一次");
    if (password !== confirmation) {
        throw new Error("两次输入的密码不一样，请重新设置");
    }
    await saveAndVerifyAdminPassword(password);
    printOutro("连接密码已修改");
}

/** Ensure first-time public access has a generated password without overwriting an existing one. */
async function ensureGeneratedAdminPassword(
    options: { display?: boolean } = {},
): Promise<string | undefined> {
    if (await hasAdminPassword()) {
        if (options.display !== false) {
            printSuccess("连接密码已经存在，保持不变。");
            printInfo("需要修改时运行：codex-mcp auth");
        }
        return undefined;
    }

    const password = generateAdminPassword();
    await saveAndVerifyAdminPassword(password);
    if (options.display !== false) {
        printSuccess("连接密码已自动生成。");
        printWarning("请保存下面的密码，连接 ChatGPT 时需要输入：");
        printNote("连接密码", password);
        printInfo("电脑不会保存密码明文；忘记后可运行 `codex-mcp auth` 设置新密码。");
    }
    return password;
}

async function saveAndVerifyAdminPassword(password: string): Promise<void> {
    await setAdminPassword(password);
    if (!(await verifyAdminPassword(password))) {
        throw new Error("连接密码保存后校验失败，请重新运行 `codex-mcp setup`");
    }
}

async function ensureAdminPasswordConfigured(): Promise<void> {
    if (await hasAdminPassword()) return;
    if (!canPromptInteractively()) {
        throw new Error("还没有连接密码，请先运行 `codex-mcp setup`");
    }
    printWarning("第一次使用需要生成连接密码。");
    await ensureGeneratedAdminPassword();
}

void main(process.argv.slice(2)).catch((error) => {
    const detail = error instanceof Error ? error.message : String(error);
    writeRuntimeLog("error", "startup_failed", { error: detail });
    printError(detail);
    try {
        closeRuntimeLog();
    } catch (logError) {
        const logDetail = logError instanceof Error ? logError.message : String(logError);
        printWarning(`文件日志关闭失败：${logDetail}`);
    }
    process.exit(1);
});
