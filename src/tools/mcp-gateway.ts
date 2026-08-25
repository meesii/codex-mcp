import { z } from "zod";
import type { CallToolResult, McpServer } from "@modelcontextprotocol/server";
import type { CapabilityToolScopeProvider } from "../capabilities/tool-scope.js";
import type { DownstreamServerInfo } from "../downstream/hub.js";
import { registerTool } from "../lib/tool/log.js";
import { openWorldAnnotations, proxyAnnotations, withToolAuth } from "../lib/tool/meta.js";
import { errorResult, okResult, resultText } from "../lib/tool/result.js";

export function registerMcpGatewayTools(server: McpServer, capabilityScope: CapabilityToolScopeProvider): void {
    registerTool(server, "mcp_tools", withToolAuth({
        title: "Discover downstream MCP tools",
        description: "List enabled downstream MCP servers and their available tools. Pass server to inspect one server in detail.",
        inputSchema: { server: z.string().min(1).optional() },
        outputSchema: {
            text: z.string(), servers: z.array(z.object({
                name: z.string(), description: z.string(), status: z.enum(["ready", "error"]), error: z.string().optional(),
                capabilities: z.object({ tools: z.boolean(), resources: z.boolean(), prompts: z.boolean() }).optional(),
            })), tools: z.record(z.string(), z.array(z.object({ name: z.string(), description: z.string(), inputSchema: z.record(z.string(), z.unknown()) }))),
        },
        annotations: openWorldAnnotations,
    }), async ({ server: serverName }) => {
        try {
            const { hub } = await capabilityScope();
            const known = hub.listServers();
            const targets = serverName ? known.filter((item) => item.name === serverName) : known;
            if (serverName && targets.length === 0) return errorResult(`Unknown downstream MCP: ${serverName}`);
            if (targets.length === 0) return okResult("No downstream MCP enabled.", { text: "No downstream MCP enabled.", servers: [], tools: {} });

            const grouped: Record<string, unknown> = {};
            const rendered: string[] = [];
            const servers: DownstreamServerInfo[] = [];
            for (const target of targets) {
                let info = target;
                if (info.status !== "ready") {
                    try { info = await hub.reconnectServer(info.name); } catch { /* report the current error below */ }
                }
                const status = hub.listServers().find((item) => item.name === info.name) ?? info;
                servers.push(status);
                if (status.status !== "ready") {
                    grouped[status.name] = [];
                    rendered.push(`=== ${status.name} [error] ===`, `  ${status.error ?? "not connected"}`);
                    continue;
                }
                try {
                    const listed = await hub.listTools(status.name);
                    grouped[status.name] = listed.items;
                    rendered.push(`=== ${status.name} [ready] ${listed.items.length} tools ===`, ...listed.items.map((tool) => `  ${tool.name}: ${tool.description.slice(0, 160)}`));
                } catch (error) {
                    grouped[status.name] = [];
                    rendered.push(`=== ${status.name} [error] ===`, `  ${String(error)}`);
                }
            }
            const text = rendered.join("\n");
            return okResult(text, { text, servers, tools: grouped });
        } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
        }
    });

    registerTool(server, "mcp_call", withToolAuth({
        title: "Call downstream MCP tool",
        description: "Call one tool exposed by a downstream MCP server. Only arguments is forwarded to the downstream tool.",
        inputSchema: {
            server: z.string().min(1), tool: z.string().min(1),
            arguments: z.record(z.string(), z.unknown()).optional(),
        },
        outputSchema: {
            text: z.string(), isError: z.boolean(),
            structuredContent: z.record(z.string(), z.unknown()).nullable(),
        },
        annotations: proxyAnnotations,
    }), async ({ server: serverName, tool, arguments: args }) => {
        try {
            const { hub } = await capabilityScope();
            const current = hub.listServers().find((item) => item.name === serverName);
            if (!current) return errorResult(`Unknown downstream MCP: ${serverName}`);
            if (current.status !== "ready") {
                try { await hub.reconnectServer(serverName); }
                catch (error) { return errorResult(error instanceof Error ? error.message : String(error)); }
            }
            return decorateDownstream(await hub.callTool(serverName, tool, args ?? {}));
        } catch (error) {
            return errorResult(error instanceof Error ? error.message : String(error));
        }
    });
}

function decorateDownstream(result: CallToolResult): CallToolResult {
    const text = resultText(result) || (result.isError ? "downstream tool error" : "ok");
    const structuredContent = result.structuredContent && typeof result.structuredContent === "object"
        ? result.structuredContent as Record<string, unknown>
        : null;
    return {
        ...result,
        structuredContent: { text, isError: result.isError === true, structuredContent },
    };
}
