import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { destructiveAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { formatOutput, OUTPUT_MODES, type OutputMode } from "../lib/tool/output-mode.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

const DEFAULT_OUTPUT_CHARS = 12_000;
const PROCESS_CAPTURE_CHARS = 200_000;

export function registerWriteStdinTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(
        server,
        "write_stdin",
        withToolAuth({
            title: "Write to / poll process",
            description:
                "Write characters to an existing exec_command process and/or return recent output (Codex write_stdin style). Omit chars (or empty) to only poll. On Unix, \\u0003 sends SIGINT to the process group; on Windows it force-stops the process tree. For an explicit hard stop prefer process_kill.",
            inputSchema: {
                processId: z
                    .number()
                    .int()
                    .positive()
                    .describe("Identifier of the running process from exec_command."),
                chars: z
                    .string()
                    .optional()
                    .describe("Characters to write to stdin. Omit/empty to poll only."),
                yield_time_ms: z
                    .number()
                    .int()
                    .min(0)
                    .max(30_000)
                    .optional()
                    .describe("Wait for more output before returning (default poll 5000 ms)."),
                output_mode: z
                    .enum(OUTPUT_MODES)
                    .optional()
                    .describe("Output selection: summary (default), tail, head_tail, or full."),
                max_output_chars: z
                    .number()
                    .int()
                    .positive()
                    .max(200_000)
                    .optional()
                    .describe("Returned output character budget (default 12000)."),
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
            processId,
            chars,
            yield_time_ms: yieldTimeMs,
            output_mode: outputMode,
            max_output_chars: maxOutputChars,
        }) => {
            try {
                const { processes } = scope();
                const effectiveMode: OutputMode = outputMode ?? "summary";
                const effectiveMaxChars = maxOutputChars ?? DEFAULT_OUTPUT_CHARS;
                const snapshot = await processes.poll({
                    processId,
                    chars,
                    yieldTimeMs,
                    maxOutputChars: PROCESS_CAPTURE_CHARS,
                });
                const formatted = formatOutput(snapshot.output, effectiveMode, effectiveMaxChars);
                const output = formatted.text;
                const status = snapshot.running
                    ? `Process still running (processId=${snapshot.processId}).`
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
