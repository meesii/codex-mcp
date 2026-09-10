#!/usr/bin/env node
import { loadConfig, type ServerConfig } from "./config/loader.js";
import type { DoctorLevel } from "./doctor/index.js";
import { DownstreamMcpHub } from "./downstream/hub.js";
import { CapabilityManager } from "./capabilities/manager.js";
import { CapabilityWatcher } from "./capabilities/runtime.js";
import type { SkillRegistry } from "./skills/registry.js";
import { resolveAllowedTools } from "./capabilities/policy.js";
import { createHttpServer } from "./server/http-server.js";
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
    printWarning,
} from "./lib/util/terminal.js";
import {
    CloudflaredSidecar,
    type TunnelSidecarStatus,
} from "./tunnel/sidecar.js";
import { verifyTunnelRoute } from "./tunnel/verify.js";
import {
    loadCommittedTunnelSetup,
    type TunnelSetupResult,
} from "./tunnel/setup.js";
import { loadUserConfig } from "./config/user-config.js";
import { randomBytes } from "node:crypto";
import type { TunnelObservedStatus } from "./daemon/control.js";
import {
    loadDaemonState,
    removeDaemonState,
    saveDaemonState,
} from "./daemon/state.js";
import { BindingStore } from "./projects/bindings.js";
import { ProjectRegistry } from "./projects/registry.js";
import { ProjectRuntimeManager } from "./projects/runtime.js";
import { PACKAGE_VERSION } from "./server/version.js";
import { parseCliArgs, type CliFlags } from "./cli/args.js";
import { followLogFile, readRecentLogLines } from "./cli/logs.js";
import {
    configureAdminPassword,
    ensureAdminPasswordConfigured,
    runFirstTimeSetup,
} from "./cli/setup-commands.js";
import {
    ensureDaemonAndRegister,
    getPackageVersion,
    runRestart,
    runStatus,
    runStop,
} from "./cli/daemon-commands.js";
import { runProjectCommand } from "./cli/project-commands.js";
import { runControllerProcess } from "./control/process.js";
import { runDoctorService, selfUpdate } from "./control/services.js";

/** Print CLI usage. */
function printUsage(): void {
    printIntro("codex-mcp");
    printNote(
        "常用命令",
        [
            "codex-mcp start                   注册当前项目并确保后台服务运行",
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
            "codex-mcp start --local           注册当前项目并以本机模式启动",
            "codex-mcp start --root <目录>     指定 start 的项目目录",
            "codex-mcp --version               查看版本",
        ].join("\n"),
    );
    printInfo("多数情况下：进入项目目录运行 codex-mcp start；排查问题先看 status 和 logs。");
    printOutro("首次使用：运行 codex-mcp setup");
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
        await selfUpdate();
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

    if (flags.command === "daemon") {
        await runDaemonProcess(flags);
        return;
    }

    if (flags.command === "controller") {
        await runControllerProcess();
        return;
    }

    await runStart(flags);
}

/** Ensure the daemon is running, register the current project, and print status. */
async function runStart(flags: CliFlags): Promise<void> {
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
    runtimeIntent: { local: boolean; noTunnel: boolean; tunnelLogs: boolean };
    onShutdown: () => Promise<void>;
}

interface StartServicesOptions {
    signal: AbortSignal;
    flags: CliFlags;
    userConfig: ReturnType<typeof loadUserConfig>;
    daemon?: DaemonStartContext;
    tunnelStatus: () => TunnelObservedStatus;
    onTunnelStatus: (status: TunnelSidecarStatus) => void;
}

async function cleanupStartedResources(
    server: ReturnType<typeof createHttpServer>,
    capabilityWatcher?: CapabilityWatcher,
    sidecar?: CloudflaredSidecar,
): Promise<unknown[]> {
    const errors: unknown[] = [];
    try {
        capabilityWatcher?.close();
    } catch (error) {
        errors.push(error);
    }
    if (sidecar) {
        try {
            await sidecar.stop();
        } catch (error) {
            errors.push(error);
        }
    }
    try {
        await server.close();
    } catch (error) {
        errors.push(error);
    }
    return errors;
}

function startupCleanupError(original: unknown, cleanupErrors: unknown[]): unknown {
    return cleanupErrors.length === 0
        ? original
        : new AggregateError(
              [original, ...cleanupErrors],
              `启动失败，且 ${cleanupErrors.length} 项本机资源清理未完成`,
          );
}

/**
 * Start the HTTP MCP server plus the shared hub/skills/watcher, and optionally
 * the Cloudflare sidecar. Used by the internal daemon.
 */
async function startServices(options: StartServicesOptions): Promise<StartedServices> {
    const { flags, userConfig, signal } = options;
    signal.throwIfAborted();
    const allowSidecar = !flags.local && !flags.noTunnel;

    const config = loadConfig({
        projectRoot: flags.root,
        userConfig,
        local: flags.local,
    });

    if (!flags.local && config.allowedHosts.length === 0) {
        throw new Error("还没有设置公网地址，请先运行 `codex-mcp setup`；只在本机使用请运行 `codex-mcp start --local`");
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
        allowSidecar && userConfig.publicAccess?.kind === "cloudflare";
    if (wantSidecar) {
        tunnelSetup = await loadCommittedTunnelSetup(userConfig, config.host, config.port);
    }

    const capabilities = new CapabilityManager(
        config.projectRoot,
        options.daemon
            ? {
                  includeUserScopes: true,
                  includeProjectScopes: false,
              }
            : {},
    );
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
                      runtimeIntent: options.daemon.runtimeIntent,
                      tunnelStatus: options.tunnelStatus,
                      onShutdown: options.daemon.onShutdown,
                  },
              }
            : {}),
    });
    let capabilityWatcher: CapabilityWatcher | undefined;
    let sidecar: CloudflaredSidecar | undefined;
    let tunnelReady: { protocol?: string; location?: string } | undefined;
    const publicUrl =
        config.allowedHosts[0] !== undefined
            ? `https://${config.allowedHosts[0]}/mcp`
            : undefined;

    const cancelSidecar = () => { void sidecar?.stop().catch(() => undefined); };
    signal.addEventListener("abort", cancelSidecar, { once: true });
    try {
        signal.throwIfAborted();
        await server.listen();
        signal.throwIfAborted();
        capabilityWatcher = new CapabilityWatcher(capabilities, hub, skills);
        capabilityWatcher.start();
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
                maxRestarts: options.daemon ? 3 : 0,
                onStateChange: options.onTunnelStatus,
            });
            tunnelReady = await sidecar.start();
            signal.throwIfAborted();
        }
        if (publicUrl) {
            await verifyTunnelRoute(publicUrl, server.getTunnelProbe(), { signal });
        }
    } catch (error) {
        const cleanupErrors = await cleanupStartedResources(server, capabilityWatcher, sidecar);
        throw startupCleanupError(error, cleanupErrors);
    } finally {
        signal.removeEventListener("abort", cancelSidecar);
    }

    if (!capabilityWatcher) throw new Error("Capability watcher 没有启动");
    return { config, server, hub, skills, capabilityWatcher, sidecar, tunnelReady, logDirectory, userConfig };
}

/**
 * Internal daemon entrypoint (spawned detached by the CLI). Owns the MCP
 * server, the Cloudflare sidecar, and the durable daemon state.
 */
async function runDaemonProcess(flags: CliFlags): Promise<void> {
    if (typeof process.send !== "function" || !process.connected) {
        throw new Error("daemon 是内部入口；请运行 codex-mcp start");
    }
    const startup = new AbortController();
    const cancel = () => startup.abort(new Error("已取消守护进程启动"));
    // Keep IPC ownership until state is committed. If the starting CLI dies,
    // an unfinished daemon must clean up instead of becoming an orphan.
    process.once("disconnect", cancel);
    process.once("SIGINT", cancel);
    process.once("SIGTERM", cancel);
    const release = () => {
        process.off("disconnect", cancel);
        process.off("SIGINT", cancel);
        process.off("SIGTERM", cancel);
    };
    try {
        await runDaemonServices(flags, startup.signal, () => {
            release();
            if (process.connected) process.disconnect();
        });
    } finally {
        release();
    }
}

async function runDaemonServices(flags: CliFlags, signal: AbortSignal, ready: () => void): Promise<void> {
    const userConfig = loadUserConfig();
    if (!flags.local && !userConfig.publicAccess) {
        throw new Error("daemon 只读取已提交配置；请先在前台运行 `codex-mcp setup`");
    }

    if (!flags.local) {
        await ensureAdminPasswordConfigured();
    }

    const registry = new ProjectRegistry();
    const bindings = new BindingStore();
    await bindings.pruneStale();
    const runtimes = new ProjectRuntimeManager();
    const controlToken = randomBytes(32).toString("base64url");

    let services: StartedServices | undefined;
    let tunnelStatus: TunnelObservedStatus = { running: false, state: "off" };
    let shuttingDown = false;

    const shutdown = async (): Promise<void> => {
        if (shuttingDown) return;
        shuttingDown = true;
        writeRuntimeLog("info", "daemon_stopping");
        let exitCode = 0;
        try {
            if (services) {
                const errors = await cleanupStartedResources(services.server, services.capabilityWatcher, services.sidecar);
                if (errors.length) throw new AggregateError(errors, "后台服务清理未完成");
            }
            await removeDaemonState();
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
        signal,
        flags,
        userConfig,
        daemon: {
            registry,
            bindings,
            runtimes,
            controlToken,
            runtimeIntent: {
                local: flags.local,
                noTunnel: flags.noTunnel,
                tunnelLogs: flags.tunnelLogs,
            },
            onShutdown: shutdown,
        },
        tunnelStatus: () => tunnelStatus,
        onTunnelStatus: (status) => {
            tunnelStatus = status;
        },
    });

    try {
        signal.throwIfAborted();
        await saveDaemonState({
            schemaVersion: 1,
            pid: process.pid,
            host: services.config.host,
            port: services.server.getPort(),
            controlToken,
            ...(services.config.publicMcpUrl ? { publicMcpUrl: services.config.publicMcpUrl } : {}),
            startedAt: new Date().toISOString(),
            version: PACKAGE_VERSION,
            runtimeIntent: {
                local: flags.local,
                noTunnel: flags.noTunnel,
                tunnelLogs: flags.tunnelLogs,
            },
        });
        signal.throwIfAborted();
    } catch (error) {
        if (loadDaemonState()?.pid === process.pid) await removeDaemonState();
        const cleanupErrors = await cleanupStartedResources(
            services.server,
            services.capabilityWatcher,
            services.sidecar,
        );
        try {
            closeRuntimeLog();
        } catch (logError) {
            cleanupErrors.push(logError);
        }
        throw startupCleanupError(error, cleanupErrors);
    }
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
    ready();
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

/** Print installation/configuration report; --fix only performs whitelisted local repairs. */
async function printDoctorReport(fix: boolean): Promise<void> {
    printIntro("codex-mcp 检查");

    const result = await runDoctorService(fix);
    for (const fixMessage of result.fixes) printSuccess(fixMessage);
    if (fix) printInfo("--fix 不会修改 Cloudflare DNS、OAuth 身份、连接密码或项目文件。");

    const report = result.report;
    for (const check of report.checks) {
        printDoctorMessage(check.level, `${check.label}：${check.detail}`);
    }

    if (report.errors > 0) {
        process.exitCode = 1;
        printError(
            `发现 ${report.errors} 个需要处理的问题。按上面的提示修复后，再运行一次 codex-mcp doctor。`,
        );
    } else if (report.warnings > 0) {
        printWarning(`可以正常使用。有 ${report.warnings} 个需要留意的提示。`);
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
