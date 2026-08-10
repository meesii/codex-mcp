import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";

export interface McpTestClient {
    client: Client;
    listToolNames: () => Promise<string[]>;
    callTool: (
        name: string,
        args: Record<string, unknown>,
    ) => Promise<CallToolResult>;
    close: () => Promise<void>;
}

/**
 * Connect an MCP client to a Streamable HTTP endpoint.
 *
 * @param mcpUrl - Full URL ending in /mcp
 * @returns Connected test client helpers
 */
export async function connectMcpClient(
    mcpUrl: string,
    headers?: Record<string, string>,
): Promise<McpTestClient> {
    const client = new Client({ name: "codex-mcp-e2e", version: "0.1.0" });
    const transport = new StreamableHTTPClientTransport(new URL(mcpUrl), {
        requestInit: headers ? { headers } : undefined,
    });
    await client.connect(transport);

    return {
        client,
        listToolNames: async () => {
            const listed = await client.listTools();
            return listed.tools.map((tool) => tool.name).sort();
        },
        callTool: async (name, args) => {
            const result = await client.callTool({ name, arguments: args });
            return result as CallToolResult;
        },
        close: async () => {
            await client.close();
        },
    };
}

/**
 * Extract text content from a tool result.
 *
 * @param result - Tool call result
 * @returns Joined text
 */
export function toolText(result: CallToolResult): string {
    return result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
