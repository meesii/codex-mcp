import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { PACKAGE_VERSION } from "../server/version.js";
import { registerTool } from "../lib/tool/log.js";
import { readOnlyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { okResult } from "../lib/tool/result.js";
import { PROJECT_TOOL_NAMES, TOOL_NAMES } from "./names.js";
import type { ToolScopeTryProvider } from "../server/project-router.js";
import {
    CHATGPT_CONTROL_GATEWAY_TOOLS,
    CHATGPT_STABLE_BOOTSTRAP_TOOLS,
    CHATGPT_SURFACE_VERSION,
    checkChatGptCompatibility,
} from "./surface.js";

const PROCESS_STARTED_AT = new Date(Date.now() - process.uptime() * 1_000).toISOString();
const STARTUP_TOOLSET_HASH = buildToolsetHash();

function buildToolsetHash(): string {
    const hash = createHash("sha256").update(PACKAGE_VERSION).update("\0");
    try {
        const toolDir = dirname(fileURLToPath(import.meta.url));
        const extension = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
        const files = readdirSync(toolDir)
            .filter((name) => name.endsWith(extension))
            .sort();
        for (const name of files) {
            hash.update(name).update("\0").update(readFileSync(`${toolDir}/${name}`)).update("\0");
        }
    } catch {
        hash.update(TOOL_NAMES.join("\n"));
    }
    return hash.digest("hex").slice(0, 16);
}

export function registerServerInfoTool(
    server: McpServer,
    scope: ToolScopeTryProvider,
    options: {
        daemonMode: boolean;
        allowedTools?: ReadonlySet<string>;
    },
): void {
    const serverTools = toolNamesForServer(options);
    registerTool(
        server,
        "server_info",
        withToolAuth({
            title: "Read server info",
            description:
                "Return runtime/toolset data plus the stable ChatGPT ABI and frozen-action-snapshot compatibility check. Optionally pass the tool names visible to the host to detect a stale approved action snapshot; tools/list_changed requests metadata refresh but cannot approve newly published actions.",
            inputSchema: {
                host_tools: z
                    .array(z.string().min(1).max(256))
                    .max(512)
                    .optional()
                    .describe("Optional tool names currently visible in the host's approved action snapshot."),
            },
            outputSchema: {
                version: z.string(),
                startedAt: z.string(),
                pid: z.number().int(),
                projectRoot: z.string().nullable(),
                workspaceRoots: z.array(z.string()),
                toolsetHash: z.string(),
                diskToolsetHash: z.string(),
                toolCount: z.number().int(),
                restartRequiredForCoreToolChanges: z.boolean(),
                restartRecommended: z.boolean(),
                capabilities: z.object({
                    applyPatch: z.boolean(),
                    structuredSearch: z.boolean(),
                    commandCwd: z.boolean(),
                    mutationDiff: z.boolean(),
                    externalReads: z.boolean(),
                    externalAuthorization: z.boolean(),
                }),
                compatibility: z.object({
                    surfaceVersion: z.string(),
                    stableTools: z.array(z.string()),
                    controlGateways: z.array(z.string()),
                    serverTools: z.array(z.string()),
                    additiveOptionalParametersPreferred: z.boolean(),
                    toolsListChangedRefreshesApprovedSnapshot: z.boolean(),
                    fallback: z.object({
                        projectBinding: z.object({
                            preferredTool: z.string(),
                            compatibilityTool: z.string(),
                            selectorParameters: z.array(z.string()),
                            available: z.boolean(),
                        }),
                        externalAuthorization: z.object({
                            preferred: z.string(),
                            fallbackTool: z.string(),
                            gatewayTool: z.string(),
                            fallbackToolAvailable: z.boolean(),
                            gatewayToolAvailable: z.boolean(),
                            staleSnapshotRecovery: z.string(),
                        }),
                        persistentWorkspaceTrust: z.object({
                            gatewayTool: z.string(),
                            legacyTools: z.array(z.string()),
                            available: z.boolean(),
                            includedInReadOnlyCompatibilityTool: z.boolean(),
                            staleSnapshotRecovery: z.string(),
                        }),
                    }),
                    selfCheck: z.object({
                        surfaceVersion: z.string(),
                        serverToolCount: z.number().int(),
                        serverMissingStableTools: z.array(z.string()),
                        serverCoreWorkflowAvailable: z.boolean(),
                        hostToolsProvided: z.boolean(),
                        hostToolCount: z.number().int().nullable(),
                        hostMissingStableTools: z.array(z.string()),
                        hostMissingServerTools: z.array(z.string()),
                        hostCoreWorkflowAvailable: z.boolean().nullable(),
                        hostActionSnapshotStale: z.boolean().nullable(),
                    }),
                }),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ host_tools: hostTools }) => {
            const diskToolsetHash = buildToolsetHash();
            const restartRecommended = diskToolsetHash !== STARTUP_TOOLSET_HASH;
            const current = scope();
            const compatibility = checkChatGptCompatibility(serverTools, hostTools);
            return okResult(
                restartRecommended
                    ? `codex-mcp ${PACKAGE_VERSION} · core tool source changed on disk; restart recommended.`
                    : `codex-mcp ${PACKAGE_VERSION} · ${serverTools.length} registered tool name(s).`,
                {
                    version: PACKAGE_VERSION,
                    startedAt: PROCESS_STARTED_AT,
                    pid: process.pid,
                    projectRoot: current?.project.root ?? null,
                    workspaceRoots: current?.project.roots ?? [],
                    toolsetHash: STARTUP_TOOLSET_HASH,
                    diskToolsetHash,
                    toolCount: serverTools.length,
                    restartRequiredForCoreToolChanges: true,
                    restartRecommended,
                    capabilities: {
                        applyPatch: serverTools.includes("apply_patch"),
                        structuredSearch: serverTools.includes("grep"),
                        commandCwd:
                            serverTools.includes("bash") || serverTools.includes("exec_command"),
                        mutationDiff:
                            serverTools.includes("write") ||
                            serverTools.includes("edit") ||
                            serverTools.includes("apply_patch"),
                        externalReads:
                            serverTools.includes("read") || serverTools.includes("read_many"),
                        externalAuthorization:
                            serverTools.includes("permission_grant") ||
                            serverTools.includes("permission_control"),
                    },
                    compatibility: {
                        surfaceVersion: CHATGPT_SURFACE_VERSION,
                        stableTools: [...CHATGPT_STABLE_BOOTSTRAP_TOOLS],
                        controlGateways: [...CHATGPT_CONTROL_GATEWAY_TOOLS],
                        serverTools,
                        additiveOptionalParametersPreferred: true,
                        toolsListChangedRefreshesApprovedSnapshot: false,
                        fallback: {
                            projectBinding: {
                                preferredTool: "project_select",
                                compatibilityTool: "workspace_projects",
                                selectorParameters: ["project_id", "project_path", "force"],
                                available:
                                    options.daemonMode && serverTools.includes("workspace_projects"),
                            },
                            externalAuthorization: {
                                preferred: "MCP elicitation",
                                fallbackTool: "permission_grant",
                                gatewayTool: "permission_control",
                                fallbackToolAvailable: serverTools.includes("permission_grant"),
                                gatewayToolAvailable: serverTools.includes("permission_control"),
                                staleSnapshotRecovery: "Refresh or re-publish the ChatGPT MCP app actions.",
                            },
                            persistentWorkspaceTrust: {
                                gatewayTool: "workspace_control",
                                legacyTools: ["workspace_add", "workspace_remove"],
                                available:
                                    serverTools.includes("workspace_control") ||
                                    serverTools.includes("workspace_add"),
                                includedInReadOnlyCompatibilityTool: false,
                                staleSnapshotRecovery: "Refresh or re-publish the ChatGPT MCP app actions.",
                            },
                        },
                        selfCheck: compatibility,
                    },
                },
            );
        },
    );
}

function toolNamesForServer(options: {
    daemonMode: boolean;
    allowedTools?: ReadonlySet<string>;
}): string[] {
    const projectTools = new Set<string>(PROJECT_TOOL_NAMES);
    return TOOL_NAMES.filter(
        (name) =>
            (options.daemonMode || !projectTools.has(name)) &&
            (options.allowedTools?.has(name) ?? true),
    );
}
