import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
    {
        name: "echo-fixture",
        version: "0.1.0",
    },
    {
        instructions: "Tiny echo MCP for codex-mcp gateway tests.",
    },
);

server.registerTool(
    "echo",
    {
        description: "Echo text back with a prefix",
        inputSchema: {
            text: z.string().describe("Text to echo"),
        },
    },
    async ({ text }) => ({
        content: [{ type: "text", text: `echo:${text}` }],
        structuredContent: { echoed: text },
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
