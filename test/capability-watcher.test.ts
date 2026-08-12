import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CapabilityManager } from "../src/capabilities/manager.js";
import { CapabilityWatcher, reloadCapabilities } from "../src/capabilities/runtime.js";
import { DownstreamMcpHub } from "../src/downstream/hub.js";
import type { UserConfig } from "../src/config/user-config.js";

function capabilityConfig(sync: "watch" | "startup"): UserConfig {
    return {
        capabilities: {
            sync,
            priority: ["agents", "codex", "claude"],
            sources: {
                agents: { enabled: true, mcp: false, skills: true },
                codex: { enabled: false, mcp: false, skills: false },
                claude: { enabled: false, mcp: false, skills: false },
            },
        },
    };
}

async function writeSkill(skillRoot: string, name: string): Promise<void> {
    const skillDir = join(skillRoot, name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(
        join(skillDir, "SKILL.md"),
        `---\nname: ${name}\ndescription: watcher smoke\n---\n\n# ${name}\n`,
        "utf8",
    );
}

async function main(): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-watch-home-"));
    const skillRoot = join(home, ".agents", "skills");
    await mkdir(join(home, ".codex-mcp"), { recursive: true });

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const hub = DownstreamMcpHub.empty();
    const errors: unknown[] = [];
    const manager = new CapabilityManager(home, {
        homeDirectory: home,
        loadConfig: () => capabilityConfig("watch"),
    });
    const skills = manager.createSkillRegistry();
    const watcher = new CapabilityWatcher(manager, hub, skills, (error: unknown) => errors.push(error));
    watcher.start();

    try {
        assert.equal(skills.list().length, 0);
        await writeSkill(skillRoot, "hot-watch");

        const deadline = Date.now() + 6_000;
        while (!skills.list().some((skill) => skill.name === "hot-watch") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(
            skills.list().some((skill) => skill.name === "hot-watch"),
            "watch mode should discover a skill root created after startup and refresh in place",
        );
        assert.equal(errors.length, 0);

        const startupManager = new CapabilityManager(home, {
            homeDirectory: home,
            loadConfig: () => capabilityConfig("startup"),
        });
        const startupSkills = startupManager.createSkillRegistry();
        const startupWatcher = new CapabilityWatcher(startupManager, hub, startupSkills, (error: unknown) => errors.push(error));
        startupWatcher.start();
        try {
            await writeSkill(skillRoot, "startup-only");
            await new Promise((resolve) => setTimeout(resolve, 900));
            assert.equal(
                startupSkills.list().some((skill) => skill.name === "startup-only"),
                false,
                "startup sync mode must not install file watchers",
            );
            await reloadCapabilities(startupManager, hub, startupSkills);
            assert.equal(
                startupSkills.list().some((skill) => skill.name === "startup-only"),
                true,
                "explicit reload should still work in startup mode",
            );
        } finally {
            startupWatcher.close();
        }
    } finally {
        watcher.close();
        await hub.close().catch(() => undefined);
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }

    console.log("capability-watcher.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
