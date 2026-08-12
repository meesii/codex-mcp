import assert from "node:assert/strict";
import { mkdtemp, readFile, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryPermissionGrantStore } from "../src/permissions/store.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";
import { startTestServer } from "./helpers/start-server.js";

async function main(): Promise<void> {
    const permissionStore = new MemoryPermissionGrantStore();
    const ctx = await startTestServer({ permissionStore });
    const externalRoot = await mkdtemp(join(tmpdir(), "codex-mcp-permission-"));
    await writeFile(join(externalRoot, "readable.txt"), "outside-readable\n", "utf8");

    const client = await connectMcpClient(ctx.mcpUrl);
    try {
        const readResult = await client.callTool("read", {
            path: join(externalRoot, "readable.txt"),
        });
        assert.notEqual(readResult.isError, true, toolText(readResult));
        assert.match(
            String((readResult.structuredContent as { content?: string })?.content ?? ""),
            /outside-readable/,
        );

        const listResult = await client.callTool("ls", { path: externalRoot });
        assert.notEqual(listResult.isError, true, toolText(listResult));

        const deniedWrite = await client.callTool("write", {
            path: join(externalRoot, "denied.txt"),
            content: "no\n",
        });
        assert.equal(deniedWrite.isError, true);
        assert.match(toolText(deniedWrite), /permission_grant|授权/);

        const onceGrant = await client.callTool("permission_grant", {
            capability: "write",
            path: externalRoot,
            duration: "once",
        });
        assert.notEqual(onceGrant.isError, true, toolText(onceGrant));

        const onceWrite = await client.callTool("write", {
            path: join(externalRoot, "once.txt"),
            content: "once\n",
        });
        assert.notEqual(onceWrite.isError, true, toolText(onceWrite));
        assert.equal(await readFile(join(externalRoot, "once.txt"), "utf8"), "once\n");

        const onceConsumed = await client.callTool("write", {
            path: join(externalRoot, "once-consumed.txt"),
            content: "no\n",
        });
        assert.equal(onceConsumed.isError, true, "one-time grant must be consumed after one operation");

        const sessionGrant = await client.callTool("permission_grant", {
            capability: "write",
            path: externalRoot,
        });
        assert.notEqual(sessionGrant.isError, true, toolText(sessionGrant));
        assert.equal(
            (sessionGrant.structuredContent as { duration?: string }).duration,
            "session",
            "permission_grant should default to session scope",
        );

        for (const name of ["session-a.txt", "session-b.txt"]) {
            const result = await client.callTool("write", {
                path: join(externalRoot, name),
                content: `${name}\n`,
            });
            assert.notEqual(result.isError, true, toolText(result));
        }

        const conversationRoot = await mkdtemp(join(tmpdir(), "codex-mcp-conversation-permission-"));
        const conversationA = { "openai/session": "conversation-a" };
        const conversationB = { "openai/session": "conversation-b" };
        const conversationGrant = await client.callTool(
            "permission_grant",
            {
                capability: "write",
                path: conversationRoot,
                duration: "session",
            },
            conversationA,
        );
        assert.notEqual(conversationGrant.isError, true, toolText(conversationGrant));
        const sameConversationWrite = await client.callTool(
            "write",
            {
                path: join(conversationRoot, "same-conversation.txt"),
                content: "allowed\n",
            },
            conversationA,
        );
        assert.notEqual(sameConversationWrite.isError, true, toolText(sameConversationWrite));
        const otherConversationWrite = await client.callTool(
            "write",
            {
                path: join(conversationRoot, "other-conversation.txt"),
                content: "must-not-write\n",
            },
            conversationB,
        );
        assert.equal(
            otherConversationWrite.isError,
            true,
            "session grants must not cross ChatGPT conversation ids",
        );
    } finally {
        await client.close();
    }

    const permanentRoot = await mkdtemp(join(tmpdir(), "codex-mcp-permanent-"));
    const canonicalPermanentRoot = await realpath(permanentRoot);
    const grantClient = await connectMcpClient(ctx.mcpUrl);
    try {
        const permanentGrant = await grantClient.callTool("permission_grant", {
            capability: "write",
            path: permanentRoot,
            duration: "permanent",
        });
        assert.notEqual(permanentGrant.isError, true, toolText(permanentGrant));
        const first = await grantClient.callTool("write", {
            path: join(permanentRoot, "first.txt"),
            content: "permanent\n",
        });
        assert.notEqual(first.isError, true, toolText(first));
    } finally {
        await grantClient.close();
    }

    const reusedPermanentClient = await connectMcpClient(ctx.mcpUrl);
    try {
        const result = await reusedPermanentClient.callTool("write", {
            path: join(permanentRoot, "second.txt"),
            content: "still-allowed\n",
        });
        assert.notEqual(result.isError, true, toolText(result));
        assert.equal(await readFile(join(permanentRoot, "second.txt"), "utf8"), "still-allowed\n");

        const listed = await reusedPermanentClient.callTool("permission_list", {});
        assert.notEqual(listed.isError, true, toolText(listed));
        const grants = (listed.structuredContent as {
            grants?: Array<{ capability: string; path: string; duration: string }>;
        }).grants ?? [];
        assert.ok(
            grants.some(
                (grant) =>
                    grant.capability === "write" &&
                    grant.path === canonicalPermanentRoot &&
                    grant.duration === "permanent",
            ),
        );

        const revoked = await reusedPermanentClient.callTool("permission_revoke", {
            capability: "write",
            path: permanentRoot,
        });
        assert.notEqual(revoked.isError, true, toolText(revoked));
        assert.equal((revoked.structuredContent as { removed?: number }).removed, 1);

        const afterRevoke = await reusedPermanentClient.callTool("write", {
            path: join(permanentRoot, "after-revoke.txt"),
            content: "no\n",
        });
        assert.equal(afterRevoke.isError, true, "revoked permanent grant must stop later writes");
    } finally {
        await reusedPermanentClient.close();
    }

    const patchRootA = await mkdtemp(join(tmpdir(), "codex-mcp-patch-a-"));
    const patchRootB = await mkdtemp(join(tmpdir(), "codex-mcp-patch-b-"));
    const patchFileA = join(patchRootA, "a.txt");
    const patchFileB = join(patchRootB, "b.txt");
    await writeFile(patchFileA, "alpha\n", "utf8");
    await writeFile(patchFileB, "beta\n", "utf8");
    const patchClient = await connectMcpClient(ctx.mcpUrl);
    try {
        for (const path of [patchRootA, patchRootB]) {
            const grant = await patchClient.callTool("permission_grant", {
                capability: "write",
                path,
                duration: "session",
            });
            assert.notEqual(grant.isError, true, toolText(grant));
        }
        const patch = [
            `--- ${patchFileA}`,
            `+++ ${patchFileA}`,
            "@@ -1,1 +1,1 @@",
            "-alpha",
            "+ALPHA",
            `--- ${patchFileB}`,
            `+++ ${patchFileB}`,
            "@@ -1,1 +1,1 @@",
            "-beta",
            "+BETA",
            "",
        ].join("\n");
        const patched = await patchClient.callTool("apply_patch", { patch });
        assert.notEqual(patched.isError, true, toolText(patched));
        assert.equal(await readFile(patchFileA, "utf8"), "ALPHA\n");
        assert.equal(await readFile(patchFileB, "utf8"), "BETA\n");
    } finally {
        await patchClient.close();
    }

    const execRoot = await mkdtemp(join(tmpdir(), "codex-mcp-exec-"));
    const execClient = await connectMcpClient(ctx.mcpUrl);
    try {
        const command = process.platform === "win32"
            ? 'node -e "process.stdout.write(process.cwd())"'
            : "node -e 'process.stdout.write(process.cwd())'";

        const deniedExec = await execClient.callTool("bash", {
            command,
            cwd: execRoot,
            output_mode: "full",
        });
        assert.equal(deniedExec.isError, true);
        assert.match(toolText(deniedExec), /permission_grant|授权/);

        const execGrant = await execClient.callTool("permission_grant", {
            capability: "exec",
            path: execRoot,
            duration: "once",
        });
        assert.notEqual(execGrant.isError, true, toolText(execGrant));

        const result = await execClient.callTool("bash", {
            command,
            cwd: execRoot,
            output_mode: "full",
        });
        assert.notEqual(result.isError, true, toolText(result));
        assert.equal(
            String((result.structuredContent as { stdout?: string })?.stdout ?? ""),
            await realpath(execRoot),
        );

        const consumedExec = await execClient.callTool("bash", {
            command,
            cwd: execRoot,
        });
        assert.equal(consumedExec.isError, true, "one-time exec grant must be consumed");

        const processConversationA = { "openai/session": "process-conversation-a" };
        const processConversationB = { "openai/session": "process-conversation-b" };
        const longRunning = await execClient.callTool(
            "exec_command",
            {
                command: process.platform === "win32" ? "Start-Sleep -Seconds 60" : "sleep 60",
                yield_time_ms: 0,
            },
            processConversationA,
        );
        assert.notEqual(longRunning.isError, true, toolText(longRunning));
        const processId = (longRunning.structuredContent as { processId?: number }).processId;
        assert.ok(processId);

        const crossConversationPoll = await execClient.callTool(
            "write_stdin",
            { processId, yield_time_ms: 0 },
            processConversationB,
        );
        assert.equal(
            crossConversationPoll.isError,
            true,
            "managed process handles must not cross ChatGPT conversation ids",
        );
        assert.match(toolText(crossConversationPoll), /Unknown processId/);

        const sameConversationKill = await execClient.callTool(
            "process_kill",
            { processId },
            processConversationA,
        );
        assert.notEqual(sameConversationKill.isError, true, toolText(sameConversationKill));
    } finally {
        await execClient.close();
        await ctx.server.close();
    }

    console.log("permissions.test.ts: ok");
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
