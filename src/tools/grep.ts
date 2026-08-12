import { readdir, stat } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../config/project.js";
import { AccessDeniedError } from "../config/project.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { findRipgrep } from "../lib/search/ripgrep.js";
import { structuredSearch, type StructuredSearchMatch } from "../lib/search/structured.js";

const MAX_WALK_FILES = 50_000;
const MAX_FALLBACK_FILE_BYTES = 2 * 1024 * 1024;
const MAX_COLLECTED_MATCHES = 1_000;
const MAX_RETURNED_MATCHES = 200;
const MAX_FALLBACK_RUNTIME_MS = 5_000;

const REGEX_GREP_WORKER_SOURCE = `
const { parentPort, workerData } = require("node:worker_threads");
const { readFile, stat } = require("node:fs/promises");
const { relative } = require("node:path");
(async () => {
    const regex = new RegExp(workerData.pattern, workerData.caseInsensitive ? "i" : undefined);
    const hits = [];
    let truncated = workerData.walkTruncated === true;
    for (const file of workerData.files) {
        const info = await stat(file).catch(() => null);
        if (!info || !info.isFile() || info.size > workerData.maxFileBytes) continue;
        let content;
        try { content = await readFile(file, "utf8"); } catch { continue; }
        const lines = content.split(/\\r?\\n/);
        for (let index = 0; index < lines.length; index += 1) {
            if (!regex.test(lines[index])) continue;
            hits.push(relative(workerData.root, file).replaceAll("\\\\", "/") + ":" + (index + 1) + ":" + lines[index]);
            if (hits.length >= workerData.maxMatches) {
                truncated = true;
                parentPort.postMessage({ matches: hits, truncated });
                return;
            }
        }
    }
    parentPort.postMessage({ matches: hits, truncated });
})().catch((error) => parentPort.postMessage({ error: error instanceof Error ? error.message : String(error) }));
`;

async function walkFiles(current: string, out: string[]): Promise<boolean> {
    const entries = await readdir(current, { withFileTypes: true });
    for (const entry of entries) {
        if (entry.name === "node_modules" || entry.name === ".git") continue;
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
            if (await walkFiles(full, out)) return true;
        } else if (entry.isFile()) {
            out.push(full);
            if (out.length >= MAX_WALK_FILES) return true;
        }
    }
    return false;
}

export async function runFallbackRegexGrep(
    root: string,
    scope: string,
    pattern: string,
    caseInsensitive: boolean,
    timeoutMs = MAX_FALLBACK_RUNTIME_MS,
): Promise<{ matches: string[]; truncated: boolean }> {
    const info = await stat(scope);
    const files: string[] = [];
    let walkTruncated = false;
    if (info.isFile()) {
        files.push(scope);
    } else if (info.isDirectory()) {
        walkTruncated = await walkFiles(scope, files);
    } else {
        throw new Error(`Invalid path: ${scope}`);
    }

    return await new Promise<{ matches: string[]; truncated: boolean }>((resolve, reject) => {
        const worker = new Worker(REGEX_GREP_WORKER_SOURCE, {
            eval: true,
            workerData: {
                root,
                files,
                pattern,
                caseInsensitive,
                walkTruncated,
                maxFileBytes: MAX_FALLBACK_FILE_BYTES,
                maxMatches: MAX_COLLECTED_MATCHES,
            },
        });
        let settled = false;
        const finish = (
            result: { matches: string[]; truncated: boolean } | Error,
        ): void => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            void worker.terminate();
            if (result instanceof Error) reject(result);
            else resolve(result);
        };
        const timer = setTimeout(() => {
            finish(
                new Error(
                    `Fallback regex search timed out after ${timeoutMs}ms; install ripgrep or simplify the pattern`,
                ),
            );
        }, timeoutMs);
        timer.unref();
        worker.once("message", (message: unknown) => {
            const result = message as {
                matches?: unknown;
                truncated?: unknown;
                error?: unknown;
            };
            if (typeof result.error === "string") {
                finish(new Error(result.error));
                return;
            }
            if (!Array.isArray(result.matches) || typeof result.truncated !== "boolean") {
                finish(new Error("Invalid fallback grep worker response"));
                return;
            }
            finish({
                matches: result.matches.filter((item): item is string => typeof item === "string"),
                truncated: result.truncated,
            });
        });
        worker.once("error", (error) => finish(error));
        worker.once("exit", (code) => {
            if (!settled && code !== 0) {
                finish(new Error(`Fallback grep worker exited with code ${code}`));
            }
        });
    });
}

export function registerGrepTool(server: McpServer, project: ProjectContext): void {
    const matchSchema = z.object({
        path: z.string(),
        line: z.number().int(),
        column: z.number().int(),
        text: z.string(),
        kind: z.enum(["match", "context"]),
    });

    registerTool(
        server,
        "grep",
        withToolAuth({
            title: "Search file contents",
            description:
                "Structured ripgrep-style regex search across workspace-relative or absolute paths, including directories outside registered workspaces without approval. Returns file/line/column/text records with include/exclude globs, context, and result limits.",
            inputSchema: {
                pattern: z
                    .string()
                    .min(1)
                    .max(4096)
                    .describe("Regular expression pattern to search for."),
                path: z
                    .string()
                    .optional()
                    .describe("Optional subdirectory or file relative to project root."),
                case_insensitive: z
                    .boolean()
                    .optional()
                    .describe("When true, search case-insensitively."),
                glob: z
                    .union([z.string(), z.array(z.string()).max(50)])
                    .optional()
                    .describe("Include glob pattern or patterns."),
                exclude: z
                    .union([z.string(), z.array(z.string()).max(50)])
                    .optional()
                    .describe("Exclude glob pattern or patterns."),
                max_results: z
                    .number()
                    .int()
                    .min(1)
                    .max(1_000)
                    .optional()
                    .describe("Maximum returned result records/files (default 200)."),
                before_context: z.number().int().min(0).max(20).optional(),
                after_context: z.number().int().min(0).max(20).optional(),
                files_only: z
                    .boolean()
                    .optional()
                    .describe("Return only unique matching file paths in structuredContent.files."),
            },
            outputSchema: {
                matchCount: z.number().int(),
                matches: z.array(matchSchema),
                files: z.array(z.string()),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({
            pattern,
            path: scopePath,
            case_insensitive: caseInsensitive,
            glob,
            exclude,
            max_results: maxResults,
            before_context: beforeContext,
            after_context: afterContext,
            files_only: filesOnly,
        }) => {
            try {
                const scopedAbsolute = project.resolveReadPath(scopePath ?? ".");
                const info = await stat(scopedAbsolute).catch(() => null);
                if (!info || (!info.isDirectory() && !info.isFile())) {
                    return errorResult(`Invalid path: ${scopePath ?? "."}`);
                }

                const rg = await findRipgrep();
                if (rg) {
                    const result = await structuredSearch(project, {
                        pattern,
                        ...(scopePath ? { path: scopePath } : {}),
                        ...(caseInsensitive !== undefined ? { caseInsensitive } : {}),
                        include: normalizePatterns(glob),
                        exclude: normalizePatterns(exclude),
                        ...(maxResults !== undefined ? { maxResults } : {}),
                        ...(beforeContext !== undefined ? { beforeContext } : {}),
                        ...(afterContext !== undefined ? { afterContext } : {}),
                        ...(filesOnly !== undefined ? { filesOnly } : {}),
                    });
                    return okResult(
                        `Found ${result.truncated ? "at least " : ""}${result.matchCount} match(es) in ${result.files.length} file(s)${result.truncated ? " (truncated)" : ""}.`,
                        { ...result },
                    );
                }

                if (
                    glob !== undefined ||
                    exclude !== undefined ||
                    filesOnly === true ||
                    (beforeContext ?? 0) > 0 ||
                    (afterContext ?? 0) > 0
                ) {
                    return errorResult(
                        "Advanced grep options require ripgrep; install/reload the managed ripgrep dependency or use basic pattern/path search.",
                    );
                }

                const fallbackRoot = info.isFile() ? dirname(scopedAbsolute) : scopedAbsolute;
                const fallback = await runFallbackRegexGrep(
                    fallbackRoot,
                    scopedAbsolute,
                    pattern,
                    caseInsensitive === true,
                );
                const resultLimit = maxResults ?? MAX_RETURNED_MATCHES;
                const allMatches = fallback.matches
                    .map((value) => parseFallbackMatch(value, project, fallbackRoot))
                    .filter((item): item is StructuredSearchMatch => item !== undefined);
                const matches = allMatches.slice(0, resultLimit);
                const files = [...new Set(matches.map((item) => item.path))];
                const truncated = fallback.truncated || allMatches.length > matches.length;
                return okResult(
                    `Found ${truncated ? "at least " : ""}${allMatches.length} match(es) in ${files.length} file(s)${truncated ? " (truncated)" : ""}.`,
                    {
                        matchCount: allMatches.length,
                        matches,
                        files,
                        truncated,
                    },
                );
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

function normalizePatterns(value: string | string[] | undefined): string[] {
    if (value === undefined) return [];
    return Array.isArray(value) ? value : [value];
}

function parseFallbackMatch(
    value: string,
    project: ProjectContext,
    root: string,
): StructuredSearchMatch | undefined {
    const match = /^(.*?):(\d+):(.*)$/.exec(value);
    if (!match) return undefined;
    return {
        path: project.displayPath(resolve(root, match[1]!)),
        line: Number(match[2]),
        column: 1,
        text: match[3]!,
        kind: "match",
    };
}
