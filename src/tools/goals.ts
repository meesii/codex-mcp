import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import {
    GOAL_CRITERION_STATUSES,
    GOAL_STATUSES,
    GOAL_TASK_STATUSES,
    type GoalRecord,
    type GoalTaskStatus,
} from "../goals/store.js";
import { registerTool } from "../lib/tool/log.js";
import {
    readOnlyAnnotations,
    stateWriteAnnotations,
    withToolAuth,
} from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import {
    projectErrorResult,
    type ToolScopeProvider,
} from "../server/project-router.js";

const MAX_TEXT = 8_000;
const MAX_LIST_ITEMS = 100;

const taskSchema = z.object({
    id: z.string(),
    title: z.string(),
    details: z.string().optional(),
    status: z.enum(GOAL_TASK_STATUSES),
    note: z.string().optional(),
    createdAt: z.string(),
    updatedAt: z.string(),
});

const criterionSchema = z.object({
    id: z.string(),
    text: z.string(),
    status: z.enum(GOAL_CRITERION_STATUSES),
    evidence: z.string().optional(),
    checkedAt: z.string().optional(),
});

const checkpointSchema = z.object({
    id: z.string(),
    summary: z.string(),
    next: z.string().optional(),
    findings: z.array(z.string()),
    blockers: z.array(z.string()),
    createdAt: z.string(),
});

const verificationSchema = z.object({
    id: z.string(),
    criterionId: z.string(),
    status: z.enum(["passed", "failed"]),
    evidence: z.string(),
    createdAt: z.string(),
});

const goalSchema = z.object({
    id: z.string(),
    projectRoot: z.string(),
    scopePath: z.string(),
    objective: z.string(),
    status: z.enum(GOAL_STATUSES),
    constraints: z.array(z.string()),
    tasks: z.array(taskSchema),
    acceptanceCriteria: z.array(criterionSchema),
    checkpoints: z.array(checkpointSchema),
    verifications: z.array(verificationSchema),
    createdAt: z.string(),
    updatedAt: z.string(),
    completedAt: z.string().optional(),
    completionSummary: z.string().optional(),
    cancelledAt: z.string().optional(),
    cancelReason: z.string().optional(),
});

const goalIdInput = z
    .string()
    .min(1)
    .max(128)
    .optional()
    .describe("Optional goal id. Omit when path identifies the intended active goal.");

const goalPathInput = z
    .string()
    .max(2_000)
    .optional()
    .describe("Optional primary-workspace-relative or absolute registered-workspace goal scope. Defaults to project_root for goal_start. Use this to disambiguate when multiple scoped goals are active.");

const boundedText = (label: string) => z.string().min(1).max(MAX_TEXT).describe(label);

export function registerGoalTools(server: McpServer, scope: ToolScopeProvider): void {
    registerTool(
        server,
        "goal_start",
        withToolAuth({
            title: "Start project goal",
            description:
                "Start one durable long-running goal for a primary or additional registered workspace scope. Use for multi-step work that may span many tool calls or chat turns, not trivial one-shot tasks. Include concrete acceptance criteria so goal_finish can enforce verification. Different scopes may have active goals concurrently; each scope allows only one unfinished goal.",
            inputSchema: {
                path: goalPathInput,
                objective: boundedText("The durable outcome this scoped project work should achieve."),
                constraints: z
                    .array(boundedText("A boundary or constraint that must remain true."))
                    .max(MAX_LIST_ITEMS)
                    .optional(),
                tasks: z
                    .array(
                        z.object({
                            title: boundedText("Short task title."),
                            details: boundedText("Optional task scope/details.").optional(),
                        }),
                    )
                    .max(MAX_LIST_ITEMS)
                    .optional(),
                acceptance_criteria: z
                    .array(boundedText("A concrete condition that proves the goal is complete."))
                    .min(1)
                    .max(MAX_LIST_ITEMS),
            },
            outputSchema: { goal: goalSchema },
            annotations: stateWriteAnnotations,
        }),
        async ({ path, objective, constraints, tasks, acceptance_criteria: acceptanceCriteria }) => {
            try {
                const { goals } = scope();
                const goal = await goals.start({
                    scopePath: path,
                    objective,
                    constraints,
                    tasks,
                    acceptanceCriteria,
                });
                return okResult(
                    `Started ${goal.id} with ${goal.tasks.length} task(s) and ${goal.acceptanceCriteria.length} acceptance criterion/criteria.`,
                    { goal },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "goal_status",
        withToolAuth({
            title: "Read project goal",
            description:
                "Restore durable goal state for this workspace. Pass path to select a project/subtree scope. With no goal_id/path, a single active goal is returned; if multiple scopes are active, goal is null and activeGoals tells you which id/path to select. recent supports recovery across chat conversations.",
            inputSchema: { goal_id: goalIdInput, path: goalPathInput },
            outputSchema: {
                goal: goalSchema.nullable(),
                activeGoals: z.array(
                    z.object({
                        id: z.string(),
                        scopePath: z.string(),
                        objective: z.string(),
                        status: z.enum(GOAL_STATUSES),
                        updatedAt: z.string(),
                    }),
                ),
                recent: z.array(
                    z.object({
                        id: z.string(),
                        scopePath: z.string(),
                        objective: z.string(),
                        status: z.enum(GOAL_STATUSES),
                        updatedAt: z.string(),
                    }),
                ),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ goal_id: goalId, path }) => {
            try {
                const { goals } = scope();
                const snapshot = await goals.status(goalId, path);
                const selected = snapshot.goal;
                return okResult(
                    selected
                        ? `Goal ${selected.id} is ${selected.status}; ${selected.tasks.filter((item) => item.status === "done").length}/${selected.tasks.length} task(s) done and ${selected.acceptanceCriteria.filter((item) => item.status === "passed").length}/${selected.acceptanceCriteria.length} acceptance criterion/criteria passed.`
                        : "No goal exists for this project.",
                    { ...snapshot },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "goal_update",
        withToolAuth({
            title: "Update project goal",
            description:
                "Update the active durable goal: maintain its task board, pause/resume it, refine constraints or acceptance criteria, and append a bounded checkpoint containing progress, findings, blockers, and the next step. Use checkpoints at meaningful phase boundaries, not after every tool call.",
            inputSchema: {
                goal_id: goalIdInput,
                path: goalPathInput,
                objective: boundedText("Optional revised objective.").optional(),
                state: z
                    .enum(["active", "paused"])
                    .optional()
                    .describe("Pause or resume the goal."),
                add_constraints: z.array(boundedText("Constraint to add.")).max(MAX_LIST_ITEMS).optional(),
                remove_constraints: z
                    .array(boundedText("Exact existing constraint to remove."))
                    .max(MAX_LIST_ITEMS)
                    .optional(),
                add_tasks: z
                    .array(
                        z.object({
                            title: boundedText("Task title."),
                            details: boundedText("Optional task scope/details.").optional(),
                        }),
                    )
                    .max(MAX_LIST_ITEMS)
                    .optional(),
                task_updates: z
                    .array(
                        z.object({
                            task_id: z.string().min(1).max(128),
                            status: z.enum(GOAL_TASK_STATUSES).optional(),
                            note: z.string().max(MAX_TEXT).optional(),
                            title: boundedText("Optional revised task title.").optional(),
                            details: z.string().max(MAX_TEXT).optional(),
                        }),
                    )
                    .max(MAX_LIST_ITEMS)
                    .optional(),
                add_acceptance_criteria: z
                    .array(boundedText("Acceptance criterion to add."))
                    .max(MAX_LIST_ITEMS)
                    .optional(),
                remove_acceptance_criteria_ids: z
                    .array(z.string().min(1).max(128))
                    .max(MAX_LIST_ITEMS)
                    .optional(),
                checkpoint: z
                    .object({
                        summary: boundedText("What has been accomplished since the previous checkpoint."),
                        next: boundedText("The next concrete step.").optional(),
                        findings: z
                            .array(boundedText("Important finding worth carrying into later turns."))
                            .max(MAX_LIST_ITEMS)
                            .optional(),
                        blockers: z
                            .array(boundedText("Current blocker or unresolved risk."))
                            .max(MAX_LIST_ITEMS)
                            .optional(),
                    })
                    .optional(),
            },
            outputSchema: { goal: goalSchema },
            annotations: stateWriteAnnotations,
        }),
        async (input) => {
            try {
                const { goals } = scope();
                const goal = await goals.update({
                    goalId: input.goal_id,
                    scopePath: input.path,
                    objective: input.objective,
                    state: input.state,
                    addConstraints: input.add_constraints,
                    removeConstraints: input.remove_constraints,
                    addTasks: input.add_tasks,
                    taskUpdates: input.task_updates?.map(
                        (item: {
                            task_id: string;
                            status?: GoalTaskStatus;
                            note?: string;
                            title?: string;
                            details?: string;
                        }) => ({
                            taskId: item.task_id,
                            status: item.status,
                            note: item.note,
                            title: item.title,
                            details: item.details,
                        }),
                    ),
                    addAcceptanceCriteria: input.add_acceptance_criteria,
                    removeAcceptanceCriteriaIds: input.remove_acceptance_criteria_ids,
                    checkpoint: input.checkpoint,
                });
                return okResult(
                    `Updated ${goal.id}; ${goal.tasks.filter((item) => item.status === "done").length}/${goal.tasks.length} task(s) done.`,
                    { goal },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "goal_verify",
        withToolAuth({
            title: "Verify goal criterion",
            description:
                "Record concrete evidence for one acceptance criterion. Mark it passed only when the evidence actually demonstrates the condition; record failed when verification shows more work is needed. Re-verifying the same criterion updates its current status while retaining bounded history.",
            inputSchema: {
                goal_id: goalIdInput,
                path: goalPathInput,
                criterion_id: z.string().min(1).max(128),
                status: z.enum(["passed", "failed"]),
                evidence: boundedText("Concrete verification evidence, such as test/build/runtime results."),
            },
            outputSchema: { goal: goalSchema },
            annotations: stateWriteAnnotations,
        }),
        async ({ goal_id: goalId, path, criterion_id: criterionId, status, evidence }) => {
            try {
                const { goals } = scope();
                const goal = await goals.verify({
                    goalId,
                    scopePath: path,
                    criterionId,
                    status,
                    evidence,
                });
                return okResult(
                    `Verification ${criterionId}=${status} for ${goal.id}.`,
                    { goal },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "goal_finish",
        withToolAuth({
            title: "Finish project goal",
            description:
                "Mark the project goal completed. This fails closed unless every task is done and every acceptance criterion is currently passed. Call only after real verification evidence has been recorded with goal_verify.",
            inputSchema: {
                goal_id: goalIdInput,
                path: goalPathInput,
                summary: boundedText("Final outcome summary after all tasks and criteria are complete."),
            },
            outputSchema: { goal: goalSchema },
            annotations: stateWriteAnnotations,
        }),
        async ({ goal_id: goalId, path, summary }) => {
            try {
                const { goals } = scope();
                const goal = await goals.finish(goalId, path, summary);
                return okResult(`Completed ${goal.id}.`, { goal });
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "goal_cancel",
        withToolAuth({
            title: "Cancel project goal",
            description:
                "Cancel an unfinished durable project goal when the user abandons or replaces the objective. Cancellation preserves history and frees the project to start a new goal.",
            inputSchema: {
                goal_id: goalIdInput,
                path: goalPathInput,
                reason: boundedText("Why this goal is being abandoned or replaced."),
            },
            outputSchema: { goal: goalSchema },
            annotations: stateWriteAnnotations,
        }),
        async ({ goal_id: goalId, path, reason }) => {
            try {
                const { goals } = scope();
                const goal = await goals.cancel(goalId, path, reason);
                return okResult(`Cancelled ${goal.id}.`, { goal });
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );
}

/** @internal Keep the type exported for focused tests without duplicating the schema shape. */
export type { GoalRecord };
