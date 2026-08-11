import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";

export function registerSummaryTool(server: McpServer): void {
    registerTool(
        server,
        "summary",
        withToolAuth({
            title: "Summarize progress",
            description:
                "Mid-task progress for the user. Use instead of chat text. done=false while work remains (include next); done=true only when the full task is finished.",
            inputSchema: {
                summary: z.string().min(1).describe("What was just completed."),
                next: z
                    .string()
                    .optional()
                    .describe("Next step when done is false."),
                done: z
                    .boolean()
                    .optional()
                    .describe("true only when the full task is finished."),
            },
            outputSchema: {
                summary: z.string(),
                next: z.string().nullable(),
                done: z.boolean(),
                continueWorking: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ summary, next, done }) => {
            const finished = done === true;
            const nextStep = next?.trim() ? next.trim() : null;
            if (!finished && !nextStep) {
                return errorResult("next is required when done=false");
            }
            const structured = {
                summary: summary.trim(),
                next: nextStep,
                done: finished,
                continueWorking: !finished,
            };

            if (finished) {
                return okResult(
                    "done=true. Brief final chat reply is allowed. Stop calling Codex-MCP unless the user asks for more.",
                    structured,
                );
            }

            return okResult(
                `done=false. Do not end the turn or write chat. Call a Codex-MCP tool now${nextStep ? `: ${nextStep}` : ""}.`,
                structured,
            );
        },
    );
}
