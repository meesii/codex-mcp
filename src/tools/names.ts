/** Local coding tools (always registered). */
export const CORE_TOOL_NAMES = [
    "read",
    "read_many",
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
    "runtime_status",
    "server_info",
    "grep",
    "glob",
    "ls",
    "webfetch",
    "summary",
    "goal_start",
    "goal_status",
    "goal_update",
    "goal_verify",
    "goal_finish",
    "goal_cancel",
    "settings_get",
    "settings_update",
    "skills_list",
    "skill_read",
    "agents_for_path",
    "capabilities_reload",
    "workspace_projects",
    "workspace_search",
    "context_pack",
    "git_status",
    "git_diff",
    "git_log",
    "git_show",
    "git_branches",
    "code_explore",
] as const;

/** Downstream gateway tools stay registered so hot reload works in existing sessions. */
export const GATEWAY_TOOL_NAMES = [
    "mcp_servers",
    "mcp_reconnect",
    "mcp_tools",
    "mcp_call",
    "mcp_resources",
    "mcp_resource_read",
    "mcp_prompts",
    "mcp_prompt_get",
] as const;

/** All tool names this package may expose. */
export const TOOL_NAMES = [...CORE_TOOL_NAMES, ...GATEWAY_TOOL_NAMES] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[number];
export type ToolName = (typeof TOOL_NAMES)[number];
