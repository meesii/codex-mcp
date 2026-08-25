import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { destructiveAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

export function registerExecCommandTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "exec_command", withToolAuth({
        title: "Execute command",
        description: "Run shell commands for tests, builds, git, package managers, and other CLI operations. Do not use shell redirection or shell file-writing commands to edit source files; use apply_patch instead. If still running after yield_time_ms, returns a session_id for write_stdin.",
        inputSchema: {
            cmd: z.string().min(1), workdir: z.string().optional(),
            yield_time_ms: z.number().int().min(0).max(30_000).optional(),
            max_output_tokens: z.number().int().positive().max(50_000).optional(),
        },
        outputSchema: {
            text: z.string(), session_id: z.number().int().optional(), running: z.boolean(),
            output_truncated: z.boolean(), exit_code: z.number().int().optional(),
        },
        annotations: destructiveAnnotations,
    }), async ({ cmd, workdir, yield_time_ms: yieldTimeMs, max_output_tokens: maxOutputTokens }) => {
        try {
            const { project, processes } = scope();
            const snapshot = await processes.start({
                command: cmd, cwd: project.resolvePath(workdir ?? "."), yieldTimeMs,
                maxOutputChars: maxOutputTokens ? maxOutputTokens * 4 : undefined,
            });
            const text = snapshot.output || (snapshot.running ? "(running, no new output)" : "(command completed with no output)");
            return okResult(text, {
                text, ...(snapshot.processId === undefined ? {} : { session_id: snapshot.processId }),
                running: snapshot.running, output_truncated: snapshot.outputTruncated,
                ...(snapshot.exitCode === undefined ? {} : { exit_code: snapshot.exitCode }),
            });
        } catch (error) { return projectErrorResult(error); }
    });
}
