import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, saveUserConfig } from "../src/config/user-config.js";

async function main(): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-cap-config-"));
    await mkdir(join(home, ".codex-mcp"), { recursive: true });
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        const path = join(home, ".codex-mcp", "config.json");
        const extraWorkspace = join(home, "extra-workspace");
        const permissionRoot = join(home, "outside-write");
        await mkdir(extraWorkspace, { recursive: true });
        await mkdir(permissionRoot, { recursive: true });
        await writeFile(
            path,
            JSON.stringify({
                host: "127.0.0.1",
                port: 8787,
                workspaces: ["~/extra-workspace"],
                permissions: {
                    grants: [{ capability: "write", path: "~/outside-write" }],
                },
                clientCapabilities: {
                    default: ["read", "git_*"],
                    clients: {
                        "local:noauth": ["*"],
                        "https://chatgpt.example/client.json": ["read", "grep", "mcp_*"],
                    },
                },
            }),
            "utf8",
        );
        const config = loadUserConfig();
        assert.deepEqual(config.workspaces, [extraWorkspace]);
        assert.deepEqual(config.permissions?.grants, [
            { capability: "write", path: permissionRoot },
        ]);
        assert.deepEqual(config.clientCapabilities?.default, ["read", "git_*"]);
        assert.deepEqual(config.clientCapabilities?.clients?.["local:noauth"], ["*"]);
        assert.deepEqual(
            config.clientCapabilities?.clients?.["https://chatgpt.example/client.json"],
            ["read", "grep", "mcp_*"],
        );

        const saved = saveUserConfig({
            permissions: {
                grants: [
                    { capability: "write", path: permissionRoot },
                    { capability: "exec", path: extraWorkspace },
                ],
            },
        });
        assert.deepEqual(saved.workspaces, [extraWorkspace]);
        assert.deepEqual(saved.permissions?.grants, [
            { capability: "write", path: permissionRoot },
            { capability: "exec", path: extraWorkspace },
        ]);

        await writeFile(
            path,
            JSON.stringify({
                clientCapabilities: {
                    default: ["read", "mcp_**"],
                },
            }),
            "utf8",
        );
        assert.throws(() => loadUserConfig(), /valid tool pattern/i);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }

    console.log("user-capabilities.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
