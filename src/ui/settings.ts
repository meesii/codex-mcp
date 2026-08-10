import {
    loadUserConfig,
    saveUserConfig,
    type UserConfig,
} from "../user-config.js";

export interface UiPreferences {
    /** Render custom cards for ordinary coding tools such as read/edit/bash. */
    tools: boolean;
    /** Render custom cards for status/progress tools such as summary and goal_*. */
    status: boolean;
}

export type UiPreferencesPatch = Partial<UiPreferences>;

export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({
    tools: false,
    status: true,
});

export interface UiSettingsPersistence {
    load: () => UiPreferences;
    save: (preferences: UiPreferences) => void;
}

/**
 * Resolve effective UI preferences from persisted user config.
 * Missing fields deliberately fall back to conservative defaults: ordinary
 * tool cards are hidden while status/progress cards remain visible.
 */
export function uiPreferencesFromUserConfig(config: UserConfig): UiPreferences {
    return {
        tools: config.ui?.tools ?? DEFAULT_UI_PREFERENCES.tools,
        status: config.ui?.status ?? DEFAULT_UI_PREFERENCES.status,
    };
}

function userConfigPersistence(): UiSettingsPersistence {
    return {
        load: () => uiPreferencesFromUserConfig(loadUserConfig()),
        save: (preferences) => {
            saveUserConfig({ ui: preferences });
        },
    };
}

/** Durable UI preference store. Production uses ~/.codex-mcp/config.json. */
export class UiSettingsStore {
    readonly persistence: UiSettingsPersistence;
    private current: UiPreferences | undefined;

    constructor(persistence: UiSettingsPersistence = userConfigPersistence()) {
        this.persistence = persistence;
    }

    get(): UiPreferences {
        if (!this.current) {
            this.current = { ...this.persistence.load() };
        }
        return { ...this.current };
    }

    update(patch: UiPreferencesPatch): UiPreferences {
        const current = this.get();
        const next: UiPreferences = {
            tools: patch.tools ?? current.tools,
            status: patch.status ?? current.status,
        };
        this.persistence.save(next);
        this.current = { ...next };
        return { ...next };
    }

    /** Re-read persistence when an embedding runtime knows config changed externally. */
    reload(): UiPreferences {
        this.current = { ...this.persistence.load() };
        return { ...this.current };
    }
}

/** Build an isolated in-memory store for tests/embedded runtimes. */
export function createMemoryUiSettingsStore(
    initial: UiPreferences = { ...DEFAULT_UI_PREFERENCES },
): UiSettingsStore {
    let current: UiPreferences = { ...initial };
    return new UiSettingsStore({
        load: () => ({ ...current }),
        save: (preferences) => {
            current = { ...preferences };
        },
    });
}

/** Settings UI is the control plane and remains reachable even if status UI is off. */
export function isSettingsUiTool(toolName: string): boolean {
    return toolName === "settings_get" || toolName === "settings_update";
}

export function isStatusUiTool(toolName: string): boolean {
    return toolName === "summary" || toolName.startsWith("goal_");
}

export function isUiEnabledForTool(
    toolName: string,
    preferences: UiPreferences,
): boolean {
    if (isSettingsUiTool(toolName)) return true;
    if (isStatusUiTool(toolName)) return preferences.status;
    return preferences.tools;
}
