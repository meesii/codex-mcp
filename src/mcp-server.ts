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
 * Build MCP initialize `instructions`: environment first (OpenAI: keep the
 * first 512 characters self-contained), then a tool-selection map — not a
 * model persona. OpenAI: shared sequences / limits here; do not repeat every
 * tool description or change the model's personality.
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
        'Codex-MCP: local project coding tools. Paths are under project_root. Shell is ' +
            shell +
            '. Prefer the dedicated tools below over shell for file inspect/edit.',
        '',
        'Tool map (pick by goal):',
        '- read — file contents before explain/change (not bash cat/type).',
        '- grep — regex search in files (not bash Select-String/grep).',
        '- glob — find paths by pattern (e.g. **/*.ts).',
        '- ls — list one directory.',
        '- edit — small exact string replace on an existing file.',
        '- write — create file or full overwrite; use edit for small patches.',
        `- bash — short foreground ${shell} (install/test/build/git); cwd=project_root; not for source read/edit.`,
        '- exec_command — long-running or interactive command; returns processId while running.',
        '- write_stdin — poll or send stdin to a processId from exec_command.',
        '- process_kill — force-stop a processId.',
        '- webfetch — http(s) URL body only.',
        '- summary — mid-task user-visible progress (done=false + next) or final checkpoint (done=true).',
        '',
        'Shared sequences / limits:',
        '- Servers/watchers: exec_command → write_stdin (poll) → process_kill when done.',
        '- Mid-task status: summary(done=false); do not use plain chat for partial progress.',
        '- After ~6 inspect calls (read/grep/glob/ls) without summary, call summary before more inspect.',
        '- summary(done=true) only when the full user task is finished.',
        '- On tool failure: use stdout/stderr, then edit/write/bash to fix and retry.',
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
