import assert from "node:assert/strict";
import test from "node:test";
import {
    connectMcp,
    createProject,
    createTestEnvironment,
    expectToolOk,
    resultText,
    startDaemonHarness,
} from "./harness.js";

// Hand-authored from the compatibility contract. This is intentionally not
// imported from src/tools/surface.ts and not generated from the current server.
const FROZEN_CORE_TOOL_NAMES = [
    "server_info",
    "workspace_projects",
    "workspace_context",
    "context_pack",
    "read",
    "read_many",
    "grep",
    "glob",
    "ls",
    "write",
    "edit",
    "apply_patch",
    "bash",
    "exec_command",
    "write_stdin",
    "process_kill",
    "process_list",
    "process_status",
    "process_output",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_branches",
] as const;

const OLD_WORKSPACE_PROJECTS_SCHEMA = {
    name: "workspace_projects",
    input_properties: ["max_depth"],
} as const;

const REFRESHED_WORKSPACE_PROJECTS_SCHEMA = {
    name: "workspace_projects",
    input_properties: ["max_depth", "project_id", "project_path", "force"],
} as const;

test("ChatGPT ABI contract: a visible tool with a frozen selector-less schema is fail-closed", async () => {
    const env = await createTestEnvironment("codex-mcp-chatgpt-abi-");
    const projectPath = await createProject("chatgpt-abi", { files: { "identity.txt": "ABI\n" } });
    const daemon = await startDaemonHarness({ home: env.home, bootstrapRoot: projectPath });
    const project = await daemon.registerProject(projectPath, "abi-project");
    const mcp = await connectMcp(daemon.mcpUrl);
    const session = { "openai/session": "frozen-host-conversation" };

    try {
        const currentTools = await mcp.listTools();
        const currentWorkspaceProjects = currentTools.find((tool) => tool.name === "workspace_projects");
        assert.ok(currentWorkspaceProjects, "current server must publish workspace_projects");
        const currentProperties = schemaProperties(currentWorkspaceProjects.inputSchema);
        assert.equal(currentProperties.has("project_id"), true, "current refreshed schema exposes project_id");

        const frozenInfo = expectToolOk<{
            compatibility?: {
                fallback?: {
                    projectBinding?: {
                        available?: boolean;
                        hostAvailable?: boolean | null;
                        staleSnapshotRecovery?: string;
                    };
                };
                selfCheck?: {
                    hostMissingStableTools?: string[];
                    hostProjectBindingAvailable?: boolean | null;
                    hostCoreWorkflowAvailable?: boolean | null;
                    hostActionSnapshotStale?: boolean | null;
                    hostIncompatibleToolSchemas?: string[];
                };
            };
        }>(await mcp.call("server_info", {
            host_tools: [...FROZEN_CORE_TOOL_NAMES],
            host_tool_schemas: [OLD_WORKSPACE_PROJECTS_SCHEMA],
        }, session));

        const frozenCompatibility = frozenInfo.compatibility;
        assert.deepEqual(frozenCompatibility?.selfCheck?.hostMissingStableTools, []);
        assert.equal(frozenCompatibility?.selfCheck?.hostProjectBindingAvailable, false);
        assert.equal(frozenCompatibility?.selfCheck?.hostCoreWorkflowAvailable, false);
        assert.equal(frozenCompatibility?.selfCheck?.hostActionSnapshotStale, true);
        assert.equal(
            frozenCompatibility?.selfCheck?.hostIncompatibleToolSchemas?.some((entry) =>
                entry.includes("workspace_projects") && entry.includes("project_id/project_path"),
            ),
            true,
        );
        assert.equal(frozenCompatibility?.fallback?.projectBinding?.available, true);
        assert.equal(frozenCompatibility?.fallback?.projectBinding?.hostAvailable, false);
        assert.match(
            frozenCompatibility?.fallback?.projectBinding?.staleSnapshotRecovery ?? "",
            /Refresh|re-publish/i,
        );

        // Omitting schema evidence must also fail closed. Tool-name presence alone
        // is not proof that the frozen host can transmit new optional arguments.
        const unknownSchemaInfo = expectToolOk<{
            compatibility?: { selfCheck?: { hostProjectBindingAvailable?: boolean | null } };
        }>(await mcp.call("server_info", {
            host_tools: [...FROZEN_CORE_TOOL_NAMES],
        }, session));
        assert.equal(unknownSchemaInfo.compatibility?.selfCheck?.hostProjectBindingAvailable, false);

        const refreshedInfo = expectToolOk<{
            compatibility?: {
                selfCheck?: {
                    hostProjectBindingAvailable?: boolean | null;
                    hostCoreWorkflowAvailable?: boolean | null;
                };
            };
        }>(await mcp.call("server_info", {
            host_tools: [...FROZEN_CORE_TOOL_NAMES],
            host_tool_schemas: [REFRESHED_WORKSPACE_PROJECTS_SCHEMA],
        }, session));
        assert.equal(refreshedInfo.compatibility?.selfCheck?.hostProjectBindingAvailable, true);
        assert.equal(refreshedInfo.compatibility?.selfCheck?.hostCoreWorkflowAvailable, true);

        // Backend compatibility is tested separately from frozen-host capability:
        // when the approved schema really has project_id, the public tool can bind.
        const bindViaCompatibility = await mcp.call("workspace_projects", {
            project_id: project.id,
            max_depth: 2,
        }, session);
        assert.notEqual(bindViaCompatibility.isError, true, resultText(bindViaCompatibility));
        const binding = (bindViaCompatibility.structuredContent as {
            binding?: { projectId?: string; projectPath?: string } | null;
        }).binding;
        assert.equal(binding?.projectId, project.id);
        assert.equal(binding?.projectPath, project.path);

        const read = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }, session));
        assert.equal(read.content, "ABI\n");
    } finally {
        await mcp.close().catch(() => undefined);
        await daemon.close().catch(() => undefined);
        await env.cleanup();
    }
});

function schemaProperties(inputSchema: unknown): Set<string> {
    if (!inputSchema || typeof inputSchema !== "object") return new Set();
    const properties = (inputSchema as { properties?: unknown }).properties;
    if (!properties || typeof properties !== "object") return new Set();
    return new Set(Object.keys(properties));
}
