import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { htmlToMarkdown } from "../lib/html-to-markdown.js";
import { registerTool } from "../lib/tool-log.js";
import { openWorldAnnotations, withNoAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/**
 * Fetch a URL and return text in the requested format.
 *
 * @param url - http(s) URL
 * @param format - Response formatting mode
 * @param timeoutMs - Request timeout
 * @returns Formatted body text
 */
export async function fetchUrlContent(
    url: string,
    format: "text" | "markdown" | "html",
    timeoutMs: number,
): Promise<string> {
    if (!url.startsWith("http://") && !url.startsWith("https://")) {
        throw new Error("URL must start with http:// or https://");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            signal: controller.signal,
            headers: {
                "User-Agent":
                    "Mozilla/5.0 (compatible; codex-mcp/0.1; +https://localhost)",
                Accept:
                    format === "html"
                        ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
                        : format === "text"
                          ? "text/plain,text/markdown;q=0.9,text/html;q=0.8,*/*;q=0.1"
                          : "text/markdown,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.1",
            },
            redirect: "follow",
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (buffer.byteLength > MAX_BYTES) {
            throw new Error(`Response exceeds ${MAX_BYTES} bytes`);
        }

        const body = buffer.toString("utf8");
        const contentType = response.headers.get("content-type") ?? "";

        if (format === "html") {
            return body;
        }
        if (format === "text") {
            if (contentType.includes("text/html")) {
                return htmlToMarkdown(body).replace(/[#*_`>\[\]()]/g, "");
            }
            return body;
        }

        if (contentType.includes("text/html") || /<html[\s>]/i.test(body)) {
            return htmlToMarkdown(body);
        }
        return body;
    } finally {
        clearTimeout(timer);
    }
}

/**
 * Register the `webfetch` tool.
 *
 * @param server - MCP server instance
 */
export function registerWebfetchTool(server: McpServer): void {
    registerTool(server, 
        "webfetch",
        withNoAuth({
            title: "Fetch URL",
            description:
                "Fetch an http(s) URL and return the body as text, markdown, or html. Body text is in structuredContent.body.",
            inputSchema: {
                url: z.string().describe("http or https URL to fetch."),
                format: z
                    .enum(["text", "markdown", "html"])
                    .optional()
                    .describe("Output format (default markdown)."),
                timeout: z
                    .number()
                    .positive()
                    .optional()
                    .describe("Timeout in seconds (max 120)."),
            },
            outputSchema: {
                url: z.string(),
                format: z.enum(["text", "markdown", "html"]),
                bytes: z.number().int(),
                body: z.string(),
            },
            annotations: openWorldAnnotations,
        }),
        async ({ url, format, timeout }) => {
            try {
                const resolvedFormat = format ?? "markdown";
                const timeoutMs = Math.min(
                    (timeout ?? DEFAULT_TIMEOUT_MS / 1000) * 1000,
                    MAX_TIMEOUT_MS,
                );
                const body = truncateText(
                    await fetchUrlContent(url, resolvedFormat, timeoutMs),
                );
                return okResult(`Fetched ${url} (${body.length} chars, ${resolvedFormat}).`, {
                    url,
                    format: resolvedFormat,
                    bytes: Buffer.byteLength(body, "utf8"),
                    body,
                });
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                return errorResult(message);
            }
        },
    );
}
