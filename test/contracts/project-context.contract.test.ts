import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
    connectMcp,
    createProject,
    createTestEnvironment,
    discoverSkillRegistry,
    expectToolError,
    expectToolOk,
    resultText,
    startSingleProjectHarness,
} from "./harness.js";

test("project context contract: AGENTS instructions are path-scoped and additive", async () => {
    const env = await createTestEnvironment("codex-mcp-agents-contract-");
    const project = await createProject("agents", {
        files: {
            "AGENTS.md": "ROOT-RULE: keep public behavior stable.\n",
            "nested/AGENTS.md": "NESTED-RULE: verify nested behavior independently.\n",
            "nested/file.ts": "export const value = 1;\n",
            "outside.ts": "export const outside = true;\n",
        },
    });
    const server = await startSingleProjectHarness({ root: project });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const nested = expectToolOk<{
            files?: Array<{ path: string; content: string; source: string }>;
        }>(await mcp.call("agents_for_path", { path: "nested/file.ts" }));
        const nestedContents = (nested.files ?? []).map((file) => file.content).join("\n");
        assert.match(nestedContents, /ROOT-RULE/);
        assert.match(nestedContents, /NESTED-RULE/);

        const rootOnly = expectToolOk<{
            files?: Array<{ path: string; content: string; source: string }>;
        }>(await mcp.call("agents_for_path", { path: "outside.ts" }));
        const rootContents = (rootOnly.files ?? []).map((file) => file.content).join("\n");
        assert.match(rootContents, /ROOT-RULE/);
        assert.doesNotMatch(rootContents, /NESTED-RULE/);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("skill contract: discovered external skills are readable but cannot escape their own directories", async () => {
    const env = await createTestEnvironment("codex-mcp-skills-contract-");
    const project = await createProject("skills");
    const agentsRoot = join(env.home, ".agents", "skills");
    const codexRoot = join(env.home, ".codex", "skills");
    const claudeRoot = join(env.home, ".claude", "skills");
    await createSkill(agentsRoot, "agent-check", "Agent source skill", "AGENT-SKILL-CONTENT");
    await createSkill(codexRoot, "codex-check", "Codex source skill", "CODEX-SKILL-CONTENT");
    await createSkill(claudeRoot, "claude-check", "Claude source skill", "CLAUDE-SKILL-CONTENT");

    const skills = discoverSkillRegistry([
        { path: agentsRoot, source: "agents", scope: "user" },
        { path: codexRoot, source: "codex", scope: "user" },
        { path: claudeRoot, source: "claude", scope: "user" },
    ]);
    const server = await startSingleProjectHarness({ root: project, skills });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const listed = expectToolOk<{
            count?: number;
            skills?: Array<{ name: string; source: string; description: string }>;
        }>(await mcp.call("skills_list", {}));
        assert.equal(listed.count, 3);
        assert.deepEqual(
            (listed.skills ?? []).map((skill) => [skill.name, skill.source]).sort(),
            [
                ["agent-check", "agents"],
                ["claude-check", "claude"],
                ["codex-check", "codex"],
            ],
        );

        for (const [name, marker] of [
            ["agent-check", "AGENT-SKILL-CONTENT"],
            ["codex-check", "CODEX-SKILL-CONTENT"],
            ["claude-check", "CLAUDE-SKILL-CONTENT"],
        ] as const) {
            const read = expectToolOk<{ content?: string }>(await mcp.call("skill_read", { name }));
            assert.match(read.content ?? "", new RegExp(marker));
        }

        expectToolError(
            await mcp.call("skill_read", { name: "agent-check", path: "../secret.txt" }),
            /escape|relative|invalid|path/i,
        );
        expectToolError(
            await mcp.call("skill_read", { name: "does-not-exist" }),
            /unknown skill/i,
        );
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("goal contract: completion fails closed until tasks and acceptance criteria have explicit evidence", async () => {
    const env = await createTestEnvironment("codex-mcp-goal-contract-");
    const project = await createProject("goal");
    const server = await startSingleProjectHarness({ root: project });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const started = expectToolOk<{
            goal?: {
                id?: string;
                tasks?: Array<{ id: string; status: string }>;
                acceptanceCriteria?: Array<{ id: string; status: string }>;
            };
        }>(await mcp.call("goal_start", {
            objective: "prove goal state machine",
            tasks: [{ title: "perform external verification" }],
            acceptance_criteria: ["external evidence recorded"],
        }));
        const goalId = started.goal?.id;
        const taskId = started.goal?.tasks?.[0]?.id;
        const criterionId = started.goal?.acceptanceCriteria?.[0]?.id;
        assert.ok(goalId);
        assert.ok(taskId);
        assert.ok(criterionId);

        expectToolError(
            await mcp.call("goal_finish", { goal_id: goalId, summary: "premature" }),
            /task|criterion|acceptance|完成|验收/i,
        );

        expectToolOk(await mcp.call("goal_update", {
            goal_id: goalId,
            task_updates: [{ task_id: taskId, status: "done" }],
        }));
        expectToolError(
            await mcp.call("goal_finish", { goal_id: goalId, summary: "still premature" }),
            /criterion|acceptance|验收/i,
        );

        expectToolOk(await mcp.call("goal_verify", {
            goal_id: goalId,
            criterion_id: criterionId,
            status: "passed",
            evidence: "black-box contract observed the required external result",
        }));
        expectToolOk(await mcp.call("goal_finish", {
            goal_id: goalId,
            summary: "goal state machine verified",
        }));

        const status = expectToolOk<{
            goal?: { status?: string } | null;
            recent?: Array<{ id?: string; status?: string }>;
        }>(await mcp.call("goal_status", { goal_id: goalId }));
        assert.equal(status.goal?.status ?? status.recent?.find((row) => row.id === goalId)?.status, "completed");
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("UI settings contract: display preferences persist across MCP reconnects and refresh requests do not change values", async () => {
    const env = await createTestEnvironment("codex-mcp-ui-contract-");
    const project = await createProject("ui");
    const server = await startSingleProjectHarness({ root: project });
    let mcp = await connectMcp(server.mcpUrl);

    try {
        const before = expectToolOk<{ ui?: { tools?: boolean; status?: boolean } }>(
            await mcp.call("settings_get", {}),
        );
        assert.equal(typeof before.ui?.tools, "boolean");
        assert.equal(typeof before.ui?.status, "boolean");

        const updated = expectToolOk<{
            ui?: { tools?: boolean; status?: boolean };
            toolListChangedRequested?: boolean;
        }>(await mcp.call("settings_update", { tools: true, status: false }));
        assert.deepEqual(updated.ui, { tools: true, status: false });
        assert.equal(updated.toolListChangedRequested, true);

        await mcp.close();
        mcp = await connectMcp(server.mcpUrl);
        const afterReconnect = expectToolOk<{ ui?: { tools?: boolean; status?: boolean } }>(
            await mcp.call("settings_get", {}),
        );
        assert.deepEqual(afterReconnect.ui, { tools: true, status: false });

        const refreshOnly = expectToolOk<{
            ui?: { tools?: boolean; status?: boolean };
            toolListChangedRequested?: boolean;
        }>(await mcp.call("settings_update", {}));
        assert.deepEqual(refreshOnly.ui, { tools: true, status: false });
        assert.equal(refreshOnly.toolListChangedRequested, true);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await env.cleanup();
    }
});

async function createSkill(
    root: string,
    name: string,
    description: string,
    marker: string,
): Promise<void> {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        "---",
        marker,
        "",
    ].join("\n"), "utf8");
}
