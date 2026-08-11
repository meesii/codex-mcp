const DEFAULT_MAX_CHARS = 80_000;

export function truncateText(text: string, maxChars = DEFAULT_MAX_CHARS): string {
    if (text.length <= maxChars) {
        return text;
    }

    const omitted = text.length - maxChars;
    return `${text.slice(0, maxChars)}\n\n[truncated ${omitted} more characters]`;
}
