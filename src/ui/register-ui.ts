import { McpServer, ResourceTemplate } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config.js";
import { TOOL_NAMES, type ToolName } from "../tools/names.js";
import {
    TOOL_CARD_LEGACY_TEMPLATE,
    TOOL_CARD_MIME,
    TOOL_CARD_URI,
    SUMMARY_CARD_URI,
    SETTINGS_CARD_URI,
} from "./constants.js";
import { toolCardHtml } from "./tool-card-html.js";
import { summaryCardHtml } from "./summary-card-html.js";
import { settingsCardHtml } from "./settings-card-html.js";
import { toolStatus } from "./tool-labels.js";
import {
    DEFAULT_UI_PREFERENCES,
    isSettingsUiTool,
    isUiEnabledForTool,
    type UiPreferences,
} from "./settings.js";

const SHARED_TOOL_CARD_HTML = toolCardHtml();
const SUMMARY_CARD_HTML = summaryCardHtml();
const SETTINGS_CARD_HTML = settingsCardHtml();
const legacyToolCardHtmlCache = new Map<ToolName | undefined, string>();
const serverUiPreferences = new WeakMap<object, UiPreferences>();

/** Snapshot ChatGPT-facing UI preferences for one concrete MCP server instance. */
export function configureServerUiPreferences(
    server: object,
    preferences: UiPreferences,
): void {
    serverUiPreferences.set(server, { ...preferences });
}

function uiPreferencesForServer(server: object): UiPreferences {
    return serverUiPreferences.get(server) ?? { ...DEFAULT_UI_PREFERENCES };
}

/**
 * Build ChatGPT / MCP Apps resource `_meta` including CSP + unique domain.
 *
 * @param config - Server config (widgetDomain)
 * @returns Resource contents `_meta`
 * @see https://developers.openai.com/apps-sdk/reference
 */
export function toolCardResourceMeta(config: ServerConfig): Record<string, unknown> {
    // Self-contained HTML: no external fetch/assets. Empty allow-lists are valid.
    const csp = {
        connectDomains: [] as string[],
        resourceDomains: [] as string[],
    };

    return {
        ui: {
            // false: don't ask ChatGPT to wrap another bordered card (avoids double chrome).
            prefersBorder: false,
            domain: config.widgetDomain,
            csp,
        },
        // ChatGPT compatibility aliases (snake_case CSP + widgetDomain).
        "openai/widgetDomain": config.widgetDomain,
        "openai/widgetCSP": {
            connect_domains: csp.connectDomains,
            resource_domains: csp.resourceDomains,
        },
        "openai/widgetPrefersBorder": false,
        "openai/widgetDescription":
            "Compact coding tool status card (summary only; never full payloads).",
    };
}

/**
 * Resource `_meta` for the always-open summary progress panel.
 *
 * @param config - Server config (widgetDomain)
 * @returns Resource contents `_meta`
 */
export function summaryCardResourceMeta(config: ServerConfig): Record<string, unknown> {
    const base = toolCardResourceMeta(config);
    return {
        ...base,
        "openai/widgetDescription":
            "Always-open progress report panel for the summary tool.",
        ui: {
            ...((base.ui as Record<string, unknown> | undefined) ?? {}),
            prefersBorder: false,
            domain: config.widgetDomain,
        },
    };
}

/** Resource metadata for the interactive settings control plane. */
export function settingsCardResourceMeta(config: ServerConfig): Record<string, unknown> {
    const base = toolCardResourceMeta(config);
    return {
        ...base,
        "openai/widgetDescription":
            "Interactive local settings panel for codex-mcp custom UI visibility.",
        ui: {
            ...((base.ui as Record<string, unknown> | undefined) ?? {}),
            prefersBorder: false,
            domain: config.widgetDomain,
        },
    };
}

/**
 * Parse a tool name from a legacy per-tool card path segment.
 *
 * @param pathName - e.g. `write_stdin@v7.html` / `read-v8.html`
 * @returns Tool name when recognized
 */
export function toolNameFromCardPath(pathName: string): ToolName | undefined {
    const base = pathName.replace(/\.html$/i, "");
    const withoutVersion = base.replace(/[@-]v\d+$/i, "");
    if ((TOOL_NAMES as readonly string[]).includes(withoutVersion)) {
        return withoutVersion as ToolName;
    }
    return undefined;
}

function cachedLegacyToolCardHtml(toolName: ToolName | undefined): string {
    const cached = legacyToolCardHtmlCache.get(toolName);
    if (cached !== undefined) return cached;
    const html = toolCardHtml(toolName);
    legacyToolCardHtmlCache.set(toolName, html);
    return html;
}

/**
 * Register the shared tool-card UI resource, plus a legacy template so old
 * ChatGPT-cached `ui://codex-mcp/tool-card/*@vN.html` pointers still fetch.
 *
 * @param server - MCP server instance
 * @param config - Server config for widget domain / CSP
 */
export function registerToolCardResource(server: McpServer, config: ServerConfig): void {
    const resourceMeta = toolCardResourceMeta(config);
    const summaryMeta = summaryCardResourceMeta(config);
    const settingsMeta = settingsCardResourceMeta(config);

    const readFixed = async (uri: { href: string }) => ({
        contents: [
            {
                uri: uri.href,
                mimeType: TOOL_CARD_MIME,
                text: SHARED_TOOL_CARD_HTML,
                _meta: resourceMeta,
            },
        ],
    });

    server.registerResource(
        "tool-card",
        TOOL_CARD_URI,
        {
            description:
                "Compact tool result card (summary only; never full file/command bodies).",
            mimeType: TOOL_CARD_MIME,
            _meta: resourceMeta,
        },
        async (uri) => readFixed(uri),
    );

    server.registerResource(
        "summary-card",
        SUMMARY_CARD_URI,
        {
            description:
                "Always-open progress report panel for the summary tool.",
            mimeType: TOOL_CARD_MIME,
            _meta: summaryMeta,
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    mimeType: TOOL_CARD_MIME,
                    text: SUMMARY_CARD_HTML,
                    _meta: summaryMeta,
                },
            ],
        }),
    );

    server.registerResource(
        "settings-card",
        SETTINGS_CARD_URI,
        {
            description:
                "Interactive codex-mcp settings panel for custom UI visibility.",
            mimeType: TOOL_CARD_MIME,
            _meta: settingsMeta,
        },
        async (uri) => ({
            contents: [
                {
                    uri: uri.href,
                    mimeType: TOOL_CARD_MIME,
                    text: SETTINGS_CARD_HTML,
                    _meta: settingsMeta,
                },
            ],
        }),
    );

    // Compatibility for connectors that still request the old per-tool URIs.
    server.registerResource(
        "tool-card-legacy",
        new ResourceTemplate(TOOL_CARD_LEGACY_TEMPLATE, { list: undefined }),
        {
            description:
                "Legacy alias for the shared tool card (old per-tool URI cache).",
            mimeType: TOOL_CARD_MIME,
            _meta: resourceMeta,
        },
        async (uri, variables) => {
            const pathName = String(variables.name ?? "");
            const toolName = toolNameFromCardPath(pathName);
            return {
                contents: [
                    {
                        uri: uri.href,
                        mimeType: TOOL_CARD_MIME,
                        text: cachedLegacyToolCardHtml(toolName),
                        _meta: resourceMeta,
                    },
                ],
            };
        },
    );
}

/**
 * Tool descriptor `_meta` that links a tool to its UI card template.
 *
 * @param toolName - Machine tool name (for per-tool host status text)
 * @returns Meta object for registerTool config
 * @see https://developers.openai.com/plugins/reference
 */
export function toolUiMeta(server: object, toolName: string): Record<string, unknown> {
    const status = toolStatus(toolName);
    const preferences = uiPreferencesForServer(server);
    const templateUri = isSettingsUiTool(toolName)
        ? SETTINGS_CARD_URI
        : toolName === "summary"
          ? SUMMARY_CARD_URI
          : TOOL_CARD_URI;
    const uiEnabled = isUiEnabledForTool(toolName, preferences);
    return {
        ...(uiEnabled
            ? {
                  ui: {
                      resourceUri: templateUri,
                  },
                  "openai/outputTemplate": templateUri,
              }
            : {}),
        // Host status row (≤64 chars). ChatGPT normally shows this chrome with outputTemplate.
        "openai/toolInvocation/invoking": status.invoking,
        "openai/toolInvocation/invoked": status.invoked,
    };
}
