import type { ToolName } from "../tools/names.js";

/** Chinese display labels for coding tools (UI card only). */
export const TOOL_LABELS: Record<ToolName, string> = {
    read: "读取文件",
    write: "写入文件",
    edit: "修改文件",
    bash: "执行命令",
    exec_command: "后台命令",
    write_stdin: "进程交互",
    process_kill: "结束进程",
    grep: "搜索内容",
    glob: "查找文件",
    ls: "列出目录",
    webfetch: "抓取网页",
    summary: "总结进度",
};

/** Host invoking / invoked status text (≤64 chars each). */
export const TOOL_STATUS: Record<ToolName, { invoking: string; invoked: string }> = {
    read: { invoking: "正在读取文件…", invoked: "文件读取完成" },
    write: { invoking: "正在写入文件…", invoked: "文件写入完成" },
    edit: { invoking: "正在修改文件…", invoked: "文件修改完成" },
    bash: { invoking: "正在执行命令…", invoked: "命令执行完成" },
    exec_command: { invoking: "正在启动后台命令…", invoked: "后台命令已就绪" },
    write_stdin: { invoking: "正在与进程交互…", invoked: "进程交互完成" },
    process_kill: { invoking: "正在结束进程…", invoked: "进程已结束" },
    grep: { invoking: "正在搜索内容…", invoked: "内容搜索完成" },
    glob: { invoking: "正在查找文件…", invoked: "文件查找完成" },
    ls: { invoking: "正在列出目录…", invoked: "目录列表完成" },
    webfetch: { invoking: "正在抓取网页…", invoked: "网页抓取完成" },
    summary: { invoking: "正在总结进度…", invoked: "进度已汇报" },
};

/**
 * Resolve a short Chinese label for a tool name.
 *
 * @param toolName - Machine tool name
 * @returns Display label
 */
export function toolLabel(toolName: string): string {
    if (Object.prototype.hasOwnProperty.call(TOOL_LABELS, toolName)) {
        return TOOL_LABELS[toolName as ToolName];
    }
    return toolName;
}

/**
 * Resolve host status text for a tool invocation.
 *
 * @param toolName - Machine tool name
 * @returns Invoking / invoked strings
 */
export function toolStatus(toolName: string): { invoking: string; invoked: string } {
    if (Object.prototype.hasOwnProperty.call(TOOL_STATUS, toolName)) {
        return TOOL_STATUS[toolName as ToolName];
    }
    return { invoking: "工具调用中…", invoked: "调用完成" };
}
