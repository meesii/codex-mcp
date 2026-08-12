import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { resolveCapabilitiesConfig } from "../src/capabilities/config.js";
import { CapabilityManager } from "../src/capabilities/manager.js";
import type { CapabilityProvider } from "../src/capabilities/provider.js";
import { loadClaudeMcpConfig } from "../src/capabilities/providers/claude.js";
import { isStdioMcpServer, isUrlMcpServer } from "../src/config/user-mcp.js";

async function writeSkill(
    root: string,
    name: string,
    options: {
        description?: string;
        disableModelInvocation?: boolean;
        contextFork?: boolean;
        allowedTools?: boolean;
        dynamicContext?: boolean;
    } = {},
): Promise<void> {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    await writeFile(
        join(dir, "SKILL.md"),
        [
            "---",
            `name: ${name}`,
            `description: ${options.description ?? name}`,
            ...(options.disableModelInvocation ? ["disable-model-invocation: true"] : []),
            ...(options.contextFork ? ["context: fork", "agent: Explore"] : []),
            ...(options.allowedTools ? ["allowed-tools: Bash(git *)"] : []),
            "---",
            "",
            `# ${name}`,
            ...(options.dynamicContext ? ["", "!`git status --short`"] : []),
            "",
        ].join("\n"),
        "utf8",
    );
}

async function testDefaults(): Promise<void> {
    const legacy = resolveCapabilitiesConfig();
    assert.equal(legacy.sync, "watch");
    assert.deepEqual(legacy.priority, ["agents", "codex", "claude"]);
    assert.deepEqual(legacy.sources.agents, { enabled: true, mcp: false, skills: true });
    assert.deepEqual(legacy.sources.codex, { enabled: true, mcp: true, skills: true });
    assert.equal(legacy.sources.claude.enabled, false);

    const startup = resolveCapabilitiesConfig({
        sync: "startup",
        priority: ["claude"],
        sources: { claude: { enabled: true, mcp: true, skills: false } },
    });
    assert.equal(startup.sync, "startup");
    assert.deepEqual(startup.priority, ["claude", "agents", "codex"]);
    assert.deepEqual(startup.sources.claude, { enabled: true, mcp: true, skills: false });
}

async function testProviderPriorityAndOverrides(home: string): Promise<void> {
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    await mkdir(join(home, ".codex-mcp"), { recursive: true });
    await writeFile(
        join(home, ".codex-mcp", "mcp.json"),
        JSON.stringify({
            mcpServers: {
                shared: { command: "local-override" },
                localOnly: { command: "local-only" },
            },
        }),
        "utf8",
    );

    const provider = (
        id: "codex" | "claude",
        command: string,
    ): CapabilityProvider => ({
        id,
        label: id,
        supportsMcp: true,
        supportsSkills: false,
        async detect() {
            return { source: id, label: id, detected: true, mcp: true, skills: false };
        },
        async loadMcp() {
            return {
                config: {
                    mcpServers: {
                        shared: { command },
                        [`${id}Only`]: { command: `${command}-only` },
                    },
                },
            };
        },
    });

    const manager = new CapabilityManager(home, {
        homeDirectory: home,
        providers: [provider("codex", "codex"), provider("claude", "claude")],
        loadConfig: () => ({
            capabilities: {
                priority: ["codex", "claude", "agents"],
                sources: {
                    agents: { enabled: false },
                    codex: { enabled: true, mcp: true, skills: false },
                    claude: { enabled: true, mcp: true, skills: false },
                },
            },
        }),
    });
    const config = await manager.loadMcpConfig();
    assert.ok(isStdioMcpServer(config.mcpServers.shared!));
    assert.equal(isStdioMcpServer(config.mcpServers.shared!) ? config.mcpServers.shared.command : "", "local-override");
    assert.ok(config.mcpServers.codexOnly);
    assert.ok(config.mcpServers.claudeOnly);
    assert.ok(config.mcpServers.localOnly);
    assert.match(manager.getDiagnostics().find((item) => item.source === "codex")?.warnings.join("\n") ?? "", /overrides.*claude/i);
}

async function testProviderFailureKeepsLastGood(home: string): Promise<void> {
    let fail = false;
    const provider: CapabilityProvider = {
        id: "claude",
        label: "claude",
        supportsMcp: true,
        supportsSkills: false,
        async detect() {
            return { source: "claude", label: "claude", detected: true, mcp: true, skills: false };
        },
        async loadMcp() {
            if (fail) throw new Error("temporary parse failure");
            return { config: { mcpServers: { cached: { command: "cached-good" } } } };
        },
    };
    const manager = new CapabilityManager(home, {
        homeDirectory: home,
        providers: [provider],
        loadConfig: () => ({
            capabilities: {
                priority: ["claude", "agents", "codex"],
                sources: {
                    agents: { enabled: false },
                    codex: { enabled: false },
                    claude: { enabled: true, mcp: true, skills: false },
                },
            },
        }),
    });
    const first = await manager.loadMcpConfig();
    assert.equal(isStdioMcpServer(first.mcpServers.cached!) ? first.mcpServers.cached.command : "", "cached-good");
    fail = true;
    const second = await manager.loadMcpConfig();
    assert.equal(isStdioMcpServer(second.mcpServers.cached!) ? second.mcpServers.cached.command : "", "cached-good");
    assert.match(manager.getDiagnostics().find((item) => item.source === "claude")?.warnings.join("\n") ?? "", /keeping last successful/i);
}

async function testClaudeMcpScopes(home: string): Promise<void> {
    const primary = join(home, "primary");
    const secondary = join(home, "secondary");
    await mkdir(primary, { recursive: true });
    await mkdir(secondary, { recursive: true });
    process.env.CLAUDE_TEST_HEADER = "header-value";

    await writeFile(
        join(home, ".claude.json"),
        JSON.stringify({
            mcpServers: {
                userOnly: { command: "user-only" },
                shared: { command: "user-shared" },
                remote: {
                    type: "http",
                    url: "https://example.com/${CLAUDE_MISSING:-fallback}/mcp",
                    headers: { "X-Test": "${CLAUDE_TEST_HEADER}" },
                },
                oauthSkip: {
                    type: "http",
                    url: "https://example.com/mcp",
                    oauth: {},
                },
            },
            projects: {
                [primary]: {
                    mcpServers: {
                        shared: { command: "primary-local" },
                        localOnly: { command: "primary-local-only" },
                    },
                },
                [secondary]: {
                    mcpServers: {
                        secondaryLocal: { command: "secondary-local" },
                    },
                },
            },
        }),
        "utf8",
    );
    await writeFile(
        join(primary, ".mcp.json"),
        JSON.stringify({
            mcpServers: {
                shared: { command: "primary-project" },
                projectOnly: { command: "primary-project-only" },
            },
        }),
        "utf8",
    );
    await writeFile(
        join(secondary, ".mcp.json"),
        JSON.stringify({
            mcpServers: {
                shared: { command: "secondary-project" },
                secondaryProject: { command: "secondary-project-only" },
            },
        }),
        "utf8",
    );

    const result = loadClaudeMcpConfig({
        homeDirectory: home,
        primaryWorkspace: primary,
        workspaceRoots: [primary, secondary],
    });
    const config = result.config.mcpServers;
    assert.equal(isStdioMcpServer(config.shared!) ? config.shared.command : "", "primary-local");
    assert.equal(isStdioMcpServer(config.projectOnly!) ? config.projectOnly.command : "", "primary-project-only");
    assert.equal(isStdioMcpServer(config.localOnly!) ? config.localOnly.command : "", "primary-local-only");
    assert.equal(isStdioMcpServer(config.userOnly!) ? config.userOnly.command : "", "user-only");

    const remote = config.remote!;
    assert.ok(isUrlMcpServer(remote));
    if (isUrlMcpServer(remote)) {
        assert.equal(remote.headers?.["X-Test"], "header-value");
        assert.match(remote.url, /fallback\/mcp/);
    }

    const secondaryKeys = Object.keys(config).filter((name) => name.includes("secondary-") && name.includes("__"));
    assert.ok(secondaryKeys.some((name) => name.endsWith("__shared")));
    assert.ok(secondaryKeys.some((name) => name.endsWith("__secondaryProject")));
    assert.ok(secondaryKeys.some((name) => name.endsWith("__secondaryLocal")));
    assert.equal(config.secondaryProject, undefined, "secondary project MCP must not leak into the global raw name");
    assert.match(result.warnings?.join("\n") ?? "", /oauthSkip.*Claude-managed OAuth/i);

    // Loading Claude configs is read-only: the provider must not create a codex-mcp copy.
    assert.equal(existsSync(join(home, ".codex-mcp")), false);
    delete process.env.CLAUDE_TEST_HEADER;
}

async function testClaudeSkills(home: string): Promise<void> {
    const primary = join(home, "skill-primary");
    const secondary = join(home, "skill-secondary");
    await mkdir(primary, { recursive: true });
    await mkdir(secondary, { recursive: true });
    await writeSkill(join(home, ".claude", "skills"), "personal", { description: "personal wins" });
    await writeSkill(join(home, ".claude", "skills"), "manual-only", {
        disableModelInvocation: true,
    });
    await writeSkill(join(home, ".claude", "skills"), "fork-only", {
        contextFork: true,
    });
    await writeSkill(join(home, ".claude", "skills"), "restricted-tools", {
        allowedTools: true,
    });
    await writeSkill(join(home, ".claude", "skills"), "dynamic-context", {
        dynamicContext: true,
    });
    await writeSkill(join(primary, ".claude", "skills"), "project-skill");
    await writeSkill(join(primary, ".claude", "skills"), "personal", { description: "project loses" });
    await writeSkill(join(secondary, ".claude", "skills"), "secondary-skill");
    await writeSkill(join(secondary, ".claude", "skills"), "personal", {
        description: "secondary project must stay shadowed by personal",
    });
    await writeSkill(join(secondary, ".claude", "skills"), "manual-only", {
        description: "project duplicate must stay shadowed by user-only personal skill",
    });

    const manager = new CapabilityManager(primary, {
        homeDirectory: home,
        loadConfig: () => ({
            workspaces: [secondary],
            capabilities: {
                priority: ["claude", "agents", "codex"],
                sources: {
                    agents: { enabled: false },
                    codex: { enabled: false },
                    claude: { enabled: true, mcp: false, skills: true },
                },
            },
        }),
    });
    const skills = manager.createSkillRegistry();
    const listed = skills.list();
    assert.ok(listed.some((item) => item.name === "personal" && item.description === "personal wins"));
    assert.ok(listed.some((item) => item.name === "project-skill" && item.workspaceRoot === primary));
    assert.equal(listed.some((item) => item.name === "manual-only"), false);
    assert.equal(listed.some((item) => item.name === "fork-only"), false);
    assert.equal(listed.some((item) => item.name === "restricted-tools"), false);
    assert.equal(listed.some((item) => item.name === "dynamic-context"), false);
    assert.equal(listed.some((item) => item.name.endsWith(":personal")), false);
    assert.equal(listed.some((item) => item.name.endsWith(":manual-only")), false);
    const secondarySkill = listed.find((item) => item.name.endsWith(":secondary-skill"));
    assert.ok(secondarySkill, `expected qualified secondary skill, got ${listed.map((item) => item.name).join(", ")}`);
    assert.equal(secondarySkill?.workspaceRoot, secondary);
    assert.match(skills.buildInstructionsBlock(), /Imported skills/);
    assert.doesNotMatch(skills.buildInstructionsBlock(), /manual-only/);
    assert.match(secondarySkill?.name ?? "", new RegExp(`^${basename(secondary).replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&")}-`));
}

async function main(): Promise<void> {
    await testDefaults();
    const root = await mkdtemp(join(tmpdir(), "codex-mcp-cap-sources-"));
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = root;
    process.env.USERPROFILE = root;
    try {
        await testProviderPriorityAndOverrides(join(root, "priority-home"));
        await testProviderFailureKeepsLastGood(join(root, "failure-home"));
        await testClaudeMcpScopes(join(root, "claude-mcp-home"));
        await testClaudeSkills(join(root, "claude-skill-home"));
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }
    console.log("capability-sources.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
