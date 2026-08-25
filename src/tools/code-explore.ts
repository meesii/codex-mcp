import { extname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { collectFiles, readLinesSafe } from "../lib/search/file-walker.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

const SOURCE_EXTENSIONS = new Set([".dart", ".ts", ".tsx", ".js", ".jsx", ".py", ".go", ".rs", ".java", ".kt", ".swift", ".c", ".h", ".cc", ".cpp", ".hpp", ".cs", ".rb", ".php", ".vue", ".svelte", ".sql", ".sh"]);
const SYMBOL = /^\s*(?:export\s+)?(?:abstract\s+|final\s+|sealed\s+|static\s+|async\s+)*(class|mixin|enum|extension|typedef|interface|struct|func|function|def|fn)\s+([A-Za-z_][\w]*)/;

export function registerCodeExploreTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "code_explore", withToolAuth({
        title: "Explore code structure", description: "Outline source files under a directory with their top-level symbols.",
        inputSchema: { path: z.string().optional(), maxFiles: z.number().int().positive().max(500).optional() },
        outputSchema: { text: z.string(), root: z.string(), fileCount: z.number().int(), outline: z.array(z.object({ path: z.string(), lines: z.number().int(), symbols: z.array(z.string()) })) },
        annotations: readOnlyAnnotations,
    }), async ({ path, maxFiles }) => {
        try {
            const relative = path ?? ".";
            const { project } = scope();
            const files = await collectFiles(project.resolvePath(relative), maxFiles ?? 80, (value) => SOURCE_EXTENSIONS.has(extname(value).toLowerCase()));
            const outline: Array<{ path: string; lines: number; symbols: string[] }> = [];
            const rendered: string[] = [];
            for (const file of files) {
                const lines = await readLinesSafe(file.absolutePath);
                const symbols: string[] = [];
                for (let index = 0; index < lines.length && symbols.length < 12; index += 1) {
                    const match = SYMBOL.exec(lines[index]!);
                    if (match) symbols.push(`${match[1]} ${match[2]} (L${index + 1})`);
                }
                outline.push({ path: file.relativePath, lines: lines.length, symbols });
                rendered.push(`${file.relativePath}  ·  ${lines.length} lines`, ...symbols.map((symbol) => `    ${symbol}`));
            }
            const text = rendered.join("\n") || "(empty)";
            return okResult(text, { text, root: relative, fileCount: outline.length, outline });
        } catch (error) { return projectErrorResult(error); }
    });
}
