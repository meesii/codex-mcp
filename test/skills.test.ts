import assert from "node:assert/strict";
import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SkillRegistry } from "../src/skills/registry.js";
import { connectMcpClient, toolText } from "./helpers/mcp-client.js";
import { startTestServer } from "./helpers/start-server.js";

async function writeSkill(root: string, name: string, description: string): Promise<string> {
    const dir = join(root, name);
    await mkdir(join(dir, "references"), { recursive: true });
    await writeFile(
        join(dir, "SKILL.md"),
        `---\nname: ${name}\ndescription: >\n  ${description}\n---\n\n# ${name}\n\nBody.\n`,
        "utf8",
    );
    await writeFile(join(dir, "references", "notes.md"), "reference-ok\n", "utf8");
    return dir;
}

async function main(): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "codex-skills-"));
    const agentsRoot = join(home, ".agents", "skills");
    const codexRoot = join(home, ".codex", "skills");
    await mkdir(agentsRoot, { recursive: true });
    await mkdir(codexRoot, { recursive: true });

    const shared = await writeSkill(agentsRoot, "shared", "agents version wins");
    await writeSkill(agentsRoot, "agents-only", "agents only skill");
    await writeSkill(codexRoot, "codex-only", "codex only skill");
    await writeSkill(join(codexRoot, ".system"), "system-only", "codex system skill");

    if (process.platform !== "win32") {
        await symlink(shared, join(codexRoot, "shared"), "dir");
    } else {
        await writeSkill(codexRoot, "shared", "codex version loses");
    }

    const registry = SkillRegistry.discover([
        { path: agentsRoot, source: "agents" },
        { path: codexRoot, source: "codex" },
    ]);
    const listed = registry.list();
    assert.deepEqual(
        listed.map((skill) => skill.name),
        ["agents-only", "codex-only", "shared", "system-only"],
    );
    assert.equal(listed.find((skill) => skill.name === "shared")?.source, "agents");
    assert.equal(listed.find((skill) => skill.name === "system-only")?.source, "codex");
    assert.match(
        listed.find((skill) => skill.name === "shared")?.description ?? "",
        /agents version wins/,
    );

    const mainSkill = registry.read("shared");
    assert.equal(mainSkill.path, "SKILL.md");
    assert.match(mainSkill.content, /# shared/);
    assert.equal(mainSkill.truncated, false);

    const reference = registry.read("shared", "references/notes.md");
    assert.equal(reference.content, "reference-ok\n");
    assert.throws(() => registry.read("shared", "../secret.txt"), /stay inside/i);
    assert.throws(() => registry.read("missing"), /unknown skill/i);

    const instructions = registry.buildInstructionsBlock();
    assert.match(instructions, /shared — agents version wins/);
    assert.doesNotMatch(instructions, /Body\./);

    const server = await startTestServer({ skills: registry });
    const mcp = await connectMcpClient(server.mcpUrl);
    try {
        const listedResult = await mcp.callTool("skills_list", {});
        assert.notEqual(listedResult.isError, true, toolText(listedResult));
        assert.equal((listedResult.structuredContent as { count?: number }).count, 4);

        const readResult = await mcp.callTool("skill_read", { name: "shared" });
        assert.notEqual(readResult.isError, true, toolText(readResult));
        assert.match(
            (readResult.structuredContent as { content?: string }).content ?? "",
            /# shared/,
        );

        await writeSkill(agentsRoot, "hot-added", "added after MCP initialize");
        const refresh = registry.refresh();
        assert.equal(refresh.count, 5);
        const hotListed = await mcp.callTool("skills_list", {});
        assert.notEqual(hotListed.isError, true, toolText(hotListed));
        assert.equal((hotListed.structuredContent as { count?: number }).count, 5);
        const hotRead = await mcp.callTool("skill_read", { name: "hot-added" });
        assert.notEqual(hotRead.isError, true, toolText(hotRead));
        assert.match(
            (hotRead.structuredContent as { content?: string }).content ?? "",
            /# hot-added/,
        );
    } finally {
        await mcp.close().catch(() => undefined);
        await server.server.close().catch(() => undefined);
    }

    console.log("skills.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
