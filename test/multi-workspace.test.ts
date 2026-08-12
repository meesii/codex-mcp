import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInstructionRegistry } from "../src/agents/registry.js";
import { loadConfig } from "../src/config/loader.js";
import { ProjectContext } from "../src/config/project.js";
import { WorkspaceRegistry } from "../src/workspace/registry.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";
import { startTestServer } from "./helpers/start-server.js";

function git(root: string, args: string[]): void {
    execFileSync("git", ["-C", root, ...args], { stdio: "ignore" });
}

async function createRepo(root: string, name: string): Promise<string> {
    const repo = join(root, name);
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "package.json"), JSON.stringify({ name }), "utf8");
    await writeFile(join(repo, "index.ts"), `export const name = ${JSON.stringify(name)};\n`, "utf8");
    git(repo, ["init"]);
    git(repo, ["config", "user.email", "codex-mcp@example.test"]);
    git(repo, ["config", "user.name", "codex-mcp test"]);
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "init"]);
    return repo;
}

async function main(): Promise<void> {
    const primaryRoot = await mkdtemp(join(tmpdir(), "codex-mcp-primary-workspace-"));
    const extraRoot = await mkdtemp(join(tmpdir(), "codex-mcp-extra-workspace-"));
    const primaryRepo = await createRepo(primaryRoot, "primary-repo");
    const extraRepo = await createRepo(extraRoot, "extra-repo");
    await writeFile(join(primaryRoot, "AGENTS.md"), "PRIMARY-RULE\n", "utf8");
    await writeFile(join(extraRoot, "AGENTS.md"), "EXTRA-RULE\n", "utf8");

    const config = loadConfig({
        local: true,
        projectRoot: primaryRoot,
        userConfig: { workspaces: [extraRoot] },
    });
    assert.deepEqual(config.workspaceRoots, [primaryRoot, extraRoot]);

    const project = new ProjectContext(primaryRoot, config.workspaceRoots);
    const canonicalExtraRepo = await realpath(extraRepo);
    assert.equal(project.resolvePath(join(extraRepo, "index.ts")), join(canonicalExtraRepo, "index.ts"));
    assert.equal(project.displayPath(await realpath(primaryRepo)), "primary-repo");
    assert.equal(project.displayPath(canonicalExtraRepo), canonicalExtraRepo);

    const workspace = new WorkspaceRegistry(project);
    const projects = await workspace.listProjects(2);
    assert.equal(projects.length, 2, JSON.stringify(projects));
    assert.ok(projects.some((item) => item.path === "primary-repo"));
    assert.ok(projects.some((item) => item.path === canonicalExtraRepo));

    const agents = new AgentInstructionRegistry(project, primaryRoot);
    const rules = agents.forPath(extraRepo);
    assert.ok(
        rules.some((item) => item.content.includes("EXTRA-RULE")),
        "additional workspace paths should load AGENTS.md from their own workspace root",
    );
    assert.ok(
        !rules.some((item) => item.content.includes("PRIMARY-RULE")),
        "additional workspace paths must not inherit primary-workspace AGENTS.md",
    );

    const runtimeHome = await mkdtemp(join(tmpdir(), "codex-mcp-workspace-config-home-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = runtimeHome;
    process.env.USERPROFILE = runtimeHome;
    const runtimeCtx = await startTestServer();
    const runtimeClient = await connectMcpClient(runtimeCtx.mcpUrl);
    try {
        const add = await runtimeClient.callTool("workspace_add", { path: extraRoot });
        assert.notEqual(add.isError, true, toolText(add));
        assert.deepEqual(loadConfig({
            local: true,
            projectRoot: runtimeCtx.fixtureRoot,
            userConfig: (await import("../src/config/user-config.js")).loadUserConfig(),
        }).workspaceRoots?.includes(await realpath(extraRoot)), true);

        const afterAdd = await runtimeClient.callTool("workspace_projects", { max_depth: 2 });
        assert.notEqual(afterAdd.isError, true, toolText(afterAdd));
        const addedProjects = (afterAdd.structuredContent as { projects?: Array<{ path: string }> }).projects ?? [];
        assert.ok(addedProjects.some((item) => item.path === canonicalExtraRepo));

        const remove = await runtimeClient.callTool("workspace_remove", { path: extraRoot });
        assert.notEqual(remove.isError, true, toolText(remove));
        const persisted = (await import("../src/config/user-config.js")).loadUserConfig();
        assert.ok(!(persisted.workspaces ?? []).includes(canonicalExtraRepo));

        const afterRemove = await runtimeClient.callTool("workspace_projects", { max_depth: 2 });
        assert.notEqual(afterRemove.isError, true, toolText(afterRemove));
        const remainingProjects = (afterRemove.structuredContent as { projects?: Array<{ path: string }> }).projects ?? [];
        assert.ok(!remainingProjects.some((item) => item.path === canonicalExtraRepo));
    } finally {
        await runtimeClient.close();
        await runtimeCtx.server.close();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }

    console.log("multi-workspace.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
