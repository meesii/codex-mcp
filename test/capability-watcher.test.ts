import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodexCapabilityWatcher } from "../src/capabilities/runtime.js";
import { DownstreamMcpHub } from "../src/downstream/hub.js";
import { SkillRegistry } from "../src/skills/registry.js";

async function main(): Promise<void> {
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-watch-home-"));
    const skillRoot = join(home, ".agents", "skills");
    // Intentionally leave the skill root absent when the watcher starts. It
    // must observe creation through the nearest existing ancestor, refresh the
    // registry, then promote itself to a recursive watcher on the new root.
    await mkdir(join(home, ".codex"), { recursive: true });
    await mkdir(join(home, ".codex-mcp"), { recursive: true });

    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;

    const hub = DownstreamMcpHub.empty();
    const skills = SkillRegistry.discover([{ path: skillRoot, source: "agents" }]);
    const errors: unknown[] = [];
    const watcher = new CodexCapabilityWatcher(hub, skills, (error) => errors.push(error), home);
    watcher.start();

    try {
        assert.equal(skills.list().length, 0);
        const skillDir = join(skillRoot, "hot-watch");
        await mkdir(skillDir, { recursive: true });
        await writeFile(
            join(skillDir, "SKILL.md"),
            "---\nname: hot-watch\ndescription: watcher smoke\n---\n\n# Hot Watch\n",
            "utf8",
        );

        const deadline = Date.now() + 6_000;
        while (!skills.list().some((skill) => skill.name === "hot-watch") && Date.now() < deadline) {
            await new Promise((resolve) => setTimeout(resolve, 100));
        }
        assert.ok(
            skills.list().some((skill) => skill.name === "hot-watch"),
            "watcher should discover a skill root created after startup and refresh in place",
        );
        assert.deepEqual(errors, []);
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
