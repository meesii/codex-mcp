#!/usr/bin/env node
import { styleText } from "node:util";
import { loadConfig } from "./config.js";
import { createHttpServer } from "./http-server.js";

/**
 * Print CLI usage to stderr.
 */
function printUsage(): void {
    console.error("Usage: codex-mcp serve");
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

/**
 * CLI entrypoint.
 *
 * @param argv - Process arguments excluding node/executable
 */
async function main(argv: string[]): Promise<void> {
    const command = argv[0] ?? "serve";
    if (command === "help" || command === "--help" || command === "-h") {
        printUsage();
        return;
    }
    if (command !== "serve") {
        printUsage();
        process.exitCode = 1;
        return;
    }

    const config = loadConfig();
    const server = createHttpServer(config);
    await server.listen();
    const logsOn = !(
        process.env.CODING_MCP_LOG_TOOLS === "0" ||
        process.env.CODING_MCP_LOG_TOOLS?.toLowerCase() === "false"
    );

    console.log(
        `${paint(["bold", "cyan"], "codex-mcp")}  ${paint("green", server.getMcpUrl())}`,
    );
    console.log(
        paint(
            "dim",
            [
                `root ${config.projectRoot}`,
                `hosts ${
                    config.allowedHosts.length > 0
                        ? config.allowedHosts.join("; ")
                        : "localhost"
                }`,
                `widget ${config.widgetDomain}`,
                `logs ${logsOn ? "on" : "off"}`,
            ].join("  ·  "),
        ),
    );

    let shuttingDown = false;
    const shutdown = async () => {
        if (shuttingDown) return;
        shuttingDown = true;
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

void main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
