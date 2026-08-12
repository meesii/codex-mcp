/**
 * Stable ChatGPT-facing ABI. Additive optional parameters may evolve these
 * tools, but existing project bind/context/coding flows must remain usable.
 */
export const CHATGPT_SURFACE_VERSION = "1.0.0";

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

export interface ChatGptCompatibilityCheck {
    surfaceVersion: string;
    serverToolCount: number;
    serverMissingStableTools: string[];
    serverCoreWorkflowAvailable: boolean;
    hostToolsProvided: boolean;
    hostToolCount: number | null;
    hostMissingStableTools: string[];
    hostMissingServerTools: string[];
    hostCoreWorkflowAvailable: boolean | null;
    hostActionSnapshotStale: boolean | null;
}

/** Compare the registered server surface and, when supplied, a host snapshot. */
export function checkChatGptCompatibility(
    serverTools: readonly string[],
    hostTools?: readonly string[],
): ChatGptCompatibilityCheck {
    const server = new Set(serverTools);
    const serverMissingStableTools = CHATGPT_STABLE_BOOTSTRAP_TOOLS.filter(
        (name) => !server.has(name),
    );
    const hostProvided = hostTools !== undefined;
    const host = new Set(hostTools ?? []);
    const hostMissingStableTools = hostProvided
        ? CHATGPT_STABLE_BOOTSTRAP_TOOLS.filter((name) => !host.has(name))
        : [];
    const hostMissingServerTools = hostProvided
        ? [...server].filter((name) => !host.has(name)).sort()
        : [];

    return {
        surfaceVersion: CHATGPT_SURFACE_VERSION,
        serverToolCount: server.size,
        serverMissingStableTools: [...serverMissingStableTools],
        serverCoreWorkflowAvailable: serverMissingStableTools.length === 0,
        hostToolsProvided: hostProvided,
        hostToolCount: hostProvided ? host.size : null,
        hostMissingStableTools: [...hostMissingStableTools],
        hostMissingServerTools,
        hostCoreWorkflowAvailable: hostProvided ? hostMissingStableTools.length === 0 : null,
        hostActionSnapshotStale: hostProvided ? hostMissingServerTools.length > 0 : null,
    };
}
