import { toolLabel } from "./tool-labels.js";
import {
    hiddenCommandLabel,
    safeUrlForDisplay,
    summarizeOutcome,
    summarizeToolCall,
    type UiParamRow,
} from "./tool-summary.js";

export type { UiParamRow };

export interface UiCard {
    tool: string;
    /** Chinese display name for the strip chip. */
    label: string;
    ok: boolean;
    /** One-line summary of call arguments (path / command / …). */
    title: string;
    /** Curated input rows for the expand panel. */
    params: UiParamRow[];
    /** Compact argument map for the widget to rebuild rows if host drops params. */
    args?: Record<string, string | number | boolean>;
    /** Short outcome line after completion. */
    outcome?: string;
    /** `summary` tool: overall task finished. */
    done?: boolean;
    /** `summary` tool: progress note (may wrap). */
    summaryText?: string;
    /** `summary` tool: next step when not done. */
    nextText?: string | null;
}

/**
 * Keep only JSON-safe scalar args the widget may need to rebuild the panel.
 *
 * @param args - Original tool arguments
 * @returns Compact args, or undefined when empty
 */
function toArgsMap(
    args?: Record<string, unknown> | null,
): Record<string, string | number | boolean> | undefined {
    if (!args || typeof args !== "object") return undefined;
    const keys = [
        "path",
        "command",
        "pattern",
        "url",
        "processId",
        "format",
        "offset",
        "limit",
        "chars",
        "summary",
        "next",
        "done",
    ] as const;
    const out: Record<string, string | number | boolean> = {};
    for (const key of keys) {
        const value = args[key];
        if (value === undefined || value === null || value === "") continue;
        if (key === "chars" && typeof value === "string") {
            out[key] = value.length;
            continue;
        }
        if (key === "command" && typeof value === "string") {
            out[key] = hiddenCommandLabel(value);
            continue;
        }
        if (key === "url" && typeof value === "string") {
            out[key] = safeUrlForDisplay(value);
            continue;
        }
        if (typeof value === "string") {
            out[key] = value.length > 200 ? `${value.slice(0, 200)}…` : value;
            continue;
        }
        if (typeof value === "number" || typeof value === "boolean") {
            out[key] = value;
        }
    }
    return Object.keys(out).length > 0 ? out : undefined;
}

/**
 * Build a compact UI card from tool arguments + result.
 * Collapsed title is always argument-driven; expand shows curated params + outcome.
 *
 * @param toolName - Tool name
 * @param ok - Whether the tool succeeded
 * @param args - Original tool arguments
 * @param structured - structuredContent from the tool
 * @param contentText - Flattened text content (for errors / fallback)
 * @returns UI card for `_meta.uiCard`
 */
export function buildUiCard(
    toolName: string,
    ok: boolean,
    args?: Record<string, unknown> | null,
    structured?: Record<string, unknown> | null,
    contentText?: string,
): UiCard {
    const call = summarizeToolCall(toolName, args);
    const outcome = summarizeOutcome(toolName, ok, structured, contentText);
    const argsMap = toArgsMap(args);

    const card: UiCard = {
        tool: toolName,
        label: toolLabel(toolName),
        ok,
        title: call.title,
        params: call.params,
        ...(argsMap ? { args: argsMap } : {}),
        ...(outcome ? { outcome } : {}),
    };

    if (toolName === "summary") {
        const summaryText =
            (typeof structured?.summary === "string" && structured.summary.trim()) ||
            (typeof args?.summary === "string" && args.summary.trim()) ||
            "";
        const nextRaw =
            structured?.next ??
            (typeof args?.next === "string" ? args.next : null);
        const nextText =
            typeof nextRaw === "string" && nextRaw.trim() ? nextRaw.trim() : null;
        const done = structured?.done === true || args?.done === true;

        card.done = done;
        card.summaryText = summaryText || call.title;
        card.nextText = done ? null : nextText;
        card.label = done ? "任务完成" : "进度汇报";
    }

    return card;
}
