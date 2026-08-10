import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/server";
import { htmlToMarkdown } from "../lib/html-to-markdown.js";
import { safeHttpGet } from "../lib/safe-http.js";
import { registerTool } from "../lib/tool-log.js";
import { openWorldAnnotations, withToolAuth } from "../lib/tool-meta.js";
import { errorResult, okResult } from "../lib/tool-result.js";
import { truncateText } from "../lib/truncate.js";

const MAX_BYTES = 5 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 120_000;

/** Fetch a public HTTP(S) URL with streaming byte and SSRF protection. */
export async function fetchUrlContent(
    url: string,
    format: "text" | "markdown" | "html",
    timeoutMs: number,
): Promise<string> {
    const response = await safeHttpGet(url, {
        maxBytes: MAX_BYTES,
        timeoutMs,
        maxRedirects: 5,
        headers: {
            Accept:
                format === "html"
                    ? "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8"
                    : format === "text"
                      ? "text/plain,text/markdown;q=0.9,text/html;q=0.8,*/*;q=0.1"
                      : "text/markdown,text/html;q=0.9,text/plain;q=0.8,*/*;q=0.1",
        },
    });

    if (response.status < 200 || response.status >= 300) {
        throw new Error(`HTTP ${response.status} ${response.statusText}`.trim());
    }

    const body = response.body.toString("utf8");
    const contentType = response.headers["content-type"] ?? "";
    if (format === "html") return body;
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
}

/** Register the `webfetch` tool. */
export function registerWebfetchTool(server: McpServer): void {
    registerTool(
        server,
        "webfetch",
        withToolAuth({
            title: "Fetch URL",
            description:
                "Fetch a public http(s) URL and return text, markdown, or html. Private/loopback/link-local destinations and redirect hops are blocked. Body text is in structuredContent.body.",
            inputSchema: {
                url: z.string().url().describe("Public http or https URL to fetch."),
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
