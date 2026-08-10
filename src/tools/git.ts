import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../project.js";
import { runGitReadOnly } from "../lib/git-readonly.js";
import { registerTool } from "../lib/tool-log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";

const MAX_GIT_DIFF_BYTES = 120_000;
const MAX_GIT_STATUS_BYTES = 2 * 1024 * 1024;
const MAX_GIT_BRANCH_BYTES = 1024 * 1024;
const MAX_STATUS_FILES = 500;
const MAX_BRANCHES = 500;

/** Register structured Git inspection tools whose execution is side-effect suppressed. */
export function registerGitTools(server: McpServer, project: ProjectContext): void {
    registerTool(
        server,
        "git_status",
        withToolAuth({
            title: "Read Git status",
            description:
                "Return structured Git branch/status for a repository inside project_root. Uses Git with optional index writes and fsmonitor disabled.",
            inputSchema: { path: z.string().optional() },
            outputSchema: {
                repository: z.string(),
                branch: z.string(),
                dirty: z.boolean(),
                files: z.array(
                    z.object({
                        path: z.string(),
                        indexStatus: z.string(),
                        worktreeStatus: z.string(),
                    }),
                ),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path }) => {
            try {
                const repo = await resolveRepository(project, path);
                const branchResult = await runGitReadOnly(repo.absolute, ["branch", "--show-current"], {
                    maxOutputBytes: 64 * 1024,
                });
                const statusResult = await runGitReadOnly(
                    repo.absolute,
                    ["status", "--porcelain=v1", "-z", "-uall"],
                    { maxOutputBytes: MAX_GIT_STATUS_BYTES, allowTruncation: true },
                );
                const rows = parsePorcelainV1Z(statusResult.stdout, statusResult.truncated);
                const files = rows.slice(0, MAX_STATUS_FILES);
                const truncated = statusResult.truncated || rows.length > files.length;
                return okResult(
                    `Git status: ${files.length}${truncated ? "+" : ""} changed file(s).`,
                    {
                        repository: repo.relative,
                        branch: branchResult.stdout.trim() || "(detached)",
                        dirty: rows.length > 0 || statusResult.truncated,
                        files,
                        truncated,
                    },
                );
            } catch (error) {
                return errorResult(errorMessage(error));
            }
        },
    );

    registerTool(
        server,
        "git_diff",
        withToolAuth({
            title: "Read Git diff",
            description:
                "Return a bounded unified diff for a repository inside project_root. External diff and textconv helpers are disabled. Set staged=true for the index diff.",
            inputSchema: {
                path: z.string().optional(),
                staged: z.boolean().optional(),
            },
            outputSchema: {
                repository: z.string(),
                staged: z.boolean(),
                diff: z.string(),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path, staged }) => {
            try {
                const repo = await resolveRepository(project, path);
                const args = ["diff", "--no-ext-diff", "--no-textconv", "--unified=3"];
                if (staged) args.push("--cached");
                const result = await runGitReadOnly(repo.absolute, args, {
                    maxOutputBytes: MAX_GIT_DIFF_BYTES,
                    allowTruncation: true,
                });
                return okResult(
                    `Read ${staged ? "staged" : "working-tree"} diff for ${repo.relative}${result.truncated ? " (truncated)" : ""}.`,
                    {
                        repository: repo.relative,
                        staged: staged === true,
                        diff: result.stdout,
                        truncated: result.truncated,
                    },
                );
            } catch (error) {
                return errorResult(errorMessage(error));
            }
        },
    );

    registerTool(
        server,
        "git_log",
        withToolAuth({
            title: "Read Git log",
            description: "Return recent commits for a repository inside project_root.",
            inputSchema: {
                path: z.string().optional(),
                limit: z.number().int().min(1).max(100).optional(),
            },
            outputSchema: {
                repository: z.string(),
                commits: z.array(
                    z.object({
                        hash: z.string(),
                        shortHash: z.string(),
                        author: z.string(),
                        date: z.string(),
                        subject: z.string(),
                    }),
                ),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path, limit }) => {
            try {
                const repo = await resolveRepository(project, path);
                const result = await runGitReadOnly(repo.absolute, [
                    "log",
                    `-${limit ?? 20}`,
                    "--date=iso-strict",
                    "--format=%H%x1f%h%x1f%an%x1f%aI%x1f%s%x1e",
                ]);
                const commits = result.stdout
                    .split("\x1e")
                    .map((record) => record.trim())
                    .filter(Boolean)
                    .map((record) => {
                        const [hash = "", shortHash = "", author = "", date = "", subject = ""] = record.split("\x1f");
                        return { hash, shortHash, author, date, subject };
                    });
                return okResult(`Read ${commits.length} commit(s) from ${repo.relative}.`, {
                    repository: repo.relative,
                    commits,
                });
            } catch (error) {
                return errorResult(errorMessage(error));
            }
        },
    );

    registerTool(
        server,
        "git_show",
        withToolAuth({
            title: "Show Git revision",
            description:
                "Show a bounded patch/stat for one Git revision inside project_root. External diff/textconv helpers are disabled; revision strings beginning with '-' are rejected.",
            inputSchema: {
                path: z.string().optional(),
                revision: z.string().min(1).max(200).optional(),
            },
            outputSchema: {
                repository: z.string(),
                revision: z.string(),
                content: z.string(),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path, revision }) => {
            try {
                const repo = await resolveRepository(project, path);
                const rev = revision?.trim() || "HEAD";
                if (rev.startsWith("-")) throw new Error("revision must not begin with '-'");
                const result = await runGitReadOnly(
                    repo.absolute,
                    [
                        "show",
                        "--no-ext-diff",
                        "--no-textconv",
                        "--stat",
                        "--patch",
                        "--format=fuller",
                        rev,
                    ],
                    { maxOutputBytes: MAX_GIT_DIFF_BYTES, allowTruncation: true },
                );
                return okResult(
                    `Read revision ${rev} from ${repo.relative}${result.truncated ? " (truncated)" : ""}.`,
                    {
                        repository: repo.relative,
                        revision: rev,
                        content: result.stdout,
                        truncated: result.truncated,
                    },
                );
            } catch (error) {
                return errorResult(errorMessage(error));
            }
        },
    );

    registerTool(
        server,
        "git_branches",
        withToolAuth({
            title: "List Git branches",
            description: "List local and remote Git refs for a repository inside project_root.",
            inputSchema: { path: z.string().optional() },
            outputSchema: {
                repository: z.string(),
                branches: z.array(
                    z.object({
                        name: z.string(),
                        hash: z.string(),
                        subject: z.string(),
                    }),
                ),
                truncated: z.boolean(),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ path }) => {
            try {
                const repo = await resolveRepository(project, path);
                const result = await runGitReadOnly(
                    repo.absolute,
                    [
                        "for-each-ref",
                        "--format=%(refname:short)%00%(objectname:short)%00%(subject)%00",
                        "refs/heads",
                        "refs/remotes",
                    ],
                    { maxOutputBytes: MAX_GIT_BRANCH_BYTES, allowTruncation: true },
                );
                const fields = result.stdout.split("\0");
                const branches: Array<{ name: string; hash: string; subject: string }> = [];
                for (let index = 0; index + 2 < fields.length && branches.length < MAX_BRANCHES; index += 3) {
                    const name = fields[index]!.trimStart();
                    const hash = fields[index + 1] ?? "";
                    const subject = fields[index + 2]?.replace(/^\n/, "") ?? "";
                    if (!name) continue;
                    branches.push({ name, hash, subject });
                }
                const truncated = result.truncated || fields.filter(Boolean).length / 3 > branches.length;
                return okResult(
                    `Listed ${branches.length}${truncated ? "+" : ""} branch ref(s) for ${repo.relative}.`,
                    { repository: repo.relative, branches, truncated },
                );
            } catch (error) {
                return errorResult(errorMessage(error));
            }
        },
    );
}

async function resolveRepository(
    project: ProjectContext,
    inputPath?: string,
): Promise<{ absolute: string; relative: string }> {
    const candidate = project.resolvePath(inputPath?.trim() || ".");
    const result = await runGitReadOnly(candidate, ["rev-parse", "--show-toplevel"], {
        maxOutputBytes: 64 * 1024,
    });
    const topLevel = result.stdout.trim();
    if (!topLevel) throw new Error(`not a Git repository: ${inputPath?.trim() || "."}`);
    const canonical = await realpath(topLevel);
    if (!isInside(project.root, canonical)) {
        throw new Error("Git repository root is outside project_root");
    }
    return {
        absolute: canonical,
        relative: relative(project.root, canonical).replaceAll("\\", "/") || ".",
    };
}

function parsePorcelainV1Z(
    raw: string,
    outputTruncated: boolean,
): Array<{ path: string; indexStatus: string; worktreeStatus: string }> {
    const records = raw.split("\0");
    if (outputTruncated && records.at(-1) !== "") records.pop();
    const files: Array<{ path: string; indexStatus: string; worktreeStatus: string }> = [];

    for (let index = 0; index < records.length; index += 1) {
        const record = records[index]!;
        if (record.length < 3) continue;
        const indexStatus = record[0] ?? " ";
        const worktreeStatus = record[1] ?? " ";
        let path = record.slice(3);
        if (indexStatus === "R" || indexStatus === "C" || worktreeStatus === "R" || worktreeStatus === "C") {
            const original = records[index + 1];
            if (original !== undefined) {
                path = `${original} -> ${path}`;
                index += 1;
            }
        }
        files.push({ path, indexStatus, worktreeStatus });
    }
    return files;
}

function isInside(root: string, candidate: string): boolean {
    const relationship = relative(resolve(root), resolve(candidate));
    return (
        relationship === "" ||
        (!isAbsolute(relationship) && relationship !== ".." && !relationship.startsWith(`..${sep}`))
    );
}

function errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
