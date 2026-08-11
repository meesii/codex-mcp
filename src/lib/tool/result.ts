import type { CallToolResult } from "@modelcontextprotocol/server";

export function okResult(
    text: string,
    structuredContent: Record<string, unknown>,
): CallToolResult {
    return {
        content: [{ type: "text", text }],
        structuredContent,
    };
}

export function errorResult(message: string): CallToolResult {
    return {
        isError: true,
        content: [{ type: "text", text: message }],
    };
}

export function resultText(result: CallToolResult): string {
    const parts = result.content ?? [];
    return parts
        .filter((part): part is { type: "text"; text: string } => part.type === "text")
        .map((part) => part.text)
        .join("\n");
}
