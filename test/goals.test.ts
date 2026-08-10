import assert from "node:assert/strict";
import { mkdir, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GoalStore } from "../src/goals/store.js";
import { ProjectContext } from "../src/project.js";

async function main(): Promise<void> {
    const root = await mkdtemp(join(tmpdir(), "codex-mcp-goal-workspace-"));
    const storageDir = await mkdtemp(join(tmpdir(), "codex-mcp-goal-state-"));
    await mkdir(join(root, "project-a"));
    await mkdir(join(root, "project-b"));

    const first = new GoalStore(new ProjectContext(root), storageDir);
    const started = await first.start({
        scopePath: "project-a",
        objective: "Ship a verified goal runtime",
        constraints: ["Do not mutate unrelated project files"],
        tasks: [
            { title: "Implement durable storage" },
            { title: "Verify recovery" },
        ],
        acceptanceCriteria: [
            "Goal state survives a new GoalStore instance",
            "Completion is blocked until every task and criterion passes",
        ],
    });
    assert.equal(started.status, "active");
    assert.equal(started.scopePath, "project-a");
    assert.equal(started.tasks.length, 2);
    assert.equal(started.acceptanceCriteria.length, 2);

    await assert.rejects(
        first.start({
            scopePath: "project-a",
            objective: "Second active goal in same scope",
            acceptanceCriteria: ["Never starts"],
        }),
        /unfinished goal already exists/i,
    );

    // A workspace root may contain many repos. Different scopes must not block each other.
    const parallel = await first.start({
        scopePath: "project-b",
        objective: "Independent scoped goal",
        acceptanceCriteria: ["Can coexist with project-a goal"],
    });
    assert.equal(parallel.scopePath, "project-b");
    const ambiguous = await first.status();
    assert.equal(ambiguous.goal, null);
    assert.equal(ambiguous.activeGoals.length, 2);
    await assert.rejects(
        first.update({ checkpoint: { summary: "Ambiguous update" } }),
        /Multiple active goals exist/i,
    );

    const updated = await first.update({
        scopePath: "project-a",
        taskUpdates: [
            { taskId: "task_1", status: "done", note: "Atomic JSON persistence implemented" },
            { taskId: "task_2", status: "in_progress" },
        ],
        checkpoint: {
            summary: "Storage implementation is complete; recovery test remains.",
            next: "Create a fresh store instance and restore the active goal.",
            findings: ["Goal state is scoped inside a multi-project workspace"],
        },
    });
    assert.equal(updated.tasks[0]?.status, "done");
    assert.equal(updated.checkpoints.length, 1);

    // A fresh store instance simulates a later stateless MCP request/process or chat.
    const second = new GoalStore(new ProjectContext(root), storageDir);
    const restored = await second.status(undefined, "project-a");
    assert.equal(restored.goal?.id, started.id);
    assert.equal(restored.goal?.scopePath, "project-a");
    assert.equal(restored.goal?.checkpoints[0]?.next, "Create a fresh store instance and restore the active goal.");

    await second.verify({
        scopePath: "project-a",
        criterionId: "criterion_1",
        status: "passed",
        evidence: "A fresh GoalStore instance restored the same scoped goal and checkpoint from disk.",
    });

    await assert.rejects(
        second.finish(undefined, "project-a", "Too early"),
        /unfinished tasks: task_2.*acceptance criteria not passed: criterion_2/i,
    );

    await second.update({
        scopePath: "project-a",
        taskUpdates: [{ taskId: "task_2", status: "done" }],
    });
    await second.verify({
        scopePath: "project-a",
        criterionId: "criterion_2",
        status: "failed",
        evidence: "The second criterion has not passed yet.",
    });
    await assert.rejects(
        second.finish(undefined, "project-a", "Still too early"),
        /acceptance criteria not passed: criterion_2/i,
    );

    await second.verify({
        scopePath: "project-a",
        criterionId: "criterion_2",
        status: "passed",
        evidence: "goal_finish rejected incomplete work and succeeded only after both tasks were done and criteria passed.",
    });
    const completed = await second.finish(
        undefined,
        "project-a",
        "Durable scoped goal runtime verified.",
    );
    assert.equal(completed.status, "completed");
    assert.equal(completed.completionSummary, "Durable scoped goal runtime verified.");

    const afterCompletion = await second.status(undefined, "project-a");
    assert.equal(afterCompletion.goal?.status, "completed");
    assert.equal(afterCompletion.activeGoals.length, 1);
    assert.equal(afterCompletion.activeGoals[0]?.id, parallel.id);

    const cancelled = await second.cancel(undefined, "project-b", "Test cleanup");
    assert.equal(cancelled.status, "cancelled");
    assert.equal((await second.status()).activeGoals.length, 0);

    console.log("goals.test.ts: ok");
}

void main();
