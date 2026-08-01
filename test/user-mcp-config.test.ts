import assert from "node:assert/strict";
import { mkdtemp, writeFile, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
    isStdioMcpServer,
    isUrlMcpServer,
    listEnabledMcpServers,
} from "../src/user-mcp-config.js";

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
    await withTempHome(async (home) => {
        const { loadUserMcpConfig } = await import("../src/user-mcp-config.js");
        const empty = loadUserMcpConfig();
        assert.deepEqual(empty, { mcpServers: {} });

        await writeFile(
            join(home, ".codex-mcp", "mcp.json"),
            JSON.stringify(
                {
                    mcpServers: {
                        github: {
                            command: "npx",
                            args: ["-y", "@modelcontextprotocol/server-github"],
                            env: { TOKEN: "x" },
                        },
                        remote: {
                            url: "https://example.com/mcp",
                            headers: { Authorization: "Bearer x" },
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
        const enabled = listEnabledMcpServers(config);
        assert.equal(enabled.length, 2);
        assert.equal(enabled[0]!.name, "github");
        assert.equal(enabled[1]!.name, "remote");
        assert.ok(isStdioMcpServer(enabled[0]!.config));
        assert.ok(isUrlMcpServer(enabled[1]!.config));
    });

    await withTempHome(async (home) => {
        const { loadUserMcpConfig } = await import("../src/user-mcp-config.js");
        await writeFile(
            join(home, ".codex-mcp", "mcp.json"),
            JSON.stringify({
                mcpServers: {
                    bad: { command: "x", url: "https://example.com/mcp" },
                },
            }),
            "utf8",
        );
        assert.throws(() => loadUserMcpConfig(), /command or url/);
    });

    console.log("user-mcp-config.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
