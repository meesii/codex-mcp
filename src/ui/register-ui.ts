import { McpServer } from "@modelcontextprotocol/server";
import type { ServerConfig } from "../config/loader.js";
import {
    TOOL_CARD_MIME,
    TOOL_CARD_URI,
    SUMMARY_CARD_URI,
} from "./constants.js";
import { toolCardHtml } from "./tool-card-html.js";
import { summaryCardHtml } from "./summary-card-html.js";
import { toolStatus } from "./tool-labels.js";
import {
    DEFAULT_UI_PREFERENCES,
    isUiEnabledForTool,
    type UiPreferences,
} from "./preferences.js";

const SHARED_TOOL_CARD_HTML = toolCardHtml();
const SUMMARY_CARD_HTML = summaryCardHtml();
const serverUiPreferences = new WeakMap<object, UiPreferences>();

export function configureServerUiPreferences(
    server: object,
    preferences: UiPreferences,
): void {
    serverUiPreferences.set(server, { ...preferences });
}

function uiPreferencesForServer(server: object): UiPreferences {
    return serverUiPreferences.get(server) ?? { ...DEFAULT_UI_PREFERENCES };
}

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

export function registerToolCardResource(server: McpServer, config: ServerConfig): void {
    const resourceMeta = toolCardResourceMeta(config);
    const summaryMeta = summaryCardResourceMeta(config);

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
                "Compact tool result card with full commands and summarized results.",
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

}

export function toolUiMeta(server: object, toolName: string): Record<string, unknown> {
    const status = toolStatus(toolName);
    const preferences = uiPreferencesForServer(server);
    const templateUri = toolName === "summary"
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
