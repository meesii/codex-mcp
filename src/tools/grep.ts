import { Minimatch } from "minimatch";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { collectFiles, readLinesSafe } from "../lib/search/file-walker.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

export function registerGrepTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "grep", withToolAuth({
        title: "Search file contents",
        description: "Search file contents by regex. Use include to narrow by glob.",
        inputSchema: {
            pattern: z.string().min(1), path: z.string().optional(), include: z.string().optional(),
            maxResults: z.number().int().positive().max(1_000).optional(), caseSensitive: z.boolean().optional(),
        },
        outputSchema: {
            text: z.string(), matchCount: z.number().int(), truncated: z.boolean(),
            matches: z.array(z.object({ path: z.string(), line: z.number().int(), text: z.string() })),
        },
        annotations: readOnlyAnnotations,
    }), async ({ pattern, path, include, maxResults, caseSensitive }) => {
        try {
            let regex: RegExp;
            try { regex = new RegExp(pattern, caseSensitive === false ? "i" : undefined); }
            catch (error) { return errorResult(`Invalid regex: ${String(error)}`); }
            const { project } = scope();
            const root = project.resolvePath(path ?? ".");
            const includeMatcher = include ? new Minimatch(include, { dot: true }) : undefined;
            const limit = maxResults ?? 100;
            const matches: Array<{ path: string; line: number; text: string }> = [];
            for (const file of await collectFiles(root, 50_000, includeMatcher ? (value) => includeMatcher.match(value) : undefined)) {
                const lines = await readLinesSafe(file.absolutePath);
                for (let index = 0; index < lines.length; index += 1) {
                    if (!regex.test(lines[index]!)) continue;
                    matches.push({ path: file.relativePath, line: index + 1, text: lines[index]!.slice(0, 240) });
                    if (matches.length >= limit) break;
                }
                if (matches.length >= limit) break;
            }
            const text = matches.map((item) => `${item.path}:${item.line}: ${item.text}`).join("\n") || "(empty)";
            return okResult(text, { text, matchCount: matches.length, truncated: matches.length >= limit, matches });
        } catch (error) { return projectErrorResult(error); }
    });
}
