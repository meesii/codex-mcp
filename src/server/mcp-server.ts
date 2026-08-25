import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import { configureToolRegistrationPolicy } from "../lib/tool/log.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { UiPreferences } from "../ui/preferences.js";
import type { ToolScopeProvider, ToolScopeTryProvider } from "./project-router.js";
import type { ProjectToolDeps } from "../tools/projects.js";
import type { CapabilityToolScopeProvider } from "../capabilities/tool-scope.js";
import { registerAllTools } from "../tools/register.js";
import { PACKAGE_VERSION } from "./version.js";

export interface CreateMcpServerOptions {
    config: ServerConfig;
    scope: ToolScopeProvider;
    tryScope: ToolScopeTryProvider;
    hub: DownstreamMcpHub;
    skills: SkillRegistry;
    uiPreferences: UiPreferences;
    allowedTools?: ReadonlySet<string>;
    projectTools?: ProjectToolDeps;
    capabilityScope?: CapabilityToolScopeProvider;
}

const CORE_TOOL_GUIDE = [
    "- read — read one or several project files with numbered lines.",
    "- read_image — read or safely resize/compress a project image.",
    "- apply_patch — transactionally create, replace, overwrite, or delete files.",
    "- ls — list one project directory.",
    "- grep / glob / code_explore — search text, paths, or source structure.",
    "- exec_command — run a command; use write_stdin when it returns session_id.",
    "- skills_list / skill_read — discover and read imported skills.",
    "- mcp_tools / mcp_call — discover and call downstream MCP tools.",
    "- summary — mandatory one-paragraph end-of-round checkpoint.",
];

export function buildServerInstructions(projectRoot: string, hub?: DownstreamMcpHub, skills?: SkillRegistry): string {
    return [
        "<environment_context>",
        `  <project_root>${projectRoot}</project_root>`,
        `  <shell>${process.platform === "win32" ? "powershell" : "bash"}</shell>`,
        "  <paths>all file and command paths must remain inside the bound project root</paths>",
        "</environment_context>",
        "",
        "Codex-MCP exposes a deliberately small coding toolset:",
        ...CORE_TOOL_GUIDE,
        "",
        "Every tool call requires purpose: a short user-visible statement of its immediate intent.",
        "After using any tool in a user round, call summary exactly once before the final response.",
        ...(hub?.buildInstructionsBlock() ? ["", hub.buildInstructionsBlock()] : []),
        ...(skills?.buildInstructionsBlock() ? ["", skills.buildInstructionsBlock()] : []),
    ].join("\n");
}

export function buildMultiProjectInstructions(): string {
    return [
        "<environment_context>",
        "  <mode>codex-mcp multi-project daemon</mode>",
        "  <binding>each conversation must use project_control to list and explicitly select one project before project-level tools are called</binding>",
        `  <shell>${process.platform === "win32" ? "powershell" : "bash"}</shell>`,
        "</environment_context>",
        "",
        "- project_control — list/select/current/unbind the conversation project. Never guess or switch without user confirmation.",
        ...CORE_TOOL_GUIDE,
        "- Project-specific Skills and downstream MCPs are resolved from the current binding; use skills_list / mcp_tools after switching projects instead of relying on a daemon-startup snapshot.",
        "",
        "Every tool call requires purpose: a short user-visible statement of its immediate intent.",
        "After using any tool in a user round, call summary exactly once before the final response.",
    ].join("\n");
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
    const { config, scope, tryScope, hub, skills, uiPreferences, allowedTools, projectTools, capabilityScope } = options;
    const server = new McpServer(
        { name: "codex-mcp", version: PACKAGE_VERSION },
        { instructions: projectTools
            ? buildMultiProjectInstructions()
            : buildServerInstructions(scope().project.root, hub, skills) },
    );
    configureToolRegistrationPolicy(server, allowedTools);
    registerAllTools(server, config, { scope, tryScope, projectTools, capabilityScope }, hub, skills, uiPreferences);
    return server;
}
