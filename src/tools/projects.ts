import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { RegisteredProject } from "../daemon/state.js";
import { registerTool } from "../lib/tool/log.js";
import {
    readOnlyAnnotations,
    stateWriteAnnotations,
    withToolAuth,
} from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";
import { canonicalProjectPath } from "../projects/identity.js";
import type { BindingStore } from "../projects/bindings.js";
import type { ProjectRegistry } from "../projects/registry.js";
import type { ProjectRuntimeManager } from "../projects/runtime.js";
import { currentBindingOwnerKey, unboundProjectMessage } from "../server/project-router.js";

export interface ProjectToolDeps {
    registry: ProjectRegistry;
    bindings: BindingStore;
    runtimes: ProjectRuntimeManager;
    /** Per-request OAuth/local fallback owner id used when no session meta exists. */
    fallbackOwnerId: string;
}

export interface BindProjectInput {
    projectId?: string;
    path?: string;
    force?: boolean;
}

const projectSchema = z.object({
    id: z.string(),
    name: z.string(),
    path: z.string(),
    active: z.boolean(),
    lastSeenAt: z.string(),
});

const bindingSchema = z.object({
    ownerKey: z.string(),
    projectId: z.string(),
    boundAt: z.string(),
    lastSeenAt: z.string(),
});

const projectControlActions = ["list", "select", "current", "unbind"] as const;

function publicProject(project: RegisteredProject) {
    return {
        id: project.id,
        name: project.name,
        path: project.path,
        active: project.active,
        lastSeenAt: project.lastSeenAt,
    };
}

/**
 * Multi-project conversation binding tools. These are the only project-scoped
 * tools allowed before a conversation binds; they never touch project files.
 */
export function registerProjectTools(server: McpServer, deps: ProjectToolDeps): void {
    const { registry, bindings, runtimes, fallbackOwnerId } = deps;

    registerTool(
        server,
        "project_list",
        withToolAuth({
            title: "List registered projects",
            description:
                "List the projects registered with the codex-mcp daemon and whether this conversation is already bound to one. Ask the user which project to use, then prefer project_select. If that action is absent, workspace_projects(project_id=...) is only usable when its host-approved input schema visibly exposes the selector; otherwise Refresh/re-publish the MCP app actions.",
            inputSchema: {},
            outputSchema: {
                projects: z.array(projectSchema),
                binding: bindingSchema.nullable(),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const ownerKey = currentBindingOwnerKey(fallbackOwnerId);
            const binding = bindings.resolve(ownerKey);
            const projects = registry
                .listActive()
                .map(publicProject)
                .sort((left, right) => left.name.localeCompare(right.name));
            const current = binding ? { ...binding } : null;
            const text = projects.length === 0
                ? "No registered projects. Ask the user to run codex-mcp inside a project directory first."
                : current
                  ? `Bound to ${current.projectId}. ${projects.length} active project(s) registered.`
                  : `${projects.length} active project(s) registered; no project bound to this conversation yet.`;
            return okResult(text, { projects, binding: current });
        },
    );

    registerTool(
        server,
        "project_select",
        withToolAuth({
            title: "Bind conversation to a project",
            description:
                "Bind this ChatGPT conversation to exactly one registered project. All file, command, Git, and process tools then act on that project. Exactly one of project_id or path is required; the selected project must be active. If this conversation is already bound to a different project, pass force=true only when the user explicitly asks to switch projects.",
            inputSchema: {
                project_id: z
                    .string()
                    .min(1)
                    .max(256)
                    .optional()
                    .describe("Registered project id from project_list."),
                path: z
                    .string()
                    .max(2_000)
                    .optional()
                    .describe("Absolute project directory path from project_list."),
                force: z
                    .boolean()
                    .optional()
                    .describe("Deliberate switch when this conversation is already bound to another project."),
            },
            outputSchema: {
                binding: bindingSchema,
                project: projectSchema,
            },
            annotations: stateWriteAnnotations,
        }),
        async ({ project_id: projectId, path, force }) => {
            try {
                const { binding, project: selected } = bindCurrentOwnerProject(deps, {
                    projectId,
                    path,
                    force,
                });
                return okResult(
                    `Bound this conversation to ${selected.name} (${selected.id}). Project tools now act on ${selected.path}.`,
                    { binding, project: publicProject(selected) },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );

    registerTool(
        server,
        "project_current",
        withToolAuth({
            title: "Read current project binding",
            description:
                "Return the project this conversation is bound to (if any) plus a short runtime summary. Safe to call before binding.",
            inputSchema: {},
            outputSchema: {
                binding: bindingSchema.nullable(),
                project: projectSchema.nullable(),
                workspaceRoots: z.array(z.string()),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const ownerKey = currentBindingOwnerKey(fallbackOwnerId);
            const binding = bindings.resolve(ownerKey);
            const project = binding ? registry.getActiveById(binding.projectId) : undefined;
            if (!binding || !project) {
                return okResult(
                    project
                        ? "No project bound to this conversation."
                        : unboundProjectMessage(registry.listActive()),
                    { binding: null, project: null, workspaceRoots: [] },
                );
            }
            const runtime = runtimes.has(project.id)
                ? runtimes.get(project.id, project.path)
                : undefined;
            return okResult(
                `Bound to ${project.name} (${project.id}).`,
                {
                    binding,
                    project: publicProject(project),
                    workspaceRoots: runtime ? [...runtime.project.roots] : [],
                },
            );
        },
    );

    registerTool(
        server,
        "project_unbind",
        withToolAuth({
            title: "Unbind conversation from project",
            description:
                "Remove this conversation's project binding. The project stays active; prefer project_select to rebind. workspace_projects(project_id=...) is a compatibility path only when that selector exists in the host-approved schema; otherwise Refresh/re-publish the MCP app actions.",
            inputSchema: {},
            outputSchema: { binding: bindingSchema.nullable() },
            annotations: stateWriteAnnotations,
        }),
        async () => {
            const ownerKey = currentBindingOwnerKey(fallbackOwnerId);
            const binding = bindings.resolve(ownerKey);
            const removed = bindings.unbind(ownerKey);
            if (!removed) {
                return okResult("This conversation was not bound to any project.", {
                    binding: null,
                });
            }
            return okResult(
                `Unbound this conversation from ${binding!.projectId}. Project tools are blocked until project_select binds a project again, or a host-approved workspace_projects schema with project_id/project_path is used as the compatibility path.`,
                { binding: null },
            );
        },
    );

    registerTool(
        server,
        "project_control",
        withToolAuth({
            title: "Manage conversation project",
            description:
                "Stable low-frequency project control gateway. list/current inspect daemon projects and binding; select binds this conversation; unbind removes the binding. Prefer the dedicated project_* tools when visible. Existing coding flows must not depend on this newly published action appearing immediately in a frozen ChatGPT snapshot.",
            inputSchema: {
                action: z.enum(projectControlActions),
                project_id: z.string().min(1).max(256).optional(),
                project_path: z.string().max(2_000).optional(),
                force: z.boolean().optional(),
            },
            outputSchema: {
                action: z.enum(projectControlActions),
                projects: z.array(projectSchema),
                binding: bindingSchema.nullable(),
                project: projectSchema.nullable(),
                workspaceRoots: z.array(z.string()),
            },
            annotations: stateWriteAnnotations,
        }),
        async ({ action, project_id: projectId, project_path: path, force }) => {
            try {
                const ownerKey = currentBindingOwnerKey(fallbackOwnerId);
                if (action === "select") {
                    bindCurrentOwnerProject(deps, { projectId, path, force });
                } else if (action === "unbind") {
                    bindings.unbind(ownerKey);
                } else if (projectId !== undefined || path !== undefined || force !== undefined) {
                    throw new Error("project_id、project_path 和 force 仅适用于 action=select。");
                }

                const binding = bindings.resolve(ownerKey) ?? null;
                const selected = binding ? registry.getActiveById(binding.projectId) : undefined;
                const runtime = selected && runtimes.has(selected.id)
                    ? runtimes.get(selected.id, selected.path)
                    : undefined;
                const projects = registry
                    .listActive()
                    .map(publicProject)
                    .sort((left, right) => left.name.localeCompare(right.name));
                const text = action === "select" && selected
                    ? `Bound this conversation to ${selected.name} (${selected.id}).`
                    : action === "unbind"
                      ? "Removed this conversation's project binding."
                      : selected
                        ? `Bound to ${selected.name} (${selected.id}); ${projects.length} active project(s) registered.`
                        : unboundProjectMessage(registry.listActive());
                return okResult(text, {
                    action,
                    projects,
                    binding,
                    project: selected ? publicProject(selected) : null,
                    workspaceRoots: runtime ? [...runtime.project.roots] : [],
                });
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

/**
 * Bind the current tool-call owner to one active daemon project. Exported so
 * an already-visible compatibility tool can provide project selection when a
 * host truncates or caches the MCP tool surface and omits project_select.
 */
export function bindCurrentOwnerProject(
    deps: ProjectToolDeps,
    input: BindProjectInput,
): { binding: ReturnType<BindingStore["bind"]>; project: RegisteredProject } {
    const { registry, bindings, runtimes, fallbackOwnerId } = deps;
    const hasId = Boolean(input.projectId?.trim());
    const hasPath = Boolean(input.path?.trim());
    if (hasId === hasPath) {
        throw new Error(
            "需要且只需要一个项目选择器：project_id 或 project_path，不能同时传也不能都不传。",
        );
    }
    const selected = selectActiveProject(registry, input.projectId, input.path);
    if (!selected) {
        throw new Error(
            hasId
                ? `没有找到 id 为 ${input.projectId!.trim()} 的活动项目。`
                : `没有找到路径为 ${input.path!.trim()} 的活动项目。`,
        );
    }
    const ownerKey = currentBindingOwnerKey(fallbackOwnerId);
    const existing = bindings.resolve(ownerKey);
    if (existing && existing.projectId !== selected.id && input.force !== true) {
        const other = registry.getById(existing.projectId);
        throw new Error(
            `这个会话已经绑定到 ${other ? `${other.name}（${other.id}）` : existing.projectId}。用户确认切换后请传 force=true。`,
        );
    }
    try {
        runtimes.get(selected.id, selected.path);
    } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        throw new Error(`无法为 ${selected.id} 创建运行时：${detail}`);
    }
    return {
        binding: bindings.bind(ownerKey, selected.id),
        project: selected,
    };
}

function selectActiveProject(
    registry: ProjectRegistry,
    projectId: string | undefined,
    path: string | undefined,
): RegisteredProject | undefined {
    if (projectId?.trim()) {
        return registry.getActiveById(projectId.trim());
    }
    const byPath = registry.getByPath(path!.trim());
    if (byPath && byPath.active) return byPath;
    const canonical = tryCanonicalPath(path!);
    return canonical ? registry.getByPath(canonical) : undefined;
}

function tryCanonicalPath(input: string): string | undefined {
    try {
        return canonicalProjectPath(input);
    } catch {
        return undefined;
    }
}
