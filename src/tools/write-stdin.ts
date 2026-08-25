import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { destructiveAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

export function registerWriteStdinTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "write_stdin", withToolAuth({
        title: "Continue command", description: "Poll a running exec_command session and optionally send stdin. Use \\u0003 in chars to send Ctrl+C.",
        inputSchema: {
            session_id: z.number().int().positive(), chars: z.string().optional(),
            yield_time_ms: z.number().int().min(0).max(30_000).optional(),
            max_output_tokens: z.number().int().positive().max(50_000).optional(),
        },
        outputSchema: {
            text: z.string(), session_id: z.number().int(), running: z.boolean(),
            output_truncated: z.boolean(), exit_code: z.number().int().optional(),
        },
        annotations: destructiveAnnotations,
    }), async ({ session_id: sessionId, chars, yield_time_ms: yieldTimeMs, max_output_tokens: maxOutputTokens }) => {
        try {
            const { processes } = scope();
            const snapshot = await processes.poll({
                processId: sessionId, chars, yieldTimeMs,
                maxOutputChars: maxOutputTokens ? maxOutputTokens * 4 : undefined,
            });
            const text = snapshot.output || (snapshot.running ? "(running, no new output)" : "(command completed with no output)");
            return okResult(text, {
                text, session_id: sessionId, running: snapshot.running,
                output_truncated: snapshot.outputTruncated,
                ...(snapshot.exitCode === undefined ? {} : { exit_code: snapshot.exitCode }),
            });
        } catch (error) { return projectErrorResult(error); }
    });
}
