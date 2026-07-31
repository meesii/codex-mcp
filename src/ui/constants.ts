/**
 * When true, tools link the MCP Apps UI template (`outputTemplate`).
 * ChatGPT only shows the per-tool host status row (正在读取文件… / 文件读取完成)
 * when a template is linked — disabling this also drops that chrome.
 */
export const TOOL_CARD_ENABLED = true;

/** Stable shared MCP Apps UI resource URI (all tools). */
export const TOOL_CARD_URI = "ui://codex-mcp/tool-card.html";

/**
 * Legacy URI prefix from the short-lived per-tool card experiment.
 * Kept as a ResourceTemplate so ChatGPT cached template pointers still resolve.
 */
export const TOOL_CARD_LEGACY_TEMPLATE = "ui://codex-mcp/tool-card/{name}";

/** MCP Apps UI MIME type (ChatGPT iframe template). */
export const TOOL_CARD_MIME = "text/html;profile=mcp-app";

/** Max characters allowed in the UI title / outcome line. */
export const UI_PREVIEW_MAX_CHARS = 120;
