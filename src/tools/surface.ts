/**
 * Stable ChatGPT-facing ABI. Additive optional parameters may evolve these
 * tools, but existing project bind/context/coding flows must remain usable.
 */
export const CHATGPT_SURFACE_VERSION = "1.1.0";

export const CHATGPT_STABLE_BOOTSTRAP_TOOLS = [
    "server_info",
    "workspace_projects",
    "workspace_context",
    "context_pack",
    "read",
    "read_many",
    "grep",
    "glob",
    "ls",
    "write",
    "edit",
    "apply_patch",
    "bash",
    "exec_command",
    "write_stdin",
    "process_kill",
    "process_list",
    "process_status",
    "process_output",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_branches",
] as const;

export const CHATGPT_CONTROL_GATEWAY_TOOLS = [
    "project_control",
    "permission_control",
    "workspace_control",
] as const;

export interface HostToolSchemaSummary {
    name: string;
    inputProperties: string[];
}

export interface ChatGptCompatibilityCheck {
    surfaceVersion: string;
    serverToolCount: number;
    serverMissingStableTools: string[];
    serverCoreWorkflowAvailable: boolean;
    hostToolsProvided: boolean;
    hostToolSchemasProvided: boolean;
    hostToolCount: number | null;
    hostMissingStableTools: string[];
    hostMissingServerTools: string[];
    hostIncompatibleToolSchemas: string[];
    hostProjectBindingAvailable: boolean | null;
    hostCoreWorkflowAvailable: boolean | null;
    hostActionSnapshotStale: boolean | null;
}

/** Compare the registered server surface and, when supplied, a frozen host snapshot. */
export function checkChatGptCompatibility(
    serverTools: readonly string[],
    hostTools?: readonly string[],
    hostToolSchemas?: readonly HostToolSchemaSummary[],
): ChatGptCompatibilityCheck {
    const server = new Set(serverTools);
    const serverMissingStableTools = CHATGPT_STABLE_BOOTSTRAP_TOOLS.filter(
        (name) => !server.has(name),
    );
    const hostProvided = hostTools !== undefined;
    const hostSchemasProvided = hostToolSchemas !== undefined;
    const host = new Set(hostTools ?? []);
    const hostSchemas = new Map(
        (hostToolSchemas ?? []).map((item) => [item.name, new Set(item.inputProperties)]),
    );
    const hostMissingStableTools = hostProvided
        ? CHATGPT_STABLE_BOOTSTRAP_TOOLS.filter((name) => !host.has(name))
        : [];
    const hostMissingServerTools = hostProvided
        ? [...server].filter((name) => !host.has(name)).sort()
        : [];
    const daemonMode = server.has("project_select");
    const hostIncompatibleToolSchemas: string[] = [];
    let hostProjectBindingAvailable: boolean | null = null;

    if (hostProvided && daemonMode) {
        if (host.has("project_select")) {
            hostProjectBindingAvailable = true;
        } else if (!host.has("workspace_projects")) {
            hostProjectBindingAvailable = false;
        } else if (!hostSchemasProvided) {
            // A frozen action can keep an old input schema even when its tool name
            // is still visible. Without the approved schema we cannot safely claim
            // that newly-added compatibility selector parameters are callable.
            hostProjectBindingAvailable = false;
        } else {
            const properties = hostSchemas.get("workspace_projects");
            hostProjectBindingAvailable =
                properties?.has("project_id") === true || properties?.has("project_path") === true;
            if (!hostProjectBindingAvailable) {
                hostIncompatibleToolSchemas.push("workspace_projects: missing project_id/project_path selector");
            }
        }
    }

    const hostCoreWorkflowAvailable = !hostProvided
        ? null
        : hostMissingStableTools.length === 0 &&
          (!daemonMode || hostProjectBindingAvailable === true);
    const hostActionSnapshotStale = !hostProvided
        ? null
        : hostMissingServerTools.length > 0 ||
          hostMissingStableTools.length > 0 ||
          hostIncompatibleToolSchemas.length > 0 ||
          (daemonMode && hostProjectBindingAvailable !== true);

    return {
        surfaceVersion: CHATGPT_SURFACE_VERSION,
        serverToolCount: server.size,
        serverMissingStableTools: [...serverMissingStableTools],
        serverCoreWorkflowAvailable: serverMissingStableTools.length === 0,
        hostToolsProvided: hostProvided,
        hostToolSchemasProvided: hostSchemasProvided,
        hostToolCount: hostProvided ? host.size : null,
        hostMissingStableTools: [...hostMissingStableTools],
        hostMissingServerTools,
        hostIncompatibleToolSchemas,
        hostProjectBindingAvailable,
        hostCoreWorkflowAvailable,
        hostActionSnapshotStale,
    };
}
