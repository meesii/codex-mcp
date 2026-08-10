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
