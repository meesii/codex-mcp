import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { terminateChildProcess } from "../lib/process-tree.js";
import { registerTool } from "../lib/tool-log.js";
import { destructiveAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";
import { commandShell } from "../lib/shell-command.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const MAX_CAPTURE_CHARS = 1_000_000;
const KILL_GRACE_MS = 2_000;

async function runShellCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
): Promise<{ stdout: string; stderr: string; exitCode: number | null; timedOut: boolean }> {
    const { file, args, isWindows } = commandShell(command);

    return new Promise((resolve, reject) => {
        const child = spawn(file, args, {
            cwd,
            stdio: ["ignore", "pipe", "pipe"],
            windowsHide: true,
            env: process.env,
            detached: !isWindows,
        });

        let stdout = "";
        let stderr = "";
        let timedOut = false;
        let closed = false;
        const timer = setTimeout(() => {
            timedOut = true;
            void terminateChildProcess(child, KILL_GRACE_MS, 1_000).catch((error) => {
                if (!closed) reject(error);
            });
        }, timeoutMs);
        timer.unref();

        const append = (target: "stdout" | "stderr", text: string): void => {
            if (target === "stdout") {
                if (stdout.length < MAX_CAPTURE_CHARS) {
                    stdout += text.slice(0, MAX_CAPTURE_CHARS - stdout.length);
                }
            } else if (stderr.length < MAX_CAPTURE_CHARS) {
                stderr += text.slice(0, MAX_CAPTURE_CHARS - stderr.length);
            }
        };

        child.stdout.on("data", (chunk: Buffer) => append("stdout", chunk.toString("utf8")));
        child.stderr.on("data", (chunk: Buffer) => append("stderr", chunk.toString("utf8")));
        child.on("error", (error) => {
            clearTimeout(timer);
            reject(error);
        });
        child.on("close", (code) => {
            closed = true;
            clearTimeout(timer);
            resolve({ stdout, stderr, exitCode: code, timedOut });
        });
    });
}

/** Register the `bash` tool. */
export function registerBashTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "bash",
        withToolAuth({
            title: "Run shell command",
            description:
                "Run a short foreground shell command in the project root and return its output (installs, tests, builds, git, scripts). Windows uses PowerShell; Unix uses bash. Prefer executing yourself over telling the user which command to run. Do NOT use this to read/search/edit source — use read/grep/glob/ls/edit/write. For long-running servers/watchers use exec_command.",
            inputSchema: {
                command: z.string().min(1).max(32_000).describe("Shell command in project root."),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .max(5 * 60_000)
                    .optional()
                    .describe("Optional timeout in milliseconds (default 60000, max 300000)."),
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
                    const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
                    const result = await runShellCommand(command, project.root, effectiveTimeout);
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
                                ? `timed out after ${effectiveTimeout}ms`
                                : `exit_code=${result.exitCode}`,
                            stderr ? `stderr_chars=${stderr.length}` : "",
                            stdout ? `stdout_chars=${stdout.length}` : "",
                        ]
                            .filter(Boolean)
                            .join(", ");
                        return {
                            ...errorResult(`Command failed (${detail}).`),
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
