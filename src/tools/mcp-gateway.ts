import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { DownstreamMcpHub } from "../downstream/hub.js";
import type { CapabilityManager } from "../capabilities/manager.js";
import { registerTool } from "../lib/tool/log.js";
import {
    openWorldAnnotations,
    operationalAnnotations,
    proxyAnnotations,
    withToolAuth,
} from "../lib/tool/meta.js";
import { errorResult, okResult, resultText } from "../lib/tool/result.js";

const toolDescriptorSchema = z.object({
    name: z.string(),
    description: z.string(),
    inputSchema: z.record(z.string(), z.unknown()),
});

const capabilitySchema = z.object({
    tools: z.boolean(),
    resources: z.boolean(),
    prompts: z.boolean(),
});

const resourceSchema = z.object({
    uri: z.string(),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
    size: z.number().optional(),
});

const resourceTemplateSchema = z.object({
    uriTemplate: z.string(),
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    mimeType: z.string().optional(),
});

const promptSchema = z.object({
    name: z.string(),
    title: z.string().optional(),
    description: z.string().optional(),
    arguments: z.array(
        z.object({
            name: z.string(),
            description: z.string().optional(),
            required: z.boolean(),
        }),
    ),
});

export function registerMcpGatewayTools(
    server: McpServer,
    hub: DownstreamMcpHub,
    capabilities?: CapabilityManager,
): void {
    registerMcpServersTool(server, hub, capabilities);
    registerMcpReconnectTool(server, hub);
    registerMcpToolsTool(server, hub);
    registerMcpCallTool(server, hub);
    registerMcpResourcesTool(server, hub);
    registerMcpResourceReadTool(server, hub);
    registerMcpPromptsTool(server, hub);
    registerMcpPromptGetTool(server, hub);
}

function registerMcpServersTool(
    server: McpServer,
    hub: DownstreamMcpHub,
    capabilities?: CapabilityManager,
): void {
    registerTool(
        server,
        "mcp_servers",
        withToolAuth({
            title: "List downstream MCP servers",
            description:
                "List downstream MCP servers imported from enabled external capability sources, with connection state, negotiated capabilities, and per-source diagnostics when available.",
            inputSchema: {},
            outputSchema: {
                generation: z.number().int(),
                importError: z.string().nullable(),
                sources: z.array(z.object({
                    source: z.enum(["agents", "codex", "claude"]),
                    enabled: z.boolean(),
                    mcpEnabled: z.boolean(),
                    skillsEnabled: z.boolean(),
                    mcpCount: z.number().int(),
                    skillCount: z.number().int(),
                    warnings: z.array(z.string()),
                })),
                servers: z.array(
                    z.object({
                        name: z.string(),
                        description: z.string(),
                        status: z.enum(["ready", "error"]),
                        error: z.string().nullable(),
                        capabilities: capabilitySchema.nullable(),
                    }),
                ),
            },
            annotations: openWorldAnnotations,
        }),
        async () => {
            const servers = hub.listServers().map((item) => ({
                name: item.name,
                description: item.description,
                status: item.status,
                error: item.error ?? null,
                capabilities: item.capabilities ?? null,
            }));
            const importError = hub.getImportError() ?? null;
            const sources = capabilities?.getDiagnostics() ?? [];
            return okResult(
                importError
                    ? `External MCP import is unavailable; core codex-mcp remains usable. ${importError}`
                    : `Listed ${servers.length} downstream MCP server(s).`,
                {
                    generation: hub.getGeneration(),
                    importError,
                    sources,
                    servers,
                },
            );
        },
    );
}

function registerMcpReconnectTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_reconnect",
        withToolAuth({
            title: "Reconnect downstream MCP",
            description: "Force one imported downstream MCP server to reconnect in place.",
            inputSchema: {
                server: z.string().min(1),
            },
            outputSchema: {
                server: z.string(),
                status: z.enum(["ready", "error"]),
                error: z.string().nullable(),
                capabilities: capabilitySchema.nullable(),
            },
            annotations: operationalAnnotations,
        }),
        async ({ server: serverName }) => {
            const name = serverName.trim();
            try {
                const info = await hub.reconnectServer(name);
                return okResult(`Reconnected downstream MCP "${name}".`, {
                    server: name,
                    status: info.status,
                    error: info.error ?? null,
                    capabilities: info.capabilities ?? null,
                });
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

function registerMcpToolsTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_tools",
        withToolAuth({
            title: "List downstream MCP tools",
            description:
                "List the current tools on a downstream MCP server, including name, description, and inputSchema. Re-list after a tool/argument failure or when the downstream server may have changed.",
            inputSchema: {
                server: z.string().min(1).describe("Downstream MCP server name."),
            },
            outputSchema: {
                server: z.string(),
                description: z.string(),
                status: z.enum(["ready", "error"]),
                error: z.string().nullable(),
                tools: z.array(toolDescriptorSchema),
                truncated: z.boolean(),
            },
            annotations: openWorldAnnotations,
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
                        truncated: false,
                    },
                );
            }

            try {
                const listed = await hub.listTools(name);
                return okResult(
                    `Listed ${listed.items.length}${listed.truncated ? "+" : ""} tool(s) on downstream MCP "${name}"${listed.truncated ? " (truncated)" : ""}.`,
                    {
                        server: name,
                        description: info.description,
                        status: "ready" as const,
                        error: null,
                        tools: listed.items,
                        truncated: listed.truncated,
                    },
                );
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return errorResult(message);
            }
        },
    );
}

function registerMcpCallTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_call",
        withToolAuth({
            title: "Call downstream MCP tool",
            description:
                "Call a tool on a downstream MCP server and preserve its MCP content (including text, images, audio, resources, or links). Use mcp_tools for the current schema when needed.",
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

function registerMcpResourcesTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_resources",
        withToolAuth({
            title: "List downstream MCP resources",
            description:
                "List resources and resource templates exposed by a downstream MCP server.",
            inputSchema: {
                server: z.string().min(1),
            },
            outputSchema: {
                server: z.string(),
                resources: z.array(resourceSchema),
                templates: z.array(resourceTemplateSchema),
                truncated: z.boolean(),
            },
            annotations: openWorldAnnotations,
        }),
        async ({ server: serverName }) => {
            const name = serverName.trim();
            try {
                const listed = await hub.listResources(name);
                return okResult(
                    `Listed ${listed.resources.length} resource(s) and ${listed.templates.length} template(s) on downstream MCP "${name}".`,
                    { server: name, ...listed },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

function registerMcpResourceReadTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_resource_read",
        withToolAuth({
            title: "Read downstream MCP resource",
            description:
                "Read a resource URI from a downstream MCP server and preserve text/blob resource contents.",
            inputSchema: {
                server: z.string().min(1),
                uri: z.string().min(1),
            },
            outputSchema: {
                server: z.string(),
                uri: z.string(),
                contents: z.array(
                    z.object({
                        uri: z.string(),
                        mimeType: z.string().optional(),
                        text: z.string().optional(),
                        blob: z.string().optional(),
                    }),
                ),
            },
            annotations: openWorldAnnotations,
        }),
        async ({ server: serverName, uri }) => {
            const name = serverName.trim();
            const resourceUri = uri.trim();
            try {
                const result = await hub.readResource(name, resourceUri);
                const content = result.contents.map((item) => ({
                    type: "resource" as const,
                    resource: {
                        uri: item.uri,
                        ...(item.mimeType ? { mimeType: item.mimeType } : {}),
                        ...(item.text !== undefined ? { text: item.text } : { blob: item.blob ?? "" }),
                    },
                }));
                return {
                    content: content.length > 0
                        ? content
                        : [{ type: "text" as const, text: `Resource ${resourceUri} returned no contents.` }],
                    structuredContent: {
                        server: name,
                        uri: resourceUri,
                        contents: result.contents,
                    },
                };
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

function registerMcpPromptsTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_prompts",
        withToolAuth({
            title: "List downstream MCP prompts",
            description: "List prompt templates exposed by a downstream MCP server.",
            inputSchema: {
                server: z.string().min(1),
            },
            outputSchema: {
                server: z.string(),
                prompts: z.array(promptSchema),
                truncated: z.boolean(),
            },
            annotations: openWorldAnnotations,
        }),
        async ({ server: serverName }) => {
            const name = serverName.trim();
            try {
                const listed = await hub.listPrompts(name);
                return okResult(
                    `Listed ${listed.items.length}${listed.truncated ? "+" : ""} prompt(s) on downstream MCP "${name}"${listed.truncated ? " (truncated)" : ""}.`,
                    {
                        server: name,
                        prompts: listed.items,
                        truncated: listed.truncated,
                    },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

function registerMcpPromptGetTool(server: McpServer, hub: DownstreamMcpHub): void {
    registerTool(
        server,
        "mcp_prompt_get",
        withToolAuth({
            title: "Get downstream MCP prompt",
            description:
                "Resolve a named downstream MCP prompt with string arguments and return its messages without executing them.",
            inputSchema: {
                server: z.string().min(1),
                prompt: z.string().min(1),
                arguments: z.record(z.string(), z.string()).optional(),
            },
            outputSchema: {
                server: z.string(),
                prompt: z.string(),
                description: z.string().nullable(),
                messages: z.array(z.record(z.string(), z.unknown())),
            },
            annotations: openWorldAnnotations,
        }),
        async ({ server: serverName, prompt, arguments: promptArgs }) => {
            const name = serverName.trim();
            const promptName = prompt.trim();
            try {
                const result = await hub.getPrompt(name, promptName, promptArgs ?? {});
                return okResult(
                    `Resolved downstream MCP prompt "${name}/${promptName}" with ${result.messages.length} message(s).`,
                    {
                        server: name,
                        prompt: promptName,
                        description: result.description ?? null,
                        messages: result.messages,
                    },
                );
            } catch (error) {
                return errorResult(error instanceof Error ? error.message : String(error));
            }
        },
    );
}

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

    const content =
        result.content && result.content.length > 0
            ? result.content
            : [{
                  type: "text" as const,
                  text: `mcp_call ${serverName}/${toolName}: ${clipPreview(text)}`,
              }];
    return {
        ...(result.isError ? { isError: true as const } : {}),
        content,
        structuredContent: payload,
    };
}

function clipPreview(text: string): string {
    const oneLine = text.replace(/\s+/g, " ").trim();
    if (oneLine.length <= 160) return oneLine;
    return `${oneLine.slice(0, 159)}…`;
}
