import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { UiCard } from "../ui/ui-card.js";

/**
 * Build a successful tool result per OpenAI MCP guidance:
 * - `content`: short text that helps the model answer the user
 * - `structuredContent`: structured data matching the tool `outputSchema`
 * - `_meta.uiCard`: compact summary for the ChatGPT iframe (never full bodies)
 *
 * @see https://developers.openai.com/plugins/build/mcp-server
 * @param text - Text content for the model
 * @param structuredContent - Structured payload (must match outputSchema)
 * @param uiCard - Optional compact UI card (normally attached by registerTool)
 * @returns MCP tool result
 */
export function okResult(
    text: string,
    structuredContent: Record<string, unknown>,
    uiCard?: UiCard,
): CallToolResult {
    return {
        content: [{ type: "text", text }],
        structuredContent,
        ...(uiCard
            ? {
                  _meta: {
                      uiCard,
                  },
              }
            : {}),
    };
}

/**
 * Build an error tool result (`isError` + text content).
 *
 * @param message - Error message shown to the model
 * @param uiCard - Optional compact UI card
 * @returns MCP tool result marked as error
 */
export function errorResult(message: string, uiCard?: UiCard): CallToolResult {
    return {
        isError: true,
        content: [{ type: "text", text: message }],
        ...(uiCard
            ? {
                  _meta: {
                      uiCard,
                  },
              }
            : {}),
    };
}

/**
 * Extract concatenated text from a tool result content array.
 *
 * @param result - Tool call result
 * @returns Joined text parts
 */
export function resultText(result: CallToolResult): string {
    return result.content
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
