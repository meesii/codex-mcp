import { spawn } from "node:child_process";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../config/project.js";
import { AccessDeniedError } from "../config/project.js";
import { terminateChildProcess } from "../lib/process/tree.js";
import { registerTool } from "../lib/tool/log.js";
import { destructiveAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { formatOutput, OUTPUT_MODES, type OutputMode } from "../lib/tool/output-mode.js";
import { commandShell } from "../lib/process/shell-command.js";

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_OUTPUT_CHARS = 12_000;
const MAX_CAPTURE_CHARS = 1_000_000;
const KILL_GRACE_MS = 2_000;

async function runShellCommand(
    command: string,
    cwd: string,
    timeoutMs: number,
): Promise<{
    stdout: string;
    stderr: string;
    stdoutChars: number;
    stderrChars: number;
    captureTruncated: boolean;
    exitCode: number | null;
    timedOut: boolean;
}> {
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
        let stdoutChars = 0;
        let stderrChars = 0;
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
                stdoutChars += text.length;
                if (stdout.length < MAX_CAPTURE_CHARS) {
                    stdout += text.slice(0, MAX_CAPTURE_CHARS - stdout.length);
                }
            } else {
                stderrChars += text.length;
                if (stderr.length < MAX_CAPTURE_CHARS) {
                    stderr += text.slice(0, MAX_CAPTURE_CHARS - stderr.length);
                }
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
            resolve({
                stdout,
                stderr,
                stdoutChars,
                stderrChars,
                captureTruncated: stdoutChars > stdout.length || stderrChars > stderr.length,
                exitCode: code,
                timedOut,
            });
        });
    });
}

export function registerBashTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "bash",
        withToolAuth({
            title: "Run shell command",
            description:
                "Run a short foreground shell command in project_root or an optional guarded project-relative cwd. Output defaults to a compact summary/tail budget; request tail, head_tail, or full when needed. Windows uses PowerShell; Unix uses bash. Do NOT use this to read/search/edit source — use read/grep/glob/ls/edit/apply_patch/write. For long-running servers/watchers use exec_command.",
            inputSchema: {
                command: z.string().min(1).max(32_000).describe("Shell command to run."),
                cwd: z
                    .string()
                    .optional()
                    .describe("Optional working directory relative to project_root."),
                timeout_ms: z
                    .number()
                    .int()
                    .positive()
                    .max(5 * 60_000)
                    .optional()
                    .describe("Optional timeout in milliseconds (default 60000, max 300000)."),
                output_mode: z
                    .enum(OUTPUT_MODES)
                    .optional()
                    .describe("Output selection: summary (default), tail, head_tail, or full."),
                max_output_chars: z
                    .number()
                    .int()
                    .min(256)
                    .max(200_000)
                    .optional()
                    .describe("Per-stream output budget after capture (default 12000)."),
            },
            outputSchema: {
                stdout: z.string(),
                stderr: z.string(),
                stdoutChars: z.number().int(),
                stderrChars: z.number().int(),
                outputMode: z.enum(OUTPUT_MODES),
                outputTruncated: z.boolean(),
                exitCode: z.number().nullable(),
                timedOut: z.boolean(),
            },
            annotations: destructiveAnnotations,
        }),
        async ({
            command,
            cwd,
            timeout_ms: timeoutMs,
            output_mode: outputMode,
            max_output_chars: maxOutputChars,
        }) => {
            try {
                return await project.lock.runExclusive(async () => {
                    const effectiveTimeout = timeoutMs ?? DEFAULT_TIMEOUT_MS;
                    const effectiveCwd = project.resolvePath(cwd ?? ".");
                    const effectiveMode: OutputMode = outputMode ?? "summary";
                    const effectiveMaxChars = maxOutputChars ?? DEFAULT_OUTPUT_CHARS;
                    const result = await runShellCommand(command, effectiveCwd, effectiveTimeout);
                    const stdoutResult = formatOutput(result.stdout, effectiveMode, effectiveMaxChars);
                    const stderrResult = formatOutput(result.stderr, effectiveMode, effectiveMaxChars);
                    const stdout = stdoutResult.text;
                    const stderr = stderrResult.text;
                    const structured = {
                        stdout,
                        stderr,
                        stdoutChars: result.stdoutChars,
                        stderrChars: result.stderrChars,
                        outputMode: effectiveMode,
                        outputTruncated:
                            result.captureTruncated || stdoutResult.truncated || stderrResult.truncated,
                        exitCode: result.exitCode,
                        timedOut: result.timedOut,
                    };

                    if (result.timedOut || (result.exitCode !== 0 && result.exitCode !== null)) {
                        const detail = [
                            result.timedOut
                                ? `timed out after ${effectiveTimeout}ms`
                                : `exit_code=${result.exitCode}`,
                            result.stderrChars ? `stderr_chars=${result.stderrChars}` : "",
                            result.stdoutChars ? `stdout_chars=${result.stdoutChars}` : "",
                        ]
                            .filter(Boolean)
                            .join(", ");
                        return {
                            ...errorResult(`Command failed (${detail}).`),
                            structuredContent: structured,
                        };
                    }

                    return okResult(
                        `Command finished (exit_code=${result.exitCode}, stdout_chars=${result.stdoutChars}, stderr_chars=${result.stderrChars}, output_mode=${effectiveMode}${structured.outputTruncated ? ", truncated" : ""}).`,
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
