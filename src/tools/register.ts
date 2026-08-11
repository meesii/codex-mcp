import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import type { AgentInstructionRegistry } from "../agents/registry.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { ProcessSessionManager } from "../lib/process/sessions.js";
import type { ProjectContext } from "../config/project.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { GoalStore } from "../goals/store.js";
import type { UiSettingsStore } from "../ui/settings.js";
import { configureServerToolAuth } from "../lib/tool/meta.js";
import {
    configureServerUiPreferences,
    registerToolCardResource,
} from "../ui/register-ui.js";
import { registerReadManyTool, registerReadTool } from "./read.js";
import { registerWriteTool } from "./write.js";
import { registerEditTool } from "./edit.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerBashTool } from "./bash.js";
import { registerExecCommandTool } from "./exec-command.js";
import { registerWriteStdinTool } from "./write-stdin.js";
import { registerProcessKillTool } from "./process-kill.js";
import { registerProcessInspectTools } from "./process-inspect.js";
import { registerRuntimeStatusTool } from "./runtime-status.js";
import { registerServerInfoTool } from "./server-info.js";
import { registerGrepTool } from "./grep.js";
import { registerGlobTool } from "./glob.js";
import { registerLsTool } from "./ls.js";
import { registerWebfetchTool } from "./webfetch.js";
import { registerSummaryTool } from "./summary.js";
import { registerGoalTools } from "./goals.js";
import { registerSettingsTools } from "./settings.js";
import { registerMcpGatewayTools } from "./mcp-gateway.js";
import { registerSkillTools } from "./skills.js";
import { registerAgentTools } from "./agents.js";
import { registerCapabilityTools } from "./capabilities.js";
import { registerWorkspaceTools } from "./workspace.js";
import { registerGitTools } from "./git.js";
import { registerCodeExploreTool } from "./code-explore.js";

export { TOOL_NAMES } from "./names.js";

export function registerAllTools(
    server: McpServer,
    config: ServerConfig,
    project: ProjectContext,
    processes: ProcessSessionManager,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
    agents: AgentInstructionRegistry,
    workspace: WorkspaceRegistry,
    goals: GoalStore,
    uiSettings: UiSettingsStore,
): void {
    configureServerToolAuth(server, config.oauthRequired);
    configureServerUiPreferences(server, uiSettings.get());
    registerToolCardResource(server, config);
    registerReadTool(server, project);
    registerReadManyTool(server, project);
    registerWriteTool(server, project);
    registerEditTool(server, project);
    registerApplyPatchTool(server, project);
    registerBashTool(server, project);
    registerExecCommandTool(server, project, processes);
    registerWriteStdinTool(server, processes);
    registerProcessKillTool(server, processes);
    registerProcessInspectTools(server, processes);
    registerRuntimeStatusTool(server, processes);
    registerServerInfoTool(server, project);
    registerGrepTool(server, project);
    registerGlobTool(server, project);
    registerLsTool(server, project);
    registerWebfetchTool(server);
    registerSummaryTool(server);
    registerGoalTools(server, goals);
    registerSettingsTools(server, uiSettings);
    registerSkillTools(server, skills);
    registerAgentTools(server, agents);
    registerCapabilityTools(server, hub, skills);
    registerWorkspaceTools(server, workspace, agents, skills, hub);
    registerGitTools(server, project);
    registerCodeExploreTool(server, project, workspace, hub);
    // Gateway tools stay registered even when zero downstream servers are
    // configured so hot-reloaded Codex MCPs become visible to existing sessions.
    registerMcpGatewayTools(server, hub);
}
