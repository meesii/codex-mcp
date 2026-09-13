import * as React from "react";
import { Check, Folder, FolderOpen, LoaderCircle } from "lucide-react";
import { api, friendlyError, type ProjectSuggestion } from "../api.js";
import { Button, Input, Modal } from "./ui.js";

export function AddProjectDialog({ open, onOpenChange, onAdd, busy }: {
    open: boolean; onOpenChange: (open: boolean) => void; onAdd: (path: string) => Promise<boolean>; busy: boolean;
}): React.JSX.Element {
    const [path, setPath] = React.useState("");
    const [suggestions, setSuggestions] = React.useState<ProjectSuggestion[]>([]);
    const [manual, setManual] = React.useState(false);
    const [picking, setPicking] = React.useState(false);
    const [error, setError] = React.useState("");
    const pickerController = React.useRef<AbortController | undefined>(undefined);
    React.useEffect(() => () => pickerController.current?.abort(), []);
    React.useEffect(() => {
        if (!open) return;
        setPath(""); setError(""); setManual(false);
        let active = true;
        void api<{ suggestions: ProjectSuggestion[] }>("/api/project-suggestions").then((data) => { if (active) setSuggestions(data.suggestions); }).catch(() => { if (active) setSuggestions([]); });
        return () => { active = false; };
    }, [open]);
    async function choose(): Promise<void> {
        setPicking(true); setError("");
        const controller = new AbortController();
        pickerController.current = controller;
        try {
            const result = await api<{ path?: string; unavailable?: boolean }>("/api/project-folder", { method: "POST", body: {}, signal: controller.signal });
            if (result.path) setPath(result.path);
            if (result.unavailable) { setManual(true); setError("暂时无法打开系统选择窗口，可以选择下方项目或粘贴文件夹路径。"); }
        } catch (reason) { if (!controller.signal.aborted) setError(friendlyError(reason)); }
        finally { setPicking(false); }
    }
    async function add(): Promise<void> { if (await onAdd(path)) onOpenChange(false); }
    function close(): void { pickerController.current?.abort(); onOpenChange(false); }
    return <Modal open={open} onOpenChange={(value) => { if (!busy) { if (!value) close(); else onOpenChange(value); } }} title="添加项目" description="选择这台电脑上的项目文件夹，ChatGPT 就可以在其中工作。" footer={<><Button variant="ghost" disabled={busy} onClick={close}>取消</Button><Button disabled={!path.trim() || picking || busy} onClick={() => void add()}>{busy ? "正在添加…" : "添加项目"}</Button></>}>
        <Button className="h-20 w-full justify-start gap-4 rounded-2xl" variant="secondary" onClick={() => void choose()} disabled={picking || busy}>
            {picking ? <LoaderCircle className="animate-spin" /> : <FolderOpen />}
            <span className="text-left"><span className="block">{picking ? "请在系统窗口中选择文件夹" : "选择文件夹"}</span><span className="mt-1 block text-xs font-normal text-[var(--muted-foreground)]">{picking ? "选择窗口会在运行服务的电脑上打开" : "打开系统文件夹选择窗口"}</span></span>
        </Button>
        {path && <div className="mt-4 rounded-xl bg-[var(--success-soft)] p-3 text-sm"><span className="flex items-center gap-2 text-[var(--success)]"><Check className="size-4" />已选择</span><p className="mt-1 break-all text-xs">{path}</p></div>}
        {suggestions.length > 0 && <div className="mt-5"><p className="mb-2 text-xs font-medium text-[var(--muted-foreground)]">最近添加过或在电脑上找到的项目</p><div className="max-h-48 space-y-1 overflow-auto">{suggestions.map((item) => <button key={item.path} disabled={picking || busy} onClick={() => { setPath(item.path); setError(""); }} className="flex w-full items-center gap-3 rounded-xl p-3 text-left hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus)]"><Folder className="size-4 shrink-0" /><span className="min-w-0 flex-1"><span className="block truncate text-sm">{item.name}</span><span className="block truncate text-xs text-[var(--muted-foreground)]">{item.path}</span></span>{path === item.path && <Check className="size-4" />}</button>)}</div></div>}
        <div className="mt-4"><Button variant="ghost" size="sm" onClick={() => setManual(!manual)} disabled={picking || busy}>手动输入路径</Button>{manual && <Input className="mt-2" aria-label="项目文件夹路径" value={path} onChange={(event) => setPath(event.target.value)} placeholder="粘贴项目文件夹的完整路径" />}</div>
        {error && <p role="alert" className="mt-3 text-xs leading-5 text-[var(--warning)]">{error}</p>}
    </Modal>;
}
