import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadUserConfig, saveUserConfig } from "../src/config/user-config.js";
import {
    DEFAULT_UI_PREFERENCES,
    UiSettingsStore,
    createMemoryUiSettingsStore,
    isUiEnabledForTool,
    uiPreferencesFromUserConfig,
} from "../src/ui/settings.js";

async function main(): Promise<void> {
    assert.deepEqual(uiPreferencesFromUserConfig({}), {
        tools: false,
        status: true,
    });
    assert.deepEqual(
        uiPreferencesFromUserConfig({ ui: { tools: true, status: false } }),
        { tools: true, status: false },
    );

    const store = createMemoryUiSettingsStore();
    assert.deepEqual(store.get(), DEFAULT_UI_PREFERENCES);
    assert.deepEqual(store.update({ tools: true }), {
        tools: true,
        status: true,
    });
    assert.deepEqual(store.update({ status: false }), {
        tools: true,
        status: false,
    });

    let loadCalls = 0;
    let saved = { tools: false, status: true };
    const cachedStore = new UiSettingsStore({
        load: () => {
            loadCalls += 1;
            return { ...saved };
        },
        save: (preferences) => {
            saved = { ...preferences };
        },
    });
    assert.deepEqual(cachedStore.get(), saved);
    assert.deepEqual(cachedStore.get(), saved);
    assert.equal(loadCalls, 1, "settings should not read config on every stateless request");
    cachedStore.update({ tools: true });
    assert.deepEqual(saved, { tools: true, status: true });
    assert.equal(loadCalls, 1);
    cachedStore.reload();
    assert.equal(loadCalls, 2);

    const defaults = { tools: false, status: true };
    assert.equal(isUiEnabledForTool("read", defaults), false);
    assert.equal(isUiEnabledForTool("bash", defaults), false);
    assert.equal(isUiEnabledForTool("summary", defaults), true);
    assert.equal(isUiEnabledForTool("goal_status", defaults), true);
    assert.equal(isUiEnabledForTool("settings_get", { tools: false, status: false }), true);
    assert.equal(isUiEnabledForTool("settings_update", { tools: false, status: false }), true);

    // Real user-config persistence: nested UI settings merge without disturbing
    // other machine settings, and malformed values fail clearly.
    const home = await mkdtemp(join(tmpdir(), "codex-mcp-ui-config-"));
    await mkdir(join(home, ".codex-mcp"), { recursive: true });
    const previousHome = process.env.HOME;
    const previousUserProfile = process.env.USERPROFILE;
    process.env.HOME = home;
    process.env.USERPROFILE = home;
    try {
        saveUserConfig({ host: "127.0.0.1", port: 8787, ui: { tools: true, status: false } });
        assert.deepEqual(loadUserConfig().ui, { tools: true, status: false });

        saveUserConfig({ ui: { tools: false } });
        const merged = loadUserConfig();
        assert.equal(merged.host, "127.0.0.1");
        assert.equal(merged.port, 8787);
        assert.deepEqual(merged.ui, { tools: false, status: false });

        const configPath = join(home, ".codex-mcp", "config.json");
        const onDisk = JSON.parse(await readFile(configPath, "utf8")) as {
            ui?: { tools?: boolean; status?: boolean };
        };
        assert.deepEqual(onDisk.ui, { tools: false, status: false });

        await writeFile(
            configPath,
            JSON.stringify({ ui: { tools: "yes", status: true } }),
            "utf8",
        );
        assert.throws(() => loadUserConfig(), /ui\.tools must be a boolean/i);
    } finally {
        if (previousHome === undefined) delete process.env.HOME;
        else process.env.HOME = previousHome;
        if (previousUserProfile === undefined) delete process.env.USERPROFILE;
        else process.env.USERPROFILE = previousUserProfile;
    }

    console.log("ui-settings.test.ts: ok");
}

void main().catch((error) => {
    console.error(error);
    process.exit(1);
});
