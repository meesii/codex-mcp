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
    runtime: { running: boolean; runtime?: RuntimeInfo };
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

export interface SetupSummary {
    config: {
        publicAccess?: { kind: "external" | "cloudflare"; domain: string };
    };
    passwordConfigured: boolean;
    capabilities: CapabilityConfig;
    detections: Array<{ id?: string; label: string; detected: boolean }>;
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
    return message;
}

export function followOperation(
    operation: OperationSnapshot,
    onUpdate: (snapshot: OperationSnapshot) => void,
    onDone?: (snapshot: OperationSnapshot) => void,
): () => void {
    onUpdate(operation);
    const source = new EventSource(`/api/operations/${encodeURIComponent(operation.id)}/events`);
    source.addEventListener("operation", (event) => {
        const snapshot = JSON.parse((event as MessageEvent).data) as OperationSnapshot;
        onUpdate(snapshot);
        if (snapshot.state !== "running") {
            source.close();
            onDone?.(snapshot);
        }
    });
    return () => source.close();
}
