import * as React from "react";
import { Check, Download, FileText, RefreshCw, Stethoscope, TriangleAlert, Wrench } from "lucide-react";
import { api, friendlyError, type OperationSnapshot } from "../api.js";
import { OperationPanel, PageHeader, SectionTitle } from "../components/common.js";
import { Badge, Button, Card, Input, Tabs, TabsContent, TabsList, TabsTrigger } from "../components/ui.js";

interface DoctorResult {
    fixes?: string[];
    report?: { checks?: Array<{ level: "ok" | "warn" | "error"; label: string; detail: string }> };
}

export function MaintenancePage({ operation, busy, onDoctor, onUpdate, onCancelOperation }: {
    operation?: OperationSnapshot;
    busy: boolean;
    onDoctor: (fix: boolean) => void;
    onUpdate: () => void;
    onCancelOperation: (id: string) => void;
}): React.JSX.Element {
    const [tab, setTab] = React.useState("check");
    const [lines, setLines] = React.useState("100");
    const [logs, setLogs] = React.useState("尚未读取日志。\n");
    const [logError, setLogError] = React.useState("");
    const doctor = operation?.kind.startsWith("doctor") && operation.result ? operation.result as DoctorResult : undefined;

    const readLogs = React.useCallback(async () => {
        try {
            const count = Math.max(1, Math.min(5000, Number.parseInt(lines, 10) || 100));
            setLines(String(count));
            const result = await api<{ text: string }>(`/api/logs?lines=${count}`);
            setLogs(result.text || "当前没有运行日志。\n");
            setLogError("");
        } catch (error) {
            setLogError(friendlyError(error));
        }
    }, [lines]);

    React.useEffect(() => {
        if (tab !== "logs") return;
        void readLogs();
        const source = new EventSource("/api/logs/stream");
        source.addEventListener("logs", (event) => {
            const data = JSON.parse((event as MessageEvent).data) as { text?: string };
            setLogs(data.text || "当前没有运行日志。\n");
        });
        return () => source.close();
    }, [readLogs, tab]);

    return (
        <div>
            <PageHeader eyebrow="本机服务" title="系统维护" description="检查服务问题、查看运行记录，或安装新版本。日常使用通常不需要打开这里。" />
            <Tabs value={tab} onValueChange={setTab}>
                <TabsList className="mb-6 w-full justify-start overflow-x-auto sm:w-auto">
                    <TabsTrigger value="check"><Stethoscope className="mr-2 inline size-4" />检查与修复</TabsTrigger>
                    <TabsTrigger value="logs"><FileText className="mr-2 inline size-4" />运行日志</TabsTrigger>
                    <TabsTrigger value="update"><Download className="mr-2 inline size-4" />软件更新</TabsTrigger>
                </TabsList>

                <TabsContent value="check" className="outline-none">
                    <Card className="p-5 sm:p-6">
                        <SectionTitle title="检查服务状态" description="检查本机环境、配置文件和连接状态，不会修改任何内容。" action={<Button onClick={() => onDoctor(false)} disabled={busy}><Stethoscope />开始检查</Button>} />
                        <div className="mt-4 flex flex-wrap items-center gap-2 border-t border-[var(--border)] pt-4">
                            <p className="mr-auto text-xs text-[var(--muted-foreground)]">如果检查发现常见问题，可以让控制台进行安全修复。</p>
                            <Button variant="secondary" onClick={() => onDoctor(true)} disabled={busy}><Wrench />检查并修复</Button>
                        </div>
                        {operation?.kind.startsWith("doctor") && <OperationPanel operation={operation} onCancel={onCancelOperation} />}
                    </Card>
                    {doctor?.report?.checks && (
                        <Card className="mt-6 overflow-hidden">
                            <div className="border-b border-[var(--border)] px-5 py-4"><h2 className="font-display text-lg font-semibold">检查结果</h2></div>
                            {doctor.fixes?.map((fix) => <CheckRow key={fix} level="ok" title="已完成修复" detail={fix} />)}
                            {doctor.report.checks.map((check) => {
                                const friendly = friendlyCheck(check.label, check.detail);
                                return <CheckRow key={`${check.label}-${check.detail}`} level={check.level} title={friendly.title} detail={friendly.detail} />;
                            })}
                        </Card>
                    )}
                </TabsContent>

                <TabsContent value="logs" className="outline-none">
                    <Card className="p-5 sm:p-6">
                        <div className="mb-4 flex flex-col gap-3 sm:flex-row sm:items-center">
                            <SectionTitle title="运行日志" description="用于排查服务启动、项目工具和公网连接问题。" />
                            <div className="ml-auto flex items-center gap-2">
                                <Input className="w-24" type="number" min="1" max="5000" value={lines} onChange={(event) => setLines(event.target.value)} aria-label="日志行数" />
                                <Button variant="secondary" onClick={() => void readLogs()}><RefreshCw />重新读取</Button>
                            </div>
                        </div>
                        {logError && <p className="mb-3 text-sm text-[var(--danger)]">{logError}</p>}
                        <pre className="log-view">{logs}</pre>
                    </Card>
                </TabsContent>

                <TabsContent value="update" className="outline-none">
                    <Card className="p-5 sm:p-6">
                        <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                            <span className="grid size-11 shrink-0 place-items-center rounded-2xl bg-[var(--surface-muted)]"><Download className="size-5" /></span>
                            <div className="min-w-0 flex-1">
                                <SectionTitle title="安装最新版本" description="更新会短暂重启 MCP 服务和控制面板。项目、连接设置和密码都会保留。" action={<Button onClick={onUpdate} disabled={busy}>检查并更新</Button>} />
                                {operation?.kind === "update" && <OperationPanel operation={operation} onCancel={onCancelOperation} />}
                            </div>
                        </div>
                    </Card>
                </TabsContent>
            </Tabs>
        </div>
    );
}

function friendlyCheck(label: string, detail: string): { title: string; detail: string } {
    const titles: Record<string, string> = {
        "Node.js": "运行环境",
        "Git": "Git 工具",
        "文件搜索": "文件搜索",
        "配置文件": "本机设置",
        "外部能力": "可用工具与技能",
        "连接密码": "连接密码",
        "公网地址": "ChatGPT 连接地址",
        "守护进程": "MCP 服务",
    };
    if (label === "连接密码" && /未设置/.test(detail)) {
        return { title: titles[label]!, detail: "尚未设置。请前往“连接 ChatGPT”页面完成。" };
    }
    if (label === "公网地址" && /未设置/.test(detail)) {
        return { title: titles[label]!, detail: "尚未设置。配置后才能从 ChatGPT 网页端连接。" };
    }
    if (label === "守护进程" && /^pid\s/i.test(detail)) {
        return { title: titles[label]!, detail: "服务正在本机运行。" };
    }
    if (label === "配置文件") {
        return { title: titles[label]!, detail: "设置文件可以正常读取。" };
    }
    return { title: titles[label] ?? label, detail };
}

function CheckRow({ level, title, detail }: { level: "ok" | "warn" | "error"; title: string; detail: string }): React.JSX.Element {
    const config = level === "ok"
        ? { icon: <Check />, tone: "success" as const, label: "正常" }
        : level === "warn"
            ? { icon: <TriangleAlert />, tone: "warning" as const, label: "需要注意" }
            : { icon: <TriangleAlert />, tone: "danger" as const, label: "需要处理" };
    return (
        <div className="flex gap-4 border-b border-[var(--border)] p-5 last:border-0">
            <span className="mt-0.5 text-[var(--muted-foreground)] [&_svg]:size-4">{config.icon}</span>
            <div className="min-w-0 flex-1"><p className="font-medium">{title}</p><p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">{detail}</p></div>
            <Badge tone={config.tone}>{config.label}</Badge>
        </div>
    );
}
