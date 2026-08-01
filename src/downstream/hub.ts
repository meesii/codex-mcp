import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
    getDefaultEnvironment,
    StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult, Tool } from "@modelcontextprotocol/sdk/types.js";
import {
    isStdioMcpServer,
    isUrlMcpServer,
    listEnabledMcpServers,
    loadUserMcpConfig,
    type McpServerConfig,
    type NamedMcpServer,
} from "../user-mcp-config.js";

const DESCRIPTION_MAX = 120;

/** One connected (or failed) downstream MCP. */
export interface DownstreamServerInfo {
    name: string;
    description: string;
    status: "ready" | "error";
    error?: string;
}

/** Tool listing for `mcp_tools`. */
export interface DownstreamToolInfo {
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
}

interface LiveSession {
    info: DownstreamServerInfo;
    config: McpServerConfig;
    client?: Client;
    transport?: StdioClientTransport | StreamableHTTPClientTransport;
}

/**
 * Connects to every enabled entry in `~/.codex-mcp/mcp.json` and proxies
 * `tools/list` + `tools/call`. Failed servers stay listed with `status: error`.
 */
export class DownstreamMcpHub {
    private readonly sessions = new Map<string, LiveSession>();
    private closed = false;

    private constructor() {}

    /**
     * Load mcp.json and connect all enabled servers.
     *
     * @returns Connected hub (may contain error entries)
     */
    static async connectFromUserConfig(): Promise<DownstreamMcpHub> {
        const hub = new DownstreamMcpHub();
        const entries = listEnabledMcpServers(loadUserMcpConfig());
        await Promise.all(entries.map((entry) => hub.connectOne(entry)));
        return hub;
    }

    /**
     * Empty hub with no downstream servers (tests / no mcp.json).
     *
     * @returns Hub with zero sessions
     */
    static empty(): DownstreamMcpHub {
        return new DownstreamMcpHub();
    }

    /**
     * Whether any server is configured (ready or error).
     *
     * @returns True when mcp.json had at least one enabled entry
     */
    hasServers(): boolean {
        return this.sessions.size > 0;
    }

    /**
     * Snapshot of all configured servers in name order.
     *
     * @returns Server info rows
     */
    listServers(): DownstreamServerInfo[] {
        return [...this.sessions.values()]
            .map((session) => ({ ...session.info }))
            .sort((left, right) => left.name.localeCompare(right.name));
    }

    /**
     * Ready servers only (for instructions).
     *
     * @returns Ready server info rows
     */
    listReadyServers(): DownstreamServerInfo[] {
        return this.listServers().filter((server) => server.status === "ready");
    }

    /**
     * Build the Downstream MCP block for server instructions.
     *
     * @returns Multi-line block, or empty string when nothing is configured
     */
    buildInstructionsBlock(): string {
        const servers = this.listServers();
        if (servers.length === 0) return "";

        const lines = [
            "Downstream MCP servers (use mcp_tools / mcp_call):",
            ...servers.map((server) => {
                if (server.status === "ready") {
                    return `- ${server.name} — ${server.description}`;
                }
                const detail = server.error ? `unavailable: ${server.error}` : "unavailable";
                return `- ${server.name} — ${detail}`;
            }),
        ];
        return lines.join("\n");
    }

    /**
     * List tools on a ready downstream server (follows list pagination).
     *
     * @param serverName - Key from mcp.json
     * @returns Tool descriptors
     */
    async listTools(serverName: string): Promise<DownstreamToolInfo[]> {
        const session = await this.requireReady(serverName);
        const tools: DownstreamToolInfo[] = [];
        let cursor: string | undefined;

        do {
            const listed = await session.client!.listTools(
                cursor ? { cursor } : undefined,
            );
            for (const tool of listed.tools) {
                tools.push(toToolInfo(tool));
            }
            cursor = listed.nextCursor;
        } while (cursor);

        return tools;
    }

    /**
     * Call a tool on a ready downstream server.
     *
     * @param serverName - Key from mcp.json
     * @param toolName - Downstream tool name
     * @param args - Tool arguments
     * @returns Downstream call result
     */
    async callTool(
        serverName: string,
        toolName: string,
        args: Record<string, unknown> = {},
    ): Promise<CallToolResult> {
        const session = await this.requireReady(serverName);
        try {
            return (await session.client!.callTool({
                name: toolName,
                arguments: args,
            })) as CallToolResult;
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            if (!/not connected|connection closed|closed/i.test(message)) {
                throw error;
            }
            await this.reconnect(session);
            return (await session.client!.callTool({
                name: toolName,
                arguments: args,
            })) as CallToolResult;
        }
    }

    /**
     * Close every downstream client/transport.
     */
    async close(): Promise<void> {
        if (this.closed) return;
        this.closed = true;
        const closers = [...this.sessions.values()].map((session) => closeSession(session));
        await Promise.all(closers);
        this.sessions.clear();
    }

    /**
     * @param entry - Named config from mcp.json
     */
    private async connectOne(entry: NamedMcpServer): Promise<void> {
        const session: LiveSession = {
            config: entry.config,
            info: {
                name: entry.name,
                description: entry.name,
                status: "error",
            },
        };
        this.sessions.set(entry.name, session);

        try {
            await this.openSession(session);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            session.info = {
                name: entry.name,
                description: entry.name,
                status: "error",
                error: message,
            };
            await closeSession(session);
        }
    }

    /**
     * @param session - Session slot to (re)open
     */
    private async openSession(session: LiveSession): Promise<void> {
        await closeSession(session);

        const client = new Client({
            name: "codex-mcp",
            version: "0.1.0",
        });
        const transport = createTransport(session.config);
        await client.connect(transport);

        session.client = client;
        session.transport = transport;
        session.info = {
            name: session.info.name,
            description: resolveDescription(client),
            status: "ready",
        };
    }

    /**
     * @param session - Session to reconnect
     */
    private async reconnect(session: LiveSession): Promise<void> {
        try {
            await this.openSession(session);
        } catch (error) {
            const message = error instanceof Error ? error.message : String(error);
            session.info = {
                name: session.info.name,
                description: session.info.description,
                status: "error",
                error: message,
            };
            await closeSession(session);
            throw new Error(`downstream MCP "${session.info.name}" reconnect failed: ${message}`);
        }
    }

    /**
     * @param serverName - Key from mcp.json
     * @returns Live ready session
     */
    private async requireReady(serverName: string): Promise<LiveSession> {
        if (this.closed) {
            throw new Error("downstream MCP hub is closed");
        }
        const session = this.sessions.get(serverName);
        if (!session) {
            const known = this.listServers().map((item) => item.name);
            const hint = known.length > 0 ? `known: ${known.join(", ")}` : "none configured";
            throw new Error(`unknown downstream MCP "${serverName}" (${hint})`);
        }
        if (session.info.status !== "ready" || !session.client) {
            const detail = session.info.error ?? "not connected";
            throw new Error(`downstream MCP "${serverName}" is unavailable: ${detail}`);
        }
        return session;
    }
}

/**
 * @param config - Server config
 * @returns Matching client transport
 */
function createTransport(
    config: McpServerConfig,
): StdioClientTransport | StreamableHTTPClientTransport {
    if (isStdioMcpServer(config)) {
        return new StdioClientTransport({
            command: config.command,
            args: config.args,
            cwd: config.cwd,
            stderr: "pipe",
            env: {
                ...getDefaultEnvironment(),
                ...(config.env ?? {}),
            },
        });
    }
    if (isUrlMcpServer(config)) {
        return new StreamableHTTPClientTransport(new URL(config.url), {
            requestInit: config.headers
                ? { headers: config.headers }
                : undefined,
        });
    }
    throw new Error("unsupported MCP server config");
}

/**
 * Pull a short blurb from the remote MCP initialize payload.
 *
 * Order: instructions first line → server title → server name.
 *
 * @param client - Connected client
 * @returns Short description for instructions
 */
function resolveDescription(client: Client): string {
    const instructions = client.getInstructions()?.trim();
    if (instructions) {
        const firstLine = instructions.split(/\r?\n/).find((line) => line.trim());
        if (firstLine) return clipDescription(firstLine.trim());
    }

    const info = client.getServerVersion() as
        | { name?: string; title?: string; description?: string }
        | undefined;
    const label =
        info?.title?.trim() ||
        info?.description?.trim() ||
        info?.name?.trim();
    if (label) return clipDescription(label);

    return "downstream MCP";
}

/**
 * @param text - Raw description
 * @returns Single-line clipped text
 */
function clipDescription(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= DESCRIPTION_MAX) return oneLine;
    return `${oneLine.slice(0, DESCRIPTION_MAX - 1)}…`;
}

/**
 * @param tool - SDK tool descriptor
 * @returns Gateway-facing tool info
 */
function toToolInfo(tool: Tool): DownstreamToolInfo {
    const schema =
        tool.inputSchema && typeof tool.inputSchema === "object"
            ? (tool.inputSchema as Record<string, unknown>)
            : { type: "object", properties: {} };

    return {
        name: tool.name,
        description: tool.description?.trim() || "",
        inputSchema: schema,
    };
}

/**
 * @param session - Session to tear down
 */
async function closeSession(session: LiveSession): Promise<void> {
    const client = session.client;
    const transport = session.transport;
    session.client = undefined;
    session.transport = undefined;

    try {
        await client?.close();
    } catch {
        // ignore
    }
    try {
        await transport?.close();
    } catch {
        // ignore
    }
}
