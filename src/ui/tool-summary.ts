import { UI_PREVIEW_MAX_CHARS } from "./constants.js";

export interface UiParamRow {
    label: string;
    value: string;
}

export interface ToolCallSummary {
    title: string;
    params: UiParamRow[];
}

/** Chinese labels for curated argument keys. */
const PARAM_LABELS: Record<string, string> = {
    path: "路径",
    command: "命令",
    pattern: "模式",
    url: "网址",
    processId: "进程",
    chars: "输入",
    offset: "起始行",
    limit: "行数",
    format: "格式",
    summary: "总结",
    next: "下一步",
    done: "完成",
};

/** Per-tool argument keys worth showing (order matters). */
const PARAM_KEYS: Record<string, string[]> = {
    read: ["path", "offset", "limit"],
    write: ["path"],
    edit: ["path"],
    bash: ["command"],
    exec_command: ["command"],
    write_stdin: ["processId", "chars"],
    process_kill: ["processId"],
    grep: ["pattern", "path"],
    glob: ["pattern"],
    ls: ["path"],
    webfetch: ["url", "format"],
    summary: ["summary", "next", "done"],
};

/**
 * Clip text to a single short line for the UI strip / panel.
 *
 * @param text - Source text
 * @param max - Max characters
 * @returns Clipped one-line text
 */
export function clipLine(text: string, max: number = UI_PREVIEW_MAX_CHARS): string {
    const oneLine = String(text).replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) return oneLine;
    return `${oneLine.slice(0, max)}…`;
}

/**
 * Format a raw argument value for display.
 *
 * @param key - Argument key
 * @param value - Raw value
 * @returns Display string, or null to skip
 */
function formatParamValue(key: string, value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (key === "processId") return `#${value}`;
    if (key === "chars") {
        if (typeof value === "number") return `${value} 字符`;
        if (typeof value === "string") {
            return value.length > 0 ? `${value.length} 字符` : "(空)";
        }
    }
    if (key === "command" && typeof value === "string") {
        return clipLine(value, 160);
    }
    if (typeof value === "string") return clipLine(value, 96);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
}

/**
 * Build a collapsed title and expand-panel params from tool call arguments.
 *
 * @param toolName - Machine tool name
 * @param args - Tool arguments (from host toolInput or server handler)
 * @returns Title + curated params
 */
export function summarizeToolCall(
    toolName: string,
    args?: Record<string, unknown> | null,
): ToolCallSummary {
    const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const keys = PARAM_KEYS[toolName] ?? Object.keys(input).slice(0, 4);
    const params: UiParamRow[] = [];

    for (const key of keys) {
        const formatted = formatParamValue(key, input[key]);
        if (formatted == null) continue;
        params.push({
            label: PARAM_LABELS[key] ?? key,
            value: formatted,
        });
    }

    const title = buildTitle(toolName, input, params);
    return { title, params };
}

/**
 * Build one-line strip title from primary args.
 *
 * @param toolName - Tool name
 * @param input - Arguments
 * @param params - Already curated rows (fallback)
 * @returns Title line
 */
function buildTitle(
    toolName: string,
    input: Record<string, unknown>,
    params: UiParamRow[],
): string {
    switch (toolName) {
        case "read":
        case "write":
        case "edit":
        case "ls":
            return clipLine(String(input.path ?? params[0]?.value ?? ""), 80) || "—";
        case "bash":
        case "exec_command":
            return clipLine(String(input.command ?? ""), 80) || "—";
        case "grep": {
            const pattern = String(input.pattern ?? "");
            const path = input.path != null ? String(input.path) : "";
            if (pattern && path) return clipLine(`${pattern}  ·  ${path}`, 80);
            return clipLine(pattern || path, 80) || "—";
        }
        case "glob":
            return clipLine(String(input.pattern ?? ""), 80) || "—";
        case "webfetch":
            return clipLine(String(input.url ?? ""), 80) || "—";
        case "summary":
            return clipLine(String(input.summary ?? ""), 80) || "—";
        case "write_stdin":
        case "process_kill":
            return input.processId != null ? `#${input.processId}` : "—";
        default:
            return params[0]?.value ? clipLine(params[0].value, 80) : "—";
    }
}

/**
 * Build a short outcome line from structuredContent / content text.
 *
 * @param toolName - Tool name
 * @param ok - Whether the call succeeded
 * @param structured - structuredContent object
 * @param contentText - Flattened text content (fallback / errors)
 * @returns Short outcome, or undefined when nothing useful
 */
export function summarizeOutcome(
    toolName: string,
    ok: boolean,
    structured?: Record<string, unknown> | null,
    contentText?: string,
): string | undefined {
    if (!ok) {
        const errorText = (contentText || "").trim();
        return errorText ? clipLine(errorText, 100) : "调用失败";
    }

    const data = structured && typeof structured === "object" ? structured : null;
    if (!data) {
        const text = (contentText || "").trim();
        return text ? clipLine(text, 100) : undefined;
    }

    switch (toolName) {
        case "read": {
            const lines = data.lineCount;
            if (typeof lines === "number") return `${lines} 行`;
            break;
        }
        case "write": {
            const bytes = data.bytes;
            if (typeof bytes === "number") return `写入 ${bytes} 字节`;
            break;
        }
        case "edit": {
            if (data.replaced === true) return "已替换";
            if (data.replaced === false) return "未替换";
            break;
        }
        case "bash": {
            if (data.timedOut === true) return "超时";
            if (typeof data.exitCode === "number") return `退出码 ${data.exitCode}`;
            break;
        }
        case "exec_command":
        case "write_stdin":
        case "process_kill": {
            const parts: string[] = [];
            if (typeof data.processId === "number") parts.push(`#${data.processId}`);
            if (data.running === true) parts.push("运行中");
            else if (typeof data.exitCode === "number") parts.push(`退出码 ${data.exitCode}`);
            else if (typeof data.signal === "string") parts.push(data.signal);
            if (parts.length) return parts.join(" · ");
            break;
        }
        case "grep": {
            if (typeof data.matchCount === "number") return `${data.matchCount} 处匹配`;
            break;
        }
        case "glob": {
            if (typeof data.count === "number") return `${data.count} 个文件`;
            if (Array.isArray(data.files)) return `${data.files.length} 个文件`;
            break;
        }
        case "ls": {
            if (Array.isArray(data.entries)) return `${data.entries.length} 项`;
            break;
        }
        case "webfetch": {
            if (typeof data.bytes === "number") return `${data.bytes} 字节`;
            break;
        }
        case "summary": {
            if (data.done === true) return "任务完成";
            if (data.continueWorking === true) return "继续下一阶段";
            break;
        }
        default:
            break;
    }

    const text = (contentText || "").trim();
    return text ? clipLine(text, 100) : undefined;
}
