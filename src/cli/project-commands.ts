import { resolveProjectRoot } from "../config/loader.js";
import type { RegisteredProject } from "../daemon/state.js";
import { ensureControllerRunning } from "../control/control.js";
import { getProject, listProjects } from "../control/services.js";
import {
    printInfo,
    printIntro,
    printOutro,
    printSuccess,
    printSummary,
    printWarning,
} from "../lib/util/terminal.js";
import type { CliFlags } from "./args.js";
import { ensureControllerForRuntime } from "./daemon-commands.js";

export async function runProjectCommand(flags: CliFlags): Promise<void> {
    await runProjectAction(flags);
}

async function runProjectAction(flags: CliFlags): Promise<void> {
    const action = flags.projectAction ?? "list";
    if (action === "add") {
        const projectRoot = resolveProjectRoot(flags.target);
        const controller = await ensureControllerForRuntime(flags);
        const result = await controller.client.addProject({
            path: projectRoot,
            local: flags.local,
            noTunnel: flags.noTunnel,
            tunnelLogs: flags.tunnelLogs,
            intentSpecified: flags.runtimeIntentSpecified,
        });
        printSuccess(`已注册项目 ${result.project.name}（${result.project.path}）。`);
        printInfo(`项目 ID：${result.project.id}`);
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

    const controller = await ensureControllerRunning();
    const result = await controller.client.removeProject(target);
    if (!result.removed) {
        printWarning(`项目 ${result.project.name} 已经是停用状态。`);
        return;
    }
    printSuccess(`已停用项目 ${result.project.name}（${result.project.path}）。`);
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
