/** Stable shared MCP Apps UI resource URI for tool/goal cards. */
export const TOOL_CARD_URI = "ui://codex-mcp/tool-card.html";

/** Always-open progress panel for the `summary` tool. */
export const SUMMARY_CARD_URI = "ui://codex-mcp/summary-card.html";

/** Interactive ChatGPT-facing settings panel. */
export const SETTINGS_CARD_URI = "ui://codex-mcp/settings-card.html";

/**
 * Legacy URI prefix from the short-lived per-tool card experiment.
 * Kept as a ResourceTemplate so ChatGPT cached template pointers still resolve.
 */
export const TOOL_CARD_LEGACY_TEMPLATE = "ui://codex-mcp/tool-card/{name}";

/** MCP Apps UI MIME type (ChatGPT iframe template). */
export const TOOL_CARD_MIME = "text/html;profile=mcp-app";

/** Max characters allowed in the UI title / outcome line. */
export const UI_PREVIEW_MAX_CHARS = 120;
