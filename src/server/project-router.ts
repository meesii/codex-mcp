import type { CallToolResult } from "@modelcontextprotocol/server";
import type { AgentInstructionRegistry } from "../agents/registry.js";
import type { ProjectContext } from "../config/project.js";
import type { GoalStore } from "../goals/store.js";
import { CurrentOwnerProcessSessions } from "../lib/process/current-owner.js";
import type { ProcessSessionAccess } from "../lib/process/sessions.js";
import { getToolInvocationContext } from "../lib/tool/context.js";
import { errorResult } from "../lib/tool/result.js";
import type { RegisteredProject } from "../daemon/state.js";
import type { BindingStore } from "../projects/bindings.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { ProjectRuntimeManager, ProjectRuntime } from "../projects/runtime.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";

/**
 * Everything a project-level tool needs for one tool call. Resolved at call
 * time from the conversation binding, never captured at registration time.
 */
export interface ToolProjectScope {
    readonly project: ProjectContext;
    readonly workspace: WorkspaceRegistry;
    readonly agents: AgentInstructionRegistry;
    readonly goals: GoalStore;
    readonly processes: ProcessSessionAccess;
}

/**
 * Resolve the scope for the current tool call. Throws UnboundProjectError when
 * the current conversation has no valid binding (fail closed).
 */
export type ToolScopeProvider = () => ToolProjectScope;

/** Read-only variant that returns undefined instead of throwing when unbound. */
export type ToolScopeTryProvider = () => ToolProjectScope | undefined;

/**
 * Thrown (and caught by tool handlers) when a project-level tool runs in a
 * conversation that has not bound a project, or whose bound project is gone.
 */
export class UnboundProjectError extends Error {
    constructor(
        message: string,
        readonly projects: RegisteredProject[] = [],
    ) {
        super(message);
        this.name = "UnboundProjectError";
    }
}

/**
 * Conversation owner key used for session bindings: ChatGPT `openai/session`
 * first, MCP transport session second, then the OAuth/local client fallback.
 * This is a routing key, not proof of user identity.
 */
export function currentBindingOwnerKey(fallbackOwnerId: string): string {
    const context = getToolInvocationContext();
    if (context?.openAiSessionId) return `openai-session:${context.openAiSessionId}`;
    if (context?.transportSessionId) return `mcp-session:${context.transportSessionId}`;
    return fallbackOwnerId;
}

/** Guidance text shown to ChatGPT when a project-level tool is called unbound. */
export function unboundProjectMessage(activeProjects: RegisteredProject[]): string {
    if (activeProjects.length === 0) {
        return [
            "这个会话还没有绑定项目，而且当前没有已注册的项目。请让用户先在项目目录里运行 codex-mcp 注册项目。",
            "注册后优先调用 project_select(project_id=...)。",
            "如果 project_select 不在 ChatGPT 已批准的 action snapshot 中，使用稳定兼容入口 workspace_projects(project_id=...) 完成同一会话绑定。",
        ].join("\n");
    }
    const list = activeProjects
        .map((item) => `- ${item.id}（${item.name}）${item.path}`)
        .join("\n");
    return [
        "当前会话还没有绑定项目，因此不能读写文件、执行命令或查看 Git 状态。",
        "请先向用户确认要用哪个项目，不要自动猜测：",
        list,
        "首选：project_select(project_id=\"<确认的项目 id>\")。",
        "兼容旧 ChatGPT action snapshot：如果 project_select 不可见，调用 workspace_projects(project_id=\"<确认的项目 id>\")；该稳定 ABI 会先绑定会话，再列出项目内容。",
    ].join("\n");
}

/**
 * Tool-catch helper: renders an UnboundProjectError as a structured error
 * result (so ChatGPT can parse the project list), and any other error as the
 * ordinary plain error result.
 */
export function projectErrorResult(error: unknown): CallToolResult {
    if (error instanceof UnboundProjectError) {
        return {
            isError: true,
            content: [{ type: "text", text: error.message }],
        };
    }
    return errorResult(error instanceof Error ? error.message : String(error));
}

/**
 * Call-time project scope resolver backed by the binding store and the lazy
 * runtime manager. Created per MCP request because the fallback owner id is
 * per-request (OAuth client or `local:noauth`).
 */
export class BindingProjectScopeProvider {
    constructor(
        private readonly registry: ProjectRegistry,
        private readonly bindings: BindingStore,
        private readonly runtimes: ProjectRuntimeManager,
        private readonly fallbackOwnerId: string,
    ) {}

    resolveProject(): ToolProjectScope {
        const ownerKey = currentBindingOwnerKey(this.fallbackOwnerId);
        const binding = this.bindings.resolve(ownerKey);
        const project = binding ? this.registry.getActiveById(binding.projectId) : undefined;

        // A stale or deactivated binding must fail closed, never route anywhere.
        if (binding && !project) {
            this.bindings.unbind(ownerKey);
        }
        if (!project) {
            const activeProjects = this.registry.listActive();
            throw new UnboundProjectError(
                unboundProjectMessage(activeProjects),
                activeProjects,
            );
        }

        let runtime: ProjectRuntime;
        try {
            runtime = this.runtimes.get(project.id, project.path);
        } catch (error) {
            const activeProjects = this.registry.listActive();
            const detail = error instanceof Error ? error.message : String(error);
            throw new UnboundProjectError(
                [
                    `已绑定的项目当前不可用（${detail}）。请让用户重新运行 codex-mcp 注册项目，或明确选择其他项目。`,
                    unboundProjectMessage(activeProjects),
                ].join("\n"),
                activeProjects,
            );
        }
        this.bindings.touch(ownerKey);
        return {
            project: runtime.project,
            workspace: runtime.workspace,
            agents: runtime.agents,
            goals: runtime.goals,
            processes: new CurrentOwnerProcessSessions(
                runtime.rootProcesses,
                runtime.processOwners,
                this.fallbackOwnerId,
            ),
        };
    }

    /** Read-only view: undefined instead of throwing when unbound. */
    tryResolveProject(): ToolProjectScope | undefined {
        try {
            return this.resolveProject();
        } catch (error) {
            if (error instanceof UnboundProjectError) return undefined;
            throw error;
        }
    }
}
