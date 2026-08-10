import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "./config.js";
import type { AgentInstructionRegistry } from "./agents/registry.js";
import type { DownstreamMcpHub } from "./downstream/hub.js";
import type { ProcessSessionManager } from "./lib/process-sessions.js";
import { configureToolRegistrationPolicy } from "./lib/tool-log.js";
import type { ProjectContext } from "./project.js";
import type { SkillRegistry } from "./skills/registry.js";
import type { WorkspaceRegistry } from "./workspace/registry.js";
import { registerAllTools } from "./tools/register.js";

/**
 * Resolve the shell name advertised in MCP instructions.
 *
 * @returns Shell label matching what bash/exec_command actually spawn
 */
function instructionShellName(): string {
    return process.platform === "win32" ? "powershell" : "bash";
}

/**
 * Build MCP initialize `instructions`: environment first (OpenAI: keep the
 * first 512 characters self-contained), then a tool-selection map — not a
 * model persona. OpenAI: shared sequences / limits here; do not repeat every
 * tool description or change the model's personality.
 *
 * @param projectRoot - Absolute project directory
 * @param hub - Optional downstream MCP hub (top-level server blurbs only)
 * @param skills - Optional Codex skill registry (metadata only)
 * @param agents - Optional scoped Codex AGENTS.md registry
 * @param allowedTools - Concrete tool set for this MCP client/session
 * @returns Server instructions string
 */
export function buildServerInstructions(
    projectRoot: string,
    hub?: DownstreamMcpHub,
    skills?: SkillRegistry,
    agents?: AgentInstructionRegistry,
    allowedTools?: ReadonlySet<string>,
): string {
    const shell = instructionShellName();
    const environment = [
        "<environment_context>",
        `  <project_root>${projectRoot}</project_root>`,
        `  <shell>${shell}</shell>`,
        "  <paths>relative to project_root unless noted</paths>",
        "</environment_context>",
    ].join("\n");

    const allows = (name: string): boolean => allowedTools?.has(name) ?? true;
    const toolMap: string[] = [];
    const addTool = (name: string, text: string): void => {
        if (allows(name)) toolMap.push(`- ${name} — ${text}`);
    };
    addTool("read", "file contents before explain/change (not bash cat/type).");
    addTool("grep", "regex search in files (not bash Select-String/grep).");
    addTool("glob", "find paths by pattern (e.g. **/*.ts).");
    addTool("ls", "list one directory.");
    addTool("edit", "small exact string replace on an existing file.");
    addTool("write", "create file or full overwrite; use edit for small patches.");
    addTool("bash", `short foreground ${shell} (install/test/build/git); cwd=project_root; not for source read/edit.`);
    addTool("exec_command", "long-running or interactive command; returns processId while running.");
    addTool("write_stdin", "poll or send stdin to a processId from exec_command.");
    addTool("process_kill", "force-stop a processId.");
    addTool("process_list", "recover managed process handles for the current stable owner.");
    addTool("process_status", "inspect a managed process without consuming output.");
    addTool("process_output", "peek buffered process output without consuming it.");
    addTool("runtime_status", "inspect bounded aggregate runtime telemetry without exposing payloads or commands.");
    addTool("webfetch", "fetch a public http(s) URL body.");
    addTool("summary", "mid-task user-visible progress (done=false + next) or final checkpoint (done=true).");
    addTool("skills_list", "list skills imported from local Codex skill roots.");
    addTool("skill_read", "read a matching skill's SKILL.md or referenced text file before following it.");
    addTool("agents_for_path", "load global + nested AGENTS.md rules for a project path.");
    addTool("capabilities_reload", "force-refresh imported Codex MCPs and skills; automatic watching is also enabled in the CLI.");
    addTool("workspace_projects", "discover Git projects under project_root.");
    addTool("workspace_search", "bounded structured search across the workspace.");
    addTool("context_pack", "assemble lightweight project/files/instructions/skills context for a task.");
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
        if (["read", "grep", "glob", "ls"].some(allows)) {
            limits.push(
                "- After ~6 inspect calls (read/grep/glob/ls) without summary, call summary before more inspect.",
            );
        }
    }
    if (["edit", "write", "bash"].some(allows)) {
        const recoveryTools = ["edit", "write", "bash"].filter(allows).join("/");
        limits.push(`- On tool failure: inspect the returned error/output, then use ${recoveryTools} when appropriate and retry.`);
    }
    if (["mcp_servers", "mcp_tools", "mcp_resources", "mcp_prompts"].some(allows)) {
        limits.push(
            "- Downstream MCP: use the enabled gateway discovery tools for current hot-reloaded state before using names or schemas you have not loaded.",
        );
    }
    if (skills?.hasSkills() && allows("skill_read")) {
        limits.push(
            "- Codex skills: when a listed skill clearly matches the task, call skill_read before acting; do not infer the full skill from its description.",
        );
    }

    const bodyParts = [
        "Codex-MCP: local project coding tools. Paths are under project_root. Shell is " + shell + ".",
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

/**
 * Create an MCP server instance with all coding tools registered.
 *
 * @param config - Server configuration
 * @param project - Bound project context
 * @param processes - Shared process session manager
 * @param hub - Downstream MCP hub
 * @param skills - Codex skill registry
 * @param agents - Scoped Codex AGENTS.md registry
 * @param workspace - Shared workspace registry for cached repo topology and search
 * @param allowedTools - Concrete tool set allowed for this client/session
 * @returns Connected-ready McpServer
 */
export function createMcpServer(
    config: ServerConfig,
    project: ProjectContext,
    processes: ProcessSessionManager,
    hub: DownstreamMcpHub,
    skills: SkillRegistry,
    agents: AgentInstructionRegistry,
    workspace: WorkspaceRegistry,
    allowedTools?: ReadonlySet<string>,
): McpServer {
    const server = new McpServer(
        {
            name: "codex-mcp",
            version: "0.1.0",
        },
        {
            instructions: buildServerInstructions(
                config.projectRoot,
                hub,
                skills,
                agents,
                allowedTools,
            ),
        },
    );

    configureToolRegistrationPolicy(server, allowedTools);
    registerAllTools(server, config, project, processes, hub, skills, agents, workspace);
    return server;
}
