import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInstructionRegistry } from "../src/agents/registry.js";
import { resolveAllowedToolsFromConfig } from "../src/capabilities/policy.js";
import { buildServerInstructions } from "../src/server/mcp-server.js";
import { ProjectContext } from "../src/config/project.js";
import { connectMcpClient } from "./helpers/mcp-client.js";
import { startTestServer } from "./helpers/start-server.js";

async function main(): Promise<void> {
    const all = resolveAllowedToolsFromConfig(undefined, "client-a", [
        "read",
        "write",
        "mcp_tools",
    ]);
    assert.deepEqual([...all], ["read", "write", "mcp_tools"]);

    const restricted = resolveAllowedToolsFromConfig(
        {
            default: ["read", "git_*"],
            clients: {
                "client-a": ["read", "grep", "mcp_*"],
                "client-none": [],
            },
        },
        "client-a",
        ["read", "grep", "write", "git_log", "mcp_tools", "mcp_call"],
    );
    assert.deepEqual([...restricted], ["read", "grep", "mcp_tools", "mcp_call"]);
    assert.deepEqual(
        [
            ...resolveAllowedToolsFromConfig(
                { default: ["read", "git_*"] },
                "other",
                ["read", "write", "git_log", "git_diff"],
            ),
        ],
        ["read", "git_log", "git_diff"],
    );
    assert.equal(
        resolveAllowedToolsFromConfig(
            { clients: { "client-none": [] } },
            "client-none",
            ["read"],
        ).size,
        0,
    );

    const policyProject = await mkdtemp(join(tmpdir(), "codex-mcp-policy-project-"));
    const policyHome = await mkdtemp(join(tmpdir(), "codex-mcp-policy-home-"));
    await mkdir(join(policyHome, ".codex"), { recursive: true });
    await writeFile(join(policyHome, ".codex", "AGENTS.md"), "PRIVATE-GLOBAL-AGENT-RULE\n", "utf8");
    await writeFile(join(policyProject, "AGENTS.md"), "PRIVATE-PROJECT-AGENT-RULE\n", "utf8");
    const policyAgents = new AgentInstructionRegistry(new ProjectContext(policyProject), policyHome);

    const noneInstructions = buildServerInstructions(
        policyProject,
        undefined,
        undefined,
        policyAgents,
        new Set(),
    );
    assert.match(noneInstructions, /No coding tools are enabled/);
    assert.doesNotMatch(noneInstructions, /exec_command|write_stdin|process_kill/);
    assert.doesNotMatch(noneInstructions, /summary\(done=/);
    assert.doesNotMatch(noneInstructions, /edit\/write\/bash/);
    assert.doesNotMatch(noneInstructions, /PRIVATE-(?:GLOBAL|PROJECT)-AGENT-RULE/);

    const agentsInstructions = buildServerInstructions(
        policyProject,
        undefined,
        undefined,
        policyAgents,
        new Set(["agents_for_path"]),
    );
    assert.match(agentsInstructions, /PRIVATE-GLOBAL-AGENT-RULE/);
    assert.match(agentsInstructions, /PRIVATE-PROJECT-AGENT-RULE/);

    const allowed = new Set(["read", "grep", "skills_list"]);
    const ctx = await startTestServer({
        allowedToolsResolver: () => allowed,
    });
    const mcp = await connectMcpClient(ctx.mcpUrl);
    try {
        const names = await mcp.listToolNames();
        assert.deepEqual(names, ["grep", "read", "skills_list"]);

        const instructions = buildServerInstructions(
            ctx.fixtureRoot,
            undefined,
            undefined,
            undefined,
            allowed,
        );
        assert.match(instructions, /- read/);
        assert.match(instructions, /- grep/);
        assert.match(instructions, /- skills_list/);
        assert.doesNotMatch(instructions, /- bash/);
        assert.doesNotMatch(instructions, /mcp_tools/);
        assert.doesNotMatch(instructions, /git_log/);
    } finally {
        await mcp.close().catch(() => undefined);
        await ctx.server.close().catch(() => undefined);
    }

    console.log("capability-policy.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
