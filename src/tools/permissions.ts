import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PermissionManager } from "../permissions/manager.js";
import { PERMISSION_CAPABILITIES } from "../permissions/types.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth, writeAnnotations } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { projectErrorResult } from "../server/project-router.js";

const DURATIONS = ["once", "session", "permanent"] as const;
const PERMISSION_CONTROL_ACTIONS = ["list", "grant", "revoke"] as const;
const permissionGrantSchema = z.object({
    capability: z.enum(PERMISSION_CAPABILITIES),
    path: z.string(),
    duration: z.enum(DURATIONS),
});

/**
 * Explicit authorization bridge for MCP hosts that cannot service server-side
 * elicitation during a tool call. The host should treat this state-changing tool
 * as requiring normal user confirmation before invocation.
 */
export function registerPermissionTools(
    server: McpServer,
    permissions: PermissionManager,
): void {
    registerTool(
        server,
        "permission_list",
        withToolAuth({
            title: "List external access grants",
            description:
                "List active one-time/session grants for this client plus permanent external-access grants.",
            inputSchema: {},
            outputSchema: {
                grants: z.array(permissionGrantSchema),
            },
            annotations: readOnlyAnnotations,
        }),
        async () => {
            const grants = permissions.listGrants();
            return okResult(`Listed ${grants.length} external access grant(s).`, { grants });
        },
    );

    registerTool(
        server,
        "permission_grant",
        withToolAuth({
            title: "Authorize external access",
            description:
                "Grant codex-mcp permission for an operation outside registered workspaces. Use after an operation reports that authorization is required, or when the user explicitly asks to pre-authorize a directory. Default to session for normal personal-development flow; use once when the user wants one-operation access and permanent only when the user explicitly wants lasting access. This is a state-changing authorization action and should be user-confirmed by the MCP host.",
            inputSchema: {
                capability: z.enum(PERMISSION_CAPABILITIES).describe("Permission capability: write or exec."),
                path: z
                    .string()
                    .min(1)
                    .describe("Absolute directory scope to authorize, normally copied from the permission-required error."),
                duration: z
                    .enum(DURATIONS)
                    .default("session")
                    .describe("session = current MCP/authorization session (default), once = next matching operation only, permanent = persist in user config."),
            },
            outputSchema: {
                capability: z.enum(PERMISSION_CAPABILITIES),
                path: z.string(),
                duration: z.enum(DURATIONS),
            },
            annotations: writeAnnotations,
        }),
        async ({ capability, path, duration }) => {
            try {
                const grant = permissions.grant(capability, path, duration);
                return okResult(
                    `Authorized ${capability} access to ${grant.path} (${duration}).`,
                    { capability, path: grant.path, duration },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "permission_revoke",
        withToolAuth({
            title: "Revoke external access",
            description:
                "Revoke matching one-time/session/permanent external-access grants for an exact directory scope and capability. Use permission_list first when the stored scope is uncertain.",
            inputSchema: {
                capability: z.enum(PERMISSION_CAPABILITIES),
                path: z.string().min(1),
            },
            outputSchema: {
                capability: z.enum(PERMISSION_CAPABILITIES),
                path: z.string(),
                removed: z.number().int(),
            },
            annotations: writeAnnotations,
        }),
        async ({ capability, path }) => {
            try {
                const { grant, removed } = permissions.revoke(capability, path);
                return okResult(
                    removed > 0
                        ? `Revoked ${removed} matching ${capability} grant(s) for ${grant.path}.`
                        : `No matching ${capability} grants existed for ${grant.path}.`,
                    { capability, path: grant.path, removed },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );

    registerTool(
        server,
        "permission_control",
        withToolAuth({
            title: "Manage external access",
            description:
                "Stable low-frequency external-authorization gateway. Prefer MCP elicitation during the original operation. Use action=grant only after explicit user confirmation; permanent grants require explicit lasting intent. This write-annotated gateway does not make authorization available through read-only compatibility tools.",
            inputSchema: {
                action: z.enum(PERMISSION_CONTROL_ACTIONS),
                capability: z.enum(PERMISSION_CAPABILITIES).optional(),
                path: z.string().min(1).optional(),
                duration: z.enum(DURATIONS).optional(),
            },
            outputSchema: {
                action: z.enum(PERMISSION_CONTROL_ACTIONS),
                grants: z.array(permissionGrantSchema),
                capability: z.enum(PERMISSION_CAPABILITIES).nullable(),
                path: z.string().nullable(),
                duration: z.enum(DURATIONS).nullable(),
                removed: z.number().int(),
            },
            annotations: writeAnnotations,
        }),
        async ({ action, capability, path, duration }) => {
            try {
                let capabilityResult: (typeof PERMISSION_CAPABILITIES)[number] | null = null;
                let pathResult: string | null = null;
                let durationResult: (typeof DURATIONS)[number] | null = null;
                let removed = 0;
                if (action === "grant") {
                    if (!capability || !path) {
                        throw new Error("action=grant 需要 capability 和 path。");
                    }
                    const selectedDuration = duration ?? "session";
                    const added = permissions.grant(capability, path, selectedDuration);
                    capabilityResult = added.capability;
                    pathResult = added.path;
                    durationResult = selectedDuration;
                } else if (action === "revoke") {
                    if (!capability || !path) {
                        throw new Error("action=revoke 需要 capability 和 path。");
                    }
                    const revoked = permissions.revoke(capability, path);
                    removed = revoked.removed;
                    capabilityResult = revoked.grant.capability;
                    pathResult = revoked.grant.path;
                } else if (capability !== undefined || path !== undefined || duration !== undefined) {
                    throw new Error("capability、path 和 duration 仅适用于 grant/revoke。");
                }
                const grants = permissions.listGrants();
                return okResult(
                    action === "grant"
                        ? `Authorized ${capabilityResult} access to ${pathResult} (${durationResult}).`
                        : action === "revoke"
                          ? `Revoked ${removed} matching external-access grant(s).`
                          : `Listed ${grants.length} external access grant(s).`,
                    {
                        action,
                        grants,
                        capability: capabilityResult,
                        path: pathResult,
                        duration: durationResult,
                        removed,
                    },
                );
            } catch (error) {
                return projectErrorResult(error);
            }
        },
    );
}
