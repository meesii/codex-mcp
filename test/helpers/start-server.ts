import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    resolveWidgetDomain,
    type ServerConfig,
} from "../../src/config.js";
import { createHttpServer, type RunningHttpServer } from "../../src/http-server.js";

export interface TestServerContext {
    fixtureRoot: string;
    mcpUrl: string;
    server: RunningHttpServer;
}

/**
 * Start an in-process MCP HTTP server with a temporary fixture project root.
 *
 * @returns Server handle, fixture path, and MCP URL
 */
export async function startTestServer(): Promise<TestServerContext> {
    // Keep e2e stdout focused on assertions, not tool call logs.
    process.env.CODING_MCP_LOG_TOOLS = "0";

    const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-mcp-"));
    await mkdir(join(fixtureRoot, "src"), { recursive: true });
    await writeFile(
        join(fixtureRoot, "hello.txt"),
        "hello world\nunique-marker-alpha\n",
        "utf8",
    );
    await writeFile(join(fixtureRoot, "src", "app.ts"), "export const value = 1;\n", "utf8");

    const host = "127.0.0.1";
    const port = 0;
    const allowedHosts: string[] = [];
    const config: ServerConfig = {
        host,
        port,
        projectRoot: fixtureRoot,
        allowedHosts,
        widgetDomain: resolveWidgetDomain(allowedHosts, host, port),
    };

    const server = createHttpServer(config);
    await server.listen();

    return {
        fixtureRoot,
        mcpUrl: server.getMcpUrl(),
        server,
    };
}
