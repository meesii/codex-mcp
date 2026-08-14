import assert from "node:assert/strict";
import test from "node:test";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { delimiter, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
    connectMcp,
    createCapabilityBundle,
    createProject,
    createTestEnvironment,
    expectToolOk,
    resultText,
    startSingleProjectHarness,
    writeJsonFile,
} from "./harness.js";

const downstreamFixture = join(
    dirname(fileURLToPath(import.meta.url)),
    "fixtures",
    "downstream-contract.mjs",
);

test("capability contract: explicit source priority controls collisions, local overrides win, and imported secrets are not copied", async () => {
    const env = await createTestEnvironment("codex-mcp-capability-contract-");
    const project = await createProject("capability", {
        files: { "identity.txt": "CAPABILITY\n" },
    });
    const binDir = join(env.home, "bin");
    await mkdir(binDir, { recursive: true });
    await installFakeCodex(binDir, downstreamFixture);

    const previousPath = process.env.PATH;
    process.env.PATH = `${binDir}${delimiter}${previousPath ?? ""}`;
    const codexSecret = "codex-secret-value";
    const claudeSecret = "claude-secret-value";
    process.env.CODEX_CONTRACT_SECRET = codexSecret;
    process.env.CLAUDE_CONTRACT_SECRET = claudeSecret;

    await writeJsonFile(join(env.home, ".codex-mcp", "config.json"), {
        capabilities: {
            sync: "startup",
            priority: ["claude", "codex", "agents"],
            sources: {
                agents: { enabled: true, skills: true, mcp: false },
                codex: { enabled: true, skills: true, mcp: true },
                claude: { enabled: true, skills: true, mcp: true },
            },
        },
    });
    await writeJsonFile(join(env.home, ".claude.json"), {
        mcpServers: {
            shared: {
                type: "stdio",
                command: process.execPath,
                args: [downstreamFixture],
                env: {
                    CONTRACT_MARKER: "claude-priority",
                    CLAUDE_SECRET: "${CLAUDE_CONTRACT_SECRET}",
                },
            },
            "claude-only": {
                type: "stdio",
                command: process.execPath,
                args: [downstreamFixture],
                env: { CONTRACT_MARKER: "claude-only" },
            },
        },
    });
    await createCapabilitySkill(join(env.home, ".agents", "skills"), "shared-skill", "AGENTS-SKILL");
    await createCapabilitySkill(join(env.home, ".codex", "skills"), "shared-skill", "CODEX-SKILL");
    await createCapabilitySkill(join(env.home, ".claude", "skills"), "shared-skill", "CLAUDE-SKILL");
    await createCapabilitySkill(join(env.home, ".codex", "skills"), "codex-only-skill", "CODEX-ONLY-SKILL");

    let bundle: Awaited<ReturnType<typeof createCapabilityBundle>> | undefined;
    let server: Awaited<ReturnType<typeof startSingleProjectHarness>> | undefined;
    let mcp: Awaited<ReturnType<typeof connectMcp>> | undefined;
    try {
        bundle = await createCapabilityBundle({ primaryWorkspace: project, home: env.home });
        server = await startSingleProjectHarness({
            root: project,
            hub: bundle.hub,
            skills: bundle.skills,
            capabilities: bundle.capabilities,
        });
        mcp = await connectMcp(server.mcpUrl);

        const servers = expectToolOk<{
            servers?: Array<{ name: string; status: string }>;
            sources?: Array<{
                source: string;
                enabled: boolean;
                mcpCount: number;
                skillCount: number;
                warnings: string[];
            }>;
        }>(await mcp.call("mcp_servers", {}));
        const names = new Set((servers.servers ?? []).map((row) => row.name));
        assert.equal(names.has("shared"), true);
        assert.equal(names.has("claude-only"), true);
        assert.equal(names.has("codex-only"), true);

        const sharedBeforeOverride = await mcp.call("mcp_call", {
            server: "shared",
            tool: "echo",
            arguments: { text: "priority" },
        });
        assert.notEqual(sharedBeforeOverride.isError, true, resultText(sharedBeforeOverride));
        assert.match(resultText(sharedBeforeOverride), /downstream:priority:claude-priority/);

        const skillsBefore = expectToolOk<{
            skills?: Array<{ name: string; source: string }>;
        }>(await mcp.call("skills_list", {}));
        const sharedSkill = skillsBefore.skills?.find((row) => row.name === "shared-skill");
        assert.equal(sharedSkill?.source, "claude", "highest-priority source owns duplicate skill name");
        assert.equal(skillsBefore.skills?.some((row) => row.name === "codex-only-skill"), true);

        // codex-mcp's own mcp.json is the explicit user override layer and must
        // supersede source priority without mutating upstream source files.
        await writeJsonFile(join(env.home, ".codex-mcp", "mcp.json"), {
            mcpServers: {
                shared: {
                    command: process.execPath,
                    args: [downstreamFixture],
                    env: { CONTRACT_MARKER: "local-override" },
                },
                "codex-only": { disabled: true },
            },
        });
        const reload = expectToolOk<{
            mcp?: { changed?: string[]; removed?: string[]; ready?: number };
            skills?: { count?: number };
        }>(await mcp.call("capabilities_reload", {}));
        assert.ok((reload.mcp?.ready ?? 0) >= 2);

        const sharedAfterOverride = await mcp.call("mcp_call", {
            server: "shared",
            tool: "echo",
            arguments: { text: "override" },
        });
        assert.notEqual(sharedAfterOverride.isError, true, resultText(sharedAfterOverride));
        assert.match(resultText(sharedAfterOverride), /downstream:override:local-override/);

        const serversAfter = expectToolOk<{
            servers?: Array<{ name: string }>;
        }>(await mcp.call("mcp_servers", {}));
        const afterNames = new Set((serversAfter.servers ?? []).map((row) => row.name));
        assert.equal(afterNames.has("codex-only"), false);
        assert.equal(afterNames.has("claude-only"), true);
        assert.equal(afterNames.has("shared"), true);

        const configText = await readFile(join(env.home, ".codex-mcp", "config.json"), "utf8");
        const overridesText = await readFile(join(env.home, ".codex-mcp", "mcp.json"), "utf8");
        assert.equal(configText.includes(codexSecret), false);
        assert.equal(configText.includes(claudeSecret), false);
        assert.equal(overridesText.includes(codexSecret), false);
        assert.equal(overridesText.includes(claudeSecret), false);
    } finally {
        await mcp?.close().catch(() => undefined);
        await server?.close().catch(() => undefined);
        await bundle?.hub.close().catch(() => undefined);
        if (previousPath === undefined) delete process.env.PATH;
        else process.env.PATH = previousPath;
        delete process.env.CODEX_CONTRACT_SECRET;
        delete process.env.CLAUDE_CONTRACT_SECRET;
        await env.cleanup();
    }
});

test("capability contract: explicit reload sees new skills even when automatic sync mode is startup", async () => {
    const env = await createTestEnvironment("codex-mcp-capability-reload-contract-");
    const project = await createProject("capability-reload");
    await writeJsonFile(join(env.home, ".codex-mcp", "config.json"), {
        capabilities: {
            sync: "startup",
            priority: ["agents", "codex", "claude"],
            sources: {
                agents: { enabled: true, skills: true, mcp: false },
                codex: { enabled: false, skills: false, mcp: false },
                claude: { enabled: false, skills: false, mcp: false },
            },
        },
    });
    await createCapabilitySkill(join(env.home, ".agents", "skills"), "first-skill", "FIRST-SKILL");
    const bundle = await createCapabilityBundle({ primaryWorkspace: project, home: env.home });
    const server = await startSingleProjectHarness({
        root: project,
        hub: bundle.hub,
        skills: bundle.skills,
        capabilities: bundle.capabilities,
    });
    const mcp = await connectMcp(server.mcpUrl);

    try {
        const before = expectToolOk<{ skills?: Array<{ name: string }> }>(await mcp.call("skills_list", {}));
        assert.equal(before.skills?.some((row) => row.name === "first-skill"), true);
        assert.equal(before.skills?.some((row) => row.name === "second-skill"), false);

        await createCapabilitySkill(join(env.home, ".agents", "skills"), "second-skill", "SECOND-SKILL");
        const stillBeforeReload = expectToolOk<{ skills?: Array<{ name: string }> }>(await mcp.call("skills_list", {}));
        assert.equal(stillBeforeReload.skills?.some((row) => row.name === "second-skill"), false);

        expectToolOk(await mcp.call("capabilities_reload", {}));
        const after = expectToolOk<{ skills?: Array<{ name: string }> }>(await mcp.call("skills_list", {}));
        assert.equal(after.skills?.some((row) => row.name === "second-skill"), true);
    } finally {
        await mcp.close().catch(() => undefined);
        await server.close().catch(() => undefined);
        await bundle.hub.close().catch(() => undefined);
        await env.cleanup();
    }
});

async function installFakeCodex(binDir: string, fixturePath: string): Promise<void> {
    const scriptPath = join(binDir, "fake-codex.mjs");
    const payload = [
        "#!/usr/bin/env node",
        "const args = process.argv.slice(2);",
        "if (args.length === 1 && args[0] === '--version') { console.log('codex-contract 1.0.0'); process.exit(0); }",
        "if (args.join(' ') === 'mcp list --json') {",
        `  console.log(JSON.stringify([`,
        `    { enabled: true, name: 'shared', transport: { type: 'stdio', command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fixturePath)}], env_vars: ['CODEX_CONTRACT_SECRET'], env: { CONTRACT_MARKER: 'codex-priority' } } },`,
        `    { enabled: true, name: 'codex-only', transport: { type: 'stdio', command: ${JSON.stringify(process.execPath)}, args: [${JSON.stringify(fixturePath)}], env: { CONTRACT_MARKER: 'codex-only' } } }`,
        "  ]));",
        "  process.exit(0);",
        "}",
        "console.error('unexpected fake codex args: ' + args.join(' '));",
        "process.exit(2);",
        "",
    ].join("\n");
    await writeFile(scriptPath, payload, "utf8");
    if (process.platform === "win32") {
        await writeFile(join(binDir, "codex.cmd"), `@"${process.execPath}" "${scriptPath}" %*\r\n`, "utf8");
    } else {
        const launcher = join(binDir, "codex");
        await writeFile(launcher, `#!/bin/sh\nexec "${process.execPath}" "${scriptPath}" "$@"\n`, "utf8");
        await chmod(launcher, 0o755);
    }
}

async function createCapabilitySkill(root: string, name: string, marker: string): Promise<void> {
    const directory = join(root, name);
    await mkdir(directory, { recursive: true });
    await writeFile(join(directory, "SKILL.md"), [
        "---",
        `name: ${name}`,
        `description: ${marker}`,
        "---",
        marker,
        "",
    ].join("\n"), "utf8");
}
