import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcessSessionManager } from "../lib/process-sessions.js";
import { registerTool } from "../lib/tool-log.js";
import { destructiveAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";

/**
 * Register Codex-style `exec_command` (supports long-running processId).
 *
 * @param server - MCP server
 * @param project - Bound project context
 * @param processes - Process session manager
 */
export function registerExecCommandTool(
    server: McpServer,
    project: ProjectContext,
    processes: ProcessSessionManager,
): void {
    registerTool(
        server,
        "exec_command",
        withNoAuth({
            title: "Execute command",
            description:
                "Run a command in the project root, returning output or a processId for ongoing interaction (Codex exec_command style). Short commands finish in one call. Long-running commands (npm run dev, watchers) return processId while still running — then write_stdin to poll/write stdin, process_kill to stop. Prefer this over bash for servers/watchers. Windows: PowerShell; Unix: bash. Do NOT use this to read or edit source files.",
            inputSchema: {
                command: z
                    .string()
                    .min(1)
                    .describe(
                        "Shell command to execute (cwd is project root). Windows: PowerShell; Unix: bash.",
                    ),
                yield_time_ms: z
                    .number()
                    .int()
                    .min(0)
                    .max(30_000)
                    .optional()
                    .describe(
                        "Max time to wait before returning a processId for a still-running command. Finished commands return immediately. Default 10000 ms (range 0-30000).",
                    ),
                max_output_chars: z
                    .number()
                    .int()
                    .positive()
                    .max(200_000)
                    .optional()
                    .describe("Output character budget (default 40000)."),
            },
            outputSchema: {
                processId: z.number().int().optional(),
                running: z.boolean(),
                exitCode: z.number().int().optional(),
                signal: z.string().optional(),
                wallTimeMs: z.number(),
                output: z.string(),
                outputTruncated: z.boolean(),
            },
            annotations: destructiveAnnotations,
        }),
        async ({
            command,
            yield_time_ms: yieldTimeMs,
            max_output_chars: maxOutputChars,
        }) => {
            try {
                const snapshot = await processes.start({
                    command,
                    cwd: project.root,
                    yieldTimeMs,
                    maxOutputChars,
                });
                const output = truncateText(snapshot.output);
                const status = snapshot.running
                    ? `Process running with processId=${snapshot.processId}. Use write_stdin to poll or process_kill to stop.`
                    : snapshot.signal
                      ? `Process exited after signal ${snapshot.signal}.`
                      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
                const text = output ? `${output}\n${status}` : status;

                return okResult(text, {
                    processId: snapshot.processId,
                    running: snapshot.running,
                    exitCode: snapshot.exitCode,
                    signal: snapshot.signal,
                    wallTimeMs: snapshot.wallTimeMs,
                    output,
                    outputTruncated: snapshot.outputTruncated,
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
