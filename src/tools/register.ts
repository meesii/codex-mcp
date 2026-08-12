import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { CapabilityManager } from "../capabilities/manager.js";
import type { UiSettingsStore } from "../ui/settings.js";
import type { PermissionManager } from "../permissions/manager.js";
import { configureServerToolAuth } from "../lib/tool/meta.js";
import {
    configureServerUiPreferences,
    registerToolCardResource,
} from "../ui/register-ui.js";
import type { ToolScopeProvider, ToolScopeTryProvider } from "../server/project-router.js";
import type { ProjectToolDeps } from "./projects.js";
import { registerProjectTools } from "./projects.js";
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
import { registerPermissionTools } from "./permissions.js";
import { registerMcpGatewayTools } from "./mcp-gateway.js";
import { registerSkillTools } from "./skills.js";
import { registerAgentTools } from "./agents.js";
import { registerCapabilityTools } from "./capabilities.js";
import { registerWorkspaceTools } from "./workspace.js";
import { registerGitTools } from "./git.js";
import { registerCodeExploreTool } from "./code-explore.js";

export { TOOL_NAMES } from "./names.js";

export interface RegisterToolsOptions {
    /** Project scope resolved per tool call (throws UnboundProjectError when unbound). */
    scope: ToolScopeProvider;
    /** Unbound-safe scope view used by server_info. */
    tryScope: ToolScopeTryProvider;
    /** Multi-project binding tools; registered only in daemon mode. */
    projectTools?: ProjectToolDeps;
    /** Concrete server-side tool policy for this client. */
    allowedTools?: ReadonlySet<string>;
}

export function registerAllTools(
    server: McpServer,
    config: ServerConfig,
    options: RegisterToolsOptions,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
    capabilities: CapabilityManager | undefined,
    uiSettings: UiSettingsStore,
    permissions: PermissionManager,
): void {
    const { scope, tryScope, projectTools, allowedTools } = options;
    configureServerToolAuth(server, config.oauthRequired);
    configureServerUiPreferences(server, uiSettings.get());
    registerToolCardResource(server, config);
    if (projectTools) {
        registerProjectTools(server, projectTools);
    }
    registerReadTool(server, scope);
    registerReadManyTool(server, scope);
    registerWriteTool(server, scope, permissions);
    registerEditTool(server, scope, permissions);
    registerApplyPatchTool(server, scope, permissions);
    registerBashTool(server, scope, permissions);
    registerExecCommandTool(server, scope, permissions);
    registerWriteStdinTool(server, scope);
    registerProcessKillTool(server, scope);
    registerProcessInspectTools(server, scope);
    registerRuntimeStatusTool(server, scope);
    registerServerInfoTool(server, tryScope, {
        daemonMode: projectTools !== undefined,
        allowedTools,
    });
    registerGrepTool(server, scope);
    registerGlobTool(server, scope);
    registerLsTool(server, scope);
    registerWebfetchTool(server);
    registerSummaryTool(server);
    registerGoalTools(server, scope);
    registerSettingsTools(server, uiSettings);
    registerPermissionTools(server, permissions);
    registerSkillTools(server, skills);
    registerAgentTools(server, scope);
    registerCapabilityTools(server, hub, skills, capabilities);
    registerWorkspaceTools(server, scope, skills, hub, capabilities, projectTools);
    registerGitTools(server, scope);
    registerCodeExploreTool(server, scope, hub);
    // Gateway tools stay registered even when zero downstream servers are
    // configured so hot-reloaded external MCPs become visible to existing sessions.
    registerMcpGatewayTools(server, hub, capabilities);
}
