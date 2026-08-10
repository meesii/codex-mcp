import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { collectPaginated, DownstreamMcpHub } from "../src/downstream/hub.js";
import { buildServerInstructions } from "../src/mcp-server.js";
import { resolveWidgetDomain, type ServerConfig } from "../src/config.js";
import { createHttpServer } from "../src/http-server.js";
import { runtimeTelemetry } from "../src/lib/runtime-telemetry.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";

const fixtureServerPath = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "echo-mcp-server.mjs",
);
const countingToolsFixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "counting-tools-mcp-server.mjs",
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
                        env: { ALPHA: "1", BETA: "2" },
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

async function testToolListCache(): Promise<void> {
    runtimeTelemetry.reset();
    const temp = await mkdtemp(join(tmpdir(), "codex-mcp-tool-cache-"));
    const countFile = join(temp, "tools-list-count.txt");
    const hub = DownstreamMcpHub.empty();
    try {
        await hub.reloadFromConfig({
            mcpServers: {
                counting: {
                    command: process.execPath,
                    args: [countingToolsFixturePath],
                    env: { TOOLS_LIST_COUNT_FILE: countFile },
                },
            },
        });

        const first = await hub.listTools("counting");
        assert.ok(first.items.some((tool) => tool.name === "version_1"));
        const second = await hub.listTools("counting");
        assert.ok(second.items.some((tool) => tool.name === "version_1"));
        assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 1);

        await hub.callTool("counting", "invalidate", {});
        const afterNotification = await hub.listTools("counting");
        assert.ok(afterNotification.items.some((tool) => tool.name === "version_2"));
        assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 2);

        await hub.reconnectServer("counting");
        const afterReconnect = await hub.listTools("counting");
        assert.ok(afterReconnect.items.some((tool) => tool.name === "version_1"));
        assert.equal((await readFile(countFile, "utf8")).trim().split("\n").length, 3);

        const telemetry = runtimeTelemetry.snapshot({
            running: 0,
            retained: 0,
            bufferedChars: 0,
            starts: 0,
            completions: 0,
            outputTruncations: 0,
        });
        assert.equal(telemetry.downstream.cacheHits, 1);
        assert.equal(telemetry.downstream.cacheMisses, 3);
        assert.equal(telemetry.downstream.reconnects, 1);
        assert.ok(telemetry.downstream.calls >= 5);
        assert.ok(
            telemetry.downstream.byServer.some(
                (metric) => metric.server === "counting" && metric.calls >= 5,
            ),
        );
    } finally {
        await hub.close();
    }
}

async function main(): Promise<void> {
    process.env.CODING_MCP_LOG_TOOLS = "0";

    let repeatedCursorCalls = 0;
    await assert.rejects(
        collectPaginated("test", async () => {
            repeatedCursorCalls += 1;
            return { items: [{ id: repeatedCursorCalls }], nextCursor: "same" };
        }),
        /repeated cursor/i,
    );
    assert.equal(repeatedCursorCalls, 2);

    const itemBudget = await collectPaginated("test", async () => ({
        items: Array.from({ length: 2_001 }, (_, index) => ({ index })),
    }));
    assert.equal(itemBudget.items.length, 2_000);
    assert.equal(itemBudget.truncated, true);

    await testToolListCache();

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
        local: true,
        oauthRequired: false,
        projectRoot,
        allowedHosts,
        widgetDomain: resolveWidgetDomain(allowedHosts, host, port),
    };

    const hub = await DownstreamMcpHub.connectFromDefaultConfig();
    const server = createHttpServer(config, { hub });
    await server.listen();
    const mcp = await connectMcpClient(server.getMcpUrl());

    try {
        const ready = hub.listReadyServers();
        assert.equal(ready.length, 1);
        assert.equal(ready[0]!.name, "echo");
        assert.equal(ready[0]!.description, "echo");

        const toolNames = await mcp.listToolNames();
        assert.ok(toolNames.includes("mcp_servers"));
        assert.ok(toolNames.includes("mcp_reconnect"));
        assert.ok(toolNames.includes("mcp_tools"));
        assert.ok(toolNames.includes("mcp_call"));
        assert.ok(toolNames.includes("mcp_resources"));
        assert.ok(toolNames.includes("mcp_resource_read"));
        assert.ok(toolNames.includes("mcp_prompts"));
        assert.ok(toolNames.includes("mcp_prompt_get"));

        const instructions = buildServerInstructions(projectRoot, hub);
        assert.match(instructions, /Downstream MCP/);
        assert.match(instructions, /echo — echo/);
        assert.doesNotMatch(instructions, /Tiny echo MCP/);
        assert.match(instructions, /mcp_tools/);

        const listedToolsDescriptor = (
            await mcp.client.listTools()
        ).tools.find((tool) => tool.name === "mcp_tools");
        assert.ok(listedToolsDescriptor);
        assert.equal(listedToolsDescriptor.annotations?.readOnlyHint, true);
        assert.equal(listedToolsDescriptor.annotations?.openWorldHint, true);
        assert.doesNotMatch(
            listedToolsDescriptor.description ?? "",
            /does not change within a conversation|once per server/i,
        );

        const serverState = await mcp.callTool("mcp_servers", {});
        assert.notEqual(serverState.isError, true, toolText(serverState));
        const stateRows = (serverState.structuredContent as {
            servers?: Array<{
                name: string;
                status: string;
                capabilities?: { tools: boolean; resources: boolean; prompts: boolean };
            }>;
        }).servers ?? [];
        const echoState = stateRows.find((item) => item.name === "echo");
        assert.equal(echoState?.status, "ready");
        assert.deepEqual(echoState?.capabilities, {
            tools: true,
            resources: true,
            prompts: true,
        });

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

        const resources = await mcp.callTool("mcp_resources", { server: "echo" });
        assert.notEqual(resources.isError, true, toolText(resources));
        const resourceRows = (resources.structuredContent as {
            resources?: Array<{ uri: string }>;
        }).resources ?? [];
        assert.ok(resourceRows.some((item) => item.uri === "fixture://echo/readme"));

        const resourceRead = await mcp.callTool("mcp_resource_read", {
            server: "echo",
            uri: "fixture://echo/readme",
        });
        assert.notEqual(resourceRead.isError, true, toolText(resourceRead));
        assert.ok(
            resourceRead.content.some(
                (part) =>
                    part.type === "resource" &&
                    "text" in part.resource &&
                    part.resource.text === "resource:echo-ok",
            ),
            "mcp_resource_read should preserve embedded resource content",
        );

        const prompts = await mcp.callTool("mcp_prompts", { server: "echo" });
        assert.notEqual(prompts.isError, true, toolText(prompts));
        const promptRows = (prompts.structuredContent as {
            prompts?: Array<{ name: string }>;
        }).prompts ?? [];
        assert.ok(promptRows.some((item) => item.name === "echo-prompt"));

        const prompt = await mcp.callTool("mcp_prompt_get", {
            server: "echo",
            prompt: "echo-prompt",
            arguments: { text: "hello" },
        });
        assert.notEqual(prompt.isError, true, toolText(prompt));
        assert.match(JSON.stringify(prompt.structuredContent), /prompt:hello/);

        const explicitReconnect = await mcp.callTool("mcp_reconnect", { server: "echo" });
        assert.notEqual(explicitReconnect.isError, true, toolText(explicitReconnect));
        assert.equal(
            (explicitReconnect.structuredContent as { status?: string }).status,
            "ready",
        );

        const reorderedEnvReload = await hub.reloadFromConfig({
            mcpServers: {
                echo: {
                    command: process.execPath,
                    args: [fixtureServerPath],
                    env: { BETA: "2", ALPHA: "1" },
                },
            },
        });
        assert.deepEqual(
            reorderedEnvReload.changed,
            [],
            "object key order must not trigger downstream reconnects",
        );

        // Reload the shared hub in place: the existing parent MCP session must
        // immediately observe removal and re-addition without reconnecting.
        await hub.reloadFromConfig({ mcpServers: {} });
        const emptyState = await mcp.callTool("mcp_servers", {});
        assert.notEqual(emptyState.isError, true, toolText(emptyState));
        assert.deepEqual(
            (emptyState.structuredContent as { servers?: unknown[] }).servers,
            [],
        );
        await hub.reloadFromConfig({
            mcpServers: {
                echo: {
                    command: process.execPath,
                    args: [fixtureServerPath],
                },
            },
        });
        const afterReload = await mcp.callTool("mcp_tools", { server: "echo" });
        assert.notEqual(afterReload.isError, true, toolText(afterReload));

        const rich = await mcp.callTool("mcp_call", {
            server: "echo",
            tool: "rich",
            arguments: {},
        });
        assert.notEqual(rich.isError, true);
        assert.ok(
            rich.content.some((part) => part.type === "image"),
            "mcp_call should preserve downstream image content",
        );
        assert.ok(
            rich.content.some((part) => part.type === "text" && part.text === "rich-ok"),
            "mcp_call should preserve downstream text content",
        );

        const huge = await mcp.callTool("mcp_call", {
            server: "echo",
            tool: "huge",
            arguments: { size: 4_300_000 },
        });
        assert.equal(huge.isError, true);
        assert.match(toolText(huge), /gateway result budget/i);

        const disconnect = await mcp.callTool("mcp_call", {
            server: "echo",
            tool: "disconnect",
            arguments: {},
        });
        assert.notEqual(disconnect.isError, true);
        await new Promise((resolve) => setTimeout(resolve, 150));
        const afterDisconnect = await mcp.callTool("mcp_tools", { server: "echo" });
        assert.notEqual(afterDisconnect.isError, true);
        assert.ok(
            ((afterDisconnect.structuredContent as { tools?: Array<{ name: string }> }).tools ?? [])
                .some((tool) => tool.name === "echo"),
            "mcp_tools should reconnect and list tools after downstream disconnect",
        );

        const missing = await mcp.callTool("mcp_tools", { server: "nope" });
        assert.equal(missing.isError, true);

        // A stdio server that emits more than a pipe's high-water mark before
        // initialize must still become ready: the hub drains stderr immediately
        // into a bounded tail buffer instead of leaving the PassThrough unread.
        const stderrReload = await hub.reloadFromConfig({
            mcpServers: {
                echo: {
                    command: process.execPath,
                    args: [fixtureServerPath],
                    env: { STDERR_BURST_BYTES: String(1024 * 1024) },
                    startupTimeoutMs: 5_000,
                },
            },
        });
        assert.deepEqual(stderrReload.changed, ["echo"]);
        assert.equal(hub.listServers()[0]?.status, "ready");
        const afterStderrBurst = await mcp.callTool("mcp_tools", { server: "echo" });
        assert.notEqual(afterStderrBurst.isError, true, toolText(afterStderrBurst));

        // Reproduce the old reconnect/reload race deterministically: after the
        // downstream exits, listTools starts a deliberately slow reconnect while
        // config reload removes the same slot. The operation may fail because the
        // server was removed, but it must never observe a cleared client or revive
        // the retired slot.
        await hub.reloadFromConfig({
            mcpServers: {
                echo: {
                    command: process.execPath,
                    args: [fixtureServerPath],
                    env: { STARTUP_DELAY_MS: "400" },
                    startupTimeoutMs: 5_000,
                },
            },
        });
        const raceDisconnect = await mcp.callTool("mcp_call", {
            server: "echo",
            tool: "disconnect",
            arguments: {},
        });
        assert.notEqual(raceDisconnect.isError, true, toolText(raceDisconnect));
        await new Promise((resolve) => setTimeout(resolve, 150));
        const raceList = hub.listTools("echo").then(
            (value) => ({ value }),
            (error: unknown) => ({ error }),
        );
        await new Promise((resolve) => setTimeout(resolve, 50));
        const raceReload = hub.reloadFromConfig({ mcpServers: {} });
        const [raceResult] = await Promise.all([raceList, raceReload]);
        if ("error" in raceResult) {
            const message = raceResult.error instanceof Error
                ? raceResult.error.message
                : String(raceResult.error);
            assert.doesNotMatch(message, /TypeError|undefined.*listTools/i);
            assert.match(message, /changed|removed|closed|unavailable/i);
        }
        assert.deepEqual(hub.listServers(), []);
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
