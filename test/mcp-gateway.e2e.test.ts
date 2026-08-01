import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DownstreamMcpHub } from "../src/downstream/hub.js";
import { buildServerInstructions } from "../src/mcp-server.js";
import { resolveWidgetDomain, type ServerConfig } from "../src/config.js";
import { createHttpServer } from "../src/http-server.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";

const fixtureServerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "echo-mcp-server.mjs",
);

/**
 * Point HOME at a temp dir that contains mcp.json for the echo fixture.
 *
 * @returns Absolute temp home path
 */
async function writeEchoMcpHome(): Promise<string> {
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-gateway-"));
    await mkdir(join(home, ".codex-mcp"), { recursive: true });
    await writeFile(
        join(home, ".codex-mcp", "mcp.json"),
        JSON.stringify(
            {
                mcpServers: {
                    echo: {
                        command: process.execPath,
                        args: [fixtureServerPath],
                    },
                },
            },
            null,
            4,
        ),
        "utf8",
    );
    return home;
}

async function main(): Promise<void> {
    process.env.CODING_MCP_LOG_TOOLS = "0";

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    const home = await writeEchoMcpHome();
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const projectRoot = await mkdtemp(join(tmpdir(), "codex-mcp-proj-"));
    await writeFile(join(projectRoot, "note.txt"), "hi\n", "utf8");

    const host = "127.0.0.1";
    const port = 0;
    const allowedHosts: string[] = [];
    const config: ServerConfig = {
        host,
        port,
        projectRoot,
        allowedHosts,
        widgetDomain: resolveWidgetDomain(allowedHosts, host, port),
    };

    const hub = await DownstreamMcpHub.connectFromUserConfig();
    const server = createHttpServer(config, { hub });
    await server.listen();
    const mcp = await connectMcpClient(server.getMcpUrl());

    try {
        const ready = hub.listReadyServers();
        assert.equal(ready.length, 1);
        assert.equal(ready[0]!.name, "echo");
        assert.match(ready[0]!.description, /Tiny echo MCP/);

        const toolNames = await mcp.listToolNames();
        assert.ok(toolNames.includes("mcp_tools"));
        assert.ok(toolNames.includes("mcp_call"));

        const instructions = buildServerInstructions(projectRoot, hub);
        assert.match(instructions, /Downstream MCP/);
        assert.match(instructions, /echo — Tiny echo MCP/);
        assert.match(instructions, /mcp_tools/);

        const listed = await mcp.callTool("mcp_tools", { server: "echo" });
        assert.notEqual(listed.isError, true);
        const structured = listed.structuredContent as {
            tools: Array<{ name: string; description: string }>;
        };
        assert.ok(structured.tools.some((tool) => tool.name === "echo"));

        const called = await mcp.callTool("mcp_call", {
            server: "echo",
            tool: "echo",
            arguments: { text: "ping" },
        });
        assert.notEqual(called.isError, true);
        assert.match(toolText(called), /echo:ping/);
        const callData = called.structuredContent as {
            server: string;
            tool: string;
            text: string;
        };
        assert.equal(callData.server, "echo");
        assert.equal(callData.tool, "echo");
        assert.match(callData.text, /echo:ping/);

        const missing = await mcp.callTool("mcp_tools", { server: "nope" });
        assert.equal(missing.isError, true);
    } finally {
        await mcp.close();
        await server.close();
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }

    console.log("mcp-gateway.e2e.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
