import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { PermissionManager } from "../permissions/manager.js";
import { PERMISSION_CAPABILITIES } from "../permissions/types.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth, writeAnnotations } from "../lib/tool/meta.js";
import { errorResult, okResult } from "../lib/tool/result.js";

const DURATIONS = ["once", "session", "permanent"] as const;
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
                return errorResult(error instanceof Error ? error.message : String(error));
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
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}
