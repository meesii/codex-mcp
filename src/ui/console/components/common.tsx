import * as React from "react";
import { Check, CircleAlert, LoaderCircle, XCircle } from "lucide-react";
import { friendlyError, type OperationSnapshot } from "../api.js";
import { Badge, Button, Card } from "./ui.js";

export function PageHeader({ eyebrow, title, description, action }: {
    eyebrow?: string;
    title: string;
    description: string;
    action?: React.ReactNode;
}): React.JSX.Element {
    return (
        <header className="mb-8 flex flex-col gap-5 sm:flex-row sm:items-end sm:justify-between">
            <div>
                {eyebrow && <p className="mb-2 text-xs font-semibold uppercase tracking-[0.12em] text-[var(--muted-foreground)]">{eyebrow}</p>}
                <h1 className="font-display text-[30px] font-semibold tracking-[-0.04em] text-[var(--foreground)] sm:text-[34px]">{title}</h1>
                <p className="mt-2 max-w-2xl text-sm leading-6 text-[var(--muted-foreground)]">{description}</p>
            </div>
            {action}
        </header>
    );
}

export function SectionTitle({ title, description, action }: {
    title: string;
    description?: string;
    action?: React.ReactNode;
}): React.JSX.Element {
    return (
        <div className="flex items-start justify-between gap-4">
            <div>
                <h2 className="font-display text-lg font-semibold tracking-[-0.02em]">{title}</h2>
                {description && <p className="mt-1 text-sm leading-6 text-[var(--muted-foreground)]">{description}</p>}
            </div>
            {action}
        </div>
    );
}

export function SettingRow({ title, description, control, last = false }: {
    title: string;
    description: string;
    control: React.ReactNode;
    last?: boolean;
}): React.JSX.Element {
    return (
        <div className={`flex items-center justify-between gap-5 py-4 ${last ? "" : "border-b border-[var(--border)]"}`}>
            <div className="min-w-0">
                <p className="font-medium">{title}</p>
                <p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">{description}</p>
            </div>
            {control}
        </div>
    );
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }): React.JSX.Element {
    return (
        <div>
            <label className="mb-2 block text-sm font-medium">{label}</label>
            {children}
            {hint && <p className="mt-2 text-xs leading-5 text-[var(--muted-foreground)]">{hint}</p>}
        </div>
    );
}

export function OperationPanel({ operation, onCancel }: {
    operation?: OperationSnapshot;
    onCancel?: (id: string) => void;
}): React.JSX.Element | null {
    if (!operation) return null;
    const presentation = operation.state === "running"
        ? { icon: <LoaderCircle className="size-4 animate-spin" />, tone: "neutral" as const, label: "正在处理" }
        : operation.state === "succeeded"
            ? { icon: <Check className="size-4" />, tone: "success" as const, label: "已完成" }
            : operation.state === "cancelled"
                ? { icon: <CircleAlert className="size-4" />, tone: "warning" as const, label: "已取消" }
                : { icon: <XCircle className="size-4" />, tone: "danger" as const, label: "未完成" };
    return (
        <Card className="mt-5 p-4">
            <div className="flex items-start gap-3">
                <span className="mt-0.5 text-[var(--muted-foreground)]">{presentation.icon}</span>
                <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                        <p className="font-medium">{friendlyPhase(operation.phase)}</p>
                        <Badge tone={presentation.tone}>{presentation.label}</Badge>
                    </div>
                    {operation.messages.length > 0 && (
                        <div className="mt-3 max-h-36 overflow-auto rounded-xl bg-[var(--surface-muted)] p-3 text-xs leading-5 text-[var(--muted-foreground)]">
                            {operation.messages.slice(-8).map((message, index) => <p key={`${index}-${message}`}>{friendlyPhase(message)}</p>)}
                        </div>
                    )}
                    {operation.error && <p className="mt-3 text-sm text-[var(--danger)]">{friendlyError(operation.error)}</p>}
                </div>
                {operation.state === "running" && onCancel && <Button variant="ghost" size="sm" onClick={() => onCancel(operation.id)}>取消</Button>}
            </div>
        </Card>
    );
}

function friendlyPhase(message: string): string {
    const exact: Record<string, string> = {
        "准备中": "正在准备",
        "运行诊断": "正在检查服务",
        "执行安全本机修复": "正在修复常见问题",
        "验证公网连接": "正在检查公网连接",
        "打开 Cloudflare 登录": "正在打开 Cloudflare 登录",
        "读取 Cloudflare 登录": "正在读取 Cloudflare 账户",
        "Cloudflare 域名已读取": "可用域名已读取",
        "正在取消": "正在取消",
        "完成": "操作已完成",
    };
    return exact[message] ?? message;
}

export function EmptyState({ title, description, action }: { title: string; description: string; action?: React.ReactNode }): React.JSX.Element {
    return (
        <div className="flex min-h-56 flex-col items-center justify-center px-6 text-center">
            <div className="mb-4 grid size-10 place-items-center rounded-full bg-[var(--surface-muted)] text-lg">·</div>
            <h3 className="font-display text-base font-semibold">{title}</h3>
            <p className="mt-2 max-w-sm text-sm leading-6 text-[var(--muted-foreground)]">{description}</p>
            {action && <div className="mt-5">{action}</div>}
        </div>
    );
}
