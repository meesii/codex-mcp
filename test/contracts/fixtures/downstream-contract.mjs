import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer(
    { name: "downstream-contract", version: "1.0.0" },
    { instructions: "Black-box downstream fixture for codex-mcp contract tests." },
);

server.registerTool(
    "echo",
    {
        description: "Return caller text and one fixture environment marker.",
        inputSchema: {
            text: z.string(),
        },
    },
    async ({ text }) => ({
        content: [{ type: "text", text: `downstream:${text}:${process.env.CONTRACT_MARKER ?? "none"}` }],
        structuredContent: { text, marker: process.env.CONTRACT_MARKER ?? null },
    }),
);

server.registerTool(
    "large",
    {
        description: "Return a bounded-by-caller text payload for gateway size tests.",
        inputSchema: {
            size: z.number().int().min(1).max(5_000_000),
        },
    },
    async ({ size }) => ({
        content: [{ type: "text", text: "z".repeat(size) }],
    }),
);

server.registerTool(
    "disconnect",
    {
        description: "Respond once and then terminate the downstream process.",
        inputSchema: {},
    },
    async () => {
        setTimeout(() => process.exit(0), 20);
        return { content: [{ type: "text", text: "disconnecting" }] };
    },
);

server.registerResource(
    "contract-resource",
    "contract://fixture/readme",
    {
        title: "Contract fixture resource",
        description: "Static resource used only by black-box gateway contracts.",
        mimeType: "text/plain",
    },
    async () => ({
        contents: [{
            uri: "contract://fixture/readme",
            mimeType: "text/plain",
            text: "DOWNSTREAM-RESOURCE-CONTENT",
        }],
    }),
);

server.registerPrompt(
    "contract-prompt",
    {
        description: "Return a simple prompt with one text argument.",
        argsSchema: {
            text: z.string(),
        },
    },
    async ({ text }) => ({
        description: "Contract prompt result",
        messages: [{
            role: "user",
            content: { type: "text", text: `PROMPT:${text}` },
        }],
    }),
);

const transport = new StdioServerTransport();
await server.connect(transport);
