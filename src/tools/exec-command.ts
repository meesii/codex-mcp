import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PermissionManager } from "../permissions/manager.js";
import { registerTool } from "../lib/tool/log.js";
import { destructiveAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { formatOutput, OUTPUT_MODES, type OutputMode } from "../lib/tool/output-mode.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

const DEFAULT_OUTPUT_CHARS = 12_000;

export function registerExecCommandTool(
    server: McpServer,
    scope: ToolScopeProvider,
    permissions: PermissionManager,
): void {
    registerTool(
        server,
        "exec_command",
        withToolAuth({
            title: "Execute command",
            description:
                "Run a command in the primary workspace or an optional workspace-relative/absolute cwd, returning bounded output or a processId for ongoing interaction. An external cwd triggers lightweight user approval; in-workspace commands remain frictionless. Prefer this over bash for servers/watchers. Do NOT use this to read or edit source files.",
            inputSchema: {
                command: z
                    .string()
                    .min(1)
                    .describe("Shell command to execute. Windows: PowerShell; Unix: bash."),
                cwd: z
                    .string()
                    .optional()
                    .describe("Optional workspace-relative or absolute working directory."),
                name: z
                    .string()
                    .min(1)
                    .max(64)
                    .optional()
                    .describe("Optional short label used by process_list/status."),
                yield_time_ms: z
                    .number()
                    .int()
                    .min(0)
                    .max(30_000)
                    .optional()
                    .describe(
                        "Max time to wait before returning a processId for a still-running command. Finished commands return immediately. Default 10000 ms (range 0-30000).",
                    ),
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
                    .describe("Output character budget (default 12000)."),
            },
            outputSchema: {
                processId: z.number().int().optional(),
                running: z.boolean(),
                exitCode: z.number().int().optional(),
                signal: z.string().optional(),
                wallTimeMs: z.number(),
                output: z.string(),
                outputMode: z.enum(OUTPUT_MODES),
                outputTruncated: z.boolean(),
            },
            annotations: destructiveAnnotations,
        }),
        async ({
            command,
            cwd,
            name,
            yield_time_ms: yieldTimeMs,
            output_mode: outputMode,
            max_output_chars: maxOutputChars,
        }) => {
            try {
                const { project, processes } = scope();
                const effectiveCwd = project.resolveExternalPath(cwd ?? ".");
                await permissions.authorize({
                    capability: "exec",
                    targets: [effectiveCwd],
                    scope: effectiveCwd,
                    reason: `在 ${cwd ?? "."} 执行长时命令`,
                });
                const effectiveMode: OutputMode = outputMode ?? "summary";
                const effectiveMaxChars = maxOutputChars ?? DEFAULT_OUTPUT_CHARS;
                const snapshot = await processes.start({
                    command,
                    cwd: effectiveCwd,
                    ...(name ? { name } : {}),
                    yieldTimeMs,
                    maxOutputChars: effectiveMaxChars,
                });
                const formatted = formatOutput(snapshot.output, effectiveMode, effectiveMaxChars);
                const output = formatted.text;
                const status = snapshot.running
                    ? `Process running with processId=${snapshot.processId}. Use write_stdin to poll or process_kill to stop.`
                    : snapshot.signal
                      ? `Process exited after signal ${snapshot.signal}.`
                      : `Process exited with code ${snapshot.exitCode ?? "unknown"}.`;
                const text = output ? `${output}\n${status}` : status;
                const structured = {
                    processId: snapshot.processId,
                    running: snapshot.running,
                    exitCode: snapshot.exitCode,
                    signal: snapshot.signal,
                    wallTimeMs: snapshot.wallTimeMs,
                    output,
                    outputMode: effectiveMode,
                    outputTruncated: snapshot.outputTruncated || formatted.truncated,
                };
                const failed =
                    !snapshot.running &&
                    (snapshot.signal !== undefined ||
                        (snapshot.exitCode !== undefined && snapshot.exitCode !== 0));
                if (failed) {
                    return {
                        ...errorResult(text),
                        structuredContent: structured,
                    };
                }
                return okResult(text, structured);
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );
}
