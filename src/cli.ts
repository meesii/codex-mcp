#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig } from "./config/loader.js";
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
import { loadUserConfig } from "./config/user-config.js";
import { runSelfUpdate } from "./doctor/update.js";

interface CliFlags {
    command: "serve" | "setup" | "doctor" | "tunnel" | "auth" | "update" | "version" | "help";
    local: boolean;
    noTunnel: boolean;
    tunnelLogs: boolean;
    root?: string;
}

/** Print CLI usage. */
function printUsage(): void {
    printIntro("codex-mcp");
    printNote(
        "使用方法",
        [
            "codex-mcp                         启动当前项目",
            "codex-mcp setup                   设置 / 管理公网连接",
            "codex-mcp doctor                  检查安装和配置",
            "codex-mcp auth                    修改连接密码",
            "codex-mcp update                  更新到最新版本",
            "codex-mcp tunnel                  重新设置公网连接",
            "codex-mcp --local                 只在本机启动，不开放公网",
            "codex-mcp --root <目录>           指定项目目录",
            "codex-mcp --no-tunnel             不自动启动 Cloudflare Tunnel",
            "codex-mcp --tunnel-logs           在终端显示 Tunnel 日志",
            "codex-mcp --version               查看版本",
            "codex-mcp help                    查看帮助",
        ].join("\n"),
    );
    printInfo("平时最常用：进入项目目录后直接运行 codex-mcp。");
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
 * Parse argv into a command + flags.
 *
 * @param argv - Process arguments excluding node/executable
 * @returns Parsed flags
 */
function parseArgv(argv: string[]): CliFlags {
    let command: CliFlags["command"] = "serve";
    let local = false;
    let noTunnel = false;
    let tunnelLogs = false;
    let root: string | undefined;
    const positionals: string[] = [];

    for (let index = 0; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (arg === "--local") {
            local = true;
            continue;
        }
        if (arg === "--no-tunnel") {
            noTunnel = true;
            continue;
        }
        if (arg === "--tunnel-logs") {
            tunnelLogs = true;
            continue;
        }
        if (arg === "--root") {
            const value = argv[index + 1];
            if (!value || value.startsWith("-")) {
                throw new Error("`--root` 后面需要填写项目目录");
            }
            root = value;
            index += 1;
            continue;
        }
        if (arg === "--help" || arg === "-h") {
            return {
                command: "help",
                local,
                noTunnel,
                tunnelLogs,
                root,
            };
        }
        if (arg === "--version" || arg === "-v") {
            return {
                command: "version",
                local,
                noTunnel,
                tunnelLogs,
                root,
            };
        }
        if (arg.startsWith("-")) {
            throw new Error(`不认识这个选项：${arg}`);
        }
        positionals.push(arg);
    }

    if (positionals[0] === "help") {
        command = "help";
    } else if (positionals[0] === "setup") {
        command = "setup";
    } else if (positionals[0] === "doctor") {
        command = "doctor";
    } else if (positionals[0] === "tunnel") {
        command = "tunnel";
    } else if (positionals[0] === "auth") {
        command = "auth";
    } else if (positionals[0] === "update") {
        command = "update";
    } else if (positionals[0] === "version") {
        command = "version";
    } else if (positionals[0] === "serve" || positionals[0] === undefined) {
        command = "serve";
    } else {
        throw new Error(`不认识这个命令：${positionals[0]}。运行 codex-mcp help 查看帮助`);
    }

    if (positionals.length > 1) {
        throw new Error(`这里不需要这些内容：${positionals.slice(1).join(" ")}`);
    }

    return { command, local, noTunnel, tunnelLogs, root };
}

/**
 * CLI entrypoint.
 *
 * @param argv - Process arguments excluding node/executable
 */
async function main(argv: string[]): Promise<void> {
    const flags = parseArgv(argv);
    if (flags.command === "help") {
        printUsage();
        return;
    }

    if (flags.command === "version") {
        console.log(getPackageVersion());
        return;
    }

    if (flags.command === "doctor") {
        await printDoctorReport();
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

    await runServe(flags);
}

/**
 * Start HTTP MCP and optionally the cloudflared sidecar.
 *
 * @param flags - Parsed CLI flags
 */
async function runServe(flags: CliFlags): Promise<void> {
    let userConfig = loadUserConfig();
    const allowSidecar = !flags.local && !flags.noTunnel;

    // First-time / incomplete: configure and verify the public route as one
    // local durable-state transaction before starting the normal server.
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

    const downstream = hub.listServers().map((item) =>
        item.status === "ready" ? item.name : `${item.name}!`,
    );

    printStartupBanner({
        mcpUrl: publicUrl ?? server.getMcpUrl(),
        localUrl: server.getMcpUrl(),
        projectRoot: config.projectRoot,
        logDirectory,
        logsOn: isToolLogEnabled(),
        downstream,
        skillCount: skills.list().length,
        tunnel: sidecar
            ? (tunnelReady ?? { protocol: undefined, location: undefined })
            : wantSidecar
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
            capabilityWatcher.close();
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

/** Print a readable, read-only installation/configuration report. */
async function printDoctorReport(): Promise<void> {
    printIntro("codex-mcp 检查");

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
