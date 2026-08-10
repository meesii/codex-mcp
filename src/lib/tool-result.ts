import type { CallToolResult } from "@modelcontextprotocol/server";

/**
 * Build a successful tool result per OpenAI MCP guidance:
 * - `content`: short text for the model
 * - `structuredContent`: JSON matching the tool `outputSchema`
 *
 * @see https://developers.openai.com/plugins/build/mcp-server
 * @param text - Text content for the model
 * @param structuredContent - Structured payload (must match outputSchema)
 * @returns MCP tool result
 */
export function okResult(
    text: string,
    structuredContent: Record<string, unknown>,
): CallToolResult {
    return {
        content: [{ type: "text", text }],
        structuredContent,
    };
}

/**
 * Build an error tool result (`isError` + text content).
 *
 * @param message - Error message shown to the model
 * @returns MCP tool result marked as error
 */
export function errorResult(message: string): CallToolResult {
    return {
        isError: true,
        content: [{ type: "text", text: message }],
    };
}

/**
 * Extract concatenated text from a tool result content array.
 *
 * @param result - Tool call result
 * @returns Joined text parts
 */
export function resultText(result: CallToolResult): string {
    const parts = result.content ?? [];
    return parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
