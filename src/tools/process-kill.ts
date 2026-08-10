import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProcessSessionManager } from "../lib/process-sessions.js";
import { registerTool } from "../lib/tool-log.js";
import { withToolAuth, writeAnnotations } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";

/**
 * Register `process_kill` to stop a background process by processId.
 *
 * @param server - MCP server
 * @param processes - Process session manager
 */
export function registerProcessKillTool(
    server: McpServer,
    processes: ProcessSessionManager,
): void {
    registerTool(
        server,
        "process_kill",
        withToolAuth({
            title: "Kill process",
            description:
                "Force-stop a background process started by exec_command (Codex has no separate kill tool; this is the explicit stop). Use when npm run dev / servers should shut down. Prefer this over hoping write_stdin Ctrl-C succeeds.",
            inputSchema: {
                processId: z
                    .number()
                    .int()
                    .positive()
                    .describe("processId returned by exec_command."),
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
            annotations: writeAnnotations,
        }),
        async ({ processId }) => {
            try {
                const snapshot = await processes.kill(processId);
                const output = truncateText(snapshot.output);
                const status = snapshot.running
                    ? `Kill signaled but processId=${processId} still appears running.`
                    : `Process ${processId} stopped (exit_code=${snapshot.exitCode ?? "null"}, signal=${snapshot.signal ?? "null"}).`;
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
