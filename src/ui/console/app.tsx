import * as React from "react";
import { createRoot } from "react-dom/client";
import { ChevronRight, CircleHelp, FolderKanban, Home, Info, Link2, Menu, PanelLeftClose, RefreshCw, TerminalSquare, Wrench } from "lucide-react";
import { Toaster, toast } from "sonner";
import {
    api,
    consoleVersion,
    followOperation,
    friendlyError,
    type CapabilityConfig,
    type ControllerStatus,
    type ConnectionCheck,
    type Conversation,
    type OperationSnapshot,
    type Project,
    type SetupSummary,
} from "./api.js";
import { Badge, Button, Card, Modal, Sheet } from "./components/ui.js";
import { ConnectPage } from "./pages/connect.js";
import { HomePage } from "./pages/home.js";
import { MaintenancePage } from "./pages/maintenance.js";
import { ProjectsPage } from "./pages/projects.js";
import { AddProjectDialog } from "./components/add-project.js";

type Page = "home" | "projects" | "connect" | "maintenance";
type OperationScope = "connect" | "maintenance";

interface ConfirmState {
    title: string;
    description: string;
    confirmLabel: string;
    danger?: boolean;
    action: () => unknown | Promise<unknown>;
}

const navigation: Array<{ id: Page; label: string; icon: React.ComponentType<{ className?: string }> }> = [
    { id: "home", label: "首页", icon: Home },
    { id: "projects", label: "项目", icon: FolderKanban },
    { id: "connect", label: "连接 ChatGPT", icon: Link2 },
    { id: "maintenance", label: "系统维护", icon: Wrench },
];

function App(): React.JSX.Element {
    const [page, setPage] = React.useState<Page>("home");
    const [addOpen, setAddOpen] = React.useState(false);
    const [connectionResult, setConnectionResult] = React.useState<ConnectionCheck>();
    const [conversations, setConversations] = React.useState<Conversation[]>([]);
    const [status, setStatus] = React.useState<ControllerStatus>();
    const [projects, setProjects] = React.useState<Project[]>([]);
    const [setup, setSetup] = React.useState<SetupSummary>();
    const [loading, setLoading] = React.useState(true);
    const [busy, setBusy] = React.useState(false);
    const [loadError, setLoadError] = React.useState("");
    const [detailsOpen, setDetailsOpen] = React.useState(false);
    const [mobileOpen, setMobileOpen] = React.useState(false);
    const [confirm, setConfirm] = React.useState<ConfirmState>();
    const [zones, setZones] = React.useState<string[]>([]);
    const [operations, setOperations] = React.useState<Partial<Record<OperationScope, OperationSnapshot>>>({});
    const operationCleanups = React.useRef(new Map<string, () => void>());

    const refreshAll = React.useCallback(async (showError = true) => {
        const results = await Promise.allSettled([
            api<ControllerStatus>("/api/controller/status"),
            api<{ projects: Project[] }>("/api/projects"),
            api<SetupSummary>("/api/setup/summary"),
            api<{ conversations: Conversation[] }>("/api/project-conversations"),
        ]);
        if (results[0].status === "fulfilled") setStatus(results[0].value);
        if (results[1].status === "fulfilled") setProjects(results[1].value.projects ?? []);
        if (results[2].status === "fulfilled") setSetup(results[2].value);
        if (results[3].status === "fulfilled") setConversations(results[3].value.conversations);
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed && showError) setLoadError(friendlyError(failed.reason));
        else if (!failed) setLoadError("");
        setLoading(false);
    }, []);

    React.useEffect(() => {
        void refreshAll();
        const timer = window.setInterval(() => {
            void api<ControllerStatus>("/api/controller/status").then(setStatus).catch(() => undefined);
            void api<{ projects: Project[] }>("/api/projects").then((data) => setProjects(data.projects)).catch(() => undefined);
            void api<{ conversations: Conversation[] }>("/api/project-conversations").then((data) => setConversations(data.conversations)).catch(() => undefined);
        }, 5000);
        return () => {
            window.clearInterval(timer);
            for (const cleanup of operationCleanups.current.values()) cleanup();
        };
    }, [refreshAll]);

    const checkContext = JSON.stringify([status?.runtime.running, status?.runtime.runtime?.pid, setup?.config.publicAccess, setup?.passwordConfigured, projects.map((project) => [project.id, project.active])]);
    React.useEffect(() => { setConnectionResult(undefined); }, [checkContext]);

    function navigate(next: Page): void {
        setPage(next);
        setMobileOpen(false);
    }

    async function runAction(action: () => Promise<void>, successMessage?: string): Promise<boolean> {
        setBusy(true);
        try {
            await action();
            if (successMessage) toast.success(successMessage);
            return true;
        } catch (error) {
            toast.error(friendlyError(error));
            return false;
        } finally {
            setBusy(false);
        }
    }

    async function startOperation(
        scope: OperationScope,
        path: string,
        body: unknown,
        successMessage: string,
        onDone?: (result: unknown) => void | Promise<void>,
    ): Promise<void> {
        setBusy(true);
        try {
            const response = await api<{ operation: OperationSnapshot }>(path, { method: "POST", body });
            const cleanup = followOperation(
                response.operation,
                (snapshot) => setOperations((current) => ({ ...current, [scope]: snapshot })),
                (snapshot) => {
                    operationCleanups.current.delete(snapshot.id);
                    setBusy(false);
                    if (snapshot.state === "succeeded") {
                        toast.success(successMessage);
                        void onDone?.(snapshot.result);
                    } else if (snapshot.state === "failed") {
                        toast.error(friendlyError(snapshot.error ?? "操作未完成"));
                    }
                },
            );
            operationCleanups.current.set(response.operation.id, cleanup);
        } catch (error) {
            setBusy(false);
            toast.error(friendlyError(error));
        }
    }

    function requestConfirm(state: ConfirmState): void {
        setConfirm(state);
    }

    async function confirmAction(): Promise<void> {
        const action = confirm?.action;
        setConfirm(undefined);
        if (action) await action();
    }

    function startRuntime(): void {
        const hasPublicAccess = Boolean(setup?.config.publicAccess);
        void runAction(async () => {
            setConnectionResult(undefined);
            await api("/api/runtime/start", {
                method: "POST",
                body: { local: !hasPublicAccess, noTunnel: !hasPublicAccess, tunnelLogs: false, intentSpecified: true },
            });
            await refreshAll(false);
        }, "MCP 服务已启动");
    }

    function restartRuntime(): void {
        void runAction(async () => {
            setConnectionResult(undefined);
            await api("/api/runtime/restart", { method: "POST", body: {} });
            await refreshAll(false);
        }, "MCP 服务已重新启动");
    }

    function stopRuntime(): void {
        requestConfirm({
            title: "停止 MCP 服务？",
            description: "ChatGPT 和其他客户端将暂时无法使用项目。控制面板会继续运行，你可以随时重新启动。",
            confirmLabel: "停止服务",
            danger: true,
            action: () => runAction(async () => {
                setConnectionResult(undefined);
                await api("/api/runtime/stop", { method: "POST", body: {} });
                await refreshAll(false);
            }, "MCP 服务已停止"),
        });
    }

    async function addProject(path: string): Promise<boolean> {
        return await runAction(async () => {
            await api("/api/projects", { method: "POST", body: { path } });
            setConnectionResult(undefined);
            await refreshAll(false);
        }, "项目已添加");
    }

    function removeProject(project: Project): void {
        requestConfirm({
            title: `停用“${project.name}”？`,
            description: "这个项目将不能再被 AI 使用，已有会话连接也会被清除。项目文件不会被删除。",
            confirmLabel: "停用项目",
            danger: true,
            action: () => runAction(async () => {
                setConnectionResult(undefined);
                await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE", body: {} });
                await refreshAll(false);
            }, "项目已停用"),
        });
    }

    function discoverCloudflare(): void {
        void startOperation("connect", "/api/setup/cloudflare/discover", { forceLogin: true }, "已读取可用域名", (result) => {
            const discovery = result as { zones?: string[] } | undefined;
            setZones(discovery?.zones ?? []);
        });
    }

    function applyCloudflare(zone: string, prefix: string, overwrite: boolean): void {
        const action = () => startOperation("connect", "/api/setup/public/cloudflare", { zone, prefix, allowDnsOverwrite: overwrite }, "ChatGPT 连接地址已配置", () => refreshAll(false));
        if (!overwrite) {
            void action();
            return;
        }
        requestConfirm({
            title: "允许替换同名地址记录？",
            description: `如果 ${prefix}.${zone} 已被其他服务使用，原有地址记录会被替换。`,
            confirmLabel: "允许并继续",
            danger: true,
            action,
        });
    }

    function applyExternal(domain: string): void {
        void startOperation("connect", "/api/setup/public/external", { domain }, "自有域名已保存并通过检查", () => refreshAll(false));
    }

    function checkPublicAccess(): void {
        void runAction(async () => {
            setConnectionResult(undefined);
            setConnectionResult(await api<ConnectionCheck>("/api/connection-check", { method: "POST", body: {} }));
        });
    }

    async function savePassword(password: string): Promise<void> {
        await runAction(async () => {
            setConnectionResult(undefined);
            await api("/api/auth/password", { method: "POST", body: { password } });
            await refreshAll(false);
        }, "连接密码已保存");
    }

    async function generatePassword(): Promise<string | undefined> {
        let password: string | undefined;
        await runAction(async () => {
            const result = await api<{ password: string }>("/api/auth/generate", { method: "POST", body: {} });
            password = result.password;
            await refreshAll(false);
        }, "安全密码已生成");
        return password;
    }

    async function saveCapabilities(config: CapabilityConfig): Promise<void> {
        await runAction(async () => {
            const sources = { ...config.sources, agents: { ...config.sources.agents, mcp: false } };
            await api("/api/setup/capabilities", { method: "POST", body: { config: { ...config, priority: ["agents", "codex", "claude"], sources } } });
            await refreshAll(false);
        }, "工具设置已保存");
    }

    function runDoctor(fix: boolean): void {
        const action = () => startOperation("maintenance", "/api/doctor", { fix }, fix ? "检查和修复已完成" : "服务检查已完成");
        if (!fix) {
            void action();
            return;
        }
        requestConfirm({
            title: "检查并修复常见问题？",
            description: "控制台只会创建缺失目录、清理失效状态等安全操作，不会删除项目或配置。",
            confirmLabel: "开始检查并修复",
            action,
        });
    }

    function selfUpdate(): void {
        requestConfirm({
            title: "检查并安装最新版本？",
            description: "更新期间 MCP 服务和控制面板会短暂重启。项目和连接设置都会保留。",
            confirmLabel: "检查并更新",
            action: () => startOperation("maintenance", "/api/update", {}, "新版本已安装", (result) => {
                const update = result as { reloadUrl?: string } | undefined;
                if (update?.reloadUrl) window.setTimeout(() => { window.location.href = update.reloadUrl!; }, 800);
            }),
        });
    }

    function cancelOperation(id: string): void {
        void runAction(async () => {
            await api(`/api/operations/${encodeURIComponent(id)}`, { method: "DELETE", body: {} });
        }, "正在取消操作");
    }

    const running = status?.runtime.running === true;
    const pageTitle = navigation.find((item) => item.id === page)?.label ?? "首页";

    return (
        <div className="app-shell">
            <aside className="fixed inset-y-0 left-0 z-30 hidden w-[260px] border-r border-[var(--border)] bg-[var(--sidebar)] lg:block">
                <SidebarContent page={page} projects={projects} onNavigate={navigate} onDetails={() => setDetailsOpen(true)} />
            </aside>

            <Sheet open={mobileOpen} onOpenChange={setMobileOpen} title="codex-mcp" description="本机 MCP 工作区" side="left">
                <SidebarContent page={page} projects={projects} onNavigate={navigate} onDetails={() => { setMobileOpen(false); setDetailsOpen(true); }} compact />
            </Sheet>

            <main className="min-h-screen lg:pl-[260px]">
                <header className="sticky top-0 z-20 flex h-14 items-center gap-3 border-b border-[var(--border)] bg-[color-mix(in_srgb,var(--background)_88%,transparent)] px-4 backdrop-blur-xl sm:px-6">
                    <Button className="lg:hidden" variant="ghost" size="icon" onClick={() => setMobileOpen(true)} aria-label="打开导航"><Menu /></Button>
                    <h2 className="font-display font-semibold tracking-[-0.02em]">{pageTitle}</h2>
                    <div className="ml-auto flex items-center gap-2">
                        <Badge tone={loading ? "neutral" : running ? "success" : "warning"} className="hidden sm:inline-flex">
                            <span className={`mr-1.5 size-1.5 rounded-full ${running ? "bg-[var(--success)]" : "bg-[var(--warning)]"}`} />
                            {loading ? "正在连接" : running ? (connectionResult?.ready ? "检查已通过" : "服务运行中") : "服务未启动"}
                        </Badge>
                        <Button variant="ghost" size="icon" onClick={() => void refreshAll()} aria-label="刷新"><RefreshCw /></Button>
                        <Button variant="ghost" size="icon" onClick={() => setDetailsOpen(true)} aria-label="查看技术详情"><Info /></Button>
                    </div>
                </header>

                {loadError && (
                    <div className="mx-auto mt-5 max-w-5xl px-4 sm:px-8">
                        <div className="rounded-xl bg-[var(--danger-soft)] px-4 py-3 text-sm text-[var(--danger)]">{loadError}</div>
                    </div>
                )}

                <div className="mx-auto max-w-5xl px-4 py-7 sm:px-8 sm:py-10">
                    {page === "home" && <HomePage status={status} setup={setup} projects={projects} loading={loading} busy={busy} result={connectionResult} onNavigate={navigate} onAdd={() => setAddOpen(true)} onStart={startRuntime} onCheck={checkPublicAccess} onRepair={() => { navigate("maintenance"); runDoctor(true); }} />}
                    {page === "projects" && <ProjectsPage projects={projects} conversations={conversations} busy={busy} onAdd={() => setAddOpen(true)} onRemove={removeProject} />}
                    {page === "connect" && <ConnectPage setup={setup} result={connectionResult} onResultAction={(action) => action === "start" ? startRuntime() : action === "projects" ? setAddOpen(true) : action === "repair" ? navigate("maintenance") : undefined} operation={operations.connect} zones={zones} busy={busy} onCheck={checkPublicAccess} onDiscover={discoverCloudflare} onApplyCloudflare={applyCloudflare} onApplyExternal={applyExternal} onSavePassword={savePassword} onGeneratePassword={generatePassword} onSaveCapabilities={saveCapabilities} onCancelOperation={cancelOperation} />}
                    {page === "maintenance" && <MaintenancePage operation={operations.maintenance} busy={busy} onDoctor={runDoctor} onUpdate={selfUpdate} onCancelOperation={cancelOperation} />}
                </div>
            </main>

            <AddProjectDialog open={addOpen} onOpenChange={setAddOpen} onAdd={addProject} busy={busy} />
            <TechnicalDetails open={detailsOpen} onOpenChange={setDetailsOpen} status={status} setup={setup} onMaintenance={() => { setDetailsOpen(false); navigate("maintenance"); }} onRestart={restartRuntime} onStop={stopRuntime} busy={busy} />
            <Modal open={Boolean(confirm)} onOpenChange={(open) => { if (!open) setConfirm(undefined); }} title={confirm?.title ?? "确认操作"} description={confirm?.description} footer={<><Button variant="ghost" onClick={() => setConfirm(undefined)}>取消</Button><Button variant={confirm?.danger ? "danger" : "default"} onClick={() => void confirmAction()}>{confirm?.confirmLabel ?? "确认"}</Button></>} />
            <Toaster position="top-center" richColors closeButton theme="system" />
        </div>
    );
}

function SidebarContent({ page, projects, onNavigate, onDetails, compact = false }: {
    page: Page;
    projects: Project[];
    onNavigate: (page: Page) => void;
    onDetails: () => void;
    compact?: boolean;
}): React.JSX.Element {
    return (
        <div className={`flex h-full flex-col ${compact ? "-mx-2 -mb-3" : "p-3"}`}>
            {!compact && (
                <div className="mb-4 flex items-center gap-3 px-2 py-2">
                    <span className="grid size-8 place-items-center rounded-xl bg-[var(--foreground)] text-xs font-bold text-[var(--background)]">C</span>
                    <div><p className="font-display font-semibold tracking-[-0.02em]">codex-mcp</p><p className="text-[11px] text-[var(--muted-foreground)]">本机工作区</p></div>
                    <PanelLeftClose className="ml-auto size-4 text-[var(--muted-foreground)]" />
                </div>
            )}
            <nav className="space-y-1" aria-label="主导航">
                {navigation.filter((item) => item.id !== "maintenance").map((item) => {
                    const Icon = item.icon;
                    return (
                        <button key={item.id} onClick={() => onNavigate(item.id)} className={`flex h-10 w-full items-center gap-3 rounded-xl px-3 text-left text-sm transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus)] ${page === item.id ? "bg-[var(--surface-hover)] font-medium text-[var(--foreground)]" : "text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"}`}>
                            <Icon className="size-4" /><span>{item.label}</span>
                        </button>
                    );
                })}
            </nav>
            <div className="sidebar-scrollbar mt-6 min-h-0 flex-1 overflow-y-auto px-1">
                <div className="mb-2 flex items-center justify-between px-2"><p className="text-xs font-medium text-[var(--muted-foreground)]">最近项目</p><button onClick={() => onNavigate("projects")} className="rounded p-1 text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)]" aria-label="查看项目"><ChevronRight className="size-3.5" /></button></div>
                {projects.filter((project) => project.active).slice(0, 8).map((project) => (
                    <button key={project.id} onClick={() => onNavigate("projects")} className="flex w-full items-center gap-2 truncate rounded-lg px-2 py-2 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]">
                        <span className="size-1.5 shrink-0 rounded-full bg-[var(--success)]" /><span className="truncate">{project.name}</span>
                    </button>
                ))}
                {projects.filter((project) => project.active).length === 0 && <p className="px-2 py-2 text-xs leading-5 text-[var(--muted-foreground)]">添加项目后会显示在这里。</p>}
            </div>
            <div className="border-t border-[var(--border)] pt-3">
                <button onClick={onDetails} className="flex w-full items-center gap-3 rounded-xl px-3 py-2.5 text-left text-xs text-[var(--muted-foreground)] hover:bg-[var(--surface-hover)] hover:text-[var(--foreground)]"><CircleHelp className="size-4" />技术详情与命令行</button>
                <p className="px-3 pt-2 text-[10px] text-[var(--muted-foreground)]">版本 {consoleVersion}</p>
            </div>
        </div>
    );
}

function TechnicalDetails({ open, onOpenChange, status, setup, onMaintenance, onRestart, onStop, busy }: {
    open: boolean;
    onOpenChange: (open: boolean) => void;
    status?: ControllerStatus;
    setup?: SetupSummary;
    onMaintenance: () => void;
    onRestart: () => void;
    onStop: () => void;
    busy: boolean;
}): React.JSX.Element {
    const live = status?.runtime.runtime;
    return (
        <Sheet open={open} onOpenChange={onOpenChange} title="技术详情" description="这些信息主要用于开发和排查问题。">
            <div className="space-y-6">
                <div className="flex flex-wrap gap-2"><Button variant="secondary" onClick={onMaintenance}>日志、检查与更新</Button><Button variant="ghost" disabled={busy || !status?.runtime.running} onClick={onRestart}>重新启动</Button><Button variant="ghost" disabled={busy || !status?.runtime.running} onClick={onStop}>停止服务</Button></div>
                <Card className="divide-y divide-[var(--border)] px-4">
                    <DetailRow label="控制面板服务" value={status ? `运行中 · PID ${status.pid}` : "正在读取"} />
                    <DetailRow label="MCP 服务" value={status?.runtime.running ? `运行中 · PID ${live?.pid}` : "未启动"} />
                    <DetailRow label="运行方式" value={live?.mode === "local" ? "仅本机" : live?.mode ?? "—"} />
                    <DetailRow label="公网连接" value={live?.publicMcpUrl ? "已连接" : "未连接"} />
                    <DetailRow label="登录保护" value={live?.auth?.required ? (live.auth.configured ? "已启用" : "等待设置密码") : "仅本机，无需登录"} />
                </Card>
                <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground)]">连接地址</p>
                    <Card className="space-y-4 p-4">
                        <CodeValue label="本机连接地址" value={live?.localUrl ?? "—"} />
                        <CodeValue label="ChatGPT 连接地址" value={live?.publicMcpUrl ?? (setup?.config.publicAccess ? `https://${setup.config.publicAccess.domain}/mcp` : "—")} />
                    </Card>
                </div>
                <div>
                    <p className="mb-2 text-xs font-semibold uppercase tracking-[0.1em] text-[var(--muted-foreground)]">常用命令</p>
                    <Card className="space-y-3 p-4 technical-code">
                        <CommandRow command="codex-mcp status" description="查看状态" />
                        <CommandRow command="codex-mcp start" description="启动服务" />
                        <CommandRow command="codex-mcp logs -f" description="跟随日志" />
                        <CommandRow command="codex-mcp doctor" description="检查问题" />
                    </Card>
                </div>
            </div>
        </Sheet>
    );
}

function DetailRow({ label, value }: { label: string; value: string }): React.JSX.Element {
    return <div className="flex items-center justify-between gap-4 py-3.5"><span className="text-sm text-[var(--muted-foreground)]">{label}</span><span className="text-right text-sm font-medium">{value}</span></div>;
}

function CodeValue({ label, value }: { label: string; value: string }): React.JSX.Element {
    return <div><p className="mb-1 text-xs text-[var(--muted-foreground)]">{label}</p><code className="technical-code text-[var(--foreground)]">{value}</code></div>;
}

function CommandRow({ command, description }: { command: string; description: string }): React.JSX.Element {
    return <div className="flex items-center gap-3"><TerminalSquare className="size-3.5 text-[var(--muted-foreground)]" /><code className="min-w-0 flex-1">{command}</code><span className="font-sans text-[11px] text-[var(--muted-foreground)]">{description}</span></div>;
}

const root = document.getElementById("console-root");
if (!root) throw new Error("Console root is missing");
createRoot(root).render(<App />);
