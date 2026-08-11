export const OUTPUT_MODES = ["summary", "tail", "head_tail", "full"] as const;

export type OutputMode = (typeof OUTPUT_MODES)[number];

export interface FormattedOutput {
    text: string;
    truncated: boolean;
}

/**
 * Bound command output while preserving the most useful region for the chosen mode.
 * Short output is always returned verbatim.
 */
export function formatOutput(
    text: string,
    mode: OutputMode,
    maxChars: number,
): FormattedOutput {
    const value = text.trimEnd();
    const limit = mode === "summary" ? Math.min(maxChars, 12_000) : maxChars;
    if (value.length <= limit) return { text: value, truncated: false };

    if (mode === "full") {
        return {
            text: `${value.slice(0, limit)}\n\n[truncated ${value.length - limit} more characters]`,
            truncated: true,
        };
    }

    if (mode === "tail" || mode === "summary") {
        const kept = value.slice(-limit);
        return {
            text: `[truncated ${value.length - kept.length} earlier characters]\n${kept}`,
            truncated: true,
        };
    }

    const notice = "\n... output truncated ...\n";
    const available = Math.max(0, limit - notice.length);
    const head = Math.ceil(available / 2);
    const tail = Math.floor(available / 2);
    return {
        text: `${value.slice(0, head)}${notice}${tail > 0 ? value.slice(-tail) : ""}`,
        truncated: true,
    };
}
