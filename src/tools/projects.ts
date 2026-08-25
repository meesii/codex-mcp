import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { RegisteredProject } from "../daemon/state.js";
import { registerTool } from "../lib/tool/log.js";
import { stateWriteAnnotations, withToolAuth } from "../lib/tool/meta.js";
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
    fallbackOwnerId: string;
}

const projectSchema = z.object({
    id: z.string(), name: z.string(), path: z.string(), active: z.boolean(), lastSeenAt: z.string(),
});
const bindingSchema = z.object({
    ownerKey: z.string(), projectId: z.string(), boundAt: z.string(), lastSeenAt: z.string(),
});

function publicProject(project: RegisteredProject) {
    return { id: project.id, name: project.name, path: project.path, active: project.active, lastSeenAt: project.lastSeenAt };
}

export function registerProjectTools(server: McpServer, deps: ProjectToolDeps): void {
    const { registry, bindings, runtimes, fallbackOwnerId } = deps;
    registerTool(server, "project_control", withToolAuth({
        title: "Manage conversation project",
        description: "List projects, inspect the current conversation binding, bind one active project, or unbind it. Confirm with the user before switching projects and pass force=true only after that confirmation.",
        inputSchema: {
            action: z.enum(["list", "select", "current", "unbind"]),
            project_id: z.string().min(1).max(256).optional(),
            project_path: z.string().max(2_000).optional(),
            force: z.boolean().optional(),
        },
        outputSchema: {
            action: z.enum(["list", "select", "current", "unbind"]),
            projects: z.array(projectSchema), binding: bindingSchema.nullable(),
            project: projectSchema.nullable(), workspaceRoots: z.array(z.string()),
        },
        annotations: stateWriteAnnotations,
    }), async ({ action, project_id: projectId, project_path: projectPath, force }) => {
        try {
            const ownerKey = currentBindingOwnerKey(fallbackOwnerId);
            if (action === "select") bindProject(deps, projectId, projectPath, force);
            else if (action === "unbind") bindings.unbind(ownerKey);
            else if (projectId !== undefined || projectPath !== undefined || force !== undefined) {
                throw new Error("project_id、project_path 和 force 仅适用于 action=select。");
            }

            const binding = bindings.resolve(ownerKey) ?? null;
            const selected = binding ? registry.getActiveById(binding.projectId) : undefined;
            const runtime = selected && runtimes.has(selected.id) ? runtimes.get(selected.id, selected.path) : undefined;
            const projects = registry.listActive().map(publicProject).sort((a, b) => a.name.localeCompare(b.name));
            const text = action === "select" && selected
                ? `Bound this conversation to ${selected.name} (${selected.id}).`
                : action === "unbind" ? "Removed this conversation's project binding."
                : selected ? `Bound to ${selected.name} (${selected.id}); ${projects.length} active project(s) registered.`
                : unboundProjectMessage(registry.listActive());
            return okResult(text, { action, projects, binding, project: selected ? publicProject(selected) : null, workspaceRoots: runtime ? [...runtime.project.roots] : [] });
        } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
        }
    });
}

function bindProject(deps: ProjectToolDeps, projectId?: string, projectPath?: string, force?: boolean): void {
    const hasId = Boolean(projectId?.trim());
    const hasPath = Boolean(projectPath?.trim());
    if (hasId === hasPath) throw new Error("action=select 需要且只需要 project_id 或 project_path。");
    const selected = hasId ? deps.registry.getActiveById(projectId!.trim()) : selectByPath(deps.registry, projectPath!.trim());
    if (!selected) throw new Error("没有找到指定的活动项目。");
    const ownerKey = currentBindingOwnerKey(deps.fallbackOwnerId);
    const existing = deps.bindings.resolve(ownerKey);
    if (existing && existing.projectId !== selected.id && force !== true) {
        throw new Error("这个会话已经绑定其他项目；用户确认切换后请传 force=true。");
    }
    deps.runtimes.get(selected.id, selected.path);
    deps.bindings.bind(ownerKey, selected.id);
}

function selectByPath(registry: ProjectRegistry, path: string): RegisteredProject | undefined {
    const direct = registry.getByPath(path);
    if (direct?.active) return direct;
    try {
        const canonical = registry.getByPath(canonicalProjectPath(path));
        return canonical?.active ? canonical : undefined;
    } catch {
        return undefined;
    }
}
