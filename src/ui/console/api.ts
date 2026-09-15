export interface RuntimeIntent {
    local: boolean;
    noTunnel: boolean;
    tunnelLogs: boolean;
}

export interface RuntimeInfo {
    pid: number;
    version: string;
    mode: string;
    localUrl: string;
    publicMcpUrl?: string;
    runtimeIntent: RuntimeIntent;
    tunnel?: { state?: string };
    auth?: { required?: boolean; configured?: boolean };
}

export interface ControllerStatus {
    pid: number;
    version: string;
    uptimeMs: number;
    runtime: { running: boolean; runtime?: RuntimeInfo; projects: Project[] };
}

export interface Project {
    id: string;
    name: string;
    path: string;
    active: boolean;
    boundSessions?: number;
}

export interface Conversation { id: string; projectId: string; label: string; lastSeenAt: string; }
export interface ProjectSuggestion { name: string; path: string; source: "recent" | "discovered"; }
export interface ConnectionCheck {
    checkedAt: string;
    ready: boolean;
    checks: Array<{ id: string; label: string; state: "passed" | "failed" | "pending"; detail: string; action?: "start" | "connect" | "projects" | "repair" }>;
}

export interface CapabilitySource {
    enabled: boolean;
    mcp: boolean;
    skills: boolean;
}

export interface CapabilityConfig {
    sync: "watch" | "startup";
    priority: string[];
    sources: Record<string, CapabilitySource>;
}

export interface SetupConfigState {
    publicAccess?: { kind: "external" | "cloudflare"; domain: string };
    runtime?: { mode: "local" | "public"; noTunnel?: boolean; tunnelLogs?: boolean };
}

export interface SetupSummary {
    config: SetupConfigState;
    passwordConfigured: boolean;
    capabilities: CapabilityConfig;
    detections: Array<{ id?: string; label: string; detected: boolean }>;
}

export interface ConsoleSnapshot {
    status: ControllerStatus;
    setup: { config: SetupConfigState; passwordConfigured: boolean };
    conversations: Conversation[];
}

export interface OperationSnapshot {
    id: string;
    kind: string;
    state: "running" | "succeeded" | "failed" | "cancelled";
    phase: string;
    messages: string[];
    result?: unknown;
    error?: string;
}

const root = document.getElementById("console-root");
const csrf = root?.dataset.csrfToken ?? "";

export const consoleVersion = root?.dataset.version ?? "";

export async function api<T>(path: string, options: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
    const method = options.method ?? "GET";
    const headers: Record<string, string> = {};
    if (method !== "GET" && method !== "HEAD") {
        headers["x-csrf-token"] = csrf;
        headers["content-type"] = "application/json";
    }
    const response = await fetch(path, {
        method,
        headers,
        credentials: "same-origin",
        cache: "no-store",
        signal: options.signal,
        body: options.body === undefined ? undefined : JSON.stringify(options.body),
    });
    let data: { error?: string };
    try {
        data = await response.json() as { error?: string };
    } catch {
        throw new Error("控制台没有返回可读取的结果");
    }
    if (!response.ok || data.error) throw new Error(data.error ?? `HTTP ${response.status}`);
    return data as T;
}

export function friendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error);
    if (/unauthorized|session/i.test(message)) return "页面连接已失效，请刷新后重试。";
    if (/invalid origin|csrf/i.test(message)) return "安全校验未通过，请刷新页面后重试。";
    if (/EADDRINUSE|address already in use/i.test(message)) return "服务端口正在被其他程序使用，请先停止重复运行的服务。";
    if (/password.*12|至少 12/i.test(message)) return "连接密码至少需要 12 个字符。";
    if (/not configured|还没有配置公网/i.test(message)) return "请先完成 ChatGPT 连接设置。";
    if (/timeout|超时/i.test(message)) return "操作等待超时，请检查网络后重试。";
    if (/failed to fetch|fetch failed|networkerror|network request failed/i.test(message)) {
        return "Web Console 与本机 Controller 的连接已中断；如果刚执行了 shutdown，请运行 codex-mcp open 重新打开。";
    }
    return message;
}

export function followOperation(
    operation: OperationSnapshot,
    onUpdate: (snapshot: OperationSnapshot) => void,
    onDone?: (snapshot: OperationSnapshot) => void,
): () => void {
    let closed = false;
    let finished = false;
    let fallbackTimer: number | undefined;
    const source = new EventSource(`/api/operations/${encodeURIComponent(operation.id)}/events`);
    const clearFallback = (): void => {
        if (fallbackTimer !== undefined) window.clearTimeout(fallbackTimer);
        fallbackTimer = undefined;
    };
    const accept = (snapshot: OperationSnapshot): void => {
        if (closed || finished) return;
        onUpdate(snapshot);
        if (snapshot.state !== "running") {
            finished = true;
            clearFallback();
            source.close();
            onDone?.(snapshot);
        }
    };
    const pollFallback = async (): Promise<void> => {
        fallbackTimer = undefined;
        if (closed || finished || source.readyState === EventSource.OPEN) return;
        try {
            const payload = await api<{ operation: OperationSnapshot }>(`/api/operations/${encodeURIComponent(operation.id)}`);
            accept(payload.operation);
        } catch {
            // EventSource keeps reconnecting; the ordinary console sync surfaces a Controller outage.
        }
        if (!closed && !finished && source.readyState !== EventSource.OPEN && fallbackTimer === undefined) {
            fallbackTimer = window.setTimeout(() => { void pollFallback(); }, 1_000);
        }
    };

    accept(operation);
    source.onopen = clearFallback;
    source.onerror = () => {
        if (!closed && !finished && fallbackTimer === undefined) {
            fallbackTimer = window.setTimeout(() => { void pollFallback(); }, 500);
        }
    };
    source.addEventListener("operation", (event) => {
        accept(JSON.parse((event as MessageEvent).data) as OperationSnapshot);
    });
    return () => {
        closed = true;
        clearFallback();
        source.close();
    };
}
