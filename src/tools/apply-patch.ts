import { mkdir, readFile, stat, unlink, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../config/project.js";
import { AccessDeniedError } from "../config/project.js";
import { registerTool } from "../lib/tool/log.js";
import { withToolAuth, writeAnnotations } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { truncateText } from "../lib/search/truncate.js";

interface PatchHunk {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
}

interface FilePatch {
    oldPath: string | null;
    newPath: string | null;
    hunks: PatchHunk[];
}

interface PlannedChange {
    oldPath: string | null;
    newPath: string | null;
    oldAbsolute: string | null;
    newAbsolute: string | null;
    content: string | null;
    hunks: number;
    action: "create" | "update" | "delete" | "move";
}

const MAX_PATCH_CHARS = 500_000;
const MAX_PATCH_FILES = 100;
const MAX_RESULT_DIFF_CHARS = 40_000;

export function registerApplyPatchTool(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "apply_patch",
        withToolAuth({
            title: "Apply unified patch",
            description:
                "Apply a standard unified diff across one or more project files. All hunks and paths are validated before writes begin; paths cannot escape project_root. Prefer this for multi-hunk or multi-file changes and edit for one small exact replacement.",
            inputSchema: {
                patch: z
                    .string()
                    .min(1)
                    .max(MAX_PATCH_CHARS)
                    .describe("Unified diff text using ---/+++ file headers and @@ hunks."),
            },
            outputSchema: {
                filesChanged: z.number().int(),
                hunksApplied: z.number().int(),
                files: z.array(
                    z.object({
                        path: z.string(),
                        action: z.enum(["create", "update", "delete", "move"]),
                        hunks: z.number().int(),
                    }),
                ),
                diff: z.string(),
                diffTruncated: z.boolean(),
            },
            annotations: writeAnnotations,
        }),
        async ({ patch }) => {
            try {
                return await project.lock.runExclusive(async () => {
                    const parsed = parseUnifiedPatch(patch);
                    if (parsed.length > MAX_PATCH_FILES) {
                        return errorResult(`Patch touches ${parsed.length} files; maximum is ${MAX_PATCH_FILES}`);
                    }

                    const plan = await buildPlan(project, parsed);
                    const before = await snapshotTouchedPaths(plan);
                    try {
                        await commitPlan(plan);
                    } catch (error) {
                        await restoreSnapshot(before).catch(() => undefined);
                        throw error;
                    }

                    const hunksApplied = plan.reduce((sum, item) => sum + item.hunks, 0);
                    const diff = truncateText(patch.trimEnd(), MAX_RESULT_DIFF_CHARS);
                    return okResult(
                        `Applied ${hunksApplied} hunk(s) across ${plan.length} file(s).`,
                        {
                            filesChanged: plan.length,
                            hunksApplied,
                            files: plan.map((item) => ({
                                path: item.newPath ?? item.oldPath ?? "",
                                action: item.action,
                                hunks: item.hunks,
                            })),
                            diff,
                            diffTruncated: diff !== patch.trimEnd(),
                        },
                    );
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

function parseUnifiedPatch(input: string): FilePatch[] {
    const lines = input.replaceAll("\r\n", "\n").split("\n");
    const files: FilePatch[] = [];
    let index = 0;

    while (index < lines.length) {
        const line = lines[index] ?? "";
        if (!line.startsWith("--- ")) {
            index += 1;
            continue;
        }

        const oldPath = parseHeaderPath(line.slice(4));
        const next = lines[index + 1];
        if (!next?.startsWith("+++ ")) {
            throw new Error(`Expected +++ header after line ${index + 1}`);
        }
        const newPath = parseHeaderPath(next.slice(4));
        if (oldPath === null && newPath === null) {
            throw new Error("Patch file cannot use /dev/null for both old and new paths");
        }
        index += 2;

        const hunks: PatchHunk[] = [];
        while (index < lines.length) {
            const current = lines[index] ?? "";
            if (current.startsWith("--- ")) break;
            if (current.startsWith("diff --git ")) {
                index += 1;
                continue;
            }
            if (!current.startsWith("@@ ")) {
                index += 1;
                continue;
            }

            const match = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(current);
            if (!match) throw new Error(`Invalid hunk header at line ${index + 1}: ${current}`);
            const oldStart = Number(match[1]);
            const oldCount = match[2] === undefined ? 1 : Number(match[2]);
            const newStart = Number(match[3]);
            const newCount = match[4] === undefined ? 1 : Number(match[4]);
            index += 1;

            const hunkLines: string[] = [];
            while (index < lines.length) {
                const body = lines[index] ?? "";
                if (body.startsWith("@@ ") || body.startsWith("--- ") || body.startsWith("diff --git ")) {
                    break;
                }
                if (body === "" && index === lines.length - 1) {
                    index += 1;
                    break;
                }
                if (!body.startsWith(" ") && !body.startsWith("+") && !body.startsWith("-") && !body.startsWith("\\")) {
                    throw new Error(`Invalid unified diff line ${index + 1}: ${body}`);
                }
                hunkLines.push(body);
                index += 1;
            }

            const actualOld = hunkLines.filter((item) => item.startsWith(" ") || item.startsWith("-")).length;
            const actualNew = hunkLines.filter((item) => item.startsWith(" ") || item.startsWith("+")).length;
            if (actualOld !== oldCount || actualNew !== newCount) {
                throw new Error(
                    `Hunk count mismatch: header expects -${oldCount}/+${newCount}, body has -${actualOld}/+${actualNew}`,
                );
            }
            hunks.push({ oldStart, oldCount, newStart, newCount, lines: hunkLines });
        }

        if (hunks.length === 0) {
            throw new Error(`Patch for ${newPath ?? oldPath ?? "file"} contains no hunks`);
        }
        files.push({ oldPath, newPath, hunks });
    }

    if (files.length === 0) throw new Error("No unified diff file headers found");
    return files;
}

function parseHeaderPath(value: string): string | null {
    const raw = value.split("\t", 1)[0]!.trim();
    if (raw === "/dev/null") return null;

    let path = raw;
    if (path.startsWith('"') && path.endsWith('"')) {
        try {
            path = JSON.parse(path) as string;
        } catch {
            throw new Error(`Unsupported quoted patch path: ${raw}`);
        }
    }
    if (path.startsWith("a/") || path.startsWith("b/")) path = path.slice(2);
    if (!path) throw new Error("Patch path must not be empty");
    return path;
}

async function buildPlan(project: ProjectContext, files: FilePatch[]): Promise<PlannedChange[]> {
    const touched = new Set<string>();
    const plan: PlannedChange[] = [];

    for (const file of files) {
        const oldAbsolute = file.oldPath === null ? null : project.resolvePath(file.oldPath);
        const newAbsolute = file.newPath === null ? null : project.resolvePath(file.newPath);
        for (const absolute of new Set([oldAbsolute, newAbsolute].filter((item): item is string => item !== null))) {
            if (touched.has(absolute)) throw new Error(`Patch touches the same path more than once: ${absolute}`);
            touched.add(absolute);
        }

        let original = "";
        if (oldAbsolute) {
            original = await readFile(oldAbsolute, "utf8").catch((error: NodeJS.ErrnoException) => {
                if (error.code === "ENOENT") throw new Error(`Patch source file does not exist: ${file.oldPath}`);
                throw error;
            });
        }
        if (!oldAbsolute && newAbsolute && (await pathExists(newAbsolute))) {
            throw new Error(`Patch create target already exists: ${file.newPath}`);
        }
        if (oldAbsolute && newAbsolute && oldAbsolute !== newAbsolute && (await pathExists(newAbsolute))) {
            throw new Error(`Patch move target already exists: ${file.newPath}`);
        }

        const patchedContent = applyHunks(original, file.hunks);
        if (newAbsolute === null && patchedContent !== "") {
            throw new Error(`Delete patch must remove the entire file: ${file.oldPath}`);
        }
        const content = newAbsolute ? patchedContent : null;
        plan.push({
            oldPath: file.oldPath,
            newPath: file.newPath,
            oldAbsolute,
            newAbsolute,
            content,
            hunks: file.hunks.length,
            action:
                oldAbsolute === null
                    ? "create"
                    : newAbsolute === null
                      ? "delete"
                      : oldAbsolute === newAbsolute
                        ? "update"
                        : "move",
        });
    }
    return plan;
}

function applyHunks(original: string, hunks: PatchHunk[]): string {
    const newline = original.includes("\r\n") ? "\r\n" : "\n";
    const normalized = original.replaceAll("\r\n", "\n");
    const hadFinalNewline = normalized.endsWith("\n");
    const source = normalized === "" ? [] : normalized.split("\n");
    if (hadFinalNewline) source.pop();

    const output: string[] = [];
    let cursor = 0;
    let finalNewline = hadFinalNewline;

    for (const hunk of hunks) {
        const hunkStart = hunk.oldCount === 0 ? Math.max(0, hunk.oldStart) : Math.max(0, hunk.oldStart - 1);
        if (hunkStart < cursor || hunkStart > source.length) {
            throw new Error(`Hunk starts outside source at old line ${hunk.oldStart}`);
        }
        output.push(...source.slice(cursor, hunkStart));
        cursor = hunkStart;
        let consumedOld = 0;
        let producedNew = 0;
        let previousPrefix = "";

        for (const line of hunk.lines) {
            if (line.startsWith("\\")) {
                if (previousPrefix === " " || previousPrefix === "+") finalNewline = false;
                continue;
            }
            const prefix = line[0] ?? "";
            const text = line.slice(1);
            previousPrefix = prefix;
            if (prefix === " ") {
                assertSourceLine(source, cursor, text);
                output.push(text);
                cursor += 1;
                consumedOld += 1;
                producedNew += 1;
            } else if (prefix === "-") {
                assertSourceLine(source, cursor, text);
                cursor += 1;
                consumedOld += 1;
            } else if (prefix === "+") {
                output.push(text);
                producedNew += 1;
                finalNewline = true;
            }
        }
        if (consumedOld !== hunk.oldCount || producedNew !== hunk.newCount) {
            throw new Error(`Hunk body count changed during application at old line ${hunk.oldStart}`);
        }
    }

    output.push(...source.slice(cursor));
    if (output.length === 0) return "";
    const joined = output.join(newline);
    return finalNewline ? `${joined}${newline}` : joined;
}

function assertSourceLine(source: string[], index: number, expected: string): void {
    const actual = source[index];
    if (actual !== expected) {
        throw new Error(
            `Patch context mismatch at source line ${index + 1}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual ?? "<EOF>")}`,
        );
    }
}

async function snapshotTouchedPaths(plan: PlannedChange[]): Promise<Map<string, string | null>> {
    const paths = new Set<string>();
    for (const item of plan) {
        if (item.oldAbsolute) paths.add(item.oldAbsolute);
        if (item.newAbsolute) paths.add(item.newAbsolute);
    }
    const snapshot = new Map<string, string | null>();
    for (const path of paths) {
        snapshot.set(path, await readFile(path, "utf8").catch((error: NodeJS.ErrnoException) => {
            if (error.code === "ENOENT") return null;
            throw error;
        }));
    }
    return snapshot;
}

async function commitPlan(plan: PlannedChange[]): Promise<void> {
    for (const item of plan) {
        if (item.newAbsolute && item.content !== null) {
            await mkdir(dirname(item.newAbsolute), { recursive: true });
            await writeFile(item.newAbsolute, item.content, "utf8");
        }
        if (item.oldAbsolute && item.oldAbsolute !== item.newAbsolute) {
            await unlink(item.oldAbsolute);
        }
    }
}

async function restoreSnapshot(snapshot: Map<string, string | null>): Promise<void> {
    for (const [path, content] of snapshot) {
        if (content === null) {
            await unlink(path).catch((error: NodeJS.ErrnoException) => {
                if (error.code !== "ENOENT") throw error;
            });
            continue;
        }
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, content, "utf8");
    }
}

async function pathExists(path: string): Promise<boolean> {
    return (await stat(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code === "ENOENT") return null;
        throw error;
    })) !== null;
}
