import * as React from "react";
import { Check, Copy, FolderPlus, Link2, Play, RefreshCw, Wrench } from "lucide-react";
import { toast } from "sonner";
import type { ConnectionCheck, ControllerStatus, Project, SetupSummary } from "../api.js";
import { Button, Card } from "../components/ui.js";
import { ConnectionResult } from "../components/connection-result.js";

export function HomePage({ status, setup, projects, loading, busy, result, onNavigate, onAdd, onStart, onCheck, onRepair }: {
    status?: ControllerStatus; setup?: SetupSummary; projects: Project[]; loading: boolean; busy: boolean; result?: ConnectionCheck;
    onNavigate: (page: "projects" | "connect" | "maintenance") => void; onAdd: () => void; onStart: () => void; onCheck: () => void; onRepair: () => void;
}): React.JSX.Element {
    const running = status?.runtime.running === true;
    const active = projects.filter((project) => project.active);
    const url = setup?.config.publicAccess ? `https://${setup.config.publicAccess.domain}/mcp` : undefined;
    const configured = Boolean(url && setup?.passwordConfigured);
    const ready = running && result?.ready;
    const steps = [
        { title: "选择项目", done: active.length > 0, action: onAdd },
        { title: "连接 ChatGPT", done: configured, action: () => onNavigate("connect") },
        { title: "验证连接", done: Boolean(ready), action: onCheck },
    ];
    const action = !active.length ? onAdd : !configured ? () => onNavigate("connect") : !running ? onStart : onCheck;
    const actionText = !active.length ? "选择项目文件夹" : !configured ? "设置 ChatGPT 连接" : !running ? "启动服务" : "测试连接";
    return <div className="mx-auto max-w-3xl pb-12 pt-6 sm:pt-12">
        <div className="text-center"><p className="text-sm text-[var(--muted-foreground)]">让 ChatGPT 在你的项目中工作</p><h1 className="font-display mt-3 text-[32px] font-semibold tracking-[-0.04em] sm:text-[40px]">{loading ? "正在读取工作区…" : ready ? "项目已准备好" : !active.length ? "从一个项目开始" : !configured ? "下一步，连接 ChatGPT" : !running ? "启动后即可检查连接" : "检查一下，开始工作"}</h1><p className="mx-auto mt-3 max-w-lg text-sm leading-6 text-[var(--muted-foreground)]">{ready ? "在 ChatGPT 中选择这个连接，再告诉它你要使用哪个项目。" : "选好项目、配置连接，然后检查服务是否就绪。"}</p></div>
        <div className="my-8 grid grid-cols-3 gap-2" aria-label="开始使用的三个步骤">{steps.map((step, index) => <button key={step.title} disabled={busy || loading} onClick={step.action} className="flex flex-col items-center gap-2 rounded-xl p-3 text-xs hover:bg-[var(--surface-hover)] sm:flex-row sm:justify-center sm:text-sm"><span className={`grid size-7 shrink-0 place-items-center rounded-full ${step.done ? "bg-[var(--success-soft)] text-[var(--success)]" : "bg-[var(--surface-muted)] text-[var(--muted-foreground)]"}`}>{step.done ? <Check className="size-4" /> : index + 1}</span>{step.title}</button>)}</div>
        <Card className="p-5 sm:p-7"><div className="flex items-center justify-between gap-4"><h2 className="font-medium">{active.length ? `${active.length} 个可用项目` : "还没有项目"}</h2><Button variant="ghost" size="sm" onClick={onAdd}><FolderPlus />添加项目</Button></div>{active.length > 0 && <div className="mt-3 flex flex-wrap gap-2">{active.map((project) => <button key={project.id} onClick={() => onNavigate("projects")} className="rounded-lg bg-[var(--surface-muted)] px-3 py-2 text-sm">{project.name}</button>)}</div>}
            <div className="mt-6 border-t border-[var(--border)] pt-5"><p className="mb-2 text-xs text-[var(--muted-foreground)]">ChatGPT 连接地址</p>{url ? <div className="flex items-center gap-2"><span className="min-w-0 flex-1 break-all text-sm">{url}</span><Button variant="ghost" size="icon" aria-label="复制连接地址" onClick={() => void navigator.clipboard.writeText(url).then(() => toast.success("连接地址已复制"), () => toast.error("复制失败，请手动复制地址"))}><Copy /></Button></div> : <p className="text-sm text-[var(--muted-foreground)]">完成连接设置后会显示在这里。</p>}</div>
            <div className="mt-6 flex flex-wrap gap-2"><Button disabled={busy || loading} onClick={action}>{!active.length ? <FolderPlus /> : !configured ? <Link2 /> : !running ? <Play /> : <RefreshCw className={busy ? "animate-spin" : ""} />}{busy ? "正在处理…" : actionText}</Button><Button variant="ghost" disabled={busy || loading} onClick={onRepair}><Wrench />检查并修复</Button></div>
        </Card>
        <ConnectionResult result={result} onAction={(target) => target === "start" ? onStart() : target === "projects" ? onAdd() : target === "repair" ? onRepair() : onNavigate("connect")} />
        <p className="mt-5 text-center text-xs text-[var(--muted-foreground)]">{running ? "本机服务正在运行" : "本机服务尚未启动"} · 项目文件保存在这台电脑上</p>
    </div>;
}
