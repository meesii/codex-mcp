import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import type { AgentInstructionRegistry } from "../agents/registry.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import { configureToolRegistrationPolicy } from "../lib/tool/log.js";
import type { ProjectContext } from "../config/project.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { CapabilityManager } from "../capabilities/manager.js";
import type { UiSettingsStore } from "../ui/settings.js";
import { PermissionManager } from "../permissions/manager.js";
import type { PermissionGrantStore } from "../permissions/store.js";
import type { PermissionRuntime } from "../permissions/runtime.js";
import type {
    ToolScopeProvider,
    ToolScopeTryProvider,
} from "./project-router.js";
import type { ProjectToolDeps } from "../tools/projects.js";
import { registerAllTools } from "../tools/register.js";
import { PACKAGE_VERSION } from "./version.js";

function instructionShellName(): string {
    return process.platform === "win32" ? "powershell" : "bash";
}

export interface CreateMcpServerOptions {
    config: ServerConfig;
    /** Resolve project scope per tool call; throws UnboundProjectError when unbound. */
    scope: ToolScopeProvider;
    /** Unbound-safe scope view used by server_info. */
    tryScope: ToolScopeTryProvider;
    hub: DownstreamMcpHub;
    skills: SkillRegistry;
    capabilities: CapabilityManager | undefined;
    uiSettings: UiSettingsStore;
    allowedTools?: ReadonlySet<string>;
    permissionStore?: PermissionGrantStore;
    permissionRuntime?: PermissionRuntime;
    permissionOwnerId?: string;
    /** Multi-project binding tools; registered only in daemon mode. */
    projectTools?: ProjectToolDeps;
}

export function buildServerInstructions(
    projectRoot: string,
    hub?: DownstreamMcpHub,
    skills?: SkillRegistry,
    agents?: AgentInstructionRegistry,
    allowedTools?: ReadonlySet<string>,
    workspaceRoots?: readonly string[],
): string {
    const shell = instructionShellName();
    const trustedRoots = workspaceRoots?.length ? [...workspaceRoots] : [projectRoot];
    const environment = [
        "<environment_context>",
        `  <project_root>${projectRoot}</project_root>`,
        `  <workspace_roots>${trustedRoots.join(" | ")}</workspace_roots>`,
        `  <shell>${shell}</shell>`,
        "  <paths>relative paths use project_root; absolute reads may be outside workspaces; outside-workspace writes/exec cwd require user approval</paths>",
        "</environment_context>",
    ].join("\n");

    const allows = (name: string): boolean => allowedTools?.has(name) ?? true;
    const toolMap: string[] = [];
    const addTool = (name: string, text: string): void => {
        if (allows(name)) toolMap.push(`- ${name} — ${text}`);
    };
    addTool("read", "file contents before explain/change (not bash cat/type).");
    addTool("read_many", "batch-read related files with a bounded combined output budget.");
    addTool("grep", "structured ripgrep-style search with glob/exclude/context/result limits.");
    addTool("glob", "find paths by pattern (e.g. **/*.ts).");
    addTool("ls", "list one directory.");
    addTool("edit", "small exact string replace on an existing file.");
    addTool("apply_patch", "standard unified diff for multi-hunk or multi-file changes.");
    addTool("write", "create file or full overwrite; use edit/apply_patch for existing files.");
    addTool("bash", `short foreground ${shell} (install/test/build/git); optional safe cwd + bounded output modes; not for source read/edit.`);
    addTool("exec_command", "long-running or interactive command; optional safe cwd + bounded output modes; returns processId while running.");
    addTool("write_stdin", "poll or send stdin to a processId from exec_command; uses the same bounded output modes as exec_command.");
    addTool("process_kill", "force-stop a processId.");
    addTool("process_list", "recover managed process handles for the current stable owner.");
    addTool("process_status", "inspect a managed process without consuming output.");
    addTool("process_output", "peek buffered process output without consuming it; supports summary/tail/head_tail/full.");
    addTool("runtime_status", "inspect bounded aggregate runtime telemetry without exposing payloads or commands.");
    addTool("server_info", "inspect the running version/toolset fingerprint when connector schema freshness is uncertain.");
    addTool("webfetch", "fetch a public http(s) URL body.");
    addTool("summary", "mid-task user-visible progress (done=false + next) or final checkpoint (done=true).");
    addTool("goal_start", "persist a long-running project objective with constraints, tasks, and acceptance criteria across chat turns.");
    addTool("goal_status", "restore the active/recent project goal, task board, checkpoints, and verification state.");
    addTool("goal_update", "update goal tasks/constraints and append meaningful checkpoints; can pause/resume the goal.");
    addTool("goal_verify", "record concrete pass/fail evidence for an acceptance criterion.");
    addTool("goal_finish", "complete a goal only after every task is done and every acceptance criterion is passed.");
    addTool("goal_cancel", "cancel an abandoned/replaced goal while preserving its history.");
    addTool("settings_get", "open/read codex-mcp ChatGPT UI visibility settings.");
    addTool("settings_update", "persist ordinary-tool/status UI visibility and notify the client to refresh tool metadata.");
    addTool("permission_list", "list active external-access grants for this client plus permanent grants.");
    addTool("permission_grant", "user-confirmed session/one-time/permanent authorization for write/exec outside registered workspaces; session is the normal default, permanent requires explicit lasting intent.");
    addTool("permission_revoke", "revoke matching external-access grants for an exact directory/capability.");
    addTool("permission_control", "stable low-frequency gateway for listing/granting/revoking external access; grants remain user-confirmed state changes.");
    addTool("skills_list", "list model-invocable skills from enabled external capability sources.");
    addTool("skill_read", "read a matching skill's SKILL.md or referenced text file before following it.");
    addTool("agents_for_path", "load global + nested AGENTS.md rules for a project path.");
    addTool("capabilities_reload", "force-refresh enabled external MCP and Skill sources; automatic watching depends on the configured sync mode.");
    addTool("workspace_roots", "list the primary and additional trusted workspace roots.");
    addTool("workspace_add", "persistently trust an existing directory as a read/write/exec workspace; use only when the user explicitly requests broader workspace trust.");
    addTool("workspace_remove", "remove persisted trust for an additional workspace; primary workspace cannot be removed at runtime.");
    addTool("workspace_control", "stable low-frequency gateway for listing or explicitly changing persistent workspace trust.");
    addTool("workspace_projects", "discover Git projects across registered workspaces.");
    addTool("workspace_search", "bounded structured search across the workspace.");
    addTool("workspace_context", "one-call Chat-oriented project snapshot: Git/current Goal/processes/instructions/Skills/focus/entry points/warnings; prefer first for continue/look-at-this-project prompts.");
    addTool("context_pack", "assemble scope-focused project/files/AGENTS/skills context; after using it for a scope, do not re-load agents_for_path unless moving deeper.");
    addTool("git_status", "structured read-only Git status.");
    addTool("git_diff", "bounded read-only Git diff.");
    addTool("git_log", "structured recent Git commits.");
    addTool("git_show", "bounded read-only revision patch/stat.");
    addTool("git_branches", "list local/remote Git refs.");
    addTool("code_explore", "prefer CodeGraph for code relationships, with bounded search fallback.");
    addTool("mcp_servers", "list downstream MCP connection/capability state.");
    addTool("mcp_reconnect", "reconnect one downstream MCP.");
    addTool("mcp_tools", "discover downstream tool schemas.");
    addTool("mcp_call", "call a downstream tool.");
    addTool("mcp_resources", "discover downstream resources/templates.");
    addTool("mcp_resource_read", "read a downstream resource.");
    addTool("mcp_prompts", "discover downstream prompts.");
    addTool("mcp_prompt_get", "resolve a downstream prompt without executing it.");

    const limits: string[] = [];
    if (["exec_command", "write_stdin", "process_kill"].every(allows)) {
        limits.push("- Servers/watchers: exec_command → write_stdin (poll) → process_kill when done.");
    }
    if (allows("summary")) {
        limits.push(
            "- Mid-task status: summary(done=false); do not use plain chat for partial progress.",
            "- summary(done=true) only when the full user task is finished.",
        );
    }
    if (allows("workspace_context")) {
        limits.push(
            "- Chat project resume/overview: use workspace_context first for requests like 'continue this project', 'what changed?', or 'look at the current work'; only drill into lower-level Git/search/read tools for missing detail.",
        );
    }
    if (["goal_start", "goal_status", "goal_update", "goal_verify", "goal_finish"].every(allows)) {
        limits.push(
            "- Long-running project work that may span chat turns: goal_start → goal_update checkpoints/tasks → goal_verify acceptance criteria → goal_finish. Restore with goal_status before continuing in a later turn/chat.",
            "- Do not use goal_finish as a narrative claim: it intentionally fails unless all goal tasks are done and all acceptance criteria have passed evidence.",
        );
    }
    if (["settings_get", "settings_update"].every(allows)) {
        limits.push(
            "- ChatGPT custom UI: ordinary tool cards default off; Summary/Goal status cards default on. Use settings_get to open the interactive settings panel or settings_update for direct changes.",
        );
    }
    if (allows("permission_grant") || allows("permission_control")) {
        limits.push(
            "- External filesystem writes / external command cwd: prefer MCP elicitation. If unsupported, use visible write-annotated permission_grant or permission_control for the exact directory and retry. If neither action is visible, report a stale host action snapshot and ask the user to Refresh/re-publish; never route authorization through a read-only compatibility tool.",
            "- If the user clearly treats an external directory as a recurring project/workspace, prefer suggesting or using workspace_add with user confirmation instead of repeatedly granting temporary external access. Do not upgrade a one-off directory to a workspace silently.",
        );
    }
    if (["edit", "apply_patch", "write", "bash"].some(allows)) {
        const recoveryTools = ["edit", "apply_patch", "write", "bash"].filter(allows).join("/");
        limits.push(`- On tool failure: inspect the returned error/output, then use ${recoveryTools} when appropriate and retry.`);
    }
    if (["mcp_servers", "mcp_tools", "mcp_resources", "mcp_prompts"].some(allows)) {
        limits.push(
            "- Downstream MCP: use the enabled gateway discovery tools for current hot-reloaded state before using names or schemas you have not loaded.",
        );
    }
    if (skills?.hasSkills() && allows("skill_read")) {
        limits.push(
            "- Imported skills: when a listed skill clearly matches the task, call skill_read before acting; do not infer the full skill from its description.",
        );
    }

    const bodyParts = [
        "Codex-MCP: local coding tools with a primary project plus optional additional workspaces. Relative paths use project_root; absolute reads may go outside workspaces. Shell is " + shell + ".",
    ];
    if (toolMap.length > 0) {
        bodyParts.push("", "Tool map (pick by goal):", ...toolMap);
    } else {
        bodyParts.push("", "No coding tools are enabled for this client session.");
    }
    if (limits.length > 0) {
        bodyParts.push("", "Shared sequences / limits:", ...limits);
    }
    const body = bodyParts.join("\n");

    const extraBlocks = [
        allows("agents_for_path") ? (agents?.buildInstructionsBlock() ?? "") : "",
        ["mcp_servers", "mcp_tools", "mcp_resources", "mcp_prompts"].some(allows)
            ? (hub?.buildInstructionsBlock() ?? "")
            : "",
        allows("skill_read") ? (skills?.buildInstructionsBlock() ?? "") : "",
    ].filter(Boolean);
    if (extraBlocks.length === 0) {
        return `${environment}\n\n${body}`;
    }
    return `${environment}\n\n${body}\n\n${extraBlocks.join("\n\n")}`;
}

export function createMcpServer(options: CreateMcpServerOptions): McpServer {
    const {
        config,
        scope,
        tryScope,
        hub,
        skills,
        capabilities,
        uiSettings,
        allowedTools,
        permissionStore,
        permissionRuntime,
        permissionOwnerId,
        projectTools,
    } = options;

    const server = new McpServer(
        {
            name: "codex-mcp",
            version: PACKAGE_VERSION,
        },
        {
            instructions: projectTools
                ? buildMultiProjectInstructions(hub, skills, allowedTools)
                : buildSingleProjectInstructions(scope, hub, skills, allowedTools),
        },
    );

    const permissions = new PermissionManager(server, () => scope().project, {
        ...(permissionStore ? { store: permissionStore } : {}),
        ...(permissionRuntime ? { runtime: permissionRuntime } : {}),
        ...(permissionOwnerId ? { ownerId: permissionOwnerId } : {}),
    });
    configureToolRegistrationPolicy(server, allowedTools);
    registerAllTools(
        server,
        config,
        { scope, tryScope, projectTools, allowedTools },
        hub,
        skills,
        capabilities,
        uiSettings,
        permissions,
    );
    return server;
}

/** Single-project instructions keep the historical per-project environment block. */
function buildSingleProjectInstructions(
    scope: ToolScopeProvider,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
    allowedTools?: ReadonlySet<string>,
): string {
    const current = scope();
    return buildServerInstructions(
        current.project.root,
        hub,
        skills,
        current.agents,
        allowedTools,
        current.project.roots,
    );
}

/**
 * Multi-project instructions describe the binding flow instead of a fixed
 * project root. Each ChatGPT conversation must bind to a project first.
 */
export function buildMultiProjectInstructions(
    hub?: DownstreamMcpHub,
    skills?: SkillRegistry,
    allowedTools?: ReadonlySet<string>,
): string {
    const shell = instructionShellName();
    const environment = [
        "<environment_context>",
        "  <mode>codex-mcp multi-project daemon</mode>",
        "  <binding>each ChatGPT conversation must bind to exactly one registered project before project-level tools can be used; prefer project_list + project_select. workspace_projects(project_id=...) is only a compatibility path when the host-approved workspace_projects input schema actually exposes that selector; otherwise Refresh/re-publish the MCP app actions</binding>",
        `  <shell>${shell}</shell>`,
        "  <paths>relative paths use the bound project root; absolute reads may be outside workspaces; outside-workspace writes/exec cwd require user approval</paths>",
        "</environment_context>",
    ].join("\n");

    const allows = (name: string): boolean => allowedTools?.has(name) ?? true;
    const toolMap: string[] = [];
    const addTool = (name: string, text: string): void => {
        if (allows(name)) toolMap.push(`- ${name} — ${text}`);
    };
    addTool("project_list", "list registered projects and the current conversation binding (always available).");
    addTool("project_select", "bind this conversation to a project (required before project tools).");
    addTool("project_current", "show the current binding and bound project summary.");
    addTool("project_unbind", "remove the current binding without deactivating the project.");
    addTool("project_control", "stable low-frequency gateway for project list/select/current/unbind operations.");
    addTool("read", "file contents before explain/change (not bash cat/type).");
    addTool("read_many", "batch-read related files with a bounded combined output budget.");
    addTool("grep", "structured ripgrep-style search with glob/exclude/context/result limits.");
    addTool("glob", "find paths by pattern (e.g. **/*.ts).");
    addTool("ls", "list one directory.");
    addTool("edit", "small exact string replace on an existing file.");
    addTool("apply_patch", "standard unified diff for multi-hunk or multi-file changes.");
    addTool("write", "create file or full overwrite; use edit/apply_patch for existing files.");
    addTool("bash", `short foreground ${shell} (install/test/build/git); optional safe cwd + bounded output modes; not for source read/edit.`);
    addTool("exec_command", "long-running or interactive command; optional safe cwd + bounded output modes; returns processId while running.");
    addTool("write_stdin", "poll or send stdin to a processId from exec_command; uses the same bounded output modes as exec_command.");
    addTool("process_kill", "force-stop a processId.");
    addTool("process_list", "recover managed process handles for the current stable owner.");
    addTool("process_status", "inspect a managed process without consuming output.");
    addTool("process_output", "peek buffered process output without consuming it; supports summary/tail/head_tail/full.");
    addTool("runtime_status", "inspect bounded aggregate runtime telemetry without exposing payloads or commands.");
    addTool("server_info", "inspect the running version/toolset fingerprint when connector schema freshness is uncertain.");
    addTool("webfetch", "fetch a public http(s) URL body.");
    addTool("summary", "mid-task user-visible progress (done=false + next) or final checkpoint (done=true).");
    addTool("goal_start", "persist a long-running project objective with constraints, tasks, and acceptance criteria across chat turns.");
    addTool("goal_status", "restore the active/recent project goal, task board, checkpoints, and verification state.");
    addTool("goal_update", "update goal tasks/constraints and append meaningful checkpoints; can pause/resume the goal.");
    addTool("goal_verify", "record concrete pass/fail evidence for an acceptance criterion.");
    addTool("goal_finish", "complete a goal only after every task is done and every acceptance criterion is passed.");
    addTool("goal_cancel", "cancel an abandoned/replaced goal while preserving its history.");
    addTool("settings_get", "open/read codex-mcp ChatGPT UI visibility settings.");
    addTool("settings_update", "persist ordinary-tool/status UI visibility and notify the client to refresh tool metadata.");
    addTool("permission_list", "list active external-access grants for this client plus permanent grants.");
    addTool("permission_grant", "user-confirmed session/one-time/permanent authorization for write/exec outside registered workspaces; session is the normal default, permanent requires explicit lasting intent.");
    addTool("permission_revoke", "revoke matching external-access grants for an exact directory/capability.");
    addTool("permission_control", "stable low-frequency gateway for listing/granting/revoking external access; grants remain user-confirmed state changes.");
    addTool("skills_list", "list model-invocable skills from enabled external capability sources.");
    addTool("skill_read", "read a matching skill's SKILL.md or referenced text file before following it.");
    addTool("agents_for_path", "load global + nested AGENTS.md rules for a project path.");
    addTool("capabilities_reload", "force-refresh enabled external MCP and Skill sources; automatic watching depends on the configured sync mode.");
    addTool("workspace_roots", "list the primary and additional trusted workspace roots.");
    addTool("workspace_add", "persistently trust an existing directory as a read/write/exec workspace; use only when the user explicitly requests broader workspace trust.");
    addTool("workspace_remove", "remove persisted trust for an additional workspace; primary workspace cannot be removed at runtime.");
    addTool("workspace_control", "stable low-frequency gateway for listing or explicitly changing persistent workspace trust.");
    addTool("workspace_projects", "stable ChatGPT ABI: optionally bind via project_id/project_path, then discover Git projects.");
    addTool("workspace_search", "bounded structured search across the workspace.");
    addTool("workspace_context", "one-call Chat-oriented project snapshot: Git/current Goal/processes/instructions/Skills/focus/entry points/warnings; prefer first for continue/look-at-this-project prompts.");
    addTool("context_pack", "assemble scope-focused project/files/AGENTS/skills context; after using it for a scope, do not re-load agents_for_path unless moving deeper.");
    addTool("git_status", "structured read-only Git status.");
    addTool("git_diff", "bounded read-only Git diff.");
    addTool("git_log", "structured recent Git commits.");
    addTool("git_show", "bounded read-only revision patch/stat.");
    addTool("git_branches", "list local/remote Git refs.");
    addTool("code_explore", "prefer CodeGraph for code relationships, with bounded search fallback.");
    addTool("mcp_servers", "list downstream MCP connection/capability state.");
    addTool("mcp_reconnect", "reconnect one downstream MCP.");
    addTool("mcp_tools", "discover downstream tool schemas.");
    addTool("mcp_call", "call a downstream tool.");
    addTool("mcp_resources", "discover downstream resources/templates.");
    addTool("mcp_resource_read", "read a downstream resource.");
    addTool("mcp_prompts", "discover downstream prompts.");
    addTool("mcp_prompt_get", "resolve a downstream prompt without executing it.");

    const limits: string[] = [];
    if (["project_list", "project_select"].every(allows)) {
        limits.push(
            "- Project binding: when a project-level tool reports that no project is bound, call project_list, ask the user which project to use, then call project_select with the chosen project_id. Never guess a project. Switch projects only with explicit user confirmation and force=true.",
        );
    } else if (allows("workspace_projects")) {
        limits.push(
            "- Project binding compatibility: workspace_projects(project_id=...) is usable only when the host-approved workspace_projects schema visibly contains project_id/project_path. A frozen older schema without those selectors cannot receive newly-added optional parameters; Refresh/re-publish the MCP app actions instead. Never guess a project; use force=true only after explicit confirmation to switch.",
        );
    }
    if (["exec_command", "write_stdin", "process_kill"].every(allows)) {
        limits.push("- Servers/watchers: exec_command → write_stdin (poll) → process_kill when done.");
    }
    if (allows("summary")) {
        limits.push(
            "- Mid-task status: summary(done=false); do not use plain chat for partial progress.",
            "- summary(done=true) only when the full user task is finished.",
        );
    }
    if (allows("workspace_context")) {
        limits.push(
            "- Chat project resume/overview: use workspace_context first for requests like 'continue this project', 'what changed?', or 'look at the current work'; only drill into lower-level Git/search/read tools for missing detail.",
        );
    }
    if (["goal_start", "goal_status", "goal_update", "goal_verify", "goal_finish"].every(allows)) {
        limits.push(
            "- Long-running project work that may span chat turns: goal_start → goal_update checkpoints/tasks → goal_verify acceptance criteria → goal_finish. Restore with goal_status before continuing in a later turn/chat.",
            "- Do not use goal_finish as a narrative claim: it intentionally fails unless all goal tasks are done and all acceptance criteria have passed evidence.",
        );
    }
    if (["settings_get", "settings_update"].every(allows)) {
        limits.push(
            "- ChatGPT custom UI: ordinary tool cards default off; Summary/Goal status cards default on. Use settings_get to open the interactive settings panel or settings_update for direct changes.",
        );
    }
    if (allows("permission_grant") || allows("permission_control")) {
        limits.push(
            "- External filesystem writes / external command cwd: prefer MCP elicitation. If unsupported, use visible write-annotated permission_grant or permission_control for the exact directory and retry. If neither action is visible, report a stale host action snapshot and ask the user to Refresh/re-publish; never route authorization through workspace_projects or another compatibility read path.",
            "- If the user clearly treats an external directory as a recurring project/workspace, prefer suggesting or using workspace_add with user confirmation instead of repeatedly granting temporary external access. Do not upgrade a one-off directory to a workspace silently.",
        );
    }
    if (["edit", "apply_patch", "write", "bash"].some(allows)) {
        const recoveryTools = ["edit", "apply_patch", "write", "bash"].filter(allows).join("/");
        limits.push(`- On tool failure: inspect the returned error/output, then use ${recoveryTools} when appropriate and retry.`);
    }
    if (["mcp_servers", "mcp_tools", "mcp_resources", "mcp_prompts"].some(allows)) {
        limits.push(
            "- Downstream MCP: use the enabled gateway discovery tools for current hot-reloaded state before using names or schemas you have not loaded.",
        );
    }
    if (skills?.hasSkills() && allows("skill_read")) {
        limits.push(
            "- Imported skills: when a listed skill clearly matches the task, call skill_read before acting; do not infer the full skill from its description.",
        );
    }

    const bodyParts = [
        "Codex-MCP multi-project daemon: one local MCP server plus one public tunnel serving multiple registered local projects. Each ChatGPT conversation must bind to one project first; prefer project_list + project_select. workspace_projects(project_id=...) is only a compatibility fallback when that selector is present in the host-approved input schema; otherwise Refresh/re-publish the MCP app actions.",
    ];
    if (toolMap.length > 0) {
        bodyParts.push("", "Tool map (pick by goal):", ...toolMap);
    } else {
        bodyParts.push("", "No coding tools are enabled for this client session.");
    }
    if (limits.length > 0) {
        bodyParts.push("", "Shared sequences / limits:", ...limits);
    }
    const body = bodyParts.join("\n");

    const extraBlocks = [
        ["mcp_servers", "mcp_tools", "mcp_resources", "mcp_prompts"].some(allows)
            ? (hub?.buildInstructionsBlock() ?? "")
            : "",
        allows("skill_read") ? (skills?.buildInstructionsBlock() ?? "") : "",
    ].filter(Boolean);
    if (extraBlocks.length === 0) {
        return `${environment}\n\n${body}`;
    }
    return `${environment}\n\n${body}\n\n${extraBlocks.join("\n\n")}`;
}
