import { isCancel, multiselect } from "@clack/prompts";
import { resolveProjectRoot } from "../config/loader.js";
import { contactRunningDaemon } from "../daemon/control.js";
import {
    loadBindingsFile,
    loadProjectsFile,
    saveBindingsFile,
    saveProjectsFile,
    type RegisteredProject,
    type SessionBinding,
} from "../daemon/state.js";
import {
    printInfo,
    printIntro,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "../lib/util/terminal.js";
import {
    canonicalProjectPath,
    detectProjectDisplayName,
} from "../projects/identity.js";
import type { CliFlags } from "./args.js";
import { ensureDaemonRunning, runStop } from "./daemon-commands.js";
import { canPromptInteractively } from "../tunnel/prompt.js";

export async function runProjectCommand(flags: CliFlags): Promise<void> {
    const action = flags.projectAction ?? "list";
    if (action === "add") {
        const projectRoot = resolveProjectRoot(flags.target);
        const daemon = await ensureDaemonRunning(flags);
        const project = await daemon.client.registerProject({
            path: projectRoot,
            name: detectProjectDisplayName(projectRoot),
        });
        printSuccess(`已注册项目 ${project.name}（${project.path}）。`);
        printInfo(`项目 ID：${project.id}`);
        return;
    }

    const daemon = await contactRunningDaemon();
    const status = daemon ? await daemon.client.status() : undefined;
    const projects = status?.projects ?? loadProjectsFile();

    if (action === "list") {
        printProjectList(projects);
        return;
    }

    const project = resolveProjectSelection(projects, flags.target);
    if (!project) {
        throw new Error(flags.target ? `没有找到项目：${flags.target}` : "当前目录没有注册为项目");
    }

    if (action === "info") {
        const live = status?.projects.find((item) => item.id === project.id);
        printIntro("codex-mcp project info");
        printSummary("项目", [
            { label: "名称", value: project.name },
            { label: "ID", value: project.id },
            { label: "目录", value: project.path },
            { label: "状态", value: project.active ? "活动" : "已停用" },
            { label: "会话绑定", value: live ? String(live.boundSessions) : "daemon 未运行" },
            { label: "最后使用", value: project.lastSeenAt },
        ]);
        printOutro("项目详情");
        return;
    }

    if (daemon) {
        const result = await daemon.client.deactivateProject(project.id, project.path);
        if (!result.removed) {
            printWarning(`项目 ${project.name} 已经是停用状态。`);
            return;
        }
    } else if (project.active) {
        await saveProjectsFile(projects.map((item) => item.id === project.id ? { ...item, active: false } : item));
    } else {
        printWarning(`项目 ${project.name} 已经是停用状态。`);
        return;
    }
    printSuccess(`已停用项目 ${project.name}（${project.path}）。`);
}

export async function runBindingsCommand(flags: CliFlags): Promise<void> {
    if (flags.bindingsAction !== "clean") {
        throw new Error("bindings 命令需要 clean 子命令");
    }
    const daemon = await contactRunningDaemon();
    const status = daemon ? await daemon.client.status() : undefined;
    const projects = status?.projects ?? loadProjectsFile();
    const project = resolveProjectSelection(projects, flags.target);
    if (!project) {
        throw new Error(flags.target ? `没有找到项目：${flags.target}` : "当前目录没有注册为项目");
    }
    await cleanProjectBindings(project, daemon?.client);
}

async function cleanProjectBindings(
    project: RegisteredProject,
    daemonClient?: NonNullable<Awaited<ReturnType<typeof contactRunningDaemon>>>["client"],
): Promise<void> {
    if (!canPromptInteractively()) {
        throw new Error("清理会话绑定需要在可以输入内容的终端里运行");
    }
    const bindings = (
        daemonClient
            ? await daemonClient.listProjectBindings(project.id)
            : loadBindingsFile().filter((item) => item.projectId === project.id)
    ).sort((left, right) => Date.parse(right.lastSeenAt) - Date.parse(left.lastSeenAt));

    printIntro("codex-mcp bindings clean");
    if (bindings.length === 0) {
        printInfo(`项目 ${project.name} 当前没有会话绑定。`);
        printOutro("无需清理");
        return;
    }

    const selected = await multiselect<string>({
        message: "空格选中要保留的会话；未选中项将在回车后清理",
        options: bindings.map((binding) => ({
            value: binding.ownerKey,
            label: bindingDisplayName(binding),
            hint: `绑定 ${formatBindingTime(binding.boundAt)} · 最近 ${formatBindingTime(binding.lastSeenAt)}`,
        })),
        initialValues: [],
        required: false,
        maxItems: 12,
        showInstructions: true,
    });
    if (isCancel(selected)) {
        throw new Error("已取消清理会话绑定");
    }

    const retained = new Set(selected);
    const removeOwnerKeys = bindings
        .filter((binding) => !retained.has(binding.ownerKey))
        .map((binding) => binding.ownerKey);
    let removed: number;
    if (daemonClient) {
        const result = await daemonClient.cleanupProjectBindings(project.id, removeOwnerKeys);
        removed = result.removed;
    } else {
        const targets = new Set(removeOwnerKeys);
        const current = loadBindingsFile();
        const remaining = current.filter(
            (binding) => binding.projectId !== project.id || !targets.has(binding.ownerKey),
        );
        removed = current.length - remaining.length;
        if (removed > 0) await saveBindingsFile(remaining);
    }

    printSuccess(
        `已清理项目 ${project.name} 的 ${removed} 个会话绑定，保留 ${selected.length} 个。`,
    );
    printOutro("会话绑定清理完成");
}

function bindingDisplayName(binding: SessionBinding): string {
    const scoped = /\|(openai-session|mcp-session):(.+)$/.exec(binding.ownerKey);
    if (scoped) {
        const kind = scoped[1] === "openai-session" ? "ChatGPT 会话" : "MCP 会话";
        return `${kind} ${abbreviateIdentifier(scoped[2])}`;
    }
    return `授权会话 ${abbreviateIdentifier(binding.ownerKey)}`;
}

function abbreviateIdentifier(value: string): string {
    if (value.length <= 24) return value;
    return `${value.slice(0, 12)}…${value.slice(-8)}`;
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

/** `codex-mcp exit`: compatibility alias for project remove; `exit -a` aliases stop. */
export async function runExit(flags: CliFlags): Promise<void> {
    if (flags.all) {
        await runStop();
        return;
    }
    await runProjectCommand({
        ...flags,
        command: "project",
        projectAction: "remove",
        ...(flags.root ? { target: flags.root } : {}),
    });
    printInfo("兼容提示：以后可使用 `codex-mcp project remove [项目]`。");
}

function printProjectList(projects: Array<RegisteredProject & { boundSessions?: number }>): void {
    printIntro("codex-mcp project list");
    if (projects.length === 0) {
        printInfo("还没有注册项目。运行 `codex-mcp project add [目录]` 添加。");
        printOutro("项目列表");
        return;
    }
    for (const project of projects) {
        const sessions = project.boundSessions === undefined ? "" : ` · ${project.boundSessions} 个会话绑定`;
        printInfo(`- ${project.name}${project.active ? "" : "（已停用）"} · ${project.id} · ${project.path}${sessions}`);
    }
    printOutro(`${projects.length} 个项目`);
}

function resolveProjectSelection(
    projects: RegisteredProject[],
    target?: string,
): RegisteredProject | undefined {
    if (!target) {
        let current: string;
        try {
            current = canonicalProjectPath(resolveProjectRoot(undefined));
        } catch {
            return undefined;
        }
        return projects.find((item) => item.path === current);
    }
    const byId = projects.find((item) => item.id === target);
    if (byId) return byId;
    const byName = projects.filter((item) => item.name === target);
    if (byName.length === 1) return byName[0];
    if (byName.length > 1) {
        throw new Error(`项目名 ${target} 不唯一，请改用项目 ID 或完整目录。`);
    }
    try {
        const path = canonicalProjectPath(target);
        return projects.find((item) => item.path === path);
    } catch {
        return undefined;
    }
}
