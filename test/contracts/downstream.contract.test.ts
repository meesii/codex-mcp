import assert from "node:assert/strict";
import test from "node:test";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    connectMcp,
    createDownstreamHub,
    createProject,
    createTestEnvironment,
    expectToolError,
    expectToolOk,
    resultText,
    startSingleProjectHarness,
} from "./harness.js";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "downstream-contract.mjs");

test("downstream MCP contract: discovery, calls, resources, prompts, disconnect and reconnect are observable through gateway tools", async () => {
    const env = await createTestEnvironment("codex-mcp-downstream-contract-");
    const project = await createProject("downstream", { files: { "identity.txt": "CORE-STILL-AVAILABLE\n" } });
    const hub = await createDownstreamHub({
        mcpServers: {
            contract: {
                command: process.execPath,
                args: [fixture],
                env: { CONTRACT_MARKER: "gateway-ok" },
            },
        },
    });
    const server = await startSingleProjectHarness({ root: project, hub });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const servers = expectToolOk<{
            servers?: Array<{
                name: string;
                status: string;
                capabilities?: { tools?: boolean; resources?: boolean; prompts?: boolean } | null;
            }>;
        }>(await mcp.call("mcp_servers", {}));
        const contractServer = (servers.servers ?? []).find((row) => row.name === "contract");
        assert.equal(contractServer?.status, "ready");
        assert.deepEqual(contractServer?.capabilities, { tools: true, resources: true, prompts: true });

        const tools = expectToolOk<{
            status?: string;
            tools?: Array<{ name: string; inputSchema: Record<string, unknown> }>;
            truncated?: boolean;
        }>(await mcp.call("mcp_tools", { server: "contract" }));
        assert.equal(tools.status, "ready");
        assert.equal(tools.truncated, false);
        assert.equal(tools.tools?.some((tool) => tool.name === "echo"), true);
        assert.equal(tools.tools?.some((tool) => tool.name === "disconnect"), true);

        const echo = await mcp.call("mcp_call", {
            server: "contract",
            tool: "echo",
            arguments: { text: "hello" },
        });
        assert.notEqual(echo.isError, true, resultText(echo));
        assert.match(resultText(echo), /downstream:hello:gateway-ok/);
        const echoStructured = echo.structuredContent as {
            structuredContent?: { text?: string; marker?: string } | null;
        };
        assert.deepEqual(echoStructured.structuredContent, { text: "hello", marker: "gateway-ok" });

        const resources = expectToolOk<{
            resources?: Array<{ uri: string }>;
            truncated?: boolean;
        }>(await mcp.call("mcp_resources", { server: "contract" }));
        assert.equal(resources.resources?.some((row) => row.uri === "contract://fixture/readme"), true);
        assert.equal(resources.truncated, false);

        const resourceRead = expectToolOk<{
            contents?: Array<{ uri: string; text?: string; blob?: string }>;
        }>(await mcp.call("mcp_resource_read", {
            server: "contract",
            uri: "contract://fixture/readme",
        }));
        assert.equal(
            resourceRead.contents?.some((row) => row.text === "DOWNSTREAM-RESOURCE-CONTENT"),
            true,
        );

        const prompts = expectToolOk<{
            prompts?: Array<{ name: string }>;
            truncated?: boolean;
        }>(await mcp.call("mcp_prompts", { server: "contract" }));
        assert.equal(prompts.prompts?.some((row) => row.name === "contract-prompt"), true);
        assert.equal(prompts.truncated, false);

        const prompt = expectToolOk<{
            messages?: Array<{ role?: string; content?: { type?: string; text?: string } }>;
        }>(await mcp.call("mcp_prompt_get", {
            server: "contract",
            prompt: "contract-prompt",
            arguments: { text: "from-gateway" },
        }));
        assert.equal(prompt.messages?.[0]?.content?.text, "PROMPT:from-gateway");

        expectToolError(await mcp.call("mcp_tools", { server: "unknown-server" }), /unknown downstream/i);

        const disconnect = await mcp.call("mcp_call", {
            server: "contract",
            tool: "disconnect",
            arguments: {},
        });
        assert.notEqual(disconnect.isError, true, resultText(disconnect));
        await new Promise((resolveWait) => setTimeout(resolveWait, 80));

        // A terminated downstream process must not poison the core project tools.
        const coreRead = expectToolOk<{ content?: string }>(await mcp.call("read", { path: "identity.txt" }));
        assert.equal(coreRead.content, "CORE-STILL-AVAILABLE\n");

        // The gateway contract is resilient: the next downstream call reconnects
        // automatically rather than requiring the caller to know transport state.
        const afterDisconnect = await mcp.call("mcp_call", {
            server: "contract",
            tool: "echo",
            arguments: { text: "after-disconnect" },
        });
        assert.notEqual(afterDisconnect.isError, true, resultText(afterDisconnect));
        assert.match(resultText(afterDisconnect), /downstream:after-disconnect:gateway-ok/);

        const reconnected = expectToolOk<{ status?: string }>(
            await mcp.call("mcp_reconnect", { server: "contract" }),
        );
        assert.equal(reconnected.status, "ready");
        const echoAgain = await mcp.call("mcp_call", {
            server: "contract",
            tool: "echo",
            arguments: { text: "reconnected" },
        });
        assert.notEqual(echoAgain.isError, true, resultText(echoAgain));
        assert.match(resultText(echoAgain), /downstream:reconnected:gateway-ok/);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await hub.close().catch(() => undefined);
        await env.cleanup();
    }
});

test("downstream MCP contract: oversized downstream tool results are rejected instead of forwarded unbounded", async () => {
    const env = await createTestEnvironment("codex-mcp-downstream-size-contract-");
    const project = await createProject("downstream-size");
    const hub = await createDownstreamHub({
        mcpServers: {
            contract: { command: process.execPath, args: [fixture] },
        },
    });
    const server = await startSingleProjectHarness({ root: project, hub });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const oversized = await mcp.call("mcp_call", {
            server: "contract",
            tool: "large",
            arguments: { size: 4_500_000 },
        });
        expectToolError(oversized, /large|size|limit|exceed|bounded|result/i);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await hub.close().catch(() => undefined);
        await env.cleanup();
    }
});
