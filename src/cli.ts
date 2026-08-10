#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { loadConfig } from "./config.js";
import { runDoctorChecks, type DoctorLevel } from "./doctor.js";
import {
    generateAdminPassword,
    hasAdminPassword,
    setAdminPassword,
    verifyAdminPassword,
} from "./auth/password-store.js";
import { DownstreamMcpHub } from "./downstream/hub.js";
import { CodexCapabilityWatcher } from "./capabilities/runtime.js";
import { resolveAllowedTools } from "./capabilities/policy.js";
import { createHttpServer } from "./http-server.js";
import { isToolLogEnabled } from "./lib/tool-log.js";
import {
    paintTerminal,
    printError,
    printInfo,
    printSuccess,
    printWarning,
    terminalMessage,
} from "./lib/terminal.js";
import { SkillRegistry } from "./skills/registry.js";
import { askLine, askSecret, canPromptInteractively } from "./tunnel/prompt.js";
import { CloudflaredSidecar } from "./tunnel/sidecar.js";
import { verifyTunnelRoute } from "./tunnel/verify.js";
import {
    ensureTunnelSetup,
    runTunnelWizard,
    type TunnelSetupResult,
} from "./tunnel/setup.js";
import { loadUserConfig } from "./user-config.js";
import { runSelfUpdate } from "./update.js";

interface CliFlags {
    command: "serve" | "setup" | "doctor" | "tunnel" | "auth" | "update" | "version" | "help";
    local: boolean;
    noTunnel: boolean;
    tunnelLogs: boolean;
    root?: string;
}

/**
 * Print CLI usage to stderr.
 */
function printUsage(): void {
    console.error(`codex-mcp 使用方法

  codex-mcp                         启动当前项目
  codex-mcp setup                   首次设置
  codex-mcp doctor                  检查安装和配置
  codex-mcp auth                    修改连接密码
  codex-mcp update                  更新到最新版本
  codex-mcp tunnel                  重新设置公网连接
  codex-mcp --local                 只在本机启动，不开放公网
  codex-mcp --root <目录>           指定项目目录
  codex-mcp --no-tunnel             不自动启动 Cloudflare Tunnel
  codex-mcp --tunnel-logs           在终端显示 Tunnel 日志
  codex-mcp --version               查看版本
  codex-mcp help                    查看帮助

平时最常用：进入项目目录后直接运行 codex-mcp。
首次使用：运行 codex-mcp setup。
`);
}

const paint = paintTerminal;
const BANNER_LABEL_WIDTH = 8;

/**
 * Clear the terminal when stdout is an interactive TTY.
 */
function clearTerminal(): void {
    if (process.stdout.isTTY !== true) return;
    console.clear();
}

/**
 * Print one aligned `label  value` row for the startup banner.
 *
 * @param label - Left column (dim)
 * @param value - Right column (already styled if needed)
 */
function printBannerRow(label: string, value: string): void {
    console.log(`  ${paint("dim", label.padEnd(BANNER_LABEL_WIDTH))}  ${value}`);
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
    logsOn: boolean;
    downstream: string[];
    skillCount: number;
    tunnel:
        | { protocol?: string; location?: string }
        | "off"
        | undefined;
}): void {
    clearTerminal();
    console.log(paint(["bold", "cyan"], "codex-mcp 已启动"));
    printBannerRow("连接地址", paint(["bold", "green"], input.mcpUrl));
    if (input.localUrl !== input.mcpUrl) {
        printBannerRow("本机地址", input.localUrl);
    }
    printBannerRow("项目目录", input.projectRoot);

    if (input.tunnel === "off") {
        printBannerRow("公网连接", paint("dim", "未启动"));
    } else if (input.tunnel) {
        const bits = [input.tunnel.protocol, input.tunnel.location].filter(
            (part): part is string => Boolean(part),
        );
        printBannerRow(
            "公网连接",
            bits.length > 0
                ? paint("green", bits.join(" · "))
                : paint("green", "已连接"),
        );
    }

    if (input.downstream.length > 0) {
        printBannerRow("外部 MCP", paint("green", input.downstream.join(", ")));
    }
    if (input.skillCount > 0) {
        printBannerRow("Skills", paint("green", String(input.skillCount)));
    }

    printBannerRow("工具日志", input.logsOn ? "已开启" : paint("dim", "未开启"));
    console.log("");
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
        const result = await runTunnelWizard();
        if (result.useCloudflared && result.tunnelId) {
            console.log(
                paint(
                    "green",
                    `公网连接已设置：https://${result.domain}/mcp`,
                ),
            );
        } else {
            console.log(
                paint("green", `公网地址已保存：https://${result.domain}/mcp`),
            );
        }
        console.log(
            paint(
                "dim",
                "接下来进入你的项目目录，运行 codex-mcp 即可启动。",
            ),
        );
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

    // First-time / incomplete: create ~/.codex-mcp/config.json → domain → cloudflared?
    if (!flags.local && !userConfig.domain) {
        userConfig = (
            await ensureTunnelSetup({
                host: userConfig.host,
                port: userConfig.port,
            })
        ).userConfig;
    }

    if (!flags.local) {
        await ensureAdminPasswordConfigured();
    }

    const projectRoot = await chooseProjectRoot(flags);
    const config = loadConfig({
        projectRoot,
        userConfig,
        local: flags.local,
    });

    if (!flags.local && config.allowedHosts.length === 0) {
        throw new Error("还没有设置公网地址，请先运行 `codex-mcp setup`；只在本机使用可加 `--local`");
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

    const hub = await DownstreamMcpHub.connectFromDefaultConfig();
    const skills = SkillRegistry.discoverDefault();
    const server = createHttpServer(config, {
        hub,
        skills,
        allowedToolsResolver: resolveAllowedTools,
    });
    await server.listen();
    const capabilityWatcher = new CodexCapabilityWatcher(hub, skills);
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
        logsOn: isToolLogEnabled(),
        downstream,
        skillCount: skills.list().length,
        tunnel: sidecar
            ? (tunnelReady ?? { protocol: undefined, location: undefined })
            : wantSidecar
              ? "off"
              : undefined,
    });

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
        capabilityWatcher.close();
        if (sidecar) {
            await sidecar.stop();
        }
        await server.close();
        process.exit(0);
    };

    process.once("SIGINT", () => {
        void shutdown();
    });
    process.once("SIGTERM", () => {
        void shutdown();
    });
}

/** Run the guided first-time setup for public ChatGPT access. */
async function runFirstTimeSetup(): Promise<void> {
    if (!canPromptInteractively()) {
        throw new Error("首次设置需要在可以输入内容的终端里运行");
    }

    console.log("");
    console.log(paint(["bold", "cyan"], "开始设置 codex-mcp"));
    printInfo("首次使用会自动生成连接密码，然后设置公网连接。");
    console.log("");

    await ensureGeneratedAdminPassword();
    const result = await runTunnelWizard();

    console.log("");
    console.log(paint(["bold", "green"], "✓ 设置完成"));
    printInfo(`ChatGPT 连接地址：https://${result.domain}/mcp`);
    printInfo("接下来：进入你的项目目录，运行 codex-mcp。");
    console.log("");
}

/** Print a readable, read-only installation/configuration report. */
async function printDoctorReport(): Promise<void> {
    console.log("");
    console.log(paint(["bold", "cyan"], "codex-mcp 检查"));
    console.log("");

    const report = await runDoctorChecks();
    for (const check of report.checks) {
        console.log(doctorMessage(check.level, `${check.label}：${check.detail}`));
    }

    console.log("");
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
    console.log("");
}

function doctorMessage(level: DoctorLevel, text: string): string {
    if (level === "ok") return terminalMessage("success", text);
    if (level === "warn") return terminalMessage("warning", text);
    return terminalMessage("error", text);
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
    console.log("");
    printInfo("修改连接密码。");
    printWarning("密码要求：至少 12 个字符。");
    const password = await askSecret("新密码");
    const confirmation = await askSecret("再输入一次");
    if (password !== confirmation) {
        throw new Error("两次输入的密码不一样，请重新设置");
    }
    await saveAndVerifyAdminPassword(password);
    printSuccess("连接密码已修改。");
}

/** Ensure first-time public access has a generated password without overwriting an existing one. */
async function ensureGeneratedAdminPassword(): Promise<void> {
    if (await hasAdminPassword()) {
        printSuccess("连接密码已经存在，保持不变。");
        printInfo("需要修改时运行：codex-mcp auth");
        return;
    }

    const password = generateAdminPassword();
    await saveAndVerifyAdminPassword(password);
    printSuccess("连接密码已自动生成。");
    printWarning("请保存下面的密码，连接 ChatGPT 时需要输入：");
    console.log("");
    console.log(paint(["bold", "green"], `  ${password}`));
    console.log("");
    printInfo("电脑不会保存密码明文；忘记后可运行 `codex-mcp auth` 设置新密码。");
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
    console.log("");
    printWarning("第一次使用需要生成连接密码。");
    await ensureGeneratedAdminPassword();
}

async function chooseProjectRoot(
    flags: CliFlags,
): Promise<string | undefined> {
    if (flags.root?.trim()) {
        return flags.root.trim();
    }
    if (!canPromptInteractively()) {
        return undefined;
    }

    const cwd = process.cwd();
    console.log("");
    const answer = (
        await askLine("要操作的项目目录", cwd)
    ).trim();
    return answer || cwd;
}

void main(process.argv.slice(2)).catch((error) => {
    printError(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
