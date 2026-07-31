import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ServerConfig } from "../config.js";
import type { ProcessSessionManager } from "../lib/process-sessions.js";
import type { ProjectContext } from "../project.js";
import { registerToolCardResource } from "../ui/register-ui.js";
import { registerReadTool } from "./read.js";
import { registerWriteTool } from "./write.js";
import { registerEditTool } from "./edit.js";
import { registerBashTool } from "./bash.js";
import { registerExecCommandTool } from "./exec-command.js";
import { registerWriteStdinTool } from "./write-stdin.js";
import { registerProcessKillTool } from "./process-kill.js";
import { registerGrepTool } from "./grep.js";
import { registerGlobTool } from "./glob.js";
import { registerLsTool } from "./ls.js";
import { registerWebfetchTool } from "./webfetch.js";

export { TOOL_NAMES } from "./names.js";

/**
 * Register all coding tools on the MCP server.
 *
 * @param server - MCP server instance
 * @param config - Server configuration (widget domain / CSP)
 * @param project - Bound project context
 * @param processes - Shared process session manager
 */
export function registerAllTools(
    server: McpServer,
    config: ServerConfig,
    project: ProjectContext,
    processes: ProcessSessionManager,
): void {
    registerToolCardResource(server, config);
    registerReadTool(server, project);
    registerWriteTool(server, project);
    registerEditTool(server, project);
    registerBashTool(server, project);
    registerExecCommandTool(server, project, processes);
    registerWriteStdinTool(server, processes);
    registerProcessKillTool(server, processes);
    registerGrepTool(server, project);
    registerGlobTool(server, project);
    registerLsTool(server, project);
    registerWebfetchTool(server);
}
