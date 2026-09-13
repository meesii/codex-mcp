import type { AuthInfo } from "@modelcontextprotocol/server";

interface ProbeHandler {
    fetch(request: Request, options?: { authInfo?: AuthInfo; parsedBody?: unknown }): Promise<Response>;
}

/** Fixed, read-only requests through the live MCP handler. No arbitrary caller-supplied tool calls. */
export async function probeMcpHandler(handler: ProbeHandler, url: string, authenticated: boolean): Promise<{ toolCount: number; projectCount: number }> {
    let id = 0;
    async function request(method: string, params: unknown) {
        const body = { jsonrpc: "2.0", id: ++id, method, params };
        const response = await handler.fetch(new Request(url, {
            method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream", "mcp-protocol-version": "2025-03-26" },
            body: JSON.stringify(body), signal: AbortSignal.timeout(10_000),
        }), {
            parsedBody: body,
            ...(authenticated ? { authInfo: { token: "local-console-probe", clientId: "local-console-probe", scopes: [] } } : {}),
        });
        const text = await response.text();
        const messages = response.headers.get("content-type")?.includes("text/event-stream")
            ? text.split(/\r?\n/).filter((line) => line.startsWith("data: ")).map((line) => JSON.parse(line.slice(6)))
            : [JSON.parse(text)];
        const message = messages.find((item) => item.id === body.id);
        if (!response.ok || !message || message.error || message.result?.isError) throw new Error("服务没有正确响应工具检查，请重新启动后重试。");
        return message.result;
    }
    await request("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "codex-console-check", version: "1" } });
    const listed = await request("tools/list", {});
    if (!Array.isArray(listed.tools) || !listed.tools.some((tool: { name: string }) => tool.name === "project_control")) throw new Error("项目工具不可用，请检查工具设置。");
    const result = await request("tools/call", { name: "project_control", arguments: { action: "list", purpose: "检查项目列表是否可以读取" } });
    const projects = result.structuredContent?.projects;
    if (!Array.isArray(projects)) throw new Error("无法读取项目列表，请重新启动服务后重试。");
    return { toolCount: listed.tools.length, projectCount: projects.length };
}
