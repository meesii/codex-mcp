import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    connectMcp,
    createProject,
    createTestEnvironment,
    expectToolError,
    expectToolOk,
    issueOAuthSession,
    readJsonFile,
    startDaemonHarness,
    waitForFile,
    waitUntil,
    writeJsonFile,
} from "./harness.js";

test("multi-project contract: conversation binding is durable, explicit to switch, and invalidated on deactivate", async () => {
    const env = await createTestEnvironment("codex-mcp-project-contract-");
    const projectAPath = await createProject("project-a", {
        git: true,
        files: { "identity.txt": "PROJECT-A\n" },
    });
    const projectBPath = await createProject("project-b", {
        git: true,
        files: { "identity.txt": "PROJECT-B\n" },
    });
    const goalStorage = await mkdtemp(join(tmpdir(), "codex-mcp-project-goals-"));
    const daemon = await startDaemonHarness({
        home: env.home,
        bootstrapRoot: projectAPath,
        goalStorageDir: goalStorage,
    });
    const projectA = await daemon.registerProject(projectAPath, "alpha-display");
    const projectB = await daemon.registerProject(projectBPath, "beta-display");
    let mcp = await connectMcp(daemon.mcpUrl);
    const sessionA = { "openai/session": "conversation-A" };
    const sessionB = { "openai/session": "conversation-B" };
    const staleSession = { "openai/session": "conversation-stale" };

    try {
        expectToolError(await mcp.call("read", { path: "identity.txt" }, sessionA), /绑定|bound|project_select/i);

        const listed = expectToolOk<{
            projects?: Array<{ id: string; path: string }>;
            binding?: unknown;
        }>(await mcp.call("project_list", {}, sessionA));
        assert.equal(listed.binding ?? null, null);
        assert.equal((listed.projects ?? []).some((row) => row.id === projectA.id && row.path === projectA.path), true);
        assert.equal((listed.projects ?? []).some((row) => row.id === projectB.id && row.path === projectB.path), true);

        expectToolOk(await mcp.call("project_select", { project_id: projectA.id }, sessionA));
        expectToolOk(await mcp.call("project_select", { project_id: projectB.id }, sessionB));
        expectToolOk(await mcp.call("project_select", { project_id: projectA.id }, staleSession));

        const readA = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }, sessionA));
        const readB = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }, sessionB));
        assert.equal(readA.content, "PROJECT-A\n");
        assert.equal(readB.content, "PROJECT-B\n");

        expectToolOk(await mcp.call("write", { path: "owner.txt", content: "A\n" }, sessionA));
        expectToolOk(await mcp.call("write", { path: "owner.txt", content: "B\n" }, sessionB));
        assert.equal(await readFile(join(projectAPath, "owner.txt"), "utf8"), "A\n");
        assert.equal(await readFile(join(projectBPath, "owner.txt"), "utf8"), "B\n");

        const goalA = expectToolOk<{ goal?: { objective?: string } }>(await mcp.call("goal_start", {
            objective: "conversation A goal",
            acceptance_criteria: ["A done"],
        }, sessionA));
        const goalB = expectToolOk<{ goal?: { objective?: string } }>(await mcp.call("goal_start", {
            objective: "conversation B goal",
            acceptance_criteria: ["B done"],
        }, sessionB));
        assert.match(JSON.stringify(goalA), /conversation A goal/);
        assert.match(JSON.stringify(goalB), /conversation B goal/);

        const processA = expectToolOk<{ processId?: number; running?: boolean }>(await mcp.call("exec_command", {
            command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30",
            yield_time_ms: 0,
        }, sessionA));
        assert.ok(processA.processId);
        expectToolError(
            await mcp.call("process_status", { processId: processA.processId }, sessionB),
            /Unknown processId|process/i,
        );
        expectToolOk(await mcp.call("process_kill", { processId: processA.processId }, sessionA));

        expectToolError(
            await mcp.call("project_select", { project_id: projectB.id }, sessionA),
            /force=true|already bound|已绑定/i,
        );
        const stillA = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }, sessionA));
        assert.equal(stillA.content, "PROJECT-A\n");

        expectToolOk(await mcp.call("project_select", { project_id: projectB.id, force: true }, sessionA));
        const switchedA = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }, sessionA));
        const unchangedB = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }, sessionB));
        assert.equal(switchedA.content, "PROJECT-B\n");
        assert.equal(unchangedB.content, "PROJECT-B\n");

        // Re-register the same canonical path with a different display name.
        // The returned durable id is the contract; the test never derives it.
        const renamed = await daemon.registerProject(projectAPath, "renamed-alpha");
        assert.equal(renamed.id, projectA.id);
        assert.equal(renamed.path, projectA.path);
        const staleStillA = expectToolOk<{ content?: string }>(
            await mcp.call("read", { path: "identity.txt" }, staleSession),
        );
        assert.equal(staleStillA.content, "PROJECT-A\n");

        await mcp.close();
        await daemon.restart();
        mcp = await connectMcp(daemon.mcpUrl);

        // Binding survives daemon restart and still resolves the original project id.
        const afterRestart = expectToolOk<{ content?: string }>(
            await mcp.call("read", { path: "identity.txt" }, staleSession),
        );
        assert.equal(afterRestart.content, "PROJECT-A\n");

        await daemon.deactivateProject(projectA.id, projectAPath);
        expectToolError(
            await mcp.call("read", { path: "identity.txt" }, staleSession),
            /绑定|bound|inactive|project_select|不可用/i,
        );
        const bUnaffected = expectToolOk<{ content?: string }>(
            await mcp.call("read", { path: "identity.txt" }, sessionB),
        );
        assert.equal(bUnaffected.content, "PROJECT-B\n");
    } finally {
        await mcp.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("multi-project persistence contract: binding GC is based on lastSeen age, not owner-key assumptions", async () => {
    const env = await createTestEnvironment("codex-mcp-binding-gc-contract-");
    const projectAPath = await createProject("gc-a", { files: { "identity.txt": "GC-A\n" } });
    const projectBPath = await createProject("gc-b", { files: { "identity.txt": "GC-B\n" } });
    const daemon = await startDaemonHarness({ home: env.home, bootstrapRoot: projectAPath });
    const projectA = await daemon.registerProject(projectAPath, "gc-a");
    const projectB = await daemon.registerProject(projectBPath, "gc-b");
    const oldSession = { "openai/session": "old-conversation" };
    const freshSession = { "openai/session": "fresh-conversation" };
    let mcp = await connectMcp(daemon.mcpUrl);

    try {
        expectToolOk(await mcp.call("project_select", { project_id: projectA.id }, oldSession));
        expectToolOk(await mcp.call("project_select", { project_id: projectB.id }, freshSession));
        await mcp.close();
        await daemon.close();

        const bindingsPath = join(env.home, ".codex-mcp", "session-bindings.json");
        await waitForFile(bindingsPath);
        await waitUntil(async () => {
            const state = await readJsonFile<{ bindings?: unknown[] }>(bindingsPath)
                .catch((): { bindings?: unknown[] } => ({}));
            return state.bindings?.length === 2;
        }, 2_000, "both durable bindings to flush");
        const persisted = await readJsonFile<{
            bindings?: Array<{
                projectId: string;
                lastSeenAt: string;
                [key: string]: unknown;
            }>;
        }>(bindingsPath);
        assert.equal(persisted.bindings?.length, 2);
        const rewritten = (persisted.bindings ?? []).map((row) =>
            row.projectId === projectA.id
                ? { ...row, lastSeenAt: "2000-01-01T00:00:00.000Z" }
                : { ...row, lastSeenAt: new Date().toISOString() },
        );
        await writeJsonFile(bindingsPath, { bindings: rewritten });

        await daemon.restart();
        mcp = await connectMcp(daemon.mcpUrl);
        expectToolError(await mcp.call("read", { path: "identity.txt" }, oldSession), /绑定|bound|project_select/i);
        const freshRead = expectToolOk<{ content?: string }>(
            await mcp.call("read", { path: "identity.txt" }, freshSession),
        );
        assert.equal(freshRead.content, "GC-B\n");

        const afterGc = await readJsonFile<{ bindings?: Array<{ projectId: string }> }>(bindingsPath);
        assert.equal(afterGc.bindings?.some((row) => row.projectId === projectA.id), false);
        assert.equal(afterGc.bindings?.some((row) => row.projectId === projectB.id), true);
    } finally {
        await mcp.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("owner isolation contract: identical openai/session does not bridge two OAuth clients", async () => {
    const env = await createTestEnvironment("codex-mcp-oauth-owner-contract-");
    const projectAPath = await createProject("oauth-owner-a", { files: { "identity.txt": "OAUTH-A\n" } });
    const projectBPath = await createProject("oauth-owner-b", { files: { "identity.txt": "OAUTH-B\n" } });
    const external = await mkdtemp(join(tmpdir(), "codex-mcp-oauth-owner-external-"));
    const password = "owner-isolation-password";
    const daemon = await startDaemonHarness({
        home: env.home,
        bootstrapRoot: projectAPath,
        oauthRequired: true,
        password,
    });
    const projectA = await daemon.registerProject(projectAPath, "oauth-a");
    const projectB = await daemon.registerProject(projectBPath, "oauth-b");
    const authA = await issueOAuthSession({
        baseUrl: daemon.baseUrl,
        mcpUrl: daemon.mcpUrl,
        password,
        clientName: "owner-client-A",
        redirectPort: 55101,
    });
    const authB = await issueOAuthSession({
        baseUrl: daemon.baseUrl,
        mcpUrl: daemon.mcpUrl,
        password,
        clientName: "owner-client-B",
        redirectPort: 55102,
    });
    assert.notEqual(authA.clientId, authB.clientId);
    const clientA = await connectMcp(daemon.mcpUrl, { bearerToken: authA.accessToken, name: "owner-A" });
    const clientB = await connectMcp(daemon.mcpUrl, { bearerToken: authB.accessToken, name: "owner-B" });
    const sameConversation = { "openai/session": "same-visible-chat-session" };

    try {
        expectToolOk(await clientA.call("project_select", { project_id: projectA.id }, sameConversation));
        expectToolOk(await clientB.call("project_select", { project_id: projectB.id }, sameConversation));

        const readA = expectToolOk<{ content?: string }>(await clientA.call("read", { path: "identity.txt" }, sameConversation));
        const readB = expectToolOk<{ content?: string }>(await clientB.call("read", { path: "identity.txt" }, sameConversation));
        assert.equal(readA.content, "OAUTH-A\n");
        assert.equal(readB.content, "OAUTH-B\n");

        expectToolOk(await clientA.call("permission_grant", {
            capability: "write",
            path: external,
            duration: "session",
        }, sameConversation));
        expectToolOk(await clientA.call("write", {
            path: join(external, "client-a.txt"),
            content: "A only\n",
        }, sameConversation));
        expectToolError(
            await clientB.call("write", {
                path: join(external, "client-b.txt"),
                content: "must not inherit\n",
            }, sameConversation),
            /permission|授权/i,
        );

        const processA = expectToolOk<{ processId?: number }>(await clientA.call("exec_command", {
            command: process.platform === "win32" ? "Start-Sleep -Seconds 30" : "sleep 30",
            yield_time_ms: 0,
        }, sameConversation));
        assert.ok(processA.processId);
        expectToolError(
            await clientB.call("process_status", { processId: processA.processId }, sameConversation),
            /Unknown processId|process/i,
        );
        expectToolOk(await clientA.call("process_kill", { processId: processA.processId }, sameConversation));

        assert.equal(await readFile(join(external, "client-a.txt"), "utf8"), "A only\n");
        await assert.rejects(readFile(join(external, "client-b.txt"), "utf8"), /ENOENT/);
    } finally {
        await clientA.close().catch(() => undefined);
        await clientB.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});
