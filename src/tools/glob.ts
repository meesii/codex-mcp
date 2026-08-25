import { Minimatch } from "minimatch";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { collectFiles } from "../lib/search/file-walker.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

export function registerGlobTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "glob", withToolAuth({
        title: "Find files by glob", description: "Find files by glob pattern, e.g. **/*.ts.",
        inputSchema: { pattern: z.string().min(1), path: z.string().optional(), maxResults: z.number().int().positive().max(5_000).optional() },
        outputSchema: { text: z.string(), count: z.number().int(), files: z.array(z.string()) },
        annotations: readOnlyAnnotations,
    }), async ({ pattern, path, maxResults }) => {
        try {
            const { project } = scope();
            const root = project.resolvePath(path ?? ".");
            const matcher = new Minimatch(pattern, { dot: true, nocase: process.platform === "win32" });
            const files = (await collectFiles(root, maxResults ?? 500, (value) => matcher.match(value))).map((item) => item.relativePath);
            const text = files.join("\n") || "(empty)";
            return okResult(text, { text, count: files.length, files });
        } catch (error) { return projectErrorResult(error); }
    });
}
