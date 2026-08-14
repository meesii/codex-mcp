import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    connectMcp,
    createProject,
    createTestEnvironment,
    expectToolError,
    expectToolOk,
    git,
    startSingleProjectHarness,
} from "./harness.js";

test("MCP contract: project file, search, Git and command tools produce externally verifiable results", async () => {
    const env = await createTestEnvironment("codex-mcp-core-contract-");
    const project = await createProject("core", {
        git: true,
        files: {
            "README.txt": "alpha\nneedle-one\n",
            "src/app.ts": "export const marker = 'needle-two';\n",
        },
    });
    const server = await startSingleProjectHarness({ root: project });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const tools = await mcp.listTools();
        const toolNames = new Set(tools.map((tool) => tool.name));
        for (const required of [
            "read", "read_many", "write", "edit", "apply_patch", "grep", "glob", "ls",
            "bash", "exec_command", "process_status", "process_output", "process_kill",
            "git_status", "git_diff", "git_log", "git_show", "git_branches",
        ]) {
            assert.equal(toolNames.has(required), true, `missing public tool ${required}`);
        }

        const read = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "README.txt" }));
        assert.equal(read.content, "alpha\nneedle-one\n");

        const batch = expectToolOk<{ files?: Array<{ path: string; content?: string; error?: string }> }>(
            await mcp.call("read_many", {
                files: [{ path: "README.txt" }, { path: "missing.txt" }],
            }),
        );
        assert.match(batch.files?.find((row) => row.path === "README.txt")?.content ?? "", /needle-one/);
        assert.match(batch.files?.find((row) => row.path === "missing.txt")?.error ?? "", /ENOENT|not found/i);

        expectToolOk(await mcp.call("write", {
            path: "created.txt",
            content: "first\n",
        }));
        assert.equal(await readFile(join(project, "created.txt"), "utf8"), "first\n");

        expectToolOk(await mcp.call("edit", {
            path: "created.txt",
            old_string: "first",
            new_string: "second",
        }));
        assert.equal(await readFile(join(project, "created.txt"), "utf8"), "second\n");

        expectToolOk(await mcp.call("apply_patch", {
            patch: [
                "--- a/created.txt",
                "+++ b/created.txt",
                "@@ -1,1 +1,1 @@",
                "-second",
                "+third",
                "--- /dev/null",
                "+++ b/new-from-patch.txt",
                "@@ -0,0 +1,1 @@",
                "+new-file",
                "",
            ].join("\n"),
        }));
        assert.equal(await readFile(join(project, "created.txt"), "utf8"), "third\n");
        assert.equal(await readFile(join(project, "new-from-patch.txt"), "utf8"), "new-file\n");

        const grepResult = expectToolOk<{
            matches?: Array<{ path: string; text: string }>;
        }>(await mcp.call("grep", { pattern: "needle-(one|two)", path: "." }));
        const grepPaths = new Set((grepResult.matches ?? []).map((row) => row.path));
        assert.equal(grepPaths.has("README.txt"), true);
        assert.equal(grepPaths.has("src/app.ts"), true);

        const globResult = expectToolOk<{ files?: string[] }>(
            await mcp.call("glob", { pattern: "**/*.ts" }),
        );
        assert.deepEqual(globResult.files, ["src/app.ts"]);

        const lsResult = expectToolOk<{ entries?: Array<{ name: string }> }>(await mcp.call("ls", { path: "." }));
        assert.equal(lsResult.entries?.some((row) => row.name === "created.txt"), true);

        const bash = expectToolOk<{ stdout?: string; exitCode?: number }>(await mcp.call("bash", {
            command: process.platform === "win32"
                ? 'node -e "process.stdout.write(process.cwd())"'
                : "node -e \"process.stdout.write(process.cwd())\"",
            output_mode: "full",
        }));
        assert.equal(bash.exitCode, 0);
        assert.equal((bash.stdout ?? "").trim(), await realpath(project));

        const managed = expectToolOk<{ running?: boolean; processId?: number }>(await mcp.call("exec_command", {
            command: process.platform === "win32"
                ? 'node -e "setTimeout(()=>process.stdout.write(\'late-output\'),150);setTimeout(()=>{},5000)"'
                : "node -e \"setTimeout(()=>process.stdout.write('late-output'),150);setTimeout(()=>{},5000)\"",
            yield_time_ms: 0,
        }));
        assert.equal(managed.running, true);
        assert.ok(managed.processId);
        const processId = managed.processId!;
        await new Promise((resolveWait) => setTimeout(resolveWait, 300));
        const status = expectToolOk<{ running?: boolean }>(await mcp.call("process_status", { processId }));
        assert.equal(typeof status.running, "boolean");
        const output = expectToolOk<{ output?: string }>(await mcp.call("process_output", { processId, output_mode: "full" }));
        assert.match(output.output ?? "", /late-output/);
        expectToolOk(await mcp.call("process_kill", { processId }));

        // Modify one tracked file as well; Git diff intentionally does not include
        // untracked files, so the contract verifies a real tracked working-tree diff.
        expectToolOk(await mcp.call("edit", {
            path: "README.txt",
            old_string: "alpha",
            new_string: "alpha-modified",
        }));

        const gitStatus = expectToolOk<{ dirty?: boolean; files?: Array<{ path: string }> }>(await mcp.call("git_status", {}));
        assert.equal(gitStatus.dirty, true);
        assert.equal((gitStatus.files ?? []).some((row) => row.path === "created.txt"), true);

        const diff = expectToolOk<{ diff?: string }>(await mcp.call("git_diff", {}));
        assert.match(diff.diff ?? "", /README\.txt/);
        assert.match(diff.diff ?? "", /alpha-modified/);
        const log = expectToolOk<{ commits?: Array<{ subject?: string }> }>(await mcp.call("git_log", { limit: 5 }));
        assert.equal((log.commits ?? []).some((row) => row.subject === "fixture baseline"), true);
        const branches = expectToolOk<{ branches?: Array<{ name?: string }> }>(await mcp.call("git_branches", {}));
        assert.ok((branches.branches ?? []).length >= 1);

        assert.match(git(project, ["status", "--porcelain=v1"]), /created\.txt|new-from-patch\.txt/);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("MCP contract: external reads are open, external writes/exec and path escapes fail closed without authorization", async () => {
    const env = await createTestEnvironment("codex-mcp-boundary-contract-");
    const project = await createProject("boundary", { git: true });
    const external = await mkdtemp(join(tmpdir(), "codex-mcp-external-contract-"));
    await writeFile(join(external, "secret.txt"), "outside-readable\n", "utf8");
    const server = await startSingleProjectHarness({ root: project });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const outsideRead = expectToolOk<{ content?: string }>(
            await mcp.call("read", { path: join(external, "secret.txt") }),
        );
        assert.equal(outsideRead.content, "outside-readable\n");

        expectToolError(
            await mcp.call("write", { path: join(external, "blocked.txt"), content: "no\n" }),
            /permission|授权/i,
        );
        expectToolError(
            await mcp.call("bash", { command: "pwd", cwd: external }),
            /permission|授权/i,
        );
        expectToolError(
            await mcp.call("write", { path: "../escaped.txt", content: "no\n" }),
            /permission|outside|授权|workspace/i,
        );

        const privateFetch = await mcp.call("webfetch", { url: "http://127.0.0.1:1/private" });
        expectToolError(privateFetch, /private|reserved|loopback/i);

        if (process.platform !== "win32") {
            const externalTarget = join(external, "symlink-target.txt");
            await symlink(externalTarget, join(project, "dangling-link.txt"));
            expectToolError(
                await mcp.call("write", { path: "dangling-link.txt", content: "escape\n" }),
                /symlink|outside|permission|授权|workspace/i,
            );
            await assert.rejects(readFile(externalTarget, "utf8"), /ENOENT/);
        }

        await writeFile(join(project, "large.txt"), "x".repeat(200_000), "utf8");
        const large = expectToolOk<{ content?: string; truncated?: boolean }>(
            await mcp.call("read", { path: "large.txt" }),
        );
        assert.equal(large.truncated, true);
        assert.ok((large.content ?? "").length < 200_000);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});
