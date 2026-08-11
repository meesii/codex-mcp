import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { z } from "zod";
import { AsyncMutex } from "../lib/util/mutex.js";
import type { ProjectContext } from "../config/project.js";
import { getUserConfigDir } from "../config/user-config.js";

export const GOAL_STATUSES = ["active", "paused", "completed", "cancelled"] as const;
export const GOAL_TASK_STATUSES = ["pending", "in_progress", "blocked", "done"] as const;
export const GOAL_CRITERION_STATUSES = ["pending", "passed", "failed"] as const;

export type GoalStatus = (typeof GOAL_STATUSES)[number];
export type GoalTaskStatus = (typeof GOAL_TASK_STATUSES)[number];
export type GoalCriterionStatus = (typeof GOAL_CRITERION_STATUSES)[number];

export interface GoalTask {
    id: string;
    title: string;
    details?: string;
    status: GoalTaskStatus;
    note?: string;
    createdAt: string;
    updatedAt: string;
}

export interface GoalCriterion {
    id: string;
    text: string;
    status: GoalCriterionStatus;
    evidence?: string;
    checkedAt?: string;
}

export interface GoalCheckpoint {
    id: string;
    summary: string;
    next?: string;
    findings: string[];
    blockers: string[];
    createdAt: string;
}

export interface GoalVerification {
    id: string;
    criterionId: string;
    status: Exclude<GoalCriterionStatus, "pending">;
    evidence: string;
    createdAt: string;
}

export interface GoalRecord {
    id: string;
    projectRoot: string;
    /** Project-relative scope under projectRoot, `.` for the bound root itself. */
    scopePath: string;
    objective: string;
    status: GoalStatus;
    constraints: string[];
    tasks: GoalTask[];
    acceptanceCriteria: GoalCriterion[];
    checkpoints: GoalCheckpoint[];
    verifications: GoalVerification[];
    createdAt: string;
    updatedAt: string;
    completedAt?: string;
    completionSummary?: string;
    cancelledAt?: string;
    cancelReason?: string;
}

export interface GoalSummary {
    id: string;
    scopePath: string;
    objective: string;
    status: GoalStatus;
    updatedAt: string;
}

export interface GoalStatusSnapshot {
    goal: GoalRecord | null;
    activeGoals: GoalSummary[];
    recent: GoalSummary[];
}

export interface StartGoalInput {
    scopePath?: string;
    objective: string;
    constraints?: string[];
    tasks?: Array<{ title: string; details?: string }>;
    acceptanceCriteria: string[];
}

export interface UpdateGoalInput {
    goalId?: string;
    scopePath?: string;
    objective?: string;
    state?: "active" | "paused";
    addConstraints?: string[];
    removeConstraints?: string[];
    addTasks?: Array<{ title: string; details?: string }>;
    taskUpdates?: Array<{
        taskId: string;
        status?: GoalTaskStatus;
        note?: string;
        title?: string;
        details?: string;
    }>;
    addAcceptanceCriteria?: string[];
    removeAcceptanceCriteriaIds?: string[];
    checkpoint?: {
        summary: string;
        next?: string;
        findings?: string[];
        blockers?: string[];
    };
}

export interface VerifyGoalInput {
    goalId?: string;
    scopePath?: string;
    criterionId: string;
    status: "passed" | "failed";
    evidence: string;
}

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

const projectStateSchema = z.object({
    version: z.literal(1),
    projectRoot: z.string(),
    activeGoalIds: z.record(z.string(), z.string()),
    goals: z.array(goalSchema),
});

type ProjectGoalState = z.infer<typeof projectStateSchema>;

const MAX_STORED_GOALS = 20;
const MAX_CHECKPOINTS = 50;
const MAX_VERIFICATIONS = 100;
const MAX_STATE_BYTES = 512 * 1024;

/**
 * Durable, workspace-aware goal state for ordinary ChatGPT conversations.
 *
 * The store deliberately does not run models or background work. It persists the
 * objective, task board, checkpoints, and verification evidence so a later MCP
 * request (or a new ChatGPT conversation) can resume the same scoped goal.
 */
export class GoalStore {
    private readonly mutex = new AsyncMutex();
    private readonly filePath: string;
    readonly projectRoot: string;

    constructor(
        private readonly project: ProjectContext,
        storageDir = join(getUserConfigDir(), "goals"),
    ) {
        this.projectRoot = project.root;
        const projectKey = createHash("sha256")
            .update(this.projectRoot)
            .digest("hex")
            .slice(0, 24);
        this.filePath = join(storageDir, `${projectKey}.json`);
    }

    async start(input: StartGoalInput): Promise<GoalRecord> {
        return this.mutex.runExclusive(async () => {
            const state = await this.loadState();
            const scopePath = this.normalizeScopePath(input.scopePath);
            const active = this.resolveActiveGoalForScope(state, scopePath);
            if (active) {
                throw new Error(
                    `An unfinished goal already exists for ${scopePath}: ${active.id} (${active.status}). Read it with goal_status, update it, finish it, or cancel it before starting another in the same scope.`,
                );
            }

            const now = new Date().toISOString();
            const goal: GoalRecord = {
                id: `goal_${randomUUID().replaceAll("-", "").slice(0, 12)}`,
                projectRoot: this.projectRoot,
                scopePath,
                objective: requireText(input.objective, "Goal objective"),
                status: "active",
                constraints: normalizeTextList(input.constraints ?? []),
                tasks: (input.tasks ?? []).map((task, index) => ({
                    id: `task_${index + 1}`,
                    title: requireText(task.title, "Task title"),
                    ...(task.details?.trim() ? { details: task.details.trim() } : {}),
                    status: "pending" as const,
                    createdAt: now,
                    updatedAt: now,
                })),
                acceptanceCriteria: normalizeTextList(input.acceptanceCriteria).map((text, index) => ({
                    id: `criterion_${index + 1}`,
                    text,
                    status: "pending" as const,
                })),
                checkpoints: [],
                verifications: [],
                createdAt: now,
                updatedAt: now,
            };
            if (goal.acceptanceCriteria.length === 0) {
                throw new Error("A goal needs at least one acceptance criterion so completion can be verified.");
            }

            state.goals.push(goal);
            state.activeGoalIds[scopePath] = goal.id;
            await this.saveState(state);
            return cloneGoal(goal);
        });
    }

    async status(goalId?: string, scopePath?: string): Promise<GoalStatusSnapshot> {
        return this.mutex.runExclusive(async () => {
            const state = await this.loadState();
            const activeGoals = this.listActiveGoals(state);
            const goal = this.resolveGoal(state, goalId, scopePath, false, activeGoals);
            return {
                goal: goal ? cloneGoal(goal) : null,
                activeGoals: activeGoals
                    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                    .map(toGoalSummary),
                recent: [...state.goals]
                    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
                    .slice(0, 10)
                    .map(toGoalSummary),
            };
        });
    }

    async update(input: UpdateGoalInput): Promise<GoalRecord> {
        return this.mutex.runExclusive(async () => {
            const state = await this.loadState();
            const goal = this.resolveGoal(state, input.goalId, input.scopePath, true);
            assertMutable(goal);
            const now = new Date().toISOString();

            if (input.objective !== undefined) {
                goal.objective = requireText(input.objective, "Goal objective");
            }
            if (input.state !== undefined) goal.status = input.state;

            if (input.addConstraints?.length) {
                goal.constraints = normalizeTextList([...goal.constraints, ...input.addConstraints]);
            }
            if (input.removeConstraints?.length) {
                const removals = new Set(normalizeTextList(input.removeConstraints));
                goal.constraints = goal.constraints.filter((item) => !removals.has(item));
            }

            for (const item of input.addTasks ?? []) {
                goal.tasks.push({
                    id: nextSequentialId("task", goal.tasks.map((task) => task.id)),
                    title: requireText(item.title, "Task title"),
                    ...(item.details?.trim() ? { details: item.details.trim() } : {}),
                    status: "pending",
                    createdAt: now,
                    updatedAt: now,
                });
            }

            for (const patch of input.taskUpdates ?? []) {
                const task = goal.tasks.find((item) => item.id === patch.taskId);
                if (!task) throw new Error(`Unknown goal task: ${patch.taskId}`);
                if (patch.status !== undefined) task.status = patch.status;
                if (patch.title !== undefined) task.title = requireText(patch.title, "Task title");
                if (patch.details !== undefined) {
                    const details = patch.details.trim();
                    if (details) task.details = details;
                    else delete task.details;
                }
                if (patch.note !== undefined) {
                    const note = patch.note.trim();
                    if (note) task.note = note;
                    else delete task.note;
                }
                task.updatedAt = now;
            }

            for (const text of normalizeTextList(input.addAcceptanceCriteria ?? [])) {
                if (goal.acceptanceCriteria.some((item) => item.text === text)) continue;
                goal.acceptanceCriteria.push({
                    id: nextSequentialId(
                        "criterion",
                        goal.acceptanceCriteria.map((criterion) => criterion.id),
                    ),
                    text,
                    status: "pending",
                });
            }

            if (input.removeAcceptanceCriteriaIds?.length) {
                const removals = new Set(input.removeAcceptanceCriteriaIds);
                const unknown = [...removals].filter(
                    (id) => !goal.acceptanceCriteria.some((item) => item.id === id),
                );
                if (unknown.length > 0) {
                    throw new Error(`Unknown acceptance criterion: ${unknown.join(", ")}`);
                }
                const remainingCriteria = goal.acceptanceCriteria.filter(
                    (item) => !removals.has(item.id),
                );
                if (remainingCriteria.length === 0) {
                    throw new Error("A goal must keep at least one acceptance criterion.");
                }
                goal.acceptanceCriteria = remainingCriteria;
                goal.verifications = goal.verifications.filter(
                    (item) => !removals.has(item.criterionId),
                );
            }

            if (input.checkpoint) {
                const checkpoint: GoalCheckpoint = {
                    id: nextSequentialId(
                        "checkpoint",
                        goal.checkpoints.map((item) => item.id),
                    ),
                    summary: requireText(input.checkpoint.summary, "Checkpoint summary"),
                    ...(input.checkpoint.next?.trim()
                        ? { next: input.checkpoint.next.trim() }
                        : {}),
                    findings: normalizeTextList(input.checkpoint.findings ?? []),
                    blockers: normalizeTextList(input.checkpoint.blockers ?? []),
                    createdAt: now,
                };
                goal.checkpoints.push(checkpoint);
                if (goal.checkpoints.length > MAX_CHECKPOINTS) {
                    goal.checkpoints.splice(0, goal.checkpoints.length - MAX_CHECKPOINTS);
                }
            }

            goal.updatedAt = now;
            state.activeGoalIds[goal.scopePath] = goal.id;
            await this.saveState(state);
            return cloneGoal(goal);
        });
    }

    async verify(input: VerifyGoalInput): Promise<GoalRecord> {
        return this.mutex.runExclusive(async () => {
            const state = await this.loadState();
            const goal = this.resolveGoal(state, input.goalId, input.scopePath, true);
            assertMutable(goal);
            const criterion = goal.acceptanceCriteria.find(
                (item) => item.id === input.criterionId,
            );
            if (!criterion) {
                throw new Error(`Unknown acceptance criterion: ${input.criterionId}`);
            }

            const now = new Date().toISOString();
            const evidence = requireText(input.evidence, "Verification evidence");
            criterion.status = input.status;
            criterion.evidence = evidence;
            criterion.checkedAt = now;
            goal.verifications.push({
                id: nextSequentialId(
                    "verification",
                    goal.verifications.map((item) => item.id),
                ),
                criterionId: criterion.id,
                status: input.status,
                evidence,
                createdAt: now,
            });
            if (goal.verifications.length > MAX_VERIFICATIONS) {
                goal.verifications.splice(0, goal.verifications.length - MAX_VERIFICATIONS);
            }
            goal.updatedAt = now;
            state.activeGoalIds[goal.scopePath] = goal.id;
            await this.saveState(state);
            return cloneGoal(goal);
        });
    }

    async finish(
        goalId: string | undefined,
        scopePath: string | undefined,
        summary: string,
    ): Promise<GoalRecord> {
        return this.mutex.runExclusive(async () => {
            const state = await this.loadState();
            const goal = this.resolveGoal(state, goalId, scopePath, true);
            assertMutable(goal);

            const unfinishedTasks = goal.tasks.filter((task) => task.status !== "done");
            const unverifiedCriteria = goal.acceptanceCriteria.filter(
                (criterion) => criterion.status !== "passed",
            );
            if (unfinishedTasks.length > 0 || unverifiedCriteria.length > 0) {
                const problems = [
                    unfinishedTasks.length > 0
                        ? `unfinished tasks: ${unfinishedTasks.map((item) => item.id).join(", ")}`
                        : "",
                    unverifiedCriteria.length > 0
                        ? `acceptance criteria not passed: ${unverifiedCriteria.map((item) => item.id).join(", ")}`
                        : "",
                ].filter(Boolean);
                throw new Error(`Goal cannot be finished yet (${problems.join("; ")}).`);
            }

            const now = new Date().toISOString();
            goal.status = "completed";
            goal.completionSummary = requireText(summary, "Completion summary");
            goal.completedAt = now;
            goal.updatedAt = now;
            if (state.activeGoalIds[goal.scopePath] === goal.id) {
                delete state.activeGoalIds[goal.scopePath];
            }
            await this.saveState(state);
            return cloneGoal(goal);
        });
    }

    async cancel(
        goalId: string | undefined,
        scopePath: string | undefined,
        reason: string,
    ): Promise<GoalRecord> {
        return this.mutex.runExclusive(async () => {
            const state = await this.loadState();
            const goal = this.resolveGoal(state, goalId, scopePath, true);
            assertMutable(goal);
            const now = new Date().toISOString();
            goal.status = "cancelled";
            goal.cancelReason = requireText(reason, "Cancellation reason");
            goal.cancelledAt = now;
            goal.updatedAt = now;
            if (state.activeGoalIds[goal.scopePath] === goal.id) {
                delete state.activeGoalIds[goal.scopePath];
            }
            await this.saveState(state);
            return cloneGoal(goal);
        });
    }

    private async loadState(): Promise<ProjectGoalState> {
        let raw: unknown;
        try {
            raw = JSON.parse(await readFile(this.filePath, "utf8")) as unknown;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") {
                return {
                    version: 1,
                    projectRoot: this.projectRoot,
                    activeGoalIds: {},
                    goals: [],
                };
            }
            const message = error instanceof Error ? error.message : String(error);
            throw new Error(`Goal state is unreadable: ${this.filePath}: ${message}`);
        }

        const parsed = projectStateSchema.safeParse(raw);
        if (!parsed.success) {
            throw new Error(`Goal state has an invalid format: ${this.filePath}`);
        }
        if (parsed.data.projectRoot !== this.projectRoot) {
            throw new Error(
                `Goal state project mismatch: expected ${this.projectRoot}, found ${parsed.data.projectRoot}`,
            );
        }
        return parsed.data;
    }

    private async saveState(state: ProjectGoalState): Promise<void> {
        pruneGoalHistory(state);
        let body = `${JSON.stringify(state, null, 2)}\n`;
        const activeIds = new Set(Object.values(state.activeGoalIds));
        while (Buffer.byteLength(body, "utf8") > MAX_STATE_BYTES && state.goals.length > 1) {
            const removable = [...state.goals]
                .filter((goal) => !activeIds.has(goal.id))
                .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt))[0];
            if (!removable) break;
            state.goals = state.goals.filter((goal) => goal.id !== removable.id);
            body = `${JSON.stringify(state, null, 2)}\n`;
        }
        const bytes = Buffer.byteLength(body, "utf8");
        if (bytes > MAX_STATE_BYTES) {
            throw new Error(
                `Goal state exceeds the ${MAX_STATE_BYTES}-byte workspace budget. Reduce checkpoint/evidence detail before continuing.`,
            );
        }

        await mkdir(dirname(this.filePath), { recursive: true, mode: 0o700 });
        const tempPath = `${this.filePath}.${process.pid}.${randomUUID()}.tmp`;
        try {
            await writeFile(tempPath, body, { encoding: "utf8", mode: 0o600 });
            await rename(tempPath, this.filePath);
            if (process.platform !== "win32") await chmod(this.filePath, 0o600);
        } catch (error) {
            await rm(tempPath, { force: true }).catch(() => undefined);
            throw error;
        }
    }

    private normalizeScopePath(input?: string): string {
        const absolute = this.project.resolvePath(input?.trim() || ".");
        return relative(this.projectRoot, absolute).replaceAll("\\", "/") || ".";
    }

    private resolveActiveGoalForScope(
        state: ProjectGoalState,
        scopePath: string,
    ): GoalRecord | undefined {
        const id = state.activeGoalIds[scopePath];
        if (!id) return undefined;
        const goal = state.goals.find((item) => item.id === id);
        if (!goal || (goal.status !== "active" && goal.status !== "paused")) {
            delete state.activeGoalIds[scopePath];
            return undefined;
        }
        return goal;
    }

    private listActiveGoals(state: ProjectGoalState): GoalRecord[] {
        const active: GoalRecord[] = [];
        for (const [scopePath] of Object.entries(state.activeGoalIds)) {
            const goal = this.resolveActiveGoalForScope(state, scopePath);
            if (goal) active.push(goal);
        }
        return active;
    }

    private resolveGoal(
        state: ProjectGoalState,
        goalId: string | undefined,
        scopePath: string | undefined,
        requireGoal: boolean,
        knownActiveGoals?: GoalRecord[],
    ): GoalRecord | undefined {
        const requestedId = goalId?.trim();
        if (requestedId) {
            const selected = state.goals.find((item) => item.id === requestedId);
            if (!selected) throw new Error(`Unknown goal: ${requestedId}`);
            if (scopePath !== undefined) {
                const normalizedScope = this.normalizeScopePath(scopePath);
                if (selected.scopePath !== normalizedScope) {
                    throw new Error(
                        `Goal ${requestedId} belongs to ${selected.scopePath}, not ${normalizedScope}.`,
                    );
                }
            }
            return selected;
        }

        if (scopePath !== undefined) {
            const normalizedScope = this.normalizeScopePath(scopePath);
            return (
                this.resolveActiveGoalForScope(state, normalizedScope) ??
                [...state.goals]
                    .filter((item) => item.scopePath === normalizedScope)
                    .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ??
                this.missingGoal(requireGoal, `No goal exists for scope ${normalizedScope}.`)
            );
        }

        const activeGoals = knownActiveGoals ?? this.listActiveGoals(state);
        if (activeGoals.length === 1) return activeGoals[0];
        if (activeGoals.length > 1) {
            if (requireGoal) {
                throw new Error(
                    `Multiple active goals exist (${activeGoals.map((item) => `${item.id}:${item.scopePath}`).join(", ")}). Pass goal_id or path to select one.`,
                );
            }
            return undefined;
        }

        return (
            [...state.goals].sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0] ??
            this.missingGoal(requireGoal, "No goal exists for this workspace. Start one with goal_start.")
        );
    }

    private missingGoal(requireGoal: boolean, message: string): undefined {
        if (requireGoal) throw new Error(message);
        return undefined;
    }
}

function assertMutable(goal: GoalRecord | undefined): asserts goal is GoalRecord {
    if (!goal) throw new Error("No goal exists for this workspace. Start one with goal_start.");
    if (goal.status === "completed" || goal.status === "cancelled") {
        throw new Error(`Goal ${goal.id} is already ${goal.status} and cannot be changed.`);
    }
}

function requireText(value: string, label: string): string {
    const text = value.trim();
    if (!text) throw new Error(`${label} must not be empty.`);
    return text;
}

function normalizeTextList(values: readonly string[]): string[] {
    const result: string[] = [];
    const seen = new Set<string>();
    for (const raw of values) {
        const value = raw.trim();
        if (!value || seen.has(value)) continue;
        seen.add(value);
        result.push(value);
    }
    return result;
}

function nextSequentialId(prefix: string, existingIds: readonly string[]): string {
    let max = 0;
    const pattern = new RegExp(`^${prefix}_(\\d+)$`);
    for (const id of existingIds) {
        const match = pattern.exec(id);
        if (!match) continue;
        max = Math.max(max, Number(match[1]));
    }
    return `${prefix}_${max + 1}`;
}

function pruneGoalHistory(state: ProjectGoalState): void {
    if (state.goals.length <= MAX_STORED_GOALS) return;
    const keep = new Set(
        [...state.goals]
            .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))
            .slice(0, MAX_STORED_GOALS)
            .map((item) => item.id),
    );
    for (const id of Object.values(state.activeGoalIds)) keep.add(id);
    state.goals = state.goals.filter((item) => keep.has(item.id));
}

function toGoalSummary(goal: GoalRecord): GoalSummary {
    return {
        id: goal.id,
        scopePath: goal.scopePath,
        objective: goal.objective,
        status: goal.status,
        updatedAt: goal.updatedAt,
    };
}

function cloneGoal(goal: GoalRecord): GoalRecord {
    return structuredClone(goal);
}
