import { stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { ProjectContext } from "../../config/project.js";
import { findRipgrep, runRipgrep } from "./ripgrep.js";
import { truncateText } from "./truncate.js";

const DEFAULT_EXCLUDES = [
    ".git/**",
    "node_modules/**",
    "dist/**",
    "build/**",
    "coverage/**",
    "unpackage/**",
];

export type SearchMatchKind = "match" | "context";

export interface StructuredSearchMatch {
    path: string;
    line: number;
    column: number;
    text: string;
    kind: SearchMatchKind;
}

export interface StructuredSearchInput {
    pattern: string;
    path?: string;
    caseInsensitive?: boolean;
    include?: string[];
    exclude?: string[];
    beforeContext?: number;
    afterContext?: number;
    maxResults?: number;
    /** Optional diversity cap for stored match rows from any single file. */
    maxMatchesPerFile?: number;
    filesOnly?: boolean;
    hidden?: boolean;
}

export interface StructuredSearchResult {
    matches: StructuredSearchMatch[];
    files: string[];
    matchCount: number;
    truncated: boolean;
}

export async function structuredSearch(
    project: ProjectContext,
    input: StructuredSearchInput,
): Promise<StructuredSearchResult> {
    const rgPath = await findRipgrep();
    if (!rgPath) throw new Error("Structured search requires ripgrep (rg)");

    const scope = input.path?.trim() || ".";
    const scopedAbsolute = project.resolveReadPath(scope);
    const info = await stat(scopedAbsolute).catch(() => null);
    if (!info || (!info.isDirectory() && !info.isFile())) {
        throw new Error(`Invalid search path: ${scope}`);
    }
    const searchRoot = info.isFile() ? dirname(scopedAbsolute) : scopedAbsolute;
    const searchTarget = info.isFile() ? basename(scopedAbsolute) : ".";
    const maxResults = Math.max(1, Math.min(Math.floor(input.maxResults ?? 200), 1_000));
    const maxMatchesPerFile = input.maxMatchesPerFile === undefined
        ? maxResults
        : Math.max(1, Math.min(Math.floor(input.maxMatchesPerFile), maxResults));
    const args = input.filesOnly
        ? ["--files-with-matches", "--color", "never"]
        : ["--json", "--color", "never"];
    if (input.hidden === true) args.push("--hidden");
    if (input.caseInsensitive) args.push("--ignore-case");
    for (const pattern of input.include ?? []) args.push("--glob", pattern);
    for (const pattern of [...DEFAULT_EXCLUDES, ...(input.exclude ?? [])]) {
        args.push("--glob", `!${pattern}`);
    }
    if (!input.filesOnly && (input.beforeContext ?? 0) > 0) {
        args.push("--before-context", String(input.beforeContext));
    }
    if (!input.filesOnly && (input.afterContext ?? 0) > 0) {
        args.push("--after-context", String(input.afterContext));
    }
    args.push("--", input.pattern, searchTarget);

    const result = await runRipgrep(rgPath, args, searchRoot, 1_500_000, 30_000);
    if (result.exitCode !== 0 && result.exitCode !== 1) {
        throw new Error(result.stderr.trim() || `ripgrep exited with code ${result.exitCode}`);
    }

    if (input.filesOnly) {
        const allFiles = result.stdout
            .split(/\r?\n/)
            .filter(Boolean)
            .map((item) => normalizeResultPath(project, searchRoot, item));
        const files = allFiles.slice(0, maxResults);
        return {
            matches: [],
            files,
            matchCount: allFiles.length,
            truncated: result.truncated || allFiles.length > files.length,
        };
    }

    const matchCandidates: Array<StructuredSearchMatch & { order: number }> = [];
    const contextCandidates: Array<StructuredSearchMatch & { order: number }> = [];
    const fileSet = new Set<string>();
    const retainedMatchesPerFile = new Map<string, number>();
    let totalMatches = 0;
    let totalContexts = 0;
    let eventOrder = 0;
    let truncated = result.truncated;

    for (const line of result.stdout.split(/\r?\n/)) {
        if (!line) continue;
        let event: RgJsonEvent;
        try {
            event = JSON.parse(line) as RgJsonEvent;
        } catch {
            truncated = true;
            continue;
        }
        if (event.type !== "match" && event.type !== "context") continue;
        const data = event.data;
        const relativePath = normalizeResultPath(project, searchRoot, data.path?.text ?? "");
        if (!relativePath) continue;

        const candidate = {
            path: relativePath,
            line: data.line_number ?? 0,
            column: firstColumn(data),
            text: truncateText((data.lines?.text ?? "").replace(/\r?\n$/, ""), 2_000),
            kind: event.type,
            order: eventOrder,
        } satisfies StructuredSearchMatch & { order: number };
        eventOrder += 1;

        if (event.type === "match") {
            totalMatches += 1;
            fileSet.add(relativePath);
            const retainedForFile = retainedMatchesPerFile.get(relativePath) ?? 0;
            if (retainedForFile >= maxMatchesPerFile) {
                truncated = true;
            } else if (matchCandidates.length < maxResults) {
                matchCandidates.push(candidate);
                retainedMatchesPerFile.set(relativePath, retainedForFile + 1);
            } else {
                truncated = true;
            }
        } else {
            totalContexts += 1;
            if (contextCandidates.length < maxResults) contextCandidates.push(candidate);
        }
    }

    // `maxResults` is a record budget, but actual matches take priority over
    // context lines. A tiny budget must never return only leading context while
    // omitting the matching line that caused it.
    const contextBudget = Math.max(0, maxResults - matchCandidates.length);
    if (totalContexts > contextBudget) truncated = true;
    const matches = [...matchCandidates, ...contextCandidates.slice(0, contextBudget)]
        .sort((left, right) => left.order - right.order)
        .map(({ order: _order, ...match }) => match);

    const files = [...fileSet].slice(0, maxResults);
    if (fileSet.size > files.length) truncated = true;
    return {
        matches,
        files,
        matchCount: totalMatches,
        truncated,
    };
}

function normalizeResultPath(project: ProjectContext, searchRoot: string, rgPath: string): string {
    if (!rgPath) return "";
    return project.displayPath(join(searchRoot, rgPath));
}

function firstColumn(data: RgJsonData): number {
    const start = data.submatches?.[0]?.start;
    return typeof start === "number" ? start + 1 : 1;
}

interface RgJsonEvent {
    type?: string;
    data: RgJsonData;
}

interface RgJsonData {
    path?: { text?: string };
    lines?: { text?: string };
    line_number?: number;
    submatches?: Array<{ start?: number }>;
}
