import { appendFile } from "node:fs/promises";
import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import {
    CallToolRequestSchema,
    ListToolsRequestSchema,
} from "@modelcontextprotocol/sdk/types.js";

const countFile = process.env.TOOLS_LIST_COUNT_FILE;
let version = 1;

const server = new Server(
    { name: "counting-tools-fixture", version: "0.1.0" },
    { capabilities: { tools: { listChanged: true } } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => {
    if (countFile) await appendFile(countFile, "list\n", "utf8");
    return {
        tools: [
            {
                name: "invalidate",
                description: "Bump the fixture tool-list version and notify the client.",
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
            {
                name: `version_${version}`,
                description: `Current fixture tool-list version ${version}.`,
                inputSchema: { type: "object", properties: {}, additionalProperties: false },
            },
        ],
    };
});

server.setRequestHandler(CallToolRequestSchema, async (request) => {
    if (request.params.name !== "invalidate") {
        throw new Error(`unknown tool: ${request.params.name}`);
    }
    version += 1;
    await server.sendToolListChanged();
    return {
        content: [{ type: "text", text: `version:${version}` }],
        structuredContent: { version },
    };
});

await server.connect(new StdioServerTransport());
