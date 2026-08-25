import { toolLabel } from "./tool-labels.js";
import {
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
    /** `summary` tool: user-facing round note. */
    summaryText?: string;
}

function toArgsMap(
    args?: Record<string, unknown> | null,
): Record<string, string | number | boolean> | undefined {
    if (!args || typeof args !== "object") return undefined;
    const keys = [
        "path",
        "cmd",
        "pattern",
        "session_id",
        "offset",
        "limit",
        "chars",
        "summary",
        "title",
    ] as const;
    const out: Record<string, string | number | boolean> = {};
    for (const key of keys) {
        const value = args[key];
        if (value === undefined || value === null || value === "") continue;
        if (key === "chars" && typeof value === "string") {
            out[key] = value.length;
            continue;
        }
        if (key === "cmd" && typeof value === "string") {
            out[key] = value;
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
        card.summaryText = summaryText || call.title;
        card.label = "本轮总结";
    }

    return card;
}
