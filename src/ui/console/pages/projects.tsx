import * as React from "react";
import { Folder, FolderPlus, MessageSquare } from "lucide-react";
import type { Conversation, Project } from "../api.js";
import { EmptyState, PageHeader } from "../components/common.js";
import { Badge, Button, Card } from "../components/ui.js";

export function ProjectsPage({ projects, conversations, busy, onAdd, onRemove }: {
    projects: Project[]; conversations: Conversation[]; busy: boolean; onAdd: () => void; onRemove: (project: Project) => void;
}): React.JSX.Element {
    return <div>
        <PageHeader title="你的项目" description="选择 ChatGPT 可以使用的文件夹。每个会话独立选择项目，你可以同时处理不同项目。" action={<Button onClick={onAdd}><FolderPlus />添加项目</Button>} />
        {projects.length === 0 ? <Card><EmptyState title="先选一个项目" description="打开文件夹选择窗口，选中你想让 ChatGPT 帮忙的项目。" action={<Button onClick={onAdd}><FolderPlus />选择项目文件夹</Button>} /></Card> : <div className="space-y-4">{projects.map((project) => {
            const bindings = conversations.filter((item) => item.projectId === project.id);
            return <Card className="overflow-hidden" key={project.id}>
                <div className="flex items-start gap-4 p-5"><span className="grid size-10 shrink-0 place-items-center rounded-xl bg-[var(--surface-muted)]"><Folder className="size-5" /></span><div className="min-w-0 flex-1"><div className="flex flex-wrap items-center gap-2"><h2 className="font-medium">{project.name}</h2><Badge tone={project.active ? "success" : "neutral"}>{project.active ? "可用" : "已停用"}</Badge></div><p className="mt-2 break-all text-xs text-[var(--muted-foreground)]">{project.path}</p></div>{project.active && <Button disabled={busy} variant="ghost" size="sm" onClick={() => onRemove(project)}>停用</Button>}</div>
                {project.active && <div className="border-t border-[var(--border)] px-5 py-4"><p className="flex items-center gap-2 text-xs text-[var(--muted-foreground)]"><MessageSquare className="size-3.5" />{bindings.length ? `${bindings.length} 个会话选择过这个项目` : "还没有会话选择这个项目"}</p>{bindings.length > 0 ? <ul className="mt-3 space-y-2">{bindings.map((item) => <li key={item.id} className="flex flex-wrap justify-between gap-2 text-xs"><span>{item.label} · {item.id.slice(0, 6)}</span><span className="text-[var(--muted-foreground)]">最近使用 {new Date(item.lastSeenAt).toLocaleString("zh-CN", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })}</span></li>)}</ul> : <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">连接后，在 ChatGPT 中说“使用 {project.name} 项目”即可。</p>}</div>}
            </Card>;
        })}</div>}
        {conversations.length > 0 && <p className="mt-5 text-xs leading-5 text-[var(--muted-foreground)]">这里只显示项目选择记录，不代表会话正在运行。ChatGPT 不提供聊天标题，使用编号区分会话。</p>}
    </div>;
}
