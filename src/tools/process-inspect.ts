import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProcessInfo, ProcessSessionManager } from "../lib/process-sessions.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

const processInfoSchema = z.object({
    processId: z.number().int(),
    name: z.string().optional(),
    command: z.string(),
    cwd: z.string(),
    running: z.boolean(),
    startedAt: z.number().int(),
    wallTimeMs: z.number(),
    exitCode: z.number().int().optional(),
    signal: z.string().optional(),
    bufferedChars: z.number().int(),
    outputTruncated: z.boolean(),
});

/** Register non-consuming process discovery/inspection for the current owner. */
export function registerProcessInspectTools(
    server: McpServer,
    processes: ProcessSessionManager,
): void {
    registerTool(
        server,
        "process_list",
        withToolAuth({
            title: "List managed processes",
            description:
                "List long-running processes visible to this stable process owner without consuming their output. Use this to recover processId handles after reconnecting.",
            inputSchema: {},
            outputSchema: {
                processes: z.array(processInfoSchema),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const items = processes.list().map(publicProcessInfo);
            return okResult(`Listed ${items.length} managed process(es).`, {
                processes: items,
            });
        },
    );

    registerTool(
        server,
        "process_status",
        withToolAuth({
            title: "Inspect managed process",
            description:
                "Return metadata for one managed process without consuming buffered stdout/stderr.",
            inputSchema: {
                processId: z.number().int().positive(),
            },
            outputSchema: processInfoSchema.shape,
            annotations: readOnlyAnnotations,
        }),
        async ({ processId }) => {
            try {
                const info = publicProcessInfo(processes.status(processId));
                return okResult(
                    `Process #${processId} is ${info.running ? "running" : "stopped"}.`,
                    { ...info },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    registerTool(
        server,
        "process_output",
        withToolAuth({
            title: "Peek managed process output",
            description:
                "Peek currently buffered stdout/stderr for a managed process without consuming it. write_stdin remains the consuming poll/interaction tool.",
            inputSchema: {
                processId: z.number().int().positive(),
                max_output_chars: z.number().int().positive().max(200_000).optional(),
            },
            outputSchema: {
                processId: z.number().int(),
                running: z.boolean(),
                exitCode: z.number().int().optional(),
                signal: z.string().optional(),
                wallTimeMs: z.number(),
                output: z.string(),
                outputTruncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ processId, max_output_chars: maxOutputChars }) => {
            try {
                const snapshot = processes.peek(processId, maxOutputChars);
                return okResult(
                    `Peeked ${snapshot.output.length} buffered character(s) from process #${processId}.`,
                    {
                        processId,
                        running: snapshot.running,
                        exitCode: snapshot.exitCode,
                        signal: snapshot.signal,
                        wallTimeMs: snapshot.wallTimeMs,
                        output: snapshot.output,
                        outputTruncated: snapshot.outputTruncated,
                    },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

function publicProcessInfo(info: ProcessInfo): ProcessInfo {
    return {
        ...info,
        command: clipOneLine(info.command, 1_000),
    };
}

function clipOneLine(value: string, maxChars: number): string {
    const oneLine = value.replace(/\s+/g, " ").trim();
    if (oneLine.length <= maxChars) return oneLine;
    return `${oneLine.slice(0, maxChars - 1)}…`;
}
