import { isCancel, multiselect } from "@clack/prompts";
import { resolveProjectRoot } from "../config/loader.js";
import type { RegisteredProject } from "../daemon/state.js";
import {
    addProject,
    cleanupProjectConversations,
    getProject,
    listProjectConversations,
    listProjects,
    removeProject,
} from "../control/services.js";
import {
    printInfo,
    printIntro,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "../lib/util/terminal.js";
import type { CliFlags } from "./args.js";
import { canPromptInteractively } from "../tunnel/prompt.js";

export async function runProjectCommand(flags: CliFlags): Promise<void> {
    await runProjectAction(flags);
}

export async function runBindingsCommand(flags: CliFlags): Promise<void> {
    if (flags.bindingsAction !== "clean") {
        throw new Error("bindings 命令需要 clean 子命令");
    }
    if (!canPromptInteractively()) {
        throw new Error("清理会话绑定需要在可以输入内容的终端里运行");
    }
    const target = flags.target ?? resolveProjectRoot(undefined);
    const current = await listProjectConversations(target);
    if (!current.project) throw new Error(`没有找到项目：${target}`);

    printIntro("codex-mcp bindings clean");
    if (current.conversations.length === 0) {
        printInfo(`项目 ${current.project.name} 当前没有会话绑定。`);
        printOutro("无需清理");
        return;
    }

    const selected = await multiselect<string>({
        message: "空格选中要清理的会话；未选中项会保留",
        options: current.conversations.map((conversation) => ({
            value: conversation.id,
            label: `${conversation.label} ${conversation.id.slice(0, 6)}`,
            hint: `最近 ${formatBindingTime(conversation.lastSeenAt)}`,
        })),
        initialValues: [],
        required: false,
    });
    if (isCancel(selected)) throw new Error("已取消清理会话绑定");
    if (selected.length === 0) {
        printInfo("没有选择要清理的会话，未做任何修改。");
        printOutro("会话绑定未修改");
        return;
    }

    const result = await cleanupProjectConversations(target, selected);
    printSuccess(`已清理项目 ${current.project.name} 的 ${result.removed} 个会话绑定。`);
    printInfo(`当前保留 ${result.conversations.length} 个会话绑定。`);
    printOutro("会话绑定清理完成");
}

async function runProjectAction(flags: CliFlags): Promise<void> {
    const action = flags.projectAction ?? "list";
    if (action === "add") {
        const projectRoot = resolveProjectRoot(flags.target);
        const project = await addProject(projectRoot);
        printSuccess(`已注册项目 ${project.name}（${project.path}）。`);
        printInfo(`项目 ID：${project.id}`);
        return;
    }

    if (action === "list") {
        printProjectList(await listProjects());
        return;
    }

    const target = flags.target ?? resolveProjectRoot(undefined);
    if (action === "info") {
        const project = await getProject(target);
        if (!project) throw new Error(flags.target ? `没有找到项目：${flags.target}` : "当前目录没有注册为项目");
        printIntro("codex-mcp project info");
        printSummary("项目", [
            { label: "名称", value: project.name },
            { label: "ID", value: project.id },
            { label: "目录", value: project.path },
            { label: "状态", value: project.active ? "活动" : "已停用" },
            { label: "会话绑定", value: project.boundSessions == null ? "Runtime 未运行" : String(project.boundSessions) },
            { label: "最后使用", value: project.lastSeenAt },
        ]);
        printOutro("项目详情");
        return;
    }

    const result = await removeProject(target);
    if (!result.removed) {
        printWarning(`项目 ${result.project.name} 已经是停用状态。`);
        return;
    }
    printSuccess(`已停用项目 ${result.project.name}（${result.project.path}）。`);
}

function formatBindingTime(value: string): string {
    const timestamp = Date.parse(value);
    if (!Number.isFinite(timestamp)) return value;
    return new Intl.DateTimeFormat("zh-CN", {
        month: "2-digit",
        day: "2-digit",
        hour: "2-digit",
        minute: "2-digit",
        hour12: false,
    }).format(timestamp);
}

function printProjectList(projects: Array<RegisteredProject & { boundSessions?: number | null }>): void {
    printIntro("codex-mcp project list");
    if (projects.length === 0) {
        printInfo("还没有注册项目。运行 `codex-mcp project add [目录]` 添加。");
        printOutro("项目列表");
        return;
    }
    for (const project of projects) {
        const sessions = project.boundSessions == null ? " · Runtime 未运行" : ` · ${project.boundSessions} 个会话绑定`;
        printInfo(`- ${project.name}${project.active ? "" : "（已停用）"} · ${project.id} · ${project.path}${sessions}`);
    }
    printOutro(`${projects.length} 个项目`);
}
