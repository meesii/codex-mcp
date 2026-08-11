import { UI_PREVIEW_MAX_CHARS } from "./constants.js";

export interface UiParamRow {
    label: string;
    value: string;
}

export interface ToolCallSummary {
    title: string;
    params: UiParamRow[];
}

const PARAM_LABELS: Record<string, string> = {
    path: "路径",
    command: "命令",
    pattern: "模式",
    url: "网址",
    uri: "资源 URI",
    processId: "进程",
    chars: "输入",
    offset: "起始行",
    limit: "行数",
    format: "格式",
    summary: "总结",
    next: "下一步",
    done: "完成",
    server: "MCP",
    tool: "工具",
    name: "Skill",
    prompt: "提示词",
    query: "查询",
    intent: "意图",
    revision: "版本",
    staged: "暂存区",
    project_path: "项目",
    max_depth: "深度",
};

const PARAM_KEYS: Record<string, string[]> = {
    read: ["path", "offset", "limit"],
    write: ["path"],
    edit: ["path"],
    bash: ["command"],
    exec_command: ["command", "name"],
    write_stdin: ["processId", "chars"],
    process_kill: ["processId"],
    process_list: [],
    process_status: ["processId"],
    process_output: ["processId"],
    runtime_status: [],
    grep: ["pattern", "path"],
    glob: ["pattern"],
    ls: ["path"],
    webfetch: ["url", "format"],
    summary: ["summary", "next", "done"],
    skills_list: [],
    skill_read: ["name", "path"],
    agents_for_path: ["path"],
    capabilities_reload: [],
    workspace_projects: ["max_depth"],
    workspace_search: ["pattern", "path"],
    workspace_context: ["path", "intent"],
    context_pack: ["query", "path"],
    git_status: ["path"],
    git_diff: ["path", "staged"],
    git_log: ["path", "limit"],
    git_show: ["path", "revision"],
    git_branches: ["path"],
    code_explore: ["query", "project_path"],
    mcp_servers: [],
    mcp_reconnect: ["server"],
    mcp_tools: ["server"],
    mcp_call: ["server", "tool"],
    mcp_resources: ["server"],
    mcp_resource_read: ["server", "uri"],
    mcp_prompts: ["server"],
    mcp_prompt_get: ["server", "prompt"],
};

export function clipLine(text: string, max: number = UI_PREVIEW_MAX_CHARS): string {
    const oneLine = String(text).replace(/\s+/g, " ").trim();
    if (oneLine.length <= max) return oneLine;
    return `${oneLine.slice(0, max)}…`;
}

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
        return value;
    }
    if (key === "url" && typeof value === "string") {
        return value;
    }
    if (typeof value === "string") return clipLine(value, 96);
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    return null;
}

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
            return String(input.command ?? "") || "—";
        case "grep": {
            const pattern = String(input.pattern ?? "");
            const path = input.path != null ? String(input.path) : "";
            if (pattern && path) return clipLine(`${pattern}  ·  ${path}`, 80);
            return clipLine(pattern || path, 80) || "—";
        }
        case "glob":
            return clipLine(String(input.pattern ?? ""), 80) || "—";
        case "webfetch":
            return String(input.url ?? "") || "—";
        case "summary":
            return clipLine(String(input.summary ?? ""), 80) || "—";
        case "mcp_servers":
        case "capabilities_reload":
        case "process_list":
        case "skills_list":
            return "—";
        case "mcp_reconnect":
        case "mcp_tools":
        case "mcp_resources":
        case "mcp_prompts":
            return clipLine(String(input.server ?? ""), 80) || "—";
        case "mcp_resource_read": {
            const server = String(input.server ?? "");
            const uri = String(input.uri ?? "");
            return clipLine(server && uri ? `${server}/${uri}` : server || uri, 80) || "—";
        }
        case "mcp_prompt_get": {
            const server = String(input.server ?? "");
            const prompt = String(input.prompt ?? "");
            return clipLine(server && prompt ? `${server}/${prompt}` : server || prompt, 80) || "—";
        }
        case "mcp_call": {
            const server = String(input.server ?? "");
            const tool = String(input.tool ?? "");
            if (server && tool) return clipLine(`${server}/${tool}`, 80);
            return clipLine(server || tool, 80) || "—";
        }
        case "write_stdin":
        case "process_kill":
        case "process_status":
        case "process_output":
            return input.processId != null ? `#${input.processId}` : "—";
        default:
            return params[0]?.value ? clipLine(params[0].value, 80) : "—";
    }
}

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
        case "mcp_tools": {
            if (Array.isArray(data.tools)) return `${data.tools.length} 个工具`;
            break;
        }
        case "mcp_call": {
            const tool = typeof data.tool === "string" ? data.tool : "";
            if (data.isError === true) return tool ? `${tool} 失败` : "调用失败";
            return tool ? `${tool} 完成` : "调用完成";
        }
        default:
            break;
    }

    const text = (contentText || "").trim();
    return text ? clipLine(text, 100) : undefined;
}
