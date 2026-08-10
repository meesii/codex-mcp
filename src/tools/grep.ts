import { readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { Worker } from "node:worker_threads";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../project.js";
import { AccessDeniedError } from "../project.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";
import { findRipgrep, runRipgrep } from "../lib/ripgrep.js";

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

/** Register the `grep` tool. */
export function registerGrepTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "grep",
        withToolAuth({
            title: "Search file contents",
            description:
                "Search file contents with a regex (ripgrep when available). Prefer this over shell grep. Results are bounded and reported in structuredContent.matches.",
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
            },
            outputSchema: {
                matchCount: z.number().int(),
                matches: z.array(z.string()),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ pattern, path: scopePath, case_insensitive: caseInsensitive }) => {
            try {
                const scopedAbsolute = project.resolvePath(scopePath ?? ".");
                const info = await stat(scopedAbsolute).catch(() => null);
                if (!info || (!info.isDirectory() && !info.isFile())) {
                    return errorResult(`Invalid path: ${scopePath ?? "."}`);
                }

                const rg = await findRipgrep();
                let lines: string[];
                let truncated = false;

                if (rg) {
                    const args = ["--line-number", "--no-heading", "--color", "never"];
                    if (caseInsensitive) args.push("-i");
                    args.push("--", pattern, scopePath ?? ".");
                    const result = await runRipgrep(rg, args, project.root);
                    if (result.exitCode !== 0 && result.exitCode !== 1) {
                        return errorResult(
                            result.stderr || `rg failed with code ${result.exitCode}`,
                        );
                    }
                    lines = result.stdout
                        .split(/\r?\n/)
                        .map((line) => line.trimEnd())
                        .filter(Boolean);
                    truncated = result.truncated;
                } else {
                    const fallback = await runFallbackRegexGrep(
                        project.root,
                        scopedAbsolute,
                        pattern,
                        caseInsensitive === true,
                    );
                    lines = fallback.matches;
                    truncated = fallback.truncated;
                }

                const limited = lines
                    .slice(0, MAX_RETURNED_MATCHES)
                    .map((line) => truncateText(line, 2000));
                truncated = truncated || lines.length > limited.length;
                return okResult(
                    `Found ${truncated ? "at least " : ""}${lines.length} matches${truncated ? " (truncated)" : ""}.`,
                    {
                        matchCount: lines.length,
                        matches: limited,
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
