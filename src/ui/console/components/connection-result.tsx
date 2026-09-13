import * as React from "react";
import { Check, CircleAlert, Circle } from "lucide-react";
import type { ConnectionCheck } from "../api.js";
import { Button, Card } from "./ui.js";

export function ConnectionResult({ result, onAction }: { result?: ConnectionCheck; onAction: (action: "start" | "connect" | "projects" | "repair") => void }): React.JSX.Element | null {
    if (!result) return null;
    return <Card className="mt-5 p-5" aria-live="polite"><h2 className="font-medium">{result.ready ? "服务检查通过，可以去 ChatGPT 完成连接" : "还需要完成以下设置"}</h2><div className="mt-4 space-y-4">{result.checks.map((item) => <div key={item.id} className="flex items-start gap-3"><span className={item.state === "passed" ? "text-[var(--success)]" : "text-[var(--warning)]"}>{item.state === "passed" ? <Check className="size-4" /> : item.state === "failed" ? <CircleAlert className="size-4" /> : <Circle className="size-4" />}</span><div className="min-w-0 flex-1"><p className="text-sm font-medium">{item.label}</p><p className="mt-1 text-xs leading-5 text-[var(--muted-foreground)]">{item.detail}</p></div>{item.action && <Button variant="ghost" size="sm" onClick={() => onAction(item.action!)}>去处理</Button>}</div>)}</div><p className="mt-5 border-t border-[var(--border)] pt-3 text-xs leading-5 text-[var(--muted-foreground)]">检查时间 {new Date(result.checkedAt).toLocaleTimeString("zh-CN")}。工具检查使用本机内部连接；ChatGPT 账户授权仍需在 ChatGPT 中完成。</p></Card>;
}
