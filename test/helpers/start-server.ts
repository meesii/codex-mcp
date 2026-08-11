import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    resolveWidgetDomain,
    type ServerConfig,
} from "../../src/config/loader.js";
import {
    createHttpServer,
    type CreateHttpServerOptions,
    type RunningHttpServer,
} from "../../src/server/http-server.js";
import { AgentInstructionRegistry } from "../../src/agents/registry.js";
import { ProjectContext } from "../../src/config/project.js";
import { TOOL_NAMES } from "../../src/tools/names.js";
import { createMemoryUiSettingsStore } from "../../src/ui/settings.js";

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
export async function startTestServer(
    options: CreateHttpServerOptions = {},
): Promise<TestServerContext> {
    // Keep e2e stdout focused on assertions, not tool call logs.
    process.env.CODING_MCP_LOG_TOOLS = "0";

    const fixtureRoot = await mkdtemp(join(tmpdir(), "codex-mcp-"));
    const goalStorageDir = await mkdtemp(join(tmpdir(), "codex-mcp-goals-"));
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
        local: true,
        oauthRequired: false,
        projectRoot: fixtureRoot,
        allowedHosts,
        widgetDomain: resolveWidgetDomain(allowedHosts, host, port),
    };

    const server = createHttpServer(config, {
        ...options,
        goalStorageDir: options.goalStorageDir ?? goalStorageDir,
        uiSettings: options.uiSettings ?? createMemoryUiSettingsStore(),
        agents:
            options.agents ??
            new AgentInstructionRegistry(new ProjectContext(fixtureRoot), fixtureRoot),
        allowedToolsResolver:
            options.allowedToolsResolver ?? (() => new Set<string>(TOOL_NAMES)),
    });
    await server.listen();

    return {
        fixtureRoot,
        mcpUrl: server.getMcpUrl(),
        server,
    };
}
