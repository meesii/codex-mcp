const DEFAULT_MAX_CHARS = 80_000;

/**
 * Truncate text for model-facing tool results.
 *
 * @param text - Full text
 * @param maxChars - Maximum characters to keep
 * @returns Possibly truncated text with a short notice
 */
export function truncateText(text: string, maxChars = DEFAULT_MAX_CHARS): string {
    if (text.length <= maxChars) {
        return text;
    }

    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} more characters]`;
}
