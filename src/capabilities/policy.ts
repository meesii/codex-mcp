import { TOOL_NAMES } from "../tools/names.js";
import { loadUserConfig, type ClientCapabilitiesConfig } from "../config/user-config.js";

export const LOCAL_CAPABILITY_CLIENT_ID = "local:noauth";

export function resolveAllowedTools(clientId?: string): ReadonlySet<string> {
    const config = loadUserConfig().clientCapabilities;
    return resolveAllowedToolsFromConfig(
        config,
        clientId?.trim() || LOCAL_CAPABILITY_CLIENT_ID,
    );
}

export function resolveAllowedToolsFromConfig(
    config: ClientCapabilitiesConfig | undefined,
    clientId: string,
    toolNames: readonly string[] = TOOL_NAMES,
): ReadonlySet<string> {
    const patterns =
        config?.clients && Object.prototype.hasOwnProperty.call(config.clients, clientId)
            ? config.clients[clientId]!
            : (config?.default ?? ["*"]);

    return new Set(
        toolNames.filter((toolName) => patterns.some((pattern) => matchesPattern(toolName, pattern))),
    );
}

function matchesPattern(toolName: string, pattern: string): boolean {
    if (pattern === "*") return true;
    if (pattern.endsWith("*")) return toolName.startsWith(pattern.slice(0, -1));
    return toolName === pattern;
}
