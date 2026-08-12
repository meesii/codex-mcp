import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BindingStore } from "../src/projects/bindings.js";
import { ProjectRegistry } from "../src/projects/registry.js";
import { ProjectRuntimeManager } from "../src/projects/runtime.js";
import { TOOL_NAMES } from "../src/tools/names.js";
import {
    CHATGPT_STABLE_BOOTSTRAP_TOOLS,
    checkChatGptCompatibility,
} from "../src/tools/surface.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";
import { startTestServer } from "./helpers/start-server.js";

const LEGACY_SNAPSHOT_MISSING_TOOLS = [
    "project_list",
    "project_select",
    "project_current",
    "project_unbind",
    "permission_list",
    "permission_grant",
    "permission_revoke",
    "workspace_roots",
    "workspace_add",
    "workspace_remove",
    "project_control",
    "permission_control",
    "workspace_control",
] as const;

async function main(): Promise<void> {
    const legacySnapshot = TOOL_NAMES.filter(
        (name) => !(LEGACY_SNAPSHOT_MISSING_TOOLS as readonly string[]).includes(name),
    );
    const staticCheck = checkChatGptCompatibility(TOOL_NAMES, legacySnapshot);
    assert.equal(staticCheck.serverCoreWorkflowAvailable, true);
    assert.equal(staticCheck.hostCoreWorkflowAvailable, true);
    assert.equal(staticCheck.hostActionSnapshotStale, true);
    assert.deepEqual(staticCheck.hostMissingStableTools, []);
    assert.deepEqual(
        staticCheck.hostMissingServerTools,
        [...LEGACY_SNAPSHOT_MISSING_TOOLS].sort(),
    );
    assert.ok(CHATGPT_STABLE_BOOTSTRAP_TOOLS.includes("workspace_projects"));

    const registry = new ProjectRegistry({
        projects: [],
        save: async () => undefined,
    });
    const bindings = new BindingStore({
        bindings: [],
        save: async () => undefined,
    });
    const runtimes = new ProjectRuntimeManager({
        goalStorageDir: await mkdtemp(join(tmpdir(), "codex-mcp-chatgpt-compat-goals-")),
    });
    const ctx = await startTestServer({
        daemon: {
            registry,
            bindings,
            runtimes,
            controlToken: "chatgpt-compat-test-token",
            tunnelStatus: () => ({ running: false }),
            onShutdown: async () => undefined,
        },
    });
    const registered = registry.register({ path: ctx.fixtureRoot, name: "compat-fixture" });
    const mcp = await connectMcpClient(ctx.mcpUrl);
    const session = { "openai/session": "legacy-snapshot-conversation" };

    try {
        const listed = await mcp.client.listTools();
        const workspaceProjects = listed.tools.find((tool) => tool.name === "workspace_projects");
        assert.ok(workspaceProjects);
        assert.equal(workspaceProjects.annotations?.readOnlyHint, false);
        assert.equal(workspaceProjects.annotations?.destructiveHint, false);
        assert.ok(
            workspaceProjects.inputSchema &&
            "properties" in workspaceProjects.inputSchema &&
            workspaceProjects.inputSchema.properties &&
            "project_id" in workspaceProjects.inputSchema.properties,
            "stable workspace_projects ABI must retain the optional project_id selector",
        );

        const beforeBind = await mcp.callTool("read", { path: "hello.txt" }, session);
        assert.equal(beforeBind.isError, true);
        assert.match(toolText(beforeBind), /project_select\(project_id=/);
        assert.match(toolText(beforeBind), /workspace_projects\(project_id=/);

        const bind = await mcp.callTool(
            "workspace_projects",
            { project_id: registered.id, max_depth: 2 },
            session,
        );
        assert.notEqual(bind.isError, true, toolText(bind));
        const bindData = bind.structuredContent as {
            binding?: { projectId?: string; projectPath?: string } | null;
        };
        assert.equal(bindData.binding?.projectId, registered.id);
        assert.equal(bindData.binding?.projectPath, registered.path);

        const context = await mcp.callTool(
            "workspace_context",
            { intent: "verify legacy ChatGPT compatibility" },
            session,
        );
        assert.notEqual(context.isError, true, toolText(context));

        const read = await mcp.callTool("read", { path: "hello.txt" }, session);
        assert.notEqual(read.isError, true, toolText(read));
        const edit = await mcp.callTool(
            "edit",
            {
                path: "hello.txt",
                old_string: "unique-marker-alpha",
                new_string: "unique-marker-compat",
            },
            session,
        );
        assert.notEqual(edit.isError, true, toolText(edit));

        const gitInit = await mcp.callTool(
            "bash",
            { command: "git init", output_mode: "full" },
            session,
        );
        assert.notEqual(gitInit.isError, true, toolText(gitInit));
        const git = await mcp.callTool("git_status", {}, session);
        assert.notEqual(git.isError, true, toolText(git));

        const command = process.platform === "win32"
            ? 'node -e "process.stdout.write(\'compat-exec\')"'
            : "node -e \"process.stdout.write('compat-exec')\"";
        const exec = await mcp.callTool(
            "bash",
            { command, output_mode: "full" },
            session,
        );
        assert.notEqual(exec.isError, true, toolText(exec));
        assert.match(
            String((exec.structuredContent as { stdout?: string }).stdout ?? ""),
            /compat-exec/,
        );

        const serverInfo = await mcp.callTool(
            "server_info",
            { host_tools: legacySnapshot },
            session,
        );
        assert.notEqual(serverInfo.isError, true, toolText(serverInfo));
        const selfCheck = (serverInfo.structuredContent as {
            compatibility?: {
                surfaceVersion?: string;
                fallback?: {
                    projectBinding?: { available?: boolean };
                    persistentWorkspaceTrust?: { includedInReadOnlyCompatibilityTool?: boolean };
                };
                selfCheck?: {
                    hostActionSnapshotStale?: boolean | null;
                    hostCoreWorkflowAvailable?: boolean | null;
                    hostMissingStableTools?: string[];
                };
            };
        }).compatibility;
        assert.equal(selfCheck?.surfaceVersion, "1.0.0");
        assert.equal(selfCheck?.fallback?.projectBinding?.available, true);
        assert.equal(
            selfCheck?.fallback?.persistentWorkspaceTrust?.includedInReadOnlyCompatibilityTool,
            false,
        );
        assert.equal(selfCheck?.selfCheck?.hostActionSnapshotStale, true);
        assert.equal(selfCheck?.selfCheck?.hostCoreWorkflowAvailable, true);
        assert.deepEqual(selfCheck?.selfCheck?.hostMissingStableTools, []);
    } finally {
        await mcp.close().catch(() => undefined);
        await ctx.server.close().catch(() => undefined);
        await runtimes.shutdownAll().catch(() => undefined);
    }

    console.log("chatgpt-compatibility.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
