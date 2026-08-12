import { dirname } from "node:path";
import type { McpServer } from "@modelcontextprotocol/server";
import type { ProjectContext } from "../config/project.js";
import { isPathInsideRoot } from "../lib/fs/path-guard.js";
import { currentToolOwnerId } from "../lib/tool/context.js";
import {
    UserConfigPermissionGrantStore,
    type PermissionGrantStore,
} from "./store.js";
import { PermissionRuntime } from "./runtime.js";
import type {
    PermissionCapability,
    PermissionGrant,
    PermissionGrantDuration,
    PermissionRequest,
} from "./types.js";

export class PermissionDeniedError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "PermissionDeniedError";
    }
}

export class PermissionRequiredError extends Error {
    constructor(
        readonly request: PermissionRequest,
        message = buildFallbackMessage(request),
    ) {
        super(message);
        this.name = "PermissionRequiredError";
    }
}

export interface PermissionManagerOptions {
    ownerId?: string;
    runtime?: PermissionRuntime;
    store?: PermissionGrantStore;
}

export interface ActivePermissionGrant extends PermissionGrant {
    duration: PermissionGrantDuration;
}

/**
 * Lightweight authorization for operations outside registered workspaces.
 *
 * Modern MCP clients can answer form elicitation inline. Stateless/legacy
 * clients fall back to the permission_grant tool, whose write annotation lets
 * hosts such as ChatGPT put their normal user-confirmation UI around the grant.
 */
export class PermissionManager {
    private readonly fallbackOwnerId: string;
    private readonly runtime: PermissionRuntime;
    private readonly store: PermissionGrantStore;
    private readonly projectProvider: () => ProjectContext;

    constructor(
        private readonly server: McpServer,
        project: ProjectContext | (() => ProjectContext),
        options: PermissionManagerOptions = {},
    ) {
        this.fallbackOwnerId = options.ownerId ?? "local:noauth";
        this.runtime = options.runtime ?? new PermissionRuntime();
        this.store = options.store ?? new UserConfigPermissionGrantStore();
        this.projectProvider = typeof project === "function" ? project : () => project;
    }

    private currentProject(): ProjectContext {
        return this.projectProvider();
    }

    async authorize(request: PermissionRequest): Promise<void> {
        const project = this.currentProject();
        const targets = [...new Set(request.targets)];
        if (targets.length === 0) return;

        const externalTargets = targets.filter((target) => !project.isWorkspacePath(target));
        if (externalTargets.length === 0) return;

        const notPermanent = externalTargets.filter(
            (target) => !this.hasPermanentGrant(request.capability, target),
        );
        if (notPermanent.length === 0) return;

        const ownerId = this.currentOwnerId();
        const runtimeUncovered = this.runtime.uncoveredTargets(
            ownerId,
            request.capability,
            notPermanent,
        );
        if (runtimeUncovered.length === 0) {
            this.runtime.consumeGrant(ownerId, request.capability, notPermanent);
            return;
        }

        const uncoveredSet = new Set(runtimeUncovered);
        const runtimeCovered = notPermanent.filter((target) => !uncoveredSet.has(target));
        const pendingRequest: PermissionRequest = {
            ...request,
            targets: runtimeUncovered,
            scope: permissionScopeForTargets(request.capability, runtimeUncovered),
        };
        const inline = await this.tryInlineApproval(pendingRequest);
        if (inline === "approved") {
            if (runtimeCovered.length > 0) {
                this.runtime.consumeGrant(ownerId, request.capability, runtimeCovered);
            }
            return;
        }
        if (inline === "denied") {
            throw new PermissionDeniedError("用户拒绝了工作区外操作。");
        }

        throw new PermissionRequiredError(pendingRequest);
    }

    grant(
        capability: PermissionCapability,
        path: string,
        duration: PermissionGrantDuration,
    ): PermissionGrant {
        const canonicalPath = this.currentProject().resolveExternalPath(path);
        const grant: PermissionGrant = { capability, path: canonicalPath };
        if (duration === "permanent") {
            this.store.add(grant);
        } else {
            this.runtime.addGrant(this.currentOwnerId(), grant, duration);
        }
        return grant;
    }

    listGrants(): ActivePermissionGrant[] {
        return [
            ...this.runtime.list(this.currentOwnerId()),
            ...this.store.list().map((grant) => ({ ...grant, duration: "permanent" as const })),
        ];
    }

    revoke(
        capability: PermissionCapability,
        path: string,
    ): { grant: PermissionGrant; removed: number } {
        const grant: PermissionGrant = {
            capability,
            path: this.currentProject().resolveExternalPath(path),
        };
        const permanentRemoved = this.store.remove(grant);
        const runtimeRemoved = this.runtime.removeGrant(this.currentOwnerId(), grant);
        return { grant, removed: permanentRemoved + runtimeRemoved };
    }

    private currentOwnerId(): string {
        return currentToolOwnerId(this.fallbackOwnerId);
    }

    private hasPermanentGrant(capability: PermissionCapability, target: string): boolean {
        return this.store
            .list()
            .filter((grant) => grant.capability === capability)
            .some((grant) => isPathInsideRoot(target, grant.path));
    }

    private async tryInlineApproval(
        request: PermissionRequest,
    ): Promise<"approved" | "denied" | "unsupported"> {
        const capabilities = this.server.server.getClientCapabilities();
        if (!capabilities?.elicitation?.form) return "unsupported";

        try {
            const result = await this.server.server.elicitInput({
                mode: "form",
                message: buildPrompt(request),
                requestedSchema: {
                    type: "object",
                    properties: {
                        permission: {
                            type: "string",
                            title: "授权范围",
                            description: `会话/永久授权目录：${request.scope}`,
                            oneOf: [
                                { const: "session", title: "当前会话" },
                                { const: "once", title: "仅这一次" },
                                { const: "permanent", title: "永久允许此目录" },
                                { const: "deny", title: "拒绝" },
                            ],
                            default: "session",
                        },
                    },
                    required: ["permission"],
                },
            });
            if (result.action !== "accept") return "denied";

            const content = result.content as Record<string, unknown> | undefined;
            const duration = content?.permission;
            if (duration === "deny") return "denied";
            if (duration !== "once" && duration !== "session" && duration !== "permanent") {
                return "unsupported";
            }
            if (duration !== "once") {
                this.grant(request.capability, request.scope, duration);
            }
            return "approved";
        } catch {
            // Legacy/stateless transports cannot reliably route server-initiated
            // requests. The returned error explains the visible fallback action
            // and stale-snapshot recovery without weakening authorization.
            return "unsupported";
        }
    }
}

function buildPrompt(request: PermissionRequest): string {
    return [
        `codex-mcp 需要在已注册工作区之外执行${capabilityLabel(request.capability)}操作。`,
        request.reason,
        `目标：${summarizeTargets(request.targets)}`,
        `选择“当前会话”或“永久允许”时，授权范围为：${request.scope}`,
    ].join("\n");
}

function buildFallbackMessage(request: PermissionRequest): string {
    return [
        "需要用户授权后才能继续工作区外操作。",
        `${capabilityLabel(request.capability)}目标：${summarizeTargets(request.targets)}`,
        `授权目录：${request.scope}`,
        "首选恢复路径是由 MCP host 在原操作中处理 elicitation；当前 host/transport 未完成该流程。",
        `如果 permission_grant 可见，用户确认后调用 permission_grant(capability=${request.capability}, path=${JSON.stringify(request.scope)}, duration=session)，再重试原操作。`,
        `如果只看到稳定控制网关，可在用户确认后调用 permission_control(action=grant, capability=${request.capability}, path=${JSON.stringify(request.scope)}, duration=session)。`,
        "用户明确只允许一次时使用 duration=once；只有明确要求长期允许时才使用 permanent。",
        "如果 permission_grant 和 permission_control 都不可见，说明 host 使用的 approved action snapshot 已过期；请在 ChatGPT 中 Refresh 或重新发布 MCP app actions 后再授权。不要通过 workspace_projects 等只承担项目绑定兼容职责的工具绕过授权。",
    ].join(" ");
}

function capabilityLabel(capability: PermissionCapability): string {
    return capability === "write" ? "写入" : "执行命令";
}

function permissionScopeForTargets(
    capability: PermissionCapability,
    targets: string[],
): string {
    if (targets.length === 0) throw new Error("Permission request has no targets");
    let scope = capability === "write" ? dirname(targets[0]!) : targets[0]!;
    while (!targets.every((target) => isPathInsideRoot(target, scope))) {
        const parent = dirname(scope);
        if (parent === scope) return scope;
        scope = parent;
    }
    return scope;
}

function summarizeTargets(targets: string[]): string {
    const visible = targets.slice(0, 5);
    const suffix = targets.length > visible.length ? ` 等 ${targets.length} 个路径` : "";
    return `${visible.join(", ")}${suffix}`;
}
