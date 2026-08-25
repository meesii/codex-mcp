import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { registerTool } from "../lib/tool/log.js";
import { withToolAuth, writeAnnotations } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { projectErrorResult, type ToolScopeProvider } from "../server/project-router.js";

interface PatchState {
    relative: string;
    absolute: string;
    originalExists: boolean;
    originalContent: string | null;
    exists: boolean;
    content: string | null;
}

export function registerApplyPatchTool(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(server, "apply_patch", withToolAuth({
        title: "Apply patch",
        description: "Apply validated file changes transactionally. Multiple edits to the same file are composed in order; oldText replaces one exact snippet, omit oldText to create/overwrite, and set delete=true to delete. Writes are verified and commit failures are rolled back.",
        inputSchema: {
            edits: z.array(z.object({
                path: z.string().min(1), oldText: z.string().optional(),
                newText: z.string().optional(), delete: z.boolean().optional(),
            })).min(1),
        },
        outputSchema: { text: z.string(), files: z.array(z.string()), deleted: z.array(z.string()) },
        annotations: writeAnnotations,
    }), async ({ edits }) => {
        try {
            const { project, roundChanges } = scope();
            return await project.lock.runExclusive(async () => {
                const states = new Map<string, PatchState>();
                for (const edit of edits as Array<{ path: string; oldText?: string; newText?: string; delete?: boolean }>) {
                    const relative = edit.path.trim();
                    const absolute = project.resolvePath(relative);
                    const key = process.platform === "win32" ? absolute.toLowerCase() : absolute;
                    let state = states.get(key);
                    if (!state) {
                        state = await loadState(relative, absolute);
                        states.set(key, state);
                    }
                    if (edit.delete === true) {
                        if (!state.exists) return errorResult(`File not found: ${relative} (nothing was written)`);
                        state.exists = false;
                        state.content = null;
                        continue;
                    }
                    const newText = edit.newText ?? "";
                    if (!Object.prototype.hasOwnProperty.call(edit, "oldText")) {
                        state.exists = true;
                        state.content = newText;
                        continue;
                    }
                    const oldText = edit.oldText ?? "";
                    if (!oldText) return errorResult(`oldText must not be empty in ${relative}; omit oldText to create/overwrite (nothing was written)`);
                    if (!state.exists || state.content === null) return errorResult(`File not found: ${relative} (nothing was written)`);
                    const content = normalizeNewlines(state.content);
                    const normalizedOld = normalizeNewlines(oldText);
                    if (countOccurrences(content, normalizedOld) !== 1) {
                        return errorResult(`oldText must match exactly once in ${relative} (nothing was written)`);
                    }
                    const updated = content.replace(normalizedOld, normalizeNewlines(newText));
                    state.content = preserveNewlines(state.content, updated);
                }

                const plans = [...states.values()];
                try {
                    for (const state of plans) await commit(state);
                } catch (error) {
                    const rollbackErrors: string[] = [];
                    for (const state of [...plans].reverse()) {
                        try { await rollback(state); }
                        catch (rollbackError) { rollbackErrors.push(`${state.relative}: ${String(rollbackError)}`); }
                    }
                    const suffix = rollbackErrors.length ? `; rollback errors: ${rollbackErrors.join(" | ")}` : "";
                    return errorResult(`apply_patch commit failed: ${String(error)}${suffix}`);
                }

                for (const state of plans) {
                    roundChanges.recordCommitted({
                        relativePath: state.relative, absolutePath: state.absolute,
                        originalExists: state.originalExists, originalContent: state.originalContent,
                        finalExists: state.exists, finalContent: state.content,
                    });
                }
                const files = plans.map((state) => state.relative);
                const deleted = plans.filter((state) => !state.exists).map((state) => state.relative);
                const text = `Applied ${edits.length} edit(s) across ${plans.length} file(s): ${files.join(", ")}`;
                return okResult(text, { text, files, deleted });
            });
        } catch (error) {
            return projectErrorResult(error);
        }
    });
}

async function loadState(relative: string, absolute: string): Promise<PatchState> {
    try {
        const content = await readFile(absolute, "utf8");
        return { relative, absolute, originalExists: true, originalContent: content, exists: true, content };
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        return { relative, absolute, originalExists: false, originalContent: null, exists: false, content: null };
    }
}

async function commit(state: PatchState): Promise<void> {
    if (!state.exists) {
        await rm(state.absolute, { force: true });
        try { await readFile(state.absolute); throw new Error(`delete verification failed: ${state.relative}`); }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
        return;
    }
    await mkdir(dirname(state.absolute), { recursive: true });
    await writeFile(state.absolute, state.content!, "utf8");
    if (await readFile(state.absolute, "utf8") !== state.content) throw new Error(`write verification failed: ${state.relative}`);
}

async function rollback(state: PatchState): Promise<void> {
    if (!state.originalExists) { await rm(state.absolute, { force: true }); return; }
    await mkdir(dirname(state.absolute), { recursive: true });
    await writeFile(state.absolute, state.originalContent!, "utf8");
    if (await readFile(state.absolute, "utf8") !== state.originalContent) throw new Error(`rollback verification failed: ${state.relative}`);
}

function countOccurrences(content: string, needle: string): number {
    let count = 0;
    let index = content.indexOf(needle);
    while (index !== -1) { count += 1; index = content.indexOf(needle, index + needle.length); }
    return count;
}

function normalizeNewlines(value: string): string { return value.replaceAll("\r\n", "\n").replaceAll("\r", "\n"); }
function preserveNewlines(original: string, normalized: string): string { return original.includes("\r\n") ? normalized.replaceAll("\n", "\r\n") : normalized; }
