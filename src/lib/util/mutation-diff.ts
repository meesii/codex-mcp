import { truncateText } from "../search/truncate.js";

const DEFAULT_CONTEXT_LINES = 3;
const DEFAULT_MAX_DIFF_CHARS = 40_000;

export interface MutationDiffResult {
    diff: string;
    diffTruncated: boolean;
}

export function buildMutationDiff(
    path: string,
    before: string | null,
    after: string | null,
    contextLines = DEFAULT_CONTEXT_LINES,
    maxChars = DEFAULT_MAX_DIFF_CHARS,
): MutationDiffResult {
    const oldLines = splitLines(before ?? "");
    const newLines = splitLines(after ?? "");
    let prefix = 0;
    while (
        prefix < oldLines.length &&
        prefix < newLines.length &&
        oldLines[prefix] === newLines[prefix]
    ) {
        prefix += 1;
    }

    let suffix = 0;
    while (
        suffix < oldLines.length - prefix &&
        suffix < newLines.length - prefix &&
        oldLines[oldLines.length - 1 - suffix] === newLines[newLines.length - 1 - suffix]
    ) {
        suffix += 1;
    }

    if (prefix === oldLines.length && prefix === newLines.length) {
        return { diff: "", diffTruncated: false };
    }

    const contextBeforeStart = Math.max(0, prefix - contextLines);
    const oldChangedEnd = oldLines.length - suffix;
    const newChangedEnd = newLines.length - suffix;
    const oldContextEnd = Math.min(oldLines.length, oldChangedEnd + contextLines);
    const newContextEnd = Math.min(newLines.length, newChangedEnd + contextLines);

    const oldStart = before === null ? 0 : contextBeforeStart + 1;
    const newStart = after === null ? 0 : contextBeforeStart + 1;
    const oldCount = before === null ? 0 : oldContextEnd - contextBeforeStart;
    const newCount = after === null ? 0 : newContextEnd - contextBeforeStart;
    const oldHeader = before === null ? "/dev/null" : `a/${path}`;
    const newHeader = after === null ? "/dev/null" : `b/${path}`;
    const body: string[] = [];

    for (let index = contextBeforeStart; index < prefix; index += 1) {
        body.push(` ${oldLines[index] ?? ""}`);
    }
    for (let index = prefix; index < oldChangedEnd; index += 1) {
        body.push(`-${oldLines[index] ?? ""}`);
    }
    for (let index = prefix; index < newChangedEnd; index += 1) {
        body.push(`+${newLines[index] ?? ""}`);
    }
    const sharedContext = Math.min(oldContextEnd - oldChangedEnd, newContextEnd - newChangedEnd);
    for (let index = 0; index < sharedContext; index += 1) {
        body.push(` ${oldLines[oldChangedEnd + index] ?? ""}`);
    }

    const full = [
        `--- ${oldHeader}`,
        `+++ ${newHeader}`,
        `@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`,
        ...body,
    ].join("\n");
    const diff = truncateText(full, maxChars);
    return { diff, diffTruncated: diff !== full };
}

function splitLines(value: string): string[] {
    if (!value) return [];
    const normalized = value.replaceAll("\r\n", "\n");
    const lines = normalized.split("\n");
    if (normalized.endsWith("\n")) lines.pop();
    return lines;
}
