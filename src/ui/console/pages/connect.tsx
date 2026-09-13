import * as React from "react";
import { Check, Cloud, Copy, KeyRound, Link2, RefreshCw, ShieldCheck, Sparkles, WandSparkles } from "lucide-react";
import { toast } from "sonner";
import type { CapabilityConfig, ConnectionCheck, OperationSnapshot, SetupSummary } from "../api.js";
import { ConnectionResult } from "../components/connection-result.js";
import { Field, OperationPanel, PageHeader, SectionTitle, SettingRow } from "../components/common.js";
import { Badge, Button, Card, Input, Modal, NativeSelect, Switch } from "../components/ui.js";

export function ConnectPage({ setup, result, onResultAction, operation, zones, busy, onCheck, onDiscover, onApplyCloudflare, onApplyExternal, onSavePassword, onGeneratePassword, onSaveCapabilities, onCancelOperation }: {
    result?: ConnectionCheck;
    onResultAction: (action: "start" | "connect" | "projects" | "repair") => void;
    setup?: SetupSummary;
    operation?: OperationSnapshot;
    zones: string[];
    busy: boolean;
    onCheck: () => void;
    onDiscover: () => void;
    onApplyCloudflare: (zone: string, prefix: string, overwrite: boolean) => void;
    onApplyExternal: (domain: string) => void;
    onSavePassword: (password: string) => Promise<void>;
    onGeneratePassword: () => Promise<string | undefined>;
    onSaveCapabilities: (config: CapabilityConfig) => Promise<void>;
    onCancelOperation: (id: string) => void;
}): React.JSX.Element {
    const access = setup?.config.publicAccess;
    const publicUrl = access ? `https://${access.domain}/mcp` : undefined;
    const [cloudflareOpen, setCloudflareOpen] = React.useState(false);
    const [externalOpen, setExternalOpen] = React.useState(false);
    const [passwordOpen, setPasswordOpen] = React.useState(false);
    const [zone, setZone] = React.useState("");
    const [prefix, setPrefix] = React.useState("codex-mcp");
    const [overwrite, setOverwrite] = React.useState(false);
    const [externalDomain, setExternalDomain] = React.useState("");
    const [password, setPassword] = React.useState("");
    const [generatedPassword, setGeneratedPassword] = React.useState("");
    const [capabilities, setCapabilities] = React.useState<CapabilityConfig | undefined>(setup?.capabilities);

    React.useEffect(() => setCapabilities(setup?.capabilities), [setup?.capabilities]);
    React.useEffect(() => {
        if (zones.length > 0 && !zones.includes(zone)) setZone(zones[0] ?? "");
    }, [zone, zones]);

    async function savePassword(): Promise<void> {
        await onSavePassword(password);
        setPassword("");
        setPasswordOpen(false);
    }

    async function generatePassword(): Promise<void> {
        const value = await onGeneratePassword();
        if (value) setGeneratedPassword(value);
    }

    async function copy(value: string): Promise<void> {
        await navigator.clipboard.writeText(value);
        toast.success("已复制到剪贴板");
    }

    function updateSource(id: string, key: "enabled" | "mcp" | "skills", value: boolean): void {
        if (!capabilities) return;
        setCapabilities({
            ...capabilities,
            sources: {
                ...capabilities.sources,
                [id]: { ...capabilities.sources[id], [key]: value },
            },
        });
    }

    return (
        <div>
            <PageHeader eyebrow="外部连接" title="连接 ChatGPT" description="准备一个安全的公网地址和连接密码，让 ChatGPT 能访问你的 MCP 服务。" />

            <Card className="p-5 sm:p-6">
                <div className="flex flex-col gap-5 sm:flex-row sm:items-start">
                    <div className={`status-orb ${access ? "" : "warning"}`}>{access ? <Check className="size-5" /> : <Link2 className="size-5" />}</div>
                    <div className="min-w-0 flex-1">
                        <div className="flex flex-wrap items-center gap-2">
                            <h2 className="font-display text-lg font-semibold">{access ? "ChatGPT 连接地址已准备好" : "还没有 ChatGPT 连接地址"}</h2>
                            <Badge tone={access ? "success" : "warning"}>{access ? "已配置" : "需要设置"}</Badge>
                        </div>
                        <p className="mt-2 text-sm leading-6 text-[var(--muted-foreground)]">
                            {access ? "把下面的地址添加到 ChatGPT 的 MCP 连接设置中。" : "推荐使用自动公网连接；也可以使用已经配置好 HTTPS 的自有域名。"}
                        </p>
                        {publicUrl && (
                            <div className="mt-4 flex max-w-xl items-center gap-2 rounded-xl bg-[var(--surface-muted)] px-3 py-2.5">
                                <code className="technical-code min-w-0 flex-1 text-[var(--foreground)]">{publicUrl}</code>
                                <Button variant="ghost" size="icon" className="size-8" onClick={() => void copy(publicUrl)} aria-label="复制连接地址"><Copy /></Button>
                            </div>
                        )}
                        <div className="mt-5 flex flex-wrap gap-2">
                            <Button onClick={() => setCloudflareOpen(true)}><WandSparkles />自动配置公网连接</Button>
                            <Button variant="secondary" onClick={() => setExternalOpen(true)}>使用自己的域名</Button>
                            {access && <Button variant="ghost" disabled={busy} onClick={onCheck}><RefreshCw />测试连接</Button>}
                        </div>
                    </div>
                </div>
                <OperationPanel operation={operation} onCancel={onCancelOperation} />
            </Card>

            <ConnectionResult result={result} onAction={onResultAction} />
            <div className="mt-6 grid gap-6 lg:grid-cols-2">
                <Card className="p-5 sm:p-6">
                    <SectionTitle title="连接密码" description="ChatGPT 连接时需要输入，防止其他人使用你的服务。" action={<Badge tone={setup?.passwordConfigured ? "success" : "warning"}>{setup?.passwordConfigured ? "已设置" : "尚未设置"}</Badge>} />
                    <div className="mt-6 flex flex-wrap gap-2">
                        <Button variant="secondary" onClick={() => setPasswordOpen(true)}><KeyRound />{setup?.passwordConfigured ? "更换密码" : "设置密码"}</Button>
                        <Button variant="ghost" onClick={() => void generatePassword()}><Sparkles />生成安全密码</Button>
                    </div>
                    {generatedPassword && (
                        <div className="mt-4 rounded-xl bg-[var(--warning-soft)] p-4">
                            <p className="text-xs font-medium text-[var(--warning)]">请立即保存这个密码，离开页面后将不再显示。</p>
                            <div className="mt-2 flex items-center gap-2">
                                <code className="technical-code min-w-0 flex-1 text-[var(--foreground)]">{generatedPassword}</code>
                                <Button variant="ghost" size="icon" className="size-8" onClick={() => void copy(generatedPassword)} aria-label="复制密码"><Copy /></Button>
                            </div>
                        </div>
                    )}
                </Card>

                <Card className="p-5 sm:p-6">
                    <SectionTitle title="连接保护" description="公网访问会要求连接密码；控制面板始终只允许本机打开。" />
                    <div className="mt-6 space-y-4 text-sm">
                        <div className="flex items-center gap-3"><ShieldCheck className="size-4 text-[var(--success)]" /><span>控制面板不会暴露到公网</span></div>
                        <div className="flex items-center gap-3"><ShieldCheck className="size-4 text-[var(--success)]" /><span>所有修改操作都有本机安全校验</span></div>
                        <div className="flex items-center gap-3"><ShieldCheck className="size-4 text-[var(--success)]" /><span>项目之间的数据和任务互相隔离</span></div>
                    </div>
                </Card>
            </div>

            <Card className="mt-6 p-5 sm:p-6">
                <SectionTitle title="可用工具与技能" description="选择 MCP 服务可以读取哪些本机 AI 配置。更改后会自动同步。" />
                {capabilities ? (
                    <div className="mt-5">
                        <SettingRow title="自动同步变化" description="本机配置变化后，无需重启服务。" control={<Switch checked={capabilities.sync === "watch"} onCheckedChange={(checked) => setCapabilities({ ...capabilities, sync: checked ? "watch" : "startup" })} />} />
                        {(["agents", "codex", "claude"] as const).map((id, index) => {
                            const source = capabilities.sources[id];
                            const labels = { agents: "Agent Skills", codex: "Codex", claude: "Claude Code" };
                            const detected = setup?.detections.some((item) => item.label.toLowerCase().includes(id === "agents" ? "agent" : id));
                            return (
                                <div className={`py-4 ${index < 2 ? "border-b border-[var(--border)]" : ""}`} key={id}>
                                    <div className="flex items-center justify-between gap-4">
                                        <div>
                                            <div className="flex items-center gap-2"><p className="font-medium">{labels[id]}</p>{detected && <Badge>已检测到</Badge>}</div>
                                            <p className="mt-1 text-xs text-[var(--muted-foreground)]">允许读取这个来源中的工具和技能。</p>
                                        </div>
                                        <Switch checked={source?.enabled ?? false} onCheckedChange={(value) => updateSource(id, "enabled", value)} />
                                    </div>
                                    {source?.enabled && (
                                        <div className="mt-3 flex flex-wrap gap-4 pl-1 text-xs text-[var(--muted-foreground)]">
                                            {id !== "agents" && <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--primary)]" checked={source.mcp} onChange={(event) => updateSource(id, "mcp", event.target.checked)} />同步 MCP 配置</label>}
                                            <label className="flex items-center gap-2"><input type="checkbox" className="accent-[var(--primary)]" checked={source.skills} onChange={(event) => updateSource(id, "skills", event.target.checked)} />同步技能</label>
                                        </div>
                                    )}
                                </div>
                            );
                        })}
                        <div className="mt-5"><Button onClick={() => void onSaveCapabilities(capabilities)} disabled={busy}>保存工具设置</Button></div>
                    </div>
                ) : <p className="mt-5 text-sm text-[var(--muted-foreground)]">正在读取工具设置…</p>}
            </Card>

            <Modal open={cloudflareOpen} onOpenChange={setCloudflareOpen} title="自动配置公网连接" description="使用 Cloudflare 建立安全连接。首次使用时会打开登录页面。" footer={<><Button variant="ghost" onClick={() => setCloudflareOpen(false)}>取消</Button><Button onClick={() => { setCloudflareOpen(false); onApplyCloudflare(zone, prefix, overwrite); }} disabled={!zone || !prefix.trim() || busy}>开始配置</Button></>}>
                <div className="space-y-5">
                    {zones.length === 0 ? (
                        <Card className="p-4 text-sm leading-6 text-[var(--muted-foreground)]">
                            <Cloud className="mb-3 size-5" />
                            先登录 Cloudflare，控制台会读取你可以使用的域名。
                            <div className="mt-4"><Button variant="secondary" onClick={onDiscover} disabled={busy}>登录并读取域名</Button></div>
                        </Card>
                    ) : (
                        <>
                            <Field label="选择域名"><NativeSelect value={zone} onChange={(event) => setZone(event.target.value)}>{zones.map((item) => <option key={item} value={item}>{item}</option>)}</NativeSelect></Field>
                            <Field label="子域名前缀" hint={`最终地址将类似 ${prefix || "codex-mcp"}.${zone || "example.com"}`}><Input value={prefix} onChange={(event) => setPrefix(event.target.value)} /></Field>
                            <SettingRow title="允许替换同名记录" description="只有该地址已经被其他记录占用时才需要。" control={<Switch checked={overwrite} onCheckedChange={setOverwrite} />} last />
                        </>
                    )}
                </div>
            </Modal>

            <Modal open={externalOpen} onOpenChange={setExternalOpen} title="使用自己的域名" description="该域名必须已经通过 HTTPS 转发到本机 MCP 服务。" footer={<><Button variant="ghost" onClick={() => setExternalOpen(false)}>取消</Button><Button onClick={() => { setExternalOpen(false); onApplyExternal(externalDomain); }} disabled={!externalDomain.trim() || busy}>保存并检查</Button></>}>
                <Field label="HTTPS 域名" hint="只填写域名，不要包含 https:// 或 /mcp"><Input value={externalDomain} onChange={(event) => setExternalDomain(event.target.value)} placeholder="mcp.example.com" /></Field>
            </Modal>

            <Modal open={passwordOpen} onOpenChange={setPasswordOpen} title={setup?.passwordConfigured ? "更换连接密码" : "设置连接密码"} description="至少 12 个字符。更换后，现有 ChatGPT 连接需要重新输入密码。" footer={<><Button variant="ghost" onClick={() => setPasswordOpen(false)}>取消</Button><Button onClick={() => void savePassword()} disabled={password.length < 12 || busy}>保存密码</Button></>}>
                <Field label="新密码"><Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="new-password" placeholder="至少 12 个字符" /></Field>
            </Modal>
        </div>
    );
}
