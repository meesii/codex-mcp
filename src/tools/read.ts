import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

const MAX_FILES = 20;
const MAX_LINES = 2_000;

export function registerReadTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "read", withToolAuth({
        title: "Read files",
        description: "Read one file with path, or several files with paths (max 20). Returns numbered lines. Read before changing code.",
        inputSchema: {
            path: z.string().optional(),
            paths: z.array(z.string()).max(MAX_FILES).optional(),
            offset: z.number().int().positive().optional(),
            limit: z.number().int().positive().max(MAX_LINES).optional(),
        },
        outputSchema: {
            text: z.string(),
            files: z.array(z.object({
                path: z.string(), found: z.boolean(), offset: z.number().int().optional(),
                lineCount: z.number().int().optional(), totalLines: z.number().int().optional(),
            })),
            truncated: z.boolean(),
        },
        annotations: readOnlyAnnotations,
    }), async ({ path, paths, offset, limit }) => {
        try {
            const targets = [
                ...(path?.trim() ? [path.trim()] : []),
                ...((paths ?? []).map((item: string) => item.trim()).filter(Boolean)),
            ];
            const unique = [...new Set(targets)].slice(0, MAX_FILES);
            if (unique.length === 0) return errorResult("path or paths is required");

            const { project } = scope();
            const start = offset ?? 1;
            const perFileLimit = limit ?? (unique.length === 1 ? MAX_LINES : 400);
            const rendered: string[] = [];
            const files: Array<Record<string, unknown>> = [];
            for (const target of unique) {
                const absolute = project.resolvePath(target);
                let raw: string;
                try {
                    raw = await readFile(absolute, "utf8");
                } catch (error) {
                    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
                    if (unique.length > 1) rendered.push(`=== ${target} (not found) ===`);
                    files.push({ path: target, found: false });
                    continue;
                }
                const lines = raw ? raw.replaceAll("\r\n", "\n").split("\n") : [];
                if (raw.endsWith("\n")) lines.pop();
                const startIndex = Math.min(start - 1, lines.length);
                const slice = lines.slice(startIndex, startIndex + perFileLimit);
                if (unique.length > 1) rendered.push(`=== ${target} ===`);
                rendered.push(...slice.map((line, index) => `${startIndex + index + 1}| ${line}`));
                files.push({ path: target, found: true, offset: startIndex + 1, lineCount: slice.length, totalLines: lines.length });
            }
            const text = rendered.join("\n") || "(empty)";
            const truncated = targets.length > MAX_FILES || files.some((file) =>
                file.found === true && Number(file.offset) - 1 + Number(file.lineCount) < Number(file.totalLines));
            return okResult(text, { text, files, truncated });
        } catch (error) {
            return projectErrorResult(error);
        }
    });
}
