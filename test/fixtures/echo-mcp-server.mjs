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

server.registerTool(
    "delay",
    {
        description: "Delay before echoing, for in-flight lifecycle tests",
        inputSchema: {
            milliseconds: z.number().int().min(0).max(5_000),
        },
    },
    async ({ milliseconds }) => {
        await new Promise((resolve) => setTimeout(resolve, milliseconds));
        return { content: [{ type: "text", text: `delayed:${milliseconds}` }] };
    },
);

server.registerTool(
    "disconnect",
    {
        description: "Return once, then close this fixture process",
        inputSchema: {},
    },
    async () => {
        setTimeout(() => process.exit(0), 25);
        return { content: [{ type: "text", text: "disconnecting" }] };
    },
);

server.registerTool(
    "huge",
    {
        description: "Return a caller-selected large text payload",
        inputSchema: {
            size: z.number().int().min(1).max(5_000_000),
        },
    },
    async ({ size }) => ({
        content: [{ type: "text", text: "x".repeat(size) }],
    }),
);

server.registerTool(
    "rich",
    {
        description: "Return mixed text and image MCP content",
        inputSchema: {},
    },
    async () => ({
        content: [
            { type: "text", text: "rich-ok" },
            {
                type: "image",
                data: Buffer.from("tiny-image-fixture").toString("base64"),
                mimeType: "image/png",
            },
        ],
        structuredContent: { kind: "rich" },
    }),
);

server.registerResource(
    "echo-resource",
    "fixture://echo/readme",
    {
        title: "Echo fixture resource",
        description: "Static text resource for gateway tests",
        mimeType: "text/plain",
    },
    async () => ({
        contents: [
            {
                uri: "fixture://echo/readme",
                mimeType: "text/plain",
                text: "resource:echo-ok",
            },
        ],
    }),
);

server.registerPrompt(
    "echo-prompt",
    {
        description: "Build an echo prompt",
        argsSchema: {
            text: z.string().describe("Text to place in the prompt"),
        },
    },
    async ({ text }) => ({
        description: "Resolved echo prompt",
        messages: [
            {
                role: "user",
                content: { type: "text", text: `prompt:${text}` },
            },
        ],
    }),
);

const stderrBurstBytes = Number(process.env.STDERR_BURST_BYTES ?? "0");
if (Number.isFinite(stderrBurstBytes) && stderrBurstBytes > 0) {
    const chunk = Buffer.alloc(Math.min(stderrBurstBytes, 64 * 1024), 120);
    let remaining = stderrBurstBytes;
    while (remaining > 0) {
        const slice = chunk.subarray(0, Math.min(chunk.length, remaining));
        remaining -= slice.length;
        if (!process.stderr.write(slice)) {
            await new Promise((resolve) => process.stderr.once("drain", resolve));
        }
    }
    process.stderr.write("\n");
}

const startupDelayMs = Number(process.env.STARTUP_DELAY_MS ?? "0");
if (Number.isFinite(startupDelayMs) && startupDelayMs > 0) {
    await new Promise((resolve) => setTimeout(resolve, startupDelayMs));
}

const transport = new StdioServerTransport();
await server.connect(transport);
