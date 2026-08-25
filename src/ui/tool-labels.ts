import type { ToolName } from "../tools/names.js";

export const TOOL_LABELS: Record<ToolName, string> = {
    project_control: "管理会话项目",
    read: "读取文件",
    read_image: "读取图片",
    apply_patch: "应用补丁",
    ls: "列出目录",
    grep: "搜索内容",
    glob: "查找文件",
    code_explore: "探索代码结构",
    exec_command: "执行命令",
    write_stdin: "终端交互",
    skills_list: "列出 Skills",
    skill_read: "读取 Skill",
    mcp_tools: "发现下游工具",
    mcp_call: "调用下游工具",
    summary: "总结本轮",
};

export const TOOL_STATUS: Record<ToolName, { invoking: string; invoked: string }> = {
    project_control: { invoking: "正在管理会话项目…", invoked: "会话项目已更新" },
    read: { invoking: "正在读取文件…", invoked: "文件读取完成" },
    read_image: { invoking: "正在读取图片…", invoked: "图片读取完成" },
    apply_patch: { invoking: "正在应用补丁…", invoked: "补丁应用完成" },
    ls: { invoking: "正在列出目录…", invoked: "目录列表完成" },
    grep: { invoking: "正在搜索内容…", invoked: "内容搜索完成" },
    glob: { invoking: "正在查找文件…", invoked: "文件查找完成" },
    code_explore: { invoking: "正在探索代码结构…", invoked: "代码探索完成" },
    exec_command: { invoking: "正在执行命令…", invoked: "命令执行完成" },
    write_stdin: { invoking: "正在读取终端…", invoked: "终端已更新" },
    skills_list: { invoking: "正在列出 Skills…", invoked: "Skills 已列出" },
    skill_read: { invoking: "正在读取 Skill…", invoked: "Skill 已读取" },
    mcp_tools: { invoking: "正在发现 MCP 工具…", invoked: "MCP 工具已加载" },
    mcp_call: { invoking: "正在调用 MCP 工具…", invoked: "MCP 工具调用完成" },
    summary: { invoking: "正在整理本轮摘要…", invoked: "本轮处理已结束" },
};

export function toolLabel(toolName: string): string {
    return Object.prototype.hasOwnProperty.call(TOOL_LABELS, toolName)
        ? TOOL_LABELS[toolName as ToolName]
        : toolName;
}

export function toolStatus(toolName: string): { invoking: string; invoked: string } {
    return Object.prototype.hasOwnProperty.call(TOOL_STATUS, toolName)
        ? TOOL_STATUS[toolName as ToolName]
        : { invoking: "工具调用中…", invoked: "调用完成" };
}
