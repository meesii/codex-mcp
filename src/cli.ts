#!/usr/bin/env node
import { styleText } from "node:util";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http-server.js";
import { isToolLogEnabled } from "./lib/tool-log.js";
import { askLine, canPromptInteractively } from "./tunnel/prompt.js";
import { CloudflaredSidecar } from "./tunnel/sidecar.js";
import {
    ensureTunnelSetup,
    runTunnelWizard,
    type TunnelSetupResult,
} from "./tunnel/setup.js";
import { loadUserConfig } from "./user-config.js";

interface CliFlags {
    command: "serve" | "tunnel" | "help";
    local: boolean;
    noTunnel: boolean;
    tunnelLogs: boolean;
    root?: string;
}

/**
 * Print CLI usage to stderr.
 */
function printUsage(): void {
    console.error(`Usage:
  codex-mcp [--local] [--no-tunnel] [--tunnel-logs] [--root <dir>]
  codex-mcp serve [same flags]
  codex-mcp tunnel
  codex-mcp help

Defaults:
  project root = current working directory
  starts Cloudflare Tunnel when configured (useCloudflared)
`);
}

/**
 * Colorize startup banner text when stdout is a TTY.
 *
 * @param format - Color format
 * @param text - Text
 * @returns Styled text
 */
function paint(format: Parameters<typeof styleText>[0], text: string): string {
    if (process.env.NO_COLOR !== undefined || process.stdout.isTTY !== true) {
        return text;
    }
    return styleText(format, text);
}

const BANNER_LABEL_WIDTH = 7;

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
    tunnel:
        | { protocol?: string; location?: string }
        | "off"
        | undefined;
}): void {
    clearTerminal();
    console.log(paint(["bold", "cyan"], "codex-mcp"));
    printBannerRow("mcp", paint(["bold", "green"], input.mcpUrl));
    if (input.localUrl !== input.mcpUrl) {
        printBannerRow("local", input.localUrl);
    }
    printBannerRow("root", input.projectRoot);

    if (input.tunnel === "off") {
        printBannerRow("tunnel", paint("dim", "off"));
    } else if (input.tunnel) {
        const bits = [input.tunnel.protocol, input.tunnel.location].filter(
            (part): part is string => Boolean(part),
        );
        printBannerRow(
            "tunnel",
            bits.length > 0
                ? paint("green", bits.join(" · "))
                : paint("green", "on"),
        );
    }

    printBannerRow("logs", input.logsOn ? "on" : paint("dim", "off"));
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
                throw new Error("--root requires a directory path");
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
        if (arg.startsWith("-")) {
            throw new Error(`Unknown flag: ${arg}`);
        }
        positionals.push(arg);
    }

    if (positionals[0] === "help") {
        command = "help";
    } else if (positionals[0] === "tunnel") {
        command = "tunnel";
    } else if (positionals[0] === "serve" || positionals[0] === undefined) {
        command = "serve";
    } else {
        throw new Error(`Unknown command: ${positionals[0]}`);
    }

    if (positionals.length > 1) {
        throw new Error(`Unexpected arguments: ${positionals.slice(1).join(" ")}`);
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

    if (flags.command === "tunnel") {
        const result = await runTunnelWizard();
        if (result.useCloudflared && result.tunnelId) {
            console.log(
                paint(
                    "green",
                    `Tunnel ready: https://${result.domain}/mcp  (id ${result.tunnelId})`,
                ),
            );
        } else {
            console.log(
                paint("green", `Domain saved: https://${result.domain}/mcp`),
            );
        }
        console.log(
            paint(
                "dim",
                "Run `codex-mcp` in a project directory to serve.",
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

    const projectRoot = await chooseProjectRoot(flags);
    const config = loadConfig({
        projectRoot,
        userConfig,
        local: flags.local,
    });

    if (!flags.local && config.allowedHosts.length === 0) {
        throw new Error(
            "A public domain is required in ~/.codex-mcp/config.json. Use --local for localhost only.",
        );
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

    const server = createHttpServer(config);
    await server.listen();

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
        } catch (error) {
            await server.close();
            throw error;
        }
    }

    printStartupBanner({
        mcpUrl: publicUrl ?? server.getMcpUrl(),
        localUrl: server.getMcpUrl(),
        projectRoot: config.projectRoot,
        logsOn: isToolLogEnabled(),
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

/**
 * Pick the project root before listen.
 *
 * Skips the prompt when `--root` is set, or when stdin is not a TTY
 * (falls back to cwd via loadConfig).
 *
 * @param flags - Parsed CLI flags
 * @returns Explicit root for loadConfig, or undefined to use cwd
 */
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
        await askLine("Project root", cwd)
    ).trim();
    return answer || cwd;
}

void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
