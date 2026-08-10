import { createReadStream } from "node:fs";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

const MAX_READ_CHARS = 80_000;
const MAX_LINE_LIMIT = 10_000;
const MAX_READ_MANY_FILES = 20;
const MAX_READ_MANY_TOTAL_CHARS = 160_000;

interface ReadSlice {
    content: string;
    lineCount: number;
    truncated: boolean;
}

/**
 * Stream only the requested line range and preserve original line endings so
 * copied multi-line text can be passed back to exact-match `edit` on CRLF files.
 */
export async function readTextSlice(
    path: string,
    offset = 1,
    limit?: number,
): Promise<ReadSlice> {
    const stream = createReadStream(path, {
        encoding: "utf8",
        highWaterMark: 64 * 1024,
    });
    let pending = "";
    let currentLine = 1;
    let lineCount = 0;
    let output = "";
    let truncated = false;
    let done = false;

    const consumeLine = (text: string): void => {
        if (currentLine >= offset && (limit === undefined || lineCount < limit)) {
            lineCount += 1;
            const remaining = MAX_READ_CHARS - output.length;
            if (text.length > remaining) {
                output += text.slice(0, Math.max(remaining, 0));
                truncated = true;
                done = true;
            } else {
                output += text;
                if (limit !== undefined && lineCount >= limit) done = true;
            }
        }
        currentLine += 1;
    };

    outer: for await (const chunk of stream) {
        pending += String(chunk);
        let newlineIndex: number;
        while ((newlineIndex = pending.indexOf("\n")) >= 0) {
            const line = pending.slice(0, newlineIndex + 1);
            pending = pending.slice(newlineIndex + 1);
            consumeLine(line);
            if (done) break outer;
        }
    }

    if (!done && pending.length > 0) {
        consumeLine(pending);
    }

    if (truncated) {
        output += "\n[truncated: read output limit reached]";
    }
    return { content: output, lineCount, truncated };
}

/** Register the `read` tool. */
export function registerReadTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "read",
        withToolAuth({
            title: "Read file",
            description:
                "Read a project file before changing or explaining it. File text is in structuredContent.content and original LF/CRLF line endings are preserved. Prefer this over bash cat/type/Get-Content.",
            inputSchema: {
                path: z.string().describe("File path relative to the project root."),
                offset: z
                    .number()
                    .int()
                    .positive()
                    .optional()
                    .describe("1-indexed line number to start from."),
                limit: z
                    .number()
                    .int()
                    .positive()
                    .max(MAX_LINE_LIMIT)
                    .optional()
                    .describe(`Maximum number of lines to return (max ${MAX_LINE_LIMIT}).`),
            },
            outputSchema: {
                path: z.string(),
                content: z.string(),
                offset: z.number().int(),
                lineCount: z.number().int(),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path: filePath, offset, limit }) => {
            try {
                const absolutePath = project.resolvePath(filePath);
                const slice = await readTextSlice(absolutePath, offset ?? 1, limit);
                return okResult(`Read ${filePath} (${slice.lineCount} lines).`, {
                    path: filePath,
                    content: slice.content,
                    offset: offset ?? 1,
                    lineCount: slice.lineCount,
                    truncated: slice.truncated,
                });
            } catch (error) {
                const message =
                    error instanceof AccessDeniedError || error instanceof Error
                        ? error.message
                        : String(error);
                return errorResult(message);
            }
        },
    );
}

/** Register a bounded batch read tool for related project files. */
export function registerReadManyTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "read_many",
        withToolAuth({
            title: "Read multiple files",
            description:
                "Read up to 20 project files in one call. Each item supports the same line offset/limit as read; failures are reported per file so one missing file does not discard the rest.",
            inputSchema: {
                files: z
                    .array(
                        z.object({
                            path: z.string(),
                            offset: z.number().int().positive().optional(),
                            limit: z.number().int().positive().max(MAX_LINE_LIMIT).optional(),
                        }),
                    )
                    .min(1)
                    .max(MAX_READ_MANY_FILES),
            },
            outputSchema: {
                files: z.array(
                    z.object({
                        path: z.string(),
                        content: z.string(),
                        offset: z.number().int(),
                        lineCount: z.number().int(),
                        truncated: z.boolean(),
                        error: z.string().nullable(),
                    }),
                ),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ files }) => {
            let remainingChars = MAX_READ_MANY_TOTAL_CHARS;
            let batchTruncated = false;
            const results: Array<{
                path: string;
                content: string;
                offset: number;
                lineCount: number;
                truncated: boolean;
                error: string | null;
            }> = [];

            for (const item of files) {
                const effectiveOffset = item.offset ?? 1;
                try {
                    const absolutePath = project.resolvePath(item.path);
                    const slice = await readTextSlice(absolutePath, effectiveOffset, item.limit);
                    let content = slice.content;
                    let truncated = slice.truncated;
                    if (content.length > remainingChars) {
                        content = content.slice(0, Math.max(0, remainingChars));
                        truncated = true;
                        batchTruncated = true;
                    }
                    remainingChars = Math.max(0, remainingChars - content.length);
                    results.push({
                        path: item.path,
                        content,
                        offset: effectiveOffset,
                        lineCount: slice.lineCount,
                        truncated,
                        error: null,
                    });
                    if (remainingChars === 0) batchTruncated = true;
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    results.push({
                        path: item.path,
                        content: "",
                        offset: effectiveOffset,
                        lineCount: 0,
                        truncated: false,
                        error: message,
                    });
                }
            }

            const errors = results.filter((item) => item.error !== null).length;
            return okResult(
                `Read ${results.length - errors}/${results.length} file(s)${batchTruncated ? " (truncated)" : ""}.`,
                { files: results, truncated: batchTruncated },
            );
        },
    );
}
