import assert from "node:assert/strict";
import { mergeMcpConfigs, normalizeCodexMcpList } from "../src/config/codex-import.js";
import { isStdioMcpServer, isUrlMcpServer } from "../src/config/user-mcp.js";

function main(): void {
    const imported = normalizeCodexMcpList(
        [
            {
                name: "stdio-demo",
                enabled: true,
                startup_timeout_sec: 12.5,
                tool_timeout_sec: 3,
                transport: {
                    type: "stdio",
                    command: "demo-bin",
                    args: ["serve", "--mcp"],
                    env: { CONFIGURED: "yes" },
                    env_vars: ["INHERITED"],
                    cwd: "/tmp/demo",
                },
            },
            {
                name: "http-demo",
                enabled: true,
                transport: {
                    type: "streamable_http",
                    url: "https://example.com/mcp?key=kept-in-memory",
                    bearer_token_env_var: "BEARER_TOKEN",
                    http_headers: { "X-Configured": "value" },
                    env_http_headers: { "X-From-Env": "HEADER_VALUE" },
                },
            },
            {
                name: "disabled-demo",
                enabled: false,
                transport: { type: "stdio", command: "disabled" },
            },
        ],
        {
            INHERITED: "inherited-value",
            BEARER_TOKEN: "token-value",
            HEADER_VALUE: "header-value",
        },
    );

    assert.deepEqual(Object.keys(imported.mcpServers).sort(), ["http-demo", "stdio-demo"]);
    const stdio = imported.mcpServers["stdio-demo"]!;
    assert.ok(isStdioMcpServer(stdio));
    if (isStdioMcpServer(stdio)) {
        assert.equal(stdio.command, "demo-bin");
        assert.deepEqual(stdio.args, ["serve", "--mcp"]);
        assert.equal(stdio.env?.CONFIGURED, "yes");
        assert.equal(stdio.env?.INHERITED, "inherited-value");
        assert.equal(stdio.cwd, "/tmp/demo");
        assert.equal(stdio.startupTimeoutMs, 12_500);
        assert.equal(stdio.toolTimeoutMs, 3_000);
    }

    const http = imported.mcpServers["http-demo"]!;
    assert.ok(isUrlMcpServer(http));
    if (isUrlMcpServer(http)) {
        assert.equal(http.headers?.Authorization, "Bearer token-value");
        assert.equal(http.headers?.["X-Configured"], "value");
        assert.equal(http.headers?.["X-From-Env"], "header-value");
        assert.match(http.url, /key=kept-in-memory/);
    }

    const merged = mergeMcpConfigs(imported, {
        disabledServers: ["stdio-demo"],
        mcpServers: {
            "http-demo": { command: "override-http" },
            extra: { command: "extra" },
        },
    });
    assert.deepEqual(Object.keys(merged.mcpServers).sort(), ["extra", "http-demo"]);
    assert.ok(isStdioMcpServer(merged.mcpServers["http-demo"]!));
    assert.equal(
        isStdioMcpServer(merged.mcpServers["http-demo"]!)
            ? merged.mcpServers["http-demo"].command
            : "",
        "override-http",
    );

    assert.throws(
        () =>
            normalizeCodexMcpList([
                {
                    name: "bad-http",
                    enabled: true,
                    transport: {
                        type: "streamable_http",
                        url: "https://example.com/mcp",
                        bearer_token_env_var: "MISSING_TOKEN",
                    },
                },
            ], {}),
        /requires environment variable MISSING_TOKEN/i,
    );

    console.log("codex-import.test.ts: ok");
}

main();
