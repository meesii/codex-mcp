import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { access, mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInstructionRegistry } from "../src/agents/registry.js";
import { resolveWidgetDomain, type ServerConfig } from "../src/config.js";
import { DownstreamMcpHub } from "../src/downstream/hub.js";
import { createHttpServer } from "../src/http-server.js";
import { ProjectContext } from "../src/project.js";
import { SkillRegistry } from "../src/skills/registry.js";
import { rankContextMatches } from "../src/tools/workspace.js";
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
        "package.json": JSON.stringify({ name: "repo-a", devDependencies: { vite: "1.0.0" } }),
        ".gitattributes": "*.conv diff=reviewconv\n",
        "sample.conv": "textconv-original\n",
        "src/app.ts": "export const sharedMarker = 'workspace-marker';\n",
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
            files?: Array<{ text: string }>;
            searchTruncated?: boolean;
        };
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
