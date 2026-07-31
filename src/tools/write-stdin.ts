import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ProcessSessionManager } from "../lib/process-sessions.js";
import { registerTool } from "../lib/tool-log.js";
import { destructiveAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";

/**
 * Register Codex-style `write_stdin` (poll / write to a processId).
 *
 * @param server - MCP server
 * @param processes - Process session manager
 */
export function registerWriteStdinTool(
    server: McpServer,
    processes: ProcessSessionManager,
): void {
    registerTool(
        server,
        "write_stdin",
        withNoAuth({
            title: "Write to / poll process",
            description:
                "Write characters to an existing exec_command process and/or return recent output (Codex write_stdin style). Omit chars (or empty) to only poll. Pass \\u0003 to send Ctrl-C. For hard stop prefer process_kill.",
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
                max_output_chars: z
                    .number()
                    .int()
                    .positive()
                    .max(200_000)
                    .optional()
                    .describe("Output character budget for this call."),
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
            processId,
            chars,
            yield_time_ms: yieldTimeMs,
            max_output_chars: maxOutputChars,
        }) => {
            try {
                const snapshot = await processes.poll({
                    processId,
                    chars,
                    yieldTimeMs,
                    maxOutputChars,
                });
                const output = truncateText(snapshot.output);
                const status = snapshot.running
                    ? `Process still running (processId=${snapshot.processId}).`
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
                const message = error instanceof Error ? error.message : String(error);
                return errorResult(message);
            }
        },
    );
}
