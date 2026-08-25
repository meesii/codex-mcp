import type { UserConfig } from "../config/user-config.js";

export interface UiPreferences {
    /** Render custom cards for ordinary coding tools such as read/apply_patch/exec_command. */
    tools: boolean;
    /** Render the summary status card. */
    status: boolean;
}

export const DEFAULT_UI_PREFERENCES: Readonly<UiPreferences> = Object.freeze({
    tools: false,
    status: true,
});

export function uiPreferencesFromUserConfig(config: UserConfig): UiPreferences {
    return {
        tools: config.ui?.tools ?? DEFAULT_UI_PREFERENCES.tools,
        status: config.ui?.status ?? DEFAULT_UI_PREFERENCES.status,
    };
}

export function isStatusUiTool(toolName: string): boolean {
    return toolName === "summary";
}

export function isUiEnabledForTool(
    toolName: string,
    preferences: UiPreferences,
): boolean {
    if (isStatusUiTool(toolName)) return preferences.status;
    return preferences.tools;
}
