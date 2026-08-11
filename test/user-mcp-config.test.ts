import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { normalizeHostname } from "../src/config/user-config.js";
import {
    isStdioMcpServer,
    isUrlMcpServer,
    listEnabledMcpServers,
} from "../src/config/user-mcp.js";

/**
 * Run a callback with HOME/USERPROFILE pointed at a temp directory.
 *
 * @param run - Test body receiving the temp home path
 */
async function withTempHome(run: (home: string) => Promise<void>): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-home-"));
    await mkdir(join(home, ".codex-mcp"), { recursive: true });
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        await run(home);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }
}

async function main(): Promise<void> {
    assert.equal(normalizeHostname("HTTPS://MCP.Example.COM:443/path"), "mcp.example.com");
    assert.equal(normalizeHostname("例子.测试"), "xn--fsqu00a.xn--0zwm56d");
    for (const invalid of [
        "127.0.0.1",
        "localhost",
        "foo..example.com",
        "https://user:pass@example.com",
        "ftp://example.com",
    ]) {
        assert.throws(() => normalizeHostname(invalid), /域名格式不正确/);
    }

    await withTempHome(async (home) => {
        const { loadUserMcpConfig, loadUserMcpOverrides } = await import("../src/config/user-mcp.js");
        const empty = loadUserMcpConfig();
        assert.deepEqual(empty, { mcpServers: {} });

        process.env.CODEX_MCP_TEST_TOKEN = "x";
        const mcpConfigPath = join(home, ".codex-mcp", "mcp.json");
        await writeFile(
            mcpConfigPath,
            JSON.stringify(
                {
                    mcpServers: {
                        github: {
                            command: "npx",
                            args: ["-y", "@modelcontextprotocol/server-github"],
                            env: { TOKEN: "${CODEX_MCP_TEST_TOKEN}" },
                        },
                        remote: {
                            url: "https://example.com/mcp",
                            headers: { Authorization: "Bearer ${CODEX_MCP_TEST_TOKEN}" },
                        },
                        off: {
                            command: "echo",
                            disabled: true,
                        },
                    },
                },
                null,
                4,
            ),
            "utf8",
        );

        const config = loadUserMcpConfig();
        assert.deepEqual(loadUserMcpOverrides().disabledServers, ["off"]);
        const enabled = listEnabledMcpServers(config);
        assert.equal(enabled.length, 2);
        assert.equal(enabled[0]!.name, "github");
        assert.equal(enabled[1]!.name, "remote");
        assert.ok(isStdioMcpServer(enabled[0]!.config));
        assert.ok(isUrlMcpServer(enabled[1]!.config));
        if (isStdioMcpServer(enabled[0]!.config)) {
            assert.equal(enabled[0]!.config.env?.TOKEN, "x");
        }
        if (isUrlMcpServer(enabled[1]!.config)) {
            assert.equal(enabled[1]!.config.headers?.Authorization, "Bearer x");
        }
        if (process.platform !== "win32") {
            assert.equal((await stat(mcpConfigPath)).mode & 0o077, 0);
        }
        delete process.env.CODEX_MCP_TEST_TOKEN;
    });

    await withTempHome(async (home) => {
        const { loadUserMcpConfig } = await import("../src/config/user-mcp.js");
        const path = join(home, ".codex-mcp", "mcp.json");
        await writeFile(
            path,
            JSON.stringify({
                mcpServers: {
                    bad: { command: "x", url: "https://example.com/mcp" },
                },
            }),
            "utf8",
        );
        assert.throws(() => loadUserMcpConfig(), /command or url/);

        await writeFile(
            path,
            JSON.stringify({
                mcpServers: {
                    bad: {
                        url: "https://example.com/mcp",
                        headers: { Authorization: "Bearer plaintext-secret" },
                    },
                },
            }),
            "utf8",
        );
        assert.throws(() => loadUserMcpConfig(), /sensitive.*environment reference/i);

        await writeFile(
            path,
            JSON.stringify({
                mcpServers: {
                    bad: {
                        url: "https://example.com/mcp",
                        headers: { Authorization: "Bearer ${MISSING_CODEX_MCP_SECRET}" },
                    },
                },
            }),
            "utf8",
        );
        assert.throws(() => loadUserMcpConfig(), /missing environment variable/i);

        await writeFile(
            path,
            JSON.stringify({ mcpServers: { bad: { url: "http://example.com/mcp" } } }),
            "utf8",
        );
        assert.throws(() => loadUserMcpConfig(), /must use HTTPS/i);

        await writeFile(
            path,
            JSON.stringify({ mcpServers: { local: { url: "http://127.0.0.1:9999/mcp" } } }),
            "utf8",
        );
        const local = loadUserMcpConfig();
        assert.ok(isUrlMcpServer(local.mcpServers.local!));
    });

    console.log("user-mcp-config.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
