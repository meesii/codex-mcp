import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    connectMcp,
    createProject,
    createTestEnvironment,
    expectToolError,
    expectToolOk,
    readJsonFile,
    startDaemonHarness,
    startSingleProjectHarness,
    writeJsonFile,
} from "./harness.js";

test("workspace trust contract: global add/remove reaches live and future runtimes while preserving offline config", async () => {
    const env = await createTestEnvironment("codex-mcp-workspace-contract-");
    const projectAPath = await createProject("workspace-a", { files: { "identity.txt": "WA\n" } });
    const projectBPath = await createProject("workspace-b", { files: { "identity.txt": "WB\n" } });
    const projectCPath = await createProject("workspace-c", { files: { "identity.txt": "WC\n" } });
    const shared = await mkdtemp(join(tmpdir(), "codex-mcp-shared-contract-"));
    const canonicalShared = await realpath(shared);
    const offline = join(env.home, "offline-drive", "shared-root");
    const configPath = join(env.home, ".codex-mcp", "config.json");
    await writeJsonFile(configPath, { workspaces: [offline] });

    const daemon = await startDaemonHarness({ home: env.home, bootstrapRoot: projectAPath });
    const projectA = await daemon.registerProject(projectAPath, "workspace-a");
    const projectB = await daemon.registerProject(projectBPath, "workspace-b");
    let mcp = await connectMcp(daemon.mcpUrl);
    const sessionA = { "openai/session": "workspace-session-a" };
    const sessionB = { "openai/session": "workspace-session-b" };
    const sessionC = { "openai/session": "workspace-session-c" };

    try {
        expectToolOk(await mcp.call("project_select", { project_id: projectA.id }, sessionA));
        expectToolOk(await mcp.call("project_select", { project_id: projectB.id }, sessionB));
        // Force creation of both runtimes before changing global trust.
        expectToolOk(await mcp.call("read", { path: "identity.txt" }, sessionA));
        expectToolOk(await mcp.call("read", { path: "identity.txt" }, sessionB));

        expectToolOk(await mcp.call("workspace_add", { path: shared }, sessionA));
        // Duplicate add is idempotent, not a second trust record.
        expectToolOk(await mcp.call("workspace_control", { action: "add", path: shared }, sessionB));

        for (const [session, filename] of [[sessionA, "a.txt"], [sessionB, "b.txt"]] as const) {
            expectToolOk(await mcp.call("write", {
                path: join(shared, filename),
                content: `${filename}\n`,
            }, session));
            expectToolOk(await mcp.call("bash", {
                command: process.platform === "win32" ? "Get-Location" : "pwd",
                cwd: shared,
                output_mode: "full",
            }, session));
        }

        const projectC = await daemon.registerProject(projectCPath, "workspace-c");
        expectToolOk(await mcp.call("project_select", { project_id: projectC.id }, sessionC));
        expectToolOk(await mcp.call("write", {
            path: join(shared, "c.txt"),
            content: "future-runtime\n",
        }, sessionC));
        assert.equal(await readFile(join(shared, "c.txt"), "utf8"), "future-runtime\n");

        const configuredAfterAdd = await readJsonFile<{ workspaces?: string[] }>(configPath);
        assert.equal(configuredAfterAdd.workspaces?.includes(offline), true, "offline configured root must be preserved");
        assert.equal(configuredAfterAdd.workspaces?.filter((path) => path === canonicalShared).length, 1);

        // Persistence is a runtime contract, not merely a JSON-shape assertion:
        // restart the daemon, rebuild project runtimes, and prove the shared root
        // is still trusted before exercising revoke.
        await mcp.close();
        await daemon.restart();
        mcp = await connectMcp(daemon.mcpUrl);
        for (const [project, session] of [
            [projectA, sessionA],
            [projectB, sessionB],
            [projectC, sessionC],
        ] as const) {
            expectToolOk(await mcp.call("project_select", { project_id: project.id }, session));
        }
        for (const [session, filename] of [
            [sessionA, "restart-a.txt"],
            [sessionB, "restart-b.txt"],
            [sessionC, "restart-c.txt"],
        ] as const) {
            expectToolOk(await mcp.call("write", {
                path: join(shared, filename),
                content: "persisted-trust\n",
            }, session));
        }

        expectToolOk(await mcp.call("workspace_control", { action: "remove", path: shared }, sessionB));
        for (const [session, filename] of [
            [sessionA, "after-a.txt"],
            [sessionB, "after-b.txt"],
            [sessionC, "after-c.txt"],
        ] as const) {
            expectToolError(
                await mcp.call("write", {
                    path: join(shared, filename),
                    content: "revoked\n",
                }, session),
                /permission|授权/i,
            );
            expectToolError(
                await mcp.call("bash", { command: "pwd", cwd: shared }, session),
                /permission|授权/i,
            );
        }

        const configuredAfterRemove = await readJsonFile<{ workspaces?: string[] }>(configPath);
        assert.equal(configuredAfterRemove.workspaces?.includes(offline), true);
        assert.equal(configuredAfterRemove.workspaces?.includes(canonicalShared), false);

        expectToolError(
            await mcp.call("workspace_remove", { path: shared }, sessionA),
            /not registered|未注册|Workspace/i,
        );
    } finally {
        await mcp.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("workspace trust contract: removing a global root that is another project's primary root never revokes that project itself", async () => {
    const env = await createTestEnvironment("codex-mcp-primary-overlap-contract-");
    const projectAPath = await createProject("overlap-a", { files: { "identity.txt": "OA\n" } });
    const projectBPath = await createProject("overlap-b", { files: { "identity.txt": "OB\n" } });
    const daemon = await startDaemonHarness({ home: env.home, bootstrapRoot: projectAPath });
    const projectA = await daemon.registerProject(projectAPath, "overlap-a");
    const projectB = await daemon.registerProject(projectBPath, "overlap-b");
    const mcp = await connectMcp(daemon.mcpUrl);
    const sessionA = { "openai/session": "overlap-a" };
    const sessionB = { "openai/session": "overlap-b" };

    try {
        expectToolOk(await mcp.call("project_select", { project_id: projectA.id }, sessionA));
        expectToolOk(await mcp.call("project_select", { project_id: projectB.id }, sessionB));
        expectToolOk(await mcp.call("read", { path: "identity.txt" }, sessionB));

        expectToolOk(await mcp.call("workspace_add", { path: projectBPath }, sessionA));
        expectToolOk(await mcp.call("write", {
            path: join(projectBPath, "cross-project-global.txt"),
            content: "temporarily-global\n",
        }, sessionA));

        expectToolOk(await mcp.call("workspace_remove", { path: projectBPath }, sessionA));
        expectToolError(
            await mcp.call("write", {
                path: join(projectBPath, "cross-project-after-remove.txt"),
                content: "must be blocked for A\n",
            }, sessionA),
            /permission|授权/i,
        );

        expectToolOk(await mcp.call("write", {
            path: "primary-still-works.txt",
            content: "B primary remains trusted\n",
        }, sessionB));
        assert.equal(
            await readFile(join(projectBPath, "primary-still-works.txt"), "utf8"),
            "B primary remains trusted\n",
        );
    } finally {
        await mcp.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("permission contract: once, session and permanent grants have distinct externally observable lifetimes", async () => {
    const env = await createTestEnvironment("codex-mcp-permission-contract-");
    const project = await createProject("permission", { files: { "identity.txt": "PERMISSION\n" } });
    const external = await mkdtemp(join(tmpdir(), "codex-mcp-permission-external-"));
    const server = await startSingleProjectHarness({ root: project });
    let mcp = await connectMcp(server.mcpUrl);
    const conversationA = { "openai/session": "permission-conversation-a" };
    const conversationB = { "openai/session": "permission-conversation-b" };

    try {
        expectToolError(
            await mcp.call("write", { path: join(external, "denied.txt"), content: "no\n" }, conversationA),
            /permission|授权/i,
        );

        expectToolOk(await mcp.call("permission_grant", {
            capability: "write",
            path: external,
            duration: "once",
        }, conversationA));
        expectToolOk(await mcp.call("write", {
            path: join(external, "once.txt"),
            content: "once\n",
        }, conversationA));
        expectToolError(
            await mcp.call("write", {
                path: join(external, "once-consumed.txt"),
                content: "no\n",
            }, conversationA),
            /permission|授权/i,
        );

        expectToolOk(await mcp.call("permission_grant", {
            capability: "write",
            path: external,
            duration: "session",
        }, conversationA));
        for (const name of ["session-1.txt", "session-2.txt"]) {
            expectToolOk(await mcp.call("write", {
                path: join(external, name),
                content: `${name}\n`,
            }, conversationA));
        }
        expectToolError(
            await mcp.call("write", {
                path: join(external, "other-conversation.txt"),
                content: "must not inherit\n",
            }, conversationB),
            /permission|授权/i,
        );

        expectToolOk(await mcp.call("permission_grant", {
            capability: "write",
            path: external,
            duration: "permanent",
        }, conversationA));
        expectToolOk(await mcp.call("write", {
            path: join(external, "permanent-before-reconnect.txt"),
            content: "permanent\n",
        }, conversationB));

        await mcp.close();
        mcp = await connectMcp(server.mcpUrl);
        expectToolOk(await mcp.call("write", {
            path: join(external, "permanent-after-reconnect.txt"),
            content: "still permanent\n",
        }, conversationB));

        expectToolOk(await mcp.call("permission_revoke", {
            capability: "write",
            path: external,
        }, conversationA));
        expectToolError(
            await mcp.call("write", {
                path: join(external, "after-revoke.txt"),
                content: "no\n",
            }, conversationB),
            /permission|授权/i,
        );

        assert.equal(await readFile(join(external, "once.txt"), "utf8"), "once\n");
        assert.equal(
            await readFile(join(external, "permanent-after-reconnect.txt"), "utf8"),
            "still permanent\n",
        );
        await assert.rejects(readFile(join(external, "after-revoke.txt"), "utf8"), /ENOENT/);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("permission contract: exec authorization is capability-specific and one-time grants are consumed", async () => {
    const env = await createTestEnvironment("codex-mcp-exec-permission-contract-");
    const project = await createProject("exec-permission");
    const external = await mkdtemp(join(tmpdir(), "codex-mcp-exec-external-"));
    const server = await startSingleProjectHarness({ root: project });
    const mcp = await connectMcp(server.mcpUrl);
    const conversation = { "openai/session": "exec-permission-conversation" };

    try {
        expectToolOk(await mcp.call("permission_grant", {
            capability: "write",
            path: external,
            duration: "session",
        }, conversation));
        expectToolError(
            await mcp.call("bash", { command: "pwd", cwd: external }, conversation),
            /permission|授权/i,
        );

        expectToolOk(await mcp.call("permission_grant", {
            capability: "exec",
            path: external,
            duration: "once",
        }, conversation));
        expectToolOk(await mcp.call("bash", {
            command: process.platform === "win32" ? "Get-Location" : "pwd",
            cwd: external,
            output_mode: "full",
        }, conversation));
        expectToolError(
            await mcp.call("bash", { command: "pwd", cwd: external }, conversation),
            /permission|授权/i,
        );
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});
