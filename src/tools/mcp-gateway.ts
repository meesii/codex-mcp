import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import { registerTool } from "../lib/tool-log.js";
import {
    proxyAnnotations,
    readOnlyAnnotations,
    withNoAuth,
} from "../lib/tool-meta.js";
import { errorResult, okResult, resultText } from "../lib/tool-result.js";

const toolDescriptorSchema = z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
});

/**
 * Register `mcp_tools` and `mcp_call` for downstream MCP proxying.
 *
 * @param server - MCP server instance
 * @param hub - Connected downstream hub
 */
export function registerMcpGatewayTools(
    server: McpServer,
    hub: DownstreamMcpHub,
): void {
    registerMcpToolsTool(server, hub);
    registerMcpCallTool(server, hub);
}

/**
 * @param server - MCP server instance
 * @param hub - Connected downstream hub
 */
function registerMcpToolsTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_tools",
        withNoAuth({
            title: "List downstream MCP tools",
            description:
                "List tools on a downstream MCP server. Returns name, description, and inputSchema for each. " +
                "The catalog does not change within a conversation — fetch once, then reuse for mcp_call.",
            inputSchema: {
                server: z.string().min(1).describe("Downstream MCP server name."),
            },
            outputSchema: {
                server: z.string(),
                description: z.string(),
                status: z.enum(["ready", "error"]),
                error: z.string().nullable(),
                tools: z.array(toolDescriptorSchema),
            },
            annotations: readOnlyAnnotations,
        }),
        async ({ server: serverName }) => {
            const name = serverName.trim();
            const info = hub.listServers().find((item) => item.name === name);
            if (!info) {
                const known = hub.listServers().map((item) => item.name);
                const hint =
                    known.length > 0
                        ? `known: ${known.join(", ")}`
                        : "none configured";
                return errorResult(`unknown downstream MCP "${name}" (${hint})`);
            }

            if (info.status !== "ready") {
                return okResult(
                    `Downstream MCP "${name}" is unavailable: ${info.error ?? "not connected"}`,
                    {
                        server: name,
                        description: info.description,
                        status: "error" as const,
                        error: info.error ?? "not connected",
                        tools: [],
                    },
                );
            }

            try {
                const tools = await hub.listTools(name);
                return okResult(
                    `Listed ${tools.length} tool(s) on downstream MCP "${name}".`,
                    {
                        server: name,
                        description: info.description,
                        status: "ready" as const,
                        error: null,
                        tools,
                    },
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return errorResult(message);
            }
        },
    );
}

/**
 * @param server - MCP server instance
 * @param hub - Connected downstream hub
 */
function registerMcpCallTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_call",
        withNoAuth({
            title: "Call downstream MCP tool",
            description:
                "Call a tool on a downstream MCP server and return its result. " +
                "Reuse a prior mcp_tools catalog when available; re-list only if the server was never listed or a call failed due to invalid tool/arguments.",
            inputSchema: {
                server: z.string().min(1).describe("Downstream MCP server name."),
                tool: z.string().min(1).describe("Tool name."),
                arguments: z
                    .record(z.string(), z.unknown())
                    .optional()
                    .describe("Tool arguments."),
            },
            outputSchema: {
                server: z.string(),
                tool: z.string(),
                isError: z.boolean(),
                text: z.string(),
                structuredContent: z.record(z.string(), z.unknown()).nullable(),
            },
            annotations: proxyAnnotations,
        }),
        async ({ server: serverName, tool, arguments: toolArgs }) => {
            const name = serverName.trim();
            const toolName = tool.trim();
            const args =
                toolArgs && typeof toolArgs === "object" && !Array.isArray(toolArgs)
                    ? toolArgs
                    : {};

            try {
                const downstream = await hub.callTool(name, toolName, args);
                return wrapDownstreamResult(name, toolName, downstream);
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return errorResult(message);
            }
        },
    );
}

/**
 * Wrap a downstream tool result into our structured output shape.
 *
 * @param serverName - mcp.json key
 * @param toolName - Downstream tool name
 * @param result - Downstream call result
 * @returns Gateway tool result
 */
function wrapDownstreamResult(
    serverName: string,
    toolName: string,
    result: CallToolResult,
): CallToolResult {
    const text = resultText(result) || (result.isError ? "downstream tool error" : "ok");
    const structured =
        result.structuredContent && typeof result.structuredContent === "object"
            ? (result.structuredContent as Record<string, unknown>)
            : null;

    const payload = {
        server: serverName,
        tool: toolName,
        isError: result.isError === true,
        text,
        structuredContent: structured,
    };

    if (result.isError) {
        return {
            isError: true,
            content: [{ type: "text", text }],
            structuredContent: payload,
        };
    }

    return okResult(
        `mcp_call ${serverName}/${toolName}: ${clipPreview(text)}`,
        payload,
    );
}

/**
 * @param text - Full result text
 * @returns Short preview for content summary
 */
function clipPreview(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= 160) return oneLine;
    return `${oneLine.slice(0, 159)}…`;
}
