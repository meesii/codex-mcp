import { UI_PREVIEW_MAX_CHARS } from "./constants.js";

export interface UiParamRow { label: string; value: string; }
export interface ToolCallSummary { title: string; params: UiParamRow[]; }

const LABELS: Record<string, string> = {
    purpose: "目的", action: "操作", project_id: "项目 ID", project_path: "项目",
    path: "路径", paths: "文件", pattern: "模式", cmd: "命令", workdir: "目录",
    session_id: "会话", chars: "输入", name: "Skill", server: "MCP", tool: "工具",
    title: "标题", summary: "总结",
};

const KEYS: Record<string, string[]> = {
    project_control: ["purpose", "action", "project_id", "project_path"],
    read: ["purpose", "path", "paths"], read_image: ["purpose", "path"],
    apply_patch: ["purpose"], ls: ["purpose", "path"],
    grep: ["purpose", "pattern", "path"], glob: ["purpose", "pattern", "path"],
    code_explore: ["purpose", "path"], exec_command: ["purpose", "cmd", "workdir"],
    write_stdin: ["purpose", "session_id", "chars"], skills_list: ["purpose"],
    skill_read: ["purpose", "name"], mcp_tools: ["purpose", "server"],
    mcp_call: ["purpose", "server", "tool"], summary: ["title", "summary"],
};

export function clipLine(text: string, max: number = UI_PREVIEW_MAX_CHARS): string {
    const oneLine = String(text).replace(/\s+/g, " ").trim();
    return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max)}…`;
}

export function summarizeToolCall(toolName: string, args?: Record<string, unknown> | null): ToolCallSummary {
    const input = args && typeof args === "object" && !Array.isArray(args) ? args : {};
    const params: UiParamRow[] = [];
    for (const key of KEYS[toolName] ?? Object.keys(input).slice(0, 4)) {
        const value = formatValue(key, input[key]);
        if (value !== null) params.push({ label: LABELS[key] ?? key, value });
    }
    return { title: buildTitle(toolName, input, params), params };
}

export function summarizeOutcome(
    toolName: string,
    ok: boolean,
    structured?: Record<string, unknown> | null,
    contentText?: string,
): string | undefined {
    if (!ok) return clipLine(contentText || "调用失败", 100);
    const data = structured ?? {};
    if (toolName === "read" && Array.isArray(data.files)) return `${data.files.length} 个文件`;
    if (toolName === "apply_patch" && Array.isArray(data.files)) return `${data.files.length} 个文件`;
    if (toolName === "grep" && typeof data.matchCount === "number") return `${data.matchCount} 处匹配`;
    if ((toolName === "glob" || toolName === "ls") && typeof data.count === "number") return `${data.count} 项`;
    if (toolName === "code_explore" && typeof data.fileCount === "number") return `${data.fileCount} 个文件`;
    if (toolName === "exec_command" || toolName === "write_stdin") {
        const parts: string[] = [];
        if (typeof data.session_id === "number") parts.push(`#${data.session_id}`);
        if (data.running === true) parts.push("运行中");
        else if (typeof data.exit_code === "number") parts.push(`退出码 ${data.exit_code}`);
        if (parts.length) return parts.join(" · ");
    }
    if (toolName === "skills_list" && typeof data.count === "number") return `${data.count} 个 Skill`;
    if (toolName === "summary" && data.fileChanges && typeof data.fileChanges === "object") {
        const count = (data.fileChanges as Record<string, unknown>).count;
        if (typeof count === "number") return `${count} 个变更文件`;
    }
    const text = (contentText || "").trim();
    return text ? clipLine(text, 100) : undefined;
}

function formatValue(key: string, value: unknown): string | null {
    if (value === undefined || value === null || value === "") return null;
    if (key === "session_id") return `#${value}`;
    if (key === "chars" && typeof value === "string") return `${value.length} 字符`;
    if (Array.isArray(value)) return `${value.length} 项`;
    if (typeof value === "string") return clipLine(value, key === "cmd" ? 140 : 96);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
}

function buildTitle(toolName: string, input: Record<string, unknown>, params: UiParamRow[]): string {
    if (toolName === "exec_command") return clipLine(String(input.cmd ?? ""), 100) || "—";
    if (toolName === "mcp_call") return clipLine(`${input.server ?? ""}/${input.tool ?? ""}`, 80);
    if (toolName === "write_stdin") return input.session_id == null ? "—" : `#${input.session_id}`;
    if (typeof input.path === "string") return clipLine(input.path, 80);
    return params.find((item) => item.label !== "目的")?.value ?? params[0]?.value ?? "—";
}
