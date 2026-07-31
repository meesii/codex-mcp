import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { destructiveAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";

const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * Run a shell command inside a workspace directory.
 *
 * @param command - Command string
 * @param cwd - Working directory
 * @param timeoutMs - Kill timeout
 * @returns Captured stdout/stderr/exit code
 */
async function runShellCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    const isWindows = process.platform === "win32";
    const file = isWindows ? "pwsh" : "/bin/bash";
    const args = isWindows
        ? ["-NoProfile", "-Command", command]
        : ["-lc", command];

    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: process.env,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill("SIGTERM");
        }, timeoutMs);

        child.stdout.on("data", (chunk: Buffer) => {
            stdout += chunk.toString("utf8");
        });
        child.stderr.on("data", (chunk: Buffer) => {
            stderr += chunk.toString("utf8");
        });
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code, timedOut });
        });
    });
}

/**
 * Register the `bash` tool.
 *
 * @param server - MCP server instance
 * @param project - Bound project context
 */
export function registerBashTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "bash",
        withNoAuth({
            title: "Run shell command",
            description:
                "Run a short foreground shell command in the project root and return its output (installs, tests, builds, git, scripts). Windows uses PowerShell; Unix uses bash. Prefer executing yourself over telling the user which command to run. Do NOT use this to read/search/edit source — use read/grep/glob/ls/edit/write. For long-running servers/watchers use exec_command. On Windows: stay in PowerShell end-to-end for file ops (Remove-Item/Move-Item -LiteralPath); do not pipe paths into cmd /c for deletes.",
            inputSchema: {
                command: z
                    .string()
                    .describe(
                        'Shell command in project root (cwd already set; avoid cd). Windows PowerShell examples: Get-ChildItem -Force; Get-ChildItem -Recurse -Filter *.ts; Get-Process | Where-Object { $_.ProcessName -like "*node*" }. Unix: normal bash.',
                    ),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("Optional timeout in milliseconds (default 60000)."),
            },
            outputSchema: {
                stdout: z.string(),
                stderr: z.string(),
                exitCode: z.number().nullable(),
                timedOut: z.boolean(),
            },
            annotations: destructiveAnnotations,
        }),
        async ({ command, timeout_ms: timeoutMs }) => {
            try {
                return await project.lock.runExclusive(async () => {
                    const result = await runShellCommand(
                        command,
                        project.root,
                        timeoutMs ?? DEFAULT_TIMEOUT_MS,
                    );
                    const stdout = truncateText(result.stdout.trimEnd());
                    const stderr = truncateText(result.stderr.trimEnd());
                    const structured = {
                        stdout,
                        stderr,
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                    };

                    if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== null)) {
                        const detail = [
                            result.timedOut
                                ? `timed out after ${timeoutMs ?? DEFAULT_TIMEOUT_MS}ms`
                                : `exit_code=${result.exitCode}`,
                            stderr ? `stderr_chars=${stderr.length}` : "",
                            stdout ? `stdout_chars=${stdout.length}` : "",
                        ]
                            .filter(Boolean)
                            .join(", ");
                        return {
                            ...errorResult(`Command failed (${detail}).`),
                            // Keep structured fields so the model can still inspect output.
                            structuredContent: structured,
                        };
                    }

                    return okResult(
                        `Command finished (exit_code=${result.exitCode}, stdout_chars=${stdout.length}, stderr_chars=${stderr.length}).`,
                        structured,
                    );
                });
            } catch (error) {
                const message =
                    error instanceof AccessDeniedError || error instanceof Error
                        ? error.message
                        : String(error);
                return errorResult(message);
            }
        },
    );
}
