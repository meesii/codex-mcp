import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInstructionRegistry } from "../src/agents/registry.js";
import { resolveWidgetDomain, type ServerConfig } from "../src/config/loader.js";
import { DownstreamMcpHub } from "../src/downstream/hub.js";
import { createHttpServer } from "../src/server/http-server.js";
import { ProjectContext } from "../src/config/project.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { rankContextMatches } from "../src/tools/workspace.js";
import { WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS } from "../src/workspace/context.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";

function git(root: string, args: string[]): string {
    return execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
    }).trim();
}

async function createRepo(
    root: string,
    name: string,
    files: Record<string, string>,
): Promise<string> {
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    for (const [path, content] of Object.entries(files)) {
        const full = join(repo, path);
        await mkdir(join(full, ".."), { recursive: true });
        await writeFile(full, content, "utf8");
    }
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "codex-mcp@example.test"]);
    git(repo, ["config", "user.name", "codex-mcp test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", `init ${name}`]);
    return repo;
}

async function main(): Promise<void> {
    const ranked = rankContextMatches(
        "login auth controller",
        [
            { path: "src/misc.ts", line: 1, column: 1, text: "login auth controller fallback" },
            { path: "src/auth/LoginController.ts", line: 8, column: 3, text: "handle request" },
            { path: "src/auth/LoginController.ts", line: 20, column: 3, text: "login auth controller detail" },
            { path: "src/auth/LoginController.ts", line: 30, column: 3, text: "login auth controller extra" },
            { path: "src/auth/session.ts", line: 4, column: 1, text: "auth token" },
        ],
        4,
        2,
    );
    assert.equal(ranked[0]?.path, "src/auth/LoginController.ts");
    assert.equal(
        ranked.filter((match) => match.path === "src/auth/LoginController.ts").length,
        2,
        "context ranking should cap duplicate matches from one file",
    );
    assert.ok(
        ranked.some((match) => match.path === "src/auth/session.ts"),
        "context ranking should preserve relevant file diversity",
    );

    process.env.CODING_MCP_LOG_TOOLS = "0";
    const workspaceRoot = await mkdtemp(join(tmpdir(), "codex-mcp-workspace-"));
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-workspace-home-"));
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "AGENTS.md"), "GLOBAL-WORKSPACE-RULE\n", "utf8");
    await writeFile(join(workspaceRoot, "AGENTS.md"), "ROOT-WORKSPACE-RULE\n", "utf8");

    const repoA = await createRepo(workspaceRoot, "repo-a", {
        "package.json": JSON.stringify({
            name: "repo-a",
            version: "1.2.3",
            scripts: { test: "node --test", build: "vite build" },
            devDependencies: { vite: "1.0.0" },
        }),
        ".gitattributes": "*.conv diff=reviewconv\n",
        "sample.conv": "textconv-original\n",
        "src/main.ts": "export const boot = () => 'workspace main';\n",
        "src/app.ts": "export const sharedMarker = 'workspace-marker';\n",
        "src/workspace/context.ts": "export const workspace_context = 'chat project snapshot';\n",
        "src/aaa-noise.ts": Array.from(
            { length: 200 },
            (_, index) => `export const workspace_noise_${index} = 'workspace';`,
        ).join("\n"),
        "src/capabilities/policy.ts": "export function resolveAllowedTools(clientId: string) { return filterToolsByClientCapability(clientId); }\nfunction filterToolsByClientCapability(clientId: string) { return clientId ? ['read'] : []; }\n",
        "src/tools/register.ts": "export function registerCodingTools() { return 'registered tool capability'; }\n",
        "src/managed-tools/noise.ts": "export const tools = ['ripgrep', 'cloudflared'];\n",
        "src/context-budget.ts": [
            `context-budget-marker ${"x".repeat(2_000)}`,
            ...Array.from({ length: 39 }, (_, index) => `context-budget-marker ${index}`),
        ].join("\n"),
        "src/large.txt": "small\n",
    });
    const repoB = await createRepo(workspaceRoot, "repo-b", {
        "manifest.json": "{}\n",
        "pages.json": "{}\n",
        "src/page.vue": "<template>workspace-marker</template>\n",
    });
    await writeFile(join(repoA, "src", "app.ts"), "export const sharedMarker = 'workspace-marker-dirty';\n", "utf8");
    await writeFile(join(repoA, "sample.conv"), "textconv-dirty\n", "utf8");
    await writeFile(join(repoB, "untracked file.txt"), "untracked\n", "utf8");

    const textconvMarker = join(workspaceRoot, "textconv-ran.marker");
    const textconvHelper = join(workspaceRoot, "textconv-helper.mjs");
    await writeFile(
        textconvHelper,
        "import { readFileSync, writeFileSync } from 'node:fs';\n" +
            "writeFileSync(process.env.TEXTCONV_MARKER, 'ran');\n" +
            "process.stdout.write(readFileSync(process.argv[2]));\n",
        "utf8",
    );
    const shellPath = (value: string): string => JSON.stringify(value.replaceAll("\\", "/"));
    git(repoA, [
        "config",
        "diff.reviewconv.textconv",
        `${shellPath(process.execPath)} ${shellPath(textconvHelper)}`,
    ]);
    process.env.TEXTCONV_MARKER = textconvMarker;
    git(repoA, ["diff", "--", "sample.conv"]);
    await access(textconvMarker);
    await rm(textconvMarker);

    const host = "127.0.0.1";
    const allowedHosts: string[] = [];
    const config: ServerConfig = {
        host,
        port: 0,
        local: true,
        oauthRequired: false,
        projectRoot: workspaceRoot,
        allowedHosts,
        widgetDomain: resolveWidgetDomain(allowedHosts, host, 0),
    };
    const project = new ProjectContext(workspaceRoot);
    const agents = new AgentInstructionRegistry(project, home);
    const server = createHttpServer(config, {
        hub: DownstreamMcpHub.empty(),
        skills: SkillRegistry.empty(),
        agents,
        goalStorageDir: join(home, "goals"),
    });
    await server.listen();
    const mcp = await connectMcpClient(server.getMcpUrl());

    try {
        const projects = await mcp.callTool("workspace_projects", {});
        assert.notEqual(projects.isError, true, toolText(projects));
        const projectRows = (projects.structuredContent as {
            projects?: Array<{ path: string; kind: string; dirty: boolean }>;
        }).projects ?? [];
        assert.equal(projectRows.length, 2, JSON.stringify(projectRows));
        assert.equal(projectRows.find((item) => item.path === "repo-a")?.kind, "vite");
        assert.equal(projectRows.find((item) => item.path === "repo-a")?.dirty, true);
        assert.equal(projectRows.find((item) => item.path === "repo-b")?.kind, "uni-app");
        assert.equal(
            projectRows.find((item) => item.path === "repo-b")?.dirty,
            true,
            "workspace dirty state must include untracked files",
        );

        const contextGoal = await mcp.callTool("goal_start", {
            path: "repo-a",
            objective: "Continue the workspace-marker feature and verify Chat-oriented context",
            tasks: [
                { title: "Inspect workspace marker implementation" },
                { title: "Run focused verification" },
            ],
            acceptance_criteria: ["workspace_context exposes enough local state to resume the work"],
        });
        assert.notEqual(contextGoal.isError, true, toolText(contextGoal));
        const goalProgress = await mcp.callTool("goal_update", {
            path: "repo-a",
            task_updates: [{ task_id: "task_1", status: "done" }],
            checkpoint: {
                summary: "Workspace marker implementation was inspected.",
                next: "Run the focused verification.",
                findings: ["repo-a/src/app.ts contains the marker implementation"],
            },
        });
        assert.notEqual(goalProgress.isError, true, toolText(goalProgress));

        const workspaceContext = await mcp.callTool("workspace_context", {
            path: "repo-a",
            intent: "continue the workspace-marker implementation",
        });
        assert.notEqual(workspaceContext.isError, true, toolText(workspaceContext));
        const workspaceContextData = workspaceContext.structuredContent as {
            path?: string;
            project?: { path?: string; kind?: string; dirty?: boolean } | null;
            git?: {
                available?: boolean;
                repository?: string | null;
                changedFiles?: number | null;
                files?: Array<{ path?: string }>;
                recentCommits?: Array<{ subject?: string }>;
            };
            work?: {
                goal?: {
                    objective?: string;
                    tasks?: { done?: number; pending?: number };
                    checkpoint?: { next?: string } | null;
                } | null;
                processes?: unknown[];
            };
            instructions?: { agents?: Array<{ excerpt?: string }> };
            focus?: {
                files?: Array<{ path?: string; text?: string }>;
                entryPoints?: Array<{ path?: string }>;
                manifest?: { path?: string; name?: string; version?: string; scripts?: Array<{ name?: string }> } | null;
            };
            warnings?: string[];
            budget?: { maxStructuredChars?: number; estimatedChars?: number; truncated?: boolean };
        };
        assert.equal(workspaceContextData.path, "repo-a");
        assert.equal(workspaceContextData.project?.path, "repo-a");
        assert.equal(workspaceContextData.project?.kind, "vite");
        assert.equal(workspaceContextData.git?.available, true);
        assert.equal(workspaceContextData.git?.repository, "repo-a");
        assert.ok((workspaceContextData.git?.changedFiles ?? 0) >= 2);
        assert.ok((workspaceContextData.git?.files?.length ?? 0) <= 12);
        assert.ok((workspaceContextData.git?.recentCommits?.length ?? 0) <= 5);
        assert.match(workspaceContextData.work?.goal?.objective ?? "", /workspace-marker/i);
        assert.equal(workspaceContextData.work?.goal?.tasks?.done, 1);
        assert.equal(workspaceContextData.work?.goal?.tasks?.pending, 1);
        assert.equal(workspaceContextData.work?.goal?.checkpoint?.next, "Run the focused verification.");
        assert.match(JSON.stringify(workspaceContextData.instructions?.agents ?? []), /GLOBAL-WORKSPACE-RULE/);
        assert.match(JSON.stringify(workspaceContextData.instructions?.agents ?? []), /ROOT-WORKSPACE-RULE/);
        assert.ok(
            (workspaceContextData.focus?.files ?? []).some((item) => item.path === "repo-a/src/app.ts"),
            JSON.stringify(workspaceContextData.focus?.files),
        );

        const separatorVariantContext = await mcp.callTool("workspace_context", {
            path: "repo-a",
            intent: "continue the workspace-context implementation",
        });
        assert.notEqual(separatorVariantContext.isError, true, toolText(separatorVariantContext));
        const separatorVariantFocus = (separatorVariantContext.structuredContent as {
            focus?: { files?: Array<{ path?: string }> };
        }).focus?.files ?? [];
        assert.ok(
            separatorVariantFocus.some((item) => item.path === "repo-a/src/workspace/context.ts"),
            `hyphenated intent should match snake_case code identifiers: ${JSON.stringify(separatorVariantFocus)}`,
        );

        const diverseContext = await mcp.callTool("workspace_context", {
            path: "repo-a",
            intent: "Chat workspace context",
        });
        assert.notEqual(diverseContext.isError, true, toolText(diverseContext));
        const diverseFocus = (diverseContext.structuredContent as {
            focus?: { files?: Array<{ path?: string }> };
        }).focus?.files ?? [];
        assert.ok(
            diverseFocus.some((item) => item.path === "repo-a/src/workspace/context.ts"),
            `one noisy file must not consume the entire focus candidate budget: ${JSON.stringify(diverseFocus)}`,
        );

        assert.ok(
            (workspaceContextData.focus?.entryPoints ?? []).some((item) => item.path === "repo-a/src/main.ts"),
            JSON.stringify(workspaceContextData.focus?.entryPoints),
        );
        assert.equal(workspaceContextData.focus?.manifest?.path, "repo-a/package.json");
        assert.equal(workspaceContextData.focus?.manifest?.name, "repo-a");
        assert.equal(workspaceContextData.focus?.manifest?.version, "1.2.3");
        assert.ok(
            (workspaceContextData.focus?.manifest?.scripts ?? []).some((item) => item.name === "test"),
        );
        assert.equal(workspaceContextData.budget?.maxStructuredChars, WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS);
        assert.ok(
            (workspaceContextData.budget?.estimatedChars ?? Number.POSITIVE_INFINITY) <= WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS,
            JSON.stringify(workspaceContextData.budget),
        );
        assert.ok(
            JSON.stringify(workspaceContext.structuredContent).length <= WORKSPACE_CONTEXT_MAX_STRUCTURED_CHARS,
            "workspace_context structured payload must remain within the declared hard budget",
        );

        const workspaceRootContext = await mcp.callTool("workspace_context", {
            path: ".",
            intent: "understand all workspace projects",
        });
        assert.notEqual(workspaceRootContext.isError, true, toolText(workspaceRootContext));
        const workspaceRootData = workspaceRootContext.structuredContent as {
            project?: unknown;
            projects?: Array<{ path?: string }>;
            git?: { available?: boolean };
            warnings?: string[];
        };
        assert.equal(workspaceRootData.project, null, "multi-repo workspace root should not guess one primary repository");
        assert.deepEqual((workspaceRootData.projects ?? []).map((item) => item.path), ["repo-a", "repo-b"]);
        assert.equal(workspaceRootData.git?.available, false);
        assert.match((workspaceRootData.warnings ?? []).join("\n"), /multiple Git projects/i);

        const search = await mcp.callTool("workspace_search", {
            pattern: "workspace-marker",
        });
        assert.notEqual(search.isError, true, toolText(search));
        const matches = (search.structuredContent as {
            matches?: Array<{ path: string }>;
        }).matches ?? [];
        assert.ok(matches.some((item) => item.path === "repo-a/src/app.ts"));
        assert.ok(matches.some((item) => item.path === "repo-b/src/page.vue"));

        const context = await mcp.callTool("context_pack", {
            query: "context-budget-marker",
            path: "repo-a",
        });
        assert.notEqual(context.isError, true, toolText(context));
        assert.match(JSON.stringify(context.structuredContent), /GLOBAL-WORKSPACE-RULE/);
        assert.match(JSON.stringify(context.structuredContent), /ROOT-WORKSPACE-RULE/);
        const contextData = context.structuredContent as {
            projects?: Array<{ path: string }>;
            files?: Array<{ text: string }>;
            searchTruncated?: boolean;
            codegraphProjects?: string[];
        };
        assert.deepEqual(
            (contextData.projects ?? []).map((item) => item.path),
            ["repo-a"],
            "scoped context_pack must omit unrelated workspace projects",
        );
        assert.deepEqual(contextData.codegraphProjects ?? [], []);
        assert.ok((contextData.files?.length ?? 0) <= 20);
        assert.equal(contextData.searchTruncated, true);
        assert.ok(
            (contextData.files ?? []).every((item) => item.text.length <= 800),
            "context_pack must bound individual search-match text",
        );
        const matchesPerFile = new Map<string, number>();
        for (const item of contextData.files ?? []) {
            const path = (item as { path?: string }).path ?? "";
            matchesPerFile.set(path, (matchesPerFile.get(path) ?? 0) + 1);
        }
        assert.ok(
            [...matchesPerFile.values()].every((count) => count <= 2),
            "context_pack should cap repeated matches from one file",
        );

        // Force fresh worktree metadata immediately before git_status. A normal
        // `git status` may refresh the index; the MCP read-only runner must not.
        await writeFile(
            join(repoA, "src", "app.ts"),
            "export const sharedMarker = 'workspace-marker-dirty-2';\n",
            "utf8",
        );
        const indexBefore = await stat(join(repoA, ".git", "index"));
        await new Promise((resolve) => setTimeout(resolve, 20));
        const status = await mcp.callTool("git_status", { path: "repo-a" });
        assert.notEqual(status.isError, true, toolText(status));
        assert.equal((status.structuredContent as { dirty?: boolean }).dirty, true);

        const filteredStatus = await mcp.callTool("git_status", {
            path: "repo-a",
            paths: ["src/app.ts"],
            max_files: 1,
        });
        assert.notEqual(filteredStatus.isError, true, toolText(filteredStatus));
        const filteredStatusData = filteredStatus.structuredContent as {
            changedFiles?: number;
            files?: Array<{ path: string }>;
        };
        assert.equal(filteredStatusData.changedFiles, 1);
        assert.deepEqual((filteredStatusData.files ?? []).map((item) => item.path), ["src/app.ts"]);

        const summaryStatus = await mcp.callTool("git_status", {
            path: "repo-a",
            summary_only: true,
        });
        assert.notEqual(summaryStatus.isError, true, toolText(summaryStatus));
        assert.ok(((summaryStatus.structuredContent as { changedFiles?: number }).changedFiles ?? 0) >= 2);
        assert.deepEqual((summaryStatus.structuredContent as { files?: unknown[] }).files ?? [], []);

        const indexAfter = await stat(join(repoA, ".git", "index"));
        assert.equal(
            indexAfter.mtimeMs,
            indexBefore.mtimeMs,
            "git_status must suppress optional index refresh writes",
        );

        await writeFile(join(repoA, "src", "large.txt"), "x".repeat(200_000), "utf8");
        const diff = await mcp.callTool("git_diff", { path: "repo-a" });
        assert.notEqual(diff.isError, true, toolText(diff));
        const diffData = diff.structuredContent as { diff?: string; truncated?: boolean };
        assert.match(diffData.diff ?? "", /workspace-marker-dirty-2/);
        assert.equal(diffData.truncated, true, "large diffs must truncate instead of throwing ENOBUFS");
        await assert.rejects(access(textconvMarker), /ENOENT/);

        const filteredDiff = await mcp.callTool("git_diff", {
            path: "repo-a",
            paths: ["src/app.ts"],
        });
        assert.notEqual(filteredDiff.isError, true, toolText(filteredDiff));
        const filteredDiffData = filteredDiff.structuredContent as {
            diff?: string;
            truncated?: boolean;
        };
        assert.match(filteredDiffData.diff ?? "", /workspace-marker-dirty-2/);
        assert.doesNotMatch(filteredDiffData.diff ?? "", /src\/large\.txt/);
        assert.equal(filteredDiffData.truncated, false);

        const escapedDiff = await mcp.callTool("git_diff", {
            path: "repo-a",
            paths: ["../repo-b/src/page.vue"],
        });
        assert.equal(escapedDiff.isError, true, "git_diff paths must stay inside the selected repository");

        const log = await mcp.callTool("git_log", { path: "repo-a", limit: 5 });
        assert.notEqual(log.isError, true, toolText(log));
        assert.match(JSON.stringify(log.structuredContent), /init repo-a/);

        const show = await mcp.callTool("git_show", { path: "repo-a", revision: "HEAD" });
        assert.notEqual(show.isError, true, toolText(show));
        assert.match((show.structuredContent as { content?: string }).content ?? "", /init repo-a/);
        await assert.rejects(access(textconvMarker), /ENOENT/);

        const branches = await mcp.callTool("git_branches", { path: "repo-a" });
        assert.notEqual(branches.isError, true, toolText(branches));
        const branchRows = (branches.structuredContent as {
            branches?: Array<{ name: string; hash: string }>;
        }).branches ?? [];
        assert.ok(branchRows.length >= 1, JSON.stringify(branchRows));
        assert.ok(branchRows[0]!.name.length > 0 && branchRows[0]!.hash.length > 0);

        const explore = await mcp.callTool("code_explore", {
            query: "sharedMarker workspace-marker",
            project_path: "repo-a",
        });
        assert.notEqual(explore.isError, true, toolText(explore));
        assert.equal(
            (explore.structuredContent as { source?: string }).source,
            "workspace_search",
        );
        assert.match(JSON.stringify(explore.structuredContent), /repo-a\/src\/app\.ts/);

        const naturalExplore = await mcp.callTool("code_explore", {
            query: "how are coding tools registered and filtered by client capabilities",
            project_path: "repo-a",
            max_files: 4,
        });
        assert.notEqual(naturalExplore.isError, true, toolText(naturalExplore));
        const naturalMatches = (naturalExplore.structuredContent as {
            matches?: Array<{ path: string }>;
        }).matches ?? [];
        const naturalPaths = [...new Set(naturalMatches.map((item) => item.path))];
        assert.equal(naturalPaths[0], "repo-a/src/capabilities/policy.ts");
        assert.ok(naturalPaths.includes("repo-a/src/tools/register.ts"), JSON.stringify(naturalPaths));
        assert.notEqual(
            naturalPaths[0],
            "repo-a/src/managed-tools/noise.ts",
            "common 'tools' token must not dominate natural-language fallback ranking",
        );

        const chineseExplore = await mcp.callTool("code_explore", {
            query: "工具是怎么按客户端能力注册和过滤的",
            project_path: "repo-a",
            max_files: 3,
        });
        assert.notEqual(chineseExplore.isError, true, toolText(chineseExplore));
        const chinesePaths = [
            ...new Set(
                ((chineseExplore.structuredContent as { matches?: Array<{ path: string }> }).matches ?? [])
                    .map((item) => item.path),
            ),
        ];
        assert.equal(chinesePaths[0], "repo-a/src/capabilities/policy.ts");
        assert.ok(chinesePaths.includes("repo-a/src/tools/register.ts"), JSON.stringify(chinesePaths));

        assert.equal(git(repoA, ["status", "--porcelain=v1"]).includes("src/app.ts"), true);
        assert.match(git(repoB, ["status", "--porcelain=v1"]), /untracked file\.txt/);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
    }

    console.log("workspace-git.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
