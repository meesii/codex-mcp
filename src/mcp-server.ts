import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ServerConfig } from './config.js';
import type { ProcessSessionManager } from './lib/process-sessions.js';
import type { ProjectContext } from './project.js';
import { registerAllTools } from './tools/register.js';

/**
 * Resolve the shell name advertised in MCP instructions.
 *
 * @returns Shell label matching what bash/exec_command actually spawn
 */
function instructionShellName(): string {
    return process.platform === 'win32' ? 'powershell' : 'bash';
}

/**
 * Build MCP initialize `instructions` in a Codex-like shape:
 * environment first (OpenAI: keep the first 512 characters self-contained),
 * then act-first coding rules and tool roles.
 *
 * @param projectRoot - Absolute project directory
 * @returns Server instructions string
 */
export function buildServerInstructions(projectRoot: string): string {
    const shell = instructionShellName();
    const environment = [
        '<environment_context>',
        `  <project_root>${projectRoot}</project_root>`,
        `  <shell>${shell}</shell>`,
        '  <paths>relative to project_root unless noted</paths>',
        '</environment_context>',
    ].join('\n');

    const body = [
        "You are a local coding agent. Finish the user's task in this turn by calling MCP tools yourself.",
        'Keep calling tools until the task is fully done or you hit a real blocker. Never stop mid-task to ask the user to continue, confirm a plan, approve next steps, or run commands for you.',
        'Do not narrate progress and wait. Prefer reasonable assumptions. Do not stop at advice, pseudocode, or copy-paste commands.',
        'Ask one short plain-text question only when a needed fact cannot be discovered locally and a wrong assumption would be risky.',
        '',
        'Tool roles (Codex maps shell/apply_patch/exec_command here differently — use these MCP tools):',
        '- Inspect: prefer read / grep / glob / ls over shell cat/rg/Get-ChildItem.',
        '- Change files: edit = small exact replace; write = new file or full rewrite. Never edit source via bash.',
        `- Short shell (${shell}): bash (cwd is project_root; avoid cd).`,
        '- Long-running: exec_command → processId → write_stdin (poll/stdin) / process_kill (stop).',
        '- Public http(s) only: webfetch.',
        '',
        'On failure: inspect tool stdout/stderr, fix with edit/write, and retry until it works or you hit a real blocker.',
        'When truly blocked, say what failed and what you need — otherwise keep working with tools.',
    ].join('\n');

    return `${environment}\n\n${body}`;
}

/**
 * Create an MCP server instance with all coding tools registered.
 *
 * @param config - Server configuration
 * @param project - Bound project context
 * @param processes - Shared process session manager
 * @returns Connected-ready McpServer
 */
export function createMcpServer(config: ServerConfig, project: ProjectContext, processes: ProcessSessionManager): McpServer {
    const server = new McpServer(
        {
            name: 'codex-mcp',
            version: '0.1.0',
        },
        {
            instructions: buildServerInstructions(config.projectRoot),
        }
    );

    registerAllTools(server, config, project, processes);
    return server;
}
