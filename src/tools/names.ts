/** Local coding tools (always registered). */
export const CORE_TOOL_NAMES = [
    "read",
    "write",
    "edit",
    "bash",
    "exec_command",
    "write_stdin",
    "process_kill",
    "grep",
    "glob",
    "ls",
    "webfetch",
    "summary",
] as const;

/** Downstream gateway tools (registered when mcp.json has servers). */
export const GATEWAY_TOOL_NAMES = ["mcp_tools", "mcp_call"] as const;

/** All tool names this package may expose. */
export const TOOL_NAMES = [...CORE_TOOL_NAMES, ...GATEWAY_TOOL_NAMES] as const;

export type CoreToolName = (typeof CORE_TOOL_NAMES)[number];
export type GatewayToolName = (typeof GATEWAY_TOOL_NAMES)[number];
export type ToolName = (typeof TOOL_NAMES)[number];
