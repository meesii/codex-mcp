export const PROJECT_TOOL_NAMES = ["project_control"] as const;

export const CORE_TOOL_NAMES = [
    "read",
    "read_image",
    "apply_patch",
    "ls",
    "grep",
    "glob",
    "code_explore",
    "exec_command",
    "write_stdin",
    "skills_list",
    "skill_read",
    "mcp_tools",
    "mcp_call",
    "summary",
] as const;

export const GATEWAY_TOOL_NAMES = ["mcp_tools", "mcp_call"] as const;

export const TOOL_NAMES = [...PROJECT_TOOL_NAMES, ...CORE_TOOL_NAMES] as const;

export type ProjectToolName = (typeof PROJECT_TOOL_NAMES)[number];
export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[number];
export type ToolName = (typeof TOOL_NAMES)[number];
