import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProcessInfo, ProcessSessionAccess } from "../lib/process/sessions.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { formatOutput, OUTPUT_MODES, type OutputMode } from "../lib/tool/output-mode.js";

const DEFAULT_OUTPUT_CHARS = 12_000;
const PROCESS_CAPTURE_CHARS = 200_000;

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

export function registerProcessInspectTools(
    server: McpServer,
    processes: ProcessSessionAccess,
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
                processId: z.number().int(),
                running: z.boolean(),
                exitCode: z.number().int().optional(),
                signal: z.string().optional(),
                wallTimeMs: z.number(),
                output: z.string(),
                outputMode: z.enum(OUTPUT_MODES),
                outputTruncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ processId, output_mode: outputMode, max_output_chars: maxOutputChars }) => {
            try {
                const effectiveMode: OutputMode = outputMode ?? "summary";
                const effectiveMaxChars = maxOutputChars ?? DEFAULT_OUTPUT_CHARS;
                const snapshot = processes.peek(processId, PROCESS_CAPTURE_CHARS);
                const formatted = formatOutput(snapshot.output, effectiveMode, effectiveMaxChars);
                return okResult(
                    `Peeked process #${processId} output (mode=${effectiveMode}${snapshot.outputTruncated || formatted.truncated ? ", truncated" : ""}).`,
                    {
                        processId,
                        running: snapshot.running,
                        exitCode: snapshot.exitCode,
                        signal: snapshot.signal,
                        wallTimeMs: snapshot.wallTimeMs,
                        output: formatted.text,
                        outputMode: effectiveMode,
                        outputTruncated: snapshot.outputTruncated || formatted.truncated,
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
