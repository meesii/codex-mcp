import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProcessSessionManager } from "../lib/process/sessions.js";
import { runtimeTelemetry } from "../lib/util/telemetry.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";

const latencyMetricSchema = z.object({
    calls: z.number().int().nonnegative(),
    errors: z.number().int().nonnegative(),
    p50Ms: z.number().nonnegative(),
    p95Ms: z.number().nonnegative(),
    maxMs: z.number().nonnegative(),
    lastAt: z.number().int().nonnegative().optional(),
});

const toolMetricSchema = latencyMetricSchema.extend({
    tool: z.string(),
    responseBytes: z.object({
        total: z.number().int().nonnegative(),
        average: z.number().int().nonnegative(),
        max: z.number().int().nonnegative(),
    }),
});

const downstreamServerMetricSchema = latencyMetricSchema.extend({
    server: z.string(),
});

export function registerRuntimeStatusTool(
    server: McpServer,
    processes: ProcessSessionManager,
): void {
    registerTool(
        server,
        "runtime_status",
        withToolAuth({
            title: "Runtime telemetry",
            description:
                "Return bounded aggregate runtime telemetry: tool/HTTP/downstream latency and errors, downstream cache/reconnect counters, and process counts/buffer usage. No arguments, commands, paths, response bodies, or credentials are retained.",
            inputSchema: {},
            outputSchema: {
                startedAt: z.number().int().nonnegative(),
                uptimeMs: z.number().nonnegative(),
                sampleWindow: z.number().int().positive(),
                tools: z.array(toolMetricSchema),
                http: latencyMetricSchema.extend({
                    requests: z.number().int().nonnegative(),
                    active: z.number().int().nonnegative(),
                    aborted: z.number().int().nonnegative(),
                    status4xx: z.number().int().nonnegative(),
                    status5xx: z.number().int().nonnegative(),
                }),
                downstream: latencyMetricSchema.extend({
                    cacheHits: z.number().int().nonnegative(),
                    cacheMisses: z.number().int().nonnegative(),
                    reconnects: z.number().int().nonnegative(),
                    byServer: z.array(downstreamServerMetricSchema),
                }),
                processes: z.object({
                    running: z.number().int().nonnegative(),
                    retained: z.number().int().nonnegative(),
                    bufferedChars: z.number().int().nonnegative(),
                    starts: z.number().int().nonnegative(),
                    completions: z.number().int().nonnegative(),
                    outputTruncations: z.number().int().nonnegative(),
                }),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const snapshot = runtimeTelemetry.snapshot(processes.runtimeStats());
            return okResult(
                `Runtime telemetry: ${snapshot.http.requests} MCP HTTP request(s), ${snapshot.tools.length} observed tool(s).`,
                { ...snapshot },
            );
        },
    );
}
