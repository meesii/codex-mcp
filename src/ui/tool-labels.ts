import type { ToolName } from "../tools/names.js";

/** Chinese display labels for coding tools (UI card only). */
export const TOOL_LABELS: Record<ToolName, string> = {
    read: "读取文件",
    read_many: "批量读取文件",
    write: "写入文件",
    edit: "修改文件",
    apply_patch: "应用补丁",
    bash: "执行命令",
    exec_command: "后台命令",
    write_stdin: "进程交互",
    process_kill: "结束进程",
    process_list: "列出进程",
    process_status: "查看进程",
    process_output: "查看进程输出",
    runtime_status: "查看运行指标",
    server_info: "查看服务信息",
    grep: "搜索内容",
    glob: "查找文件",
    ls: "列出目录",
    webfetch: "抓取网页",
    summary: "总结进度",
    goal_start: "开始长期目标",
    goal_status: "查看长期目标",
    goal_update: "更新长期目标",
    goal_verify: "验证目标条件",
    goal_finish: "完成长期目标",
    goal_cancel: "取消长期目标",
    skills_list: "列出 Codex Skills",
    skill_read: "读取 Codex Skill",
    agents_for_path: "读取项目指令",
    capabilities_reload: "刷新 Codex 能力",
    workspace_projects: "列出工作区项目",
    workspace_search: "搜索工作区",
    context_pack: "构建任务上下文",
    git_status: "读取 Git 状态",
    git_diff: "读取 Git 差异",
    git_log: "读取 Git 历史",
    git_show: "查看 Git 提交",
    git_branches: "列出 Git 分支",
    code_explore: "探索代码关系",
    mcp_servers: "列出下游 MCP",
    mcp_reconnect: "重连下游 MCP",
    mcp_tools: "列出下游工具",
    mcp_call: "调用下游工具",
    mcp_resources: "列出下游资源",
    mcp_resource_read: "读取下游资源",
    mcp_prompts: "列出下游提示词",
    mcp_prompt_get: "读取下游提示词",
};

/** Host invoking / invoked status text (≤64 chars each). */
export const TOOL_STATUS: Record<ToolName, { invoking: string; invoked: string }> = {
    read: { invoking: "正在读取文件…", invoked: "文件读取完成" },
    read_many: { invoking: "正在批量读取文件…", invoked: "批量读取完成" },
    write: { invoking: "正在写入文件…", invoked: "文件写入完成" },
    edit: { invoking: "正在修改文件…", invoked: "文件修改完成" },
    apply_patch: { invoking: "正在应用补丁…", invoked: "补丁应用完成" },
    bash: { invoking: "正在执行命令…", invoked: "命令执行完成" },
    exec_command: { invoking: "正在启动后台命令…", invoked: "后台命令已就绪" },
    write_stdin: { invoking: "正在与进程交互…", invoked: "进程交互完成" },
    process_kill: { invoking: "正在结束进程…", invoked: "进程已结束" },
    process_list: { invoking: "正在列出进程…", invoked: "进程列表完成" },
    process_status: { invoking: "正在查看进程…", invoked: "进程状态已读取" },
    process_output: { invoking: "正在查看进程输出…", invoked: "进程输出已读取" },
    runtime_status: { invoking: "正在读取运行指标…", invoked: "运行指标已读取" },
    server_info: { invoking: "正在读取服务信息…", invoked: "服务信息已读取" },
    grep: { invoking: "正在搜索内容…", invoked: "内容搜索完成" },
    glob: { invoking: "正在查找文件…", invoked: "文件查找完成" },
    ls: { invoking: "正在列出目录…", invoked: "目录列表完成" },
    webfetch: { invoking: "正在抓取网页…", invoked: "网页抓取完成" },
    summary: { invoking: "正在总结进度…", invoked: "进度已汇报" },
    goal_start: { invoking: "正在建立长期目标…", invoked: "长期目标已建立" },
    goal_status: { invoking: "正在读取长期目标…", invoked: "长期目标已读取" },
    goal_update: { invoking: "正在更新长期目标…", invoked: "长期目标已更新" },
    goal_verify: { invoking: "正在记录验证结果…", invoked: "验证结果已记录" },
    goal_finish: { invoking: "正在完成长期目标…", invoked: "长期目标已完成" },
    goal_cancel: { invoking: "正在取消长期目标…", invoked: "长期目标已取消" },
    skills_list: { invoking: "正在列出 Codex Skills…", invoked: "Codex Skills 已列出" },
    skill_read: { invoking: "正在读取 Codex Skill…", invoked: "Codex Skill 已读取" },
    agents_for_path: { invoking: "正在读取项目指令…", invoked: "项目指令已加载" },
    capabilities_reload: { invoking: "正在刷新 Codex 能力…", invoked: "Codex 能力已刷新" },
    workspace_projects: { invoking: "正在发现工作区项目…", invoked: "工作区项目已列出" },
    workspace_search: { invoking: "正在搜索工作区…", invoked: "工作区搜索完成" },
    context_pack: { invoking: "正在构建任务上下文…", invoked: "任务上下文已构建" },
    git_status: { invoking: "正在读取 Git 状态…", invoked: "Git 状态已读取" },
    git_diff: { invoking: "正在读取 Git 差异…", invoked: "Git 差异已读取" },
    git_log: { invoking: "正在读取 Git 历史…", invoked: "Git 历史已读取" },
    git_show: { invoking: "正在查看 Git 提交…", invoked: "Git 提交已读取" },
    git_branches: { invoking: "正在列出 Git 分支…", invoked: "Git 分支已列出" },
    code_explore: { invoking: "正在探索代码关系…", invoked: "代码探索完成" },
    mcp_servers: { invoking: "正在读取下游 MCP 状态…", invoked: "下游 MCP 状态已读取" },
    mcp_reconnect: { invoking: "正在重连下游 MCP…", invoked: "下游 MCP 重连完成" },
    mcp_tools: { invoking: "正在列出下游工具…", invoked: "下游工具已列出" },
    mcp_call: { invoking: "正在调用下游工具…", invoked: "下游工具调用完成" },
    mcp_resources: { invoking: "正在列出下游资源…", invoked: "下游资源已列出" },
    mcp_resource_read: { invoking: "正在读取下游资源…", invoked: "下游资源读取完成" },
    mcp_prompts: { invoking: "正在列出下游提示词…", invoked: "下游提示词已列出" },
    mcp_prompt_get: { invoking: "正在读取下游提示词…", invoked: "下游提示词读取完成" },
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
