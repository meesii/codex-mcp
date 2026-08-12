import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import type { AgentInstructionRegistry } from "../agents/registry.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { ProcessSessionAccess } from "../lib/process/sessions.js";
import { configureToolRegistrationPolicy } from "../lib/tool/log.js";
import type { ProjectContext } from "../config/project.js";
import type { SkillRegistry } from "../skills/registry.js";
import type { CapabilityManager } from "../capabilities/manager.js";
import type { WorkspaceRegistry } from "../workspace/registry.js";
import type { GoalStore } from "../goals/store.js";
import type { UiSettingsStore } from "../ui/settings.js";
import { PermissionManager } from "../permissions/manager.js";
import type { PermissionGrantStore } from "../permissions/store.js";
import type { PermissionRuntime } from "../permissions/runtime.js";
import { registerAllTools } from "../tools/register.js";
import { PACKAGE_VERSION } from "./version.js";

function instructionShellName(): string {
    return process.platform === "win32" ? "powershell" : "bash";
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
    addTool("skills_list", "list model-invocable skills from enabled external capability sources.");
    addTool("skill_read", "read a matching skill's SKILL.md or referenced text file before following it.");
    addTool("agents_for_path", "load global + nested AGENTS.md rules for a project path.");
    addTool("capabilities_reload", "force-refresh enabled external MCP and Skill sources; automatic watching depends on the configured sync mode.");
    addTool("workspace_roots", "list the primary and additional trusted workspace roots.");
    addTool("workspace_add", "persistently trust an existing directory as a read/write/exec workspace; use only when the user explicitly requests broader workspace trust.");
    addTool("workspace_remove", "remove persisted trust for an additional workspace; primary workspace cannot be removed at runtime.");
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
    if (allows("permission_grant")) {
        limits.push(
            "- External filesystem writes / external command cwd: if a tool reports permission required, call permission_grant for the exact directory and retry. Use duration=session by default; use once only when the user wants one-operation access, and permanent only for explicit lasting trust.",
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

export function createMcpServer(
    config: ServerConfig,
    project: ProjectContext,
    processes: ProcessSessionAccess,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
    capabilities: CapabilityManager | undefined,
    agents: AgentInstructionRegistry,
    workspace: WorkspaceRegistry,
    goals: GoalStore,
    uiSettings: UiSettingsStore,
    allowedTools?: ReadonlySet<string>,
    permissionStore?: PermissionGrantStore,
    permissionRuntime?: PermissionRuntime,
    permissionOwnerId?: string,
): McpServer {
    const server = new McpServer(
        {
            name: "codex-mcp",
            version: PACKAGE_VERSION,
        },
        {
            instructions: buildServerInstructions(
                config.projectRoot,
                hub,
                skills,
                agents,
                allowedTools,
                project.roots,
            ),
        },
    );

    const permissions = new PermissionManager(server, project, {
        ...(permissionStore ? { store: permissionStore } : {}),
        ...(permissionRuntime ? { runtime: permissionRuntime } : {}),
        ...(permissionOwnerId ? { ownerId: permissionOwnerId } : {}),
    });
    configureToolRegistrationPolicy(server, allowedTools);
    registerAllTools(
        server,
        config,
        project,
        processes,
        hub,
        skills,
        capabilities,
        agents,
        workspace,
        goals,
        uiSettings,
        permissions,
    );
    return server;
}
