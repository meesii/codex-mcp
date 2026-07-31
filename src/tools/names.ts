/** All coding tool names exposed by this MCP server. */
export const TOOL_NAMES = [
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
] as const;

export type ToolName = (typeof TOOL_NAMES)[number];
