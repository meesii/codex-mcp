import TurndownService from "turndown";

const turndown = new TurndownService({
    headingStyle: "atx",
    codeBlockStyle: "fenced",
});

/**
 * Convert an HTML document string to markdown.
 *
 * @param html - Raw HTML
 * @returns Markdown text
 */
export function htmlToMarkdown(html: string): string {
    return turndown.turndown(html);
}
