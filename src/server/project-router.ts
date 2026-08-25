import type { CallToolResult } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../config/project.js";
import { CurrentOwnerProcessSessions } from "../lib/process/current-owner.js";
import type { ProcessSessionAccess } from "../lib/process/sessions.js";
import type { RoundChangeTracker } from "../lib/tool/round-changes.js";
import { currentToolOwnerId } from "../lib/tool/context.js";
import { errorResult } from "../lib/tool/result.js";
import type { RegisteredProject } from "../daemon/state.js";
import type { BindingStore } from "../projects/bindings.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { ProjectRuntimeManager, ProjectRuntime } from "../projects/runtime.js";

/**
 * Everything a project-level tool needs for one tool call. Resolved at call
 * time from the conversation binding, never captured at registration time.
 */
export interface ToolProjectScope {
    readonly project: ProjectContext;
    readonly processes: ProcessSessionAccess;
    readonly roundChanges: RoundChangeTracker;
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
 * Conversation owner key used for project bindings. Reuse the same namespaced
 * owner identity as permissions and managed processes so an identical host
 * session id cannot cross OAuth/local client boundaries.
 */
export function currentBindingOwnerKey(fallbackOwnerId: string): string {
    return currentToolOwnerId(fallbackOwnerId);
}

/** Guidance text shown to ChatGPT when a project-level tool is called unbound. */
export function unboundProjectMessage(activeProjects: RegisteredProject[]): string {
    if (activeProjects.length === 0) {
        return [
            "这个会话还没有绑定项目，而且当前没有已注册的项目。请让用户先在项目目录里运行 codex-mcp 注册项目。",
            "注册后调用 project_control(action=select, project_id=...)。",
            "如果 project_control 不在 ChatGPT 已批准的 action snapshot 中，请 Refresh 或重新发布 MCP app actions。",
        ].join("\n");
    }
    const list = activeProjects
        .map((item) => `- ${item.id}（${item.name}）${item.path}`)
        .join("\n");
    return [
        "当前会话还没有绑定项目，因此不能读写文件、执行命令或查看 Git 状态。",
        "请先向用户确认要用哪个项目，不要自动猜测：",
        list,
        "调用 project_control(action=select, project_id=\"<确认的项目 id>\")。",
        "如果 project_control 不可见，请 Refresh 或重新发布 MCP app actions；已删除的旧项目工具不再提供兼容入口。",
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

    resolveRuntime(): ProjectRuntime {
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
        return runtime;
    }

    resolveProject(): ToolProjectScope {
        const ownerKey = currentBindingOwnerKey(this.fallbackOwnerId);
        const runtime = this.resolveRuntime();
        return {
            project: runtime.project,
            processes: new CurrentOwnerProcessSessions(
                runtime.rootProcesses,
                runtime.processOwners,
                this.fallbackOwnerId,
            ),
            roundChanges: runtime.roundChanges.forOwner(ownerKey),
        };
    }

    /** Read-only runtime view: undefined instead of throwing when unbound. */
    tryResolveRuntime(): ProjectRuntime | undefined {
        try {
            return this.resolveRuntime();
        } catch (error) {
            if (error instanceof UnboundProjectError) return undefined;
            throw error;
        }
    }

    /** Read-only project view: undefined instead of throwing when unbound. */
    tryResolveProject(): ToolProjectScope | undefined {
        try {
            return this.resolveProject();
        } catch (error) {
            if (error instanceof UnboundProjectError) return undefined;
            throw error;
        }
    }
}
