import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AgentInstructionRegistry } from "../src/agents/registry.js";
import { ProjectContext } from "../src/config/project.js";
import { resolveWidgetDomain, type ServerConfig } from "../src/config/loader.js";
import { createHttpServer } from "../src/server/http-server.js";
import { isPathRelationshipInside } from "../src/lib/fs/path-guard.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";

async function main(): Promise<void> {
    assert.equal(isPathRelationshipInside("D:\\outside"), false);
    assert.equal(isPathRelationshipInside("..\\outside"), false);
    assert.equal(isPathRelationshipInside("nested\\deeper"), true);

    const home = await mkdtemp(join(tmpdir(), "codex-mcp-agents-home-"));
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "AGENTS.md"), "GLOBAL-RULE\n", "utf8");

    const projectRoot = await mkdtemp(join(tmpdir(), "codex-mcp-agents-project-"));
    await mkdir(join(projectRoot, "nested", "deeper"), { recursive: true });
    await writeFile(join(projectRoot, "AGENTS.md"), "ROOT-RULE\n", "utf8");
    await writeFile(join(projectRoot, "nested", "AGENTS.md"), "NESTED-RULE\n", "utf8");
    await writeFile(join(projectRoot, "nested", "deeper", "file.ts"), "export {};\n", "utf8");

    const project = new ProjectContext(projectRoot);
    const agents = new AgentInstructionRegistry(project, home);
    const scoped = agents.forPath("nested/deeper/file.ts");
    assert.deepEqual(
        scoped.map((file) => file.path),
        ["~/.codex/AGENTS.md", "AGENTS.md", "nested/AGENTS.md"],
    );
    assert.match(scoped.map((file) => file.content).join("\n"), /GLOBAL-RULE/);
    assert.match(scoped.map((file) => file.content).join("\n"), /ROOT-RULE/);
    assert.match(scoped.map((file) => file.content).join("\n"), /NESTED-RULE/);

    const initializeBlock = agents.buildInstructionsBlock();
    assert.match(initializeBlock, /GLOBAL-RULE/);
    assert.match(initializeBlock, /ROOT-RULE/);
    assert.doesNotMatch(initializeBlock, /NESTED-RULE/);
    assert.throws(() => agents.forPath("../outside"), /outside registered workspaces/i);

    const host = "127.0.0.1";
    const allowedHosts: string[] = [];
    const config: ServerConfig = {
        host,
        port: 0,
        local: true,
        oauthRequired: false,
        projectRoot,
        allowedHosts,
        widgetDomain: resolveWidgetDomain(allowedHosts, host, 0),
    };
    const server = createHttpServer(config, { agents });
    await server.listen();
    const mcp = await connectMcpClient(server.getMcpUrl());
    try {
        const result = await mcp.callTool("agents_for_path", {
            path: "nested/deeper/file.ts",
        });
        assert.notEqual(result.isError, true, toolText(result));
        assert.match(JSON.stringify(result.structuredContent), /NESTED-RULE/);
    } finally {
        await mcp.close();
        await server.close();
    }

    console.log("agents.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
