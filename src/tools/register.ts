import type { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { UiSettingsStore } from "../ui/settings.js";
import { configureServerToolAuth } from "../lib/tool/meta.js";
import { configureServerUiPreferences, registerToolCardResource } from "../ui/register-ui.js";
import type { ToolScopeProvider, ToolScopeTryProvider } from "../server/project-router.js";
import type { ProjectToolDeps } from "./projects.js";
import { registerProjectTools } from "./projects.js";
import { registerReadTool } from "./read.js";
import { registerReadImageTool } from "./read-image.js";
import { registerApplyPatchTool } from "./apply-patch.js";
import { registerLsTool } from "./ls.js";
import { registerGrepTool } from "./grep.js";
import { registerGlobTool } from "./glob.js";
import { registerCodeExploreTool } from "./code-explore.js";
import { registerExecCommandTool } from "./exec-command.js";
import { registerWriteStdinTool } from "./write-stdin.js";
import { registerSkillTools } from "./skills.js";
import { registerMcpGatewayTools } from "./mcp-gateway.js";
import { registerSummaryTool } from "./summary.js";

export { TOOL_NAMES } from "./names.js";

export interface RegisterToolsOptions {
    scope: ToolScopeProvider;
    tryScope: ToolScopeTryProvider;
    projectTools?: ProjectToolDeps;
}

export function registerAllTools(
    server: McpServer,
    config: ServerConfig,
    options: RegisterToolsOptions,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
    uiSettings: UiSettingsStore,
): void {
    const { scope, tryScope, projectTools } = options;
    configureServerToolAuth(server, config.oauthRequired);
    configureServerUiPreferences(server, uiSettings.get());
    registerToolCardResource(server, config);

    if (projectTools) registerProjectTools(server, projectTools);
    registerReadTool(server, scope);
    registerReadImageTool(server, scope);
    registerApplyPatchTool(server, scope);
    registerLsTool(server, scope);
    registerGrepTool(server, scope);
    registerGlobTool(server, scope);
    registerCodeExploreTool(server, scope);
    registerExecCommandTool(server, scope);
    registerWriteStdinTool(server, scope);
    registerSkillTools(server, skills);
    registerMcpGatewayTools(server, hub);
    registerSummaryTool(server, tryScope);
}
