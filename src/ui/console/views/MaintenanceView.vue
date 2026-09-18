<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Download, Refresh, SwitchButton, Tools, VideoPause, VideoPlay } from "@element-plus/icons-vue";
import { api, friendlyError, type CapabilityConfig, type ControllerStatus, type OperationSnapshot, type SetupSummary } from "../api.js";
import CapabilitiesPanel from "../components/CapabilitiesPanel.vue";
import OperationPanel from "../components/OperationPanel.vue";

interface DoctorResult {
    fixes?: string[];
    warnings?: string[];
    report?: { checks?: Array<{ level: "ok" | "warn" | "error"; label: string; detail: string }> };
}

interface LogEntry {
    key: string;
    raw: string;
    pretty: string;
    time: string;
    level: string;
    tagType: "info" | "warning" | "danger";
    title: string;
    detail?: string;
    meta: string[];
}

const props = defineProps<{
    status?: ControllerStatus;
    setup?: SetupSummary;
    operation?: OperationSnapshot;
    busy: boolean;
    saveCapabilities: (config: CapabilityConfig) => Promise<void>;
}>();
const emit = defineEmits<{
    restartRuntime: [];
    stopRuntime: [];
    shutdown: [];
    doctor: [fix: boolean];
    update: [];
    cancelOperation: [id: string];
}>();
const tab = ref("runtime");
const lines = ref(100);
const logs = ref("尚未读取日志。\n");
const logError = ref("");
const autoCheckPending = ref(false);
const expandedLogs = ref<Set<string>>(new Set());
let logSource: EventSource | undefined;

const doctor = computed(() => props.operation?.kind.startsWith("doctor") && props.operation.result ? props.operation.result as DoctorResult : undefined);
const logEntries = computed(() => parseLogEntries(logs.value.split(/\r?\n/).filter((line) => line.length > 0)));
const running = computed(() => props.status?.runtime.running === true);
const runtime = computed(() => props.status?.runtime.runtime);
const chatGptUrl = computed(() => runtime.value?.publicMcpUrl ?? (props.setup?.config.publicAccess ? `https://${props.setup.config.publicAccess.domain}/mcp` : "—"));

async function readLogs(): Promise<void> {
    try {
        lines.value = Math.max(1, Math.min(5000, Math.trunc(lines.value || 100)));
        const result = await api<{ text: string }>(`/api/logs?lines=${lines.value}`);
        logs.value = result.text || "当前没有运行日志。\n";
        logError.value = "";
    } catch (error) {
        logError.value = friendlyError(error);
    }
}
function parseLogEntries(lines: string[]): LogEntry[] {
    const purposes = new Map<string, string>();
    for (const line of lines) {
        try {
            const value = JSON.parse(line) as Record<string, unknown>;
            if (typeof value.invocationId === "string" && typeof value.purpose === "string") purposes.set(value.invocationId, value.purpose);
        } catch {
            // Non-JSON lines remain visible as ordinary text logs.
        }
    }
    return lines.map((line, index) => parseLogLine(line, index, purposes));
}
function parseLogLine(line: string, index: number, purposes: Map<string, string>): LogEntry {
    try {
        const value = JSON.parse(line) as Record<string, unknown>;
        const event = typeof value.event === "string" ? value.event : "log";
        const tool = typeof value.tool === "string" ? value.tool : "";
        const invocationId = typeof value.invocationId === "string" ? value.invocationId : "";
        const purpose = typeof value.purpose === "string" ? value.purpose : purposes.get(invocationId);
        const detail = purpose ?? (typeof value.message === "string" ? value.message : undefined) ?? (typeof value.error === "string" ? value.error : undefined);
        const levelInfo = formatLogLevel(value.level);
        const eventTitles: Record<string, string> = {
            tool_call_started: "工具调用开始",
            tool_call: "工具调用完成",
            mcp_http_error_response: "MCP 请求错误",
            daemon_project_bindings_cleaned: "ChatGPT 会话关联清理",
            daemon_started: "MCP 服务已启动",
            daemon_stopping: "正在停止 MCP 服务",
            daemon_stopped: "MCP 服务已停止",
            daemon_stop_failed: "MCP 服务停止失败",
            startup_failed: "MCP 服务启动失败",
        };
        const meta: string[] = [];
        if (typeof value.method === "string") meta.push(value.method);
        if (typeof value.status === "number") meta.push(`HTTP ${value.status}`);
        if (typeof value.durationMs === "number") meta.push(`${value.durationMs} ms`);
        if (typeof value.ok === "boolean") meta.push(value.ok ? "成功" : "失败");
        return {
            key: `${index}-${line}`,
            raw: line,
            pretty: JSON.stringify(value, null, 2),
            time: formatLogTime(value.time),
            level: levelInfo.label,
            tagType: levelInfo.tagType,
            title: `${eventTitles[event] ?? "运行事件"}${tool ? ` · ${tool}` : ""}`,
            ...(detail ? { detail } : {}),
            meta,
        };
    } catch {
        return { key: `${index}-${line}`, raw: line, pretty: line, time: "—", level: "日志", tagType: "info", title: "文本日志", detail: line, meta: [] };
    }
}
function formatLogTime(value: unknown): string {
    if (typeof value !== "string" && typeof value !== "number") return "—";
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? "—" : date.toLocaleTimeString("zh-CN", { hour12: false });
}
function formatLogLevel(value: unknown): { label: string; tagType: "info" | "warning" | "danger" } {
    const level = typeof value === "number" ? value : 30;
    if (level >= 50) return { label: level >= 60 ? "严重" : "错误", tagType: "danger" };
    if (level >= 40) return { label: "警告", tagType: "warning" };
    if (level <= 20) return { label: level <= 10 ? "跟踪" : "调试", tagType: "info" };
    return { label: "信息", tagType: "info" };
}
function toggleLogDetails(key: string): void {
    const next = new Set(expandedLogs.value);
    if (next.has(key)) next.delete(key); else next.add(key);
    expandedLogs.value = next;
}
function stopLogStream(): void { logSource?.close(); logSource = undefined; }
function maybeRunAutoCheck(): void {
    if (!autoCheckPending.value || props.busy) return;
    if (props.operation?.kind.startsWith("doctor") && props.operation.state === "running") {
        autoCheckPending.value = false;
        return;
    }
    autoCheckPending.value = false;
    emit("doctor", false);
}
function startLogStream(): void {
    stopLogStream();
    void readLogs();
    logSource = new EventSource(`/api/logs/stream?lines=${lines.value}`);
    logSource.onopen = () => { logError.value = ""; };
    logSource.onerror = () => { logError.value = "实时日志连接暂时中断，正在自动重连。"; };
    logSource.addEventListener("logs", (event) => {
        const data = JSON.parse((event as MessageEvent).data) as { text?: string };
        logs.value = data.text || "当前没有运行日志。\n";
    });
}
watch(tab, (value) => {
    if (value === "logs") startLogStream();
    else stopLogStream();
    autoCheckPending.value = value === "check";
    maybeRunAutoCheck();
});
watch(() => props.busy, maybeRunAutoCheck);
onBeforeUnmount(stopLogStream);

function friendlyCheck(label: string, detail: string): { title: string; detail: string } {
    const titles: Record<string, string> = {
        "Node.js": "运行环境", "Git": "Git 工具", "文件搜索": "文件搜索", "配置文件": "本机设置",
        "工具与技能": "工具与技能", "连接密码": "连接密码", "公网地址": "ChatGPT 连接地址", "MCP 服务": "MCP 服务",
    };
    if (label === "连接密码" && /未设置/.test(detail)) return { title: titles[label]!, detail: "尚未设置，请前往“连接”页面完成。" };
    if (label === "公网地址" && /未设置/.test(detail)) return { title: titles[label]!, detail: "尚未配置，配置后才能从 ChatGPT 网页端连接。" };
    if (label === "MCP 服务" && /正在运行/.test(detail)) return { title: titles[label]!, detail: "MCP 服务正在运行。" };
    if (label === "配置文件") return { title: titles[label]!, detail: "设置文件可以正常读取。" };
    return { title: titles[label] ?? label, detail };
}
function tagType(level: "ok" | "warn" | "error"): "success" | "warning" | "danger" { return level === "ok" ? "success" : level === "warn" ? "warning" : "danger"; }
</script>

<template>
    <div class="page-surface system-surface">
        <el-tabs v-model="tab">
                <el-tab-pane label="运行" name="runtime">
                    <div class="pane-toolbar">
                        <el-button :icon="VideoPlay" :disabled="busy || !running" @click="emit('restartRuntime')">重启 MCP 服务</el-button>
                        <el-button type="danger" plain :icon="VideoPause" :disabled="busy || !running" @click="emit('stopRuntime')">停止 MCP 服务</el-button>
                    </div>
                    <el-descriptions :column="1" border>
                        <el-descriptions-item label="Web 控制台">{{ status ? "运行中" : "未运行" }}</el-descriptions-item>
                        <el-descriptions-item label="MCP 服务">{{ running ? "运行中" : "未启动" }}</el-descriptions-item>
                        <el-descriptions-item label="运行方式">{{ runtime?.mode === "local" ? "仅本机" : runtime?.mode === "public" ? "ChatGPT 公网" : "—" }}</el-descriptions-item>
                        <el-descriptions-item label="公网连接">{{ runtime?.publicMcpUrl ? "已连接" : "未连接" }}</el-descriptions-item>
                        <el-descriptions-item v-if="setup?.config.publicAccess?.kind === 'cloudflare'" label="Cloudflare 协议">{{ (setup?.config.runtime?.tunnelProtocol ?? "http2") === "http2" ? "HTTP/2" : "QUIC" }}</el-descriptions-item>
                        <el-descriptions-item label="登录保护">{{ runtime?.auth?.required ? (runtime.auth.configured ? "已启用" : "等待设置密码") : "仅本机，无需登录" }}</el-descriptions-item>
                        <el-descriptions-item label="本机地址"><span class="mono small break-all">{{ runtime?.localUrl ?? "—" }}</span></el-descriptions-item>
                        <el-descriptions-item label="ChatGPT 地址"><span class="mono small break-all">{{ chatGptUrl }}</span></el-descriptions-item>
                    </el-descriptions>
                    <div class="danger-actions"><el-button type="danger" text :icon="SwitchButton" :disabled="busy" @click="emit('shutdown')">完全关闭 codex-mcp</el-button></div>
                </el-tab-pane>
                <el-tab-pane label="检查与修复" name="check">
                    <div class="pane-toolbar"><el-button :disabled="busy" @click="emit('doctor', false)">检查</el-button><el-button type="primary" :icon="Tools" :disabled="busy" @click="emit('doctor', true)">检查并修复</el-button></div>
                    <OperationPanel v-if="operation?.kind.startsWith('doctor')" :operation="operation" @cancel="emit('cancelOperation', $event)" />
                    <div v-if="doctor?.fixes?.length || doctor?.warnings?.length || doctor?.report?.checks?.length" style="margin-top: 18px">
                        <div v-for="fix in doctor?.fixes" :key="fix" class="status-line"><div><strong>已完成修复</strong><div class="muted small">{{ fix }}</div></div><el-tag type="success">完成</el-tag></div>
                        <div v-for="warning in doctor?.warnings" :key="warning" class="status-line"><div><strong>自动修复未完成</strong><div class="muted small">{{ warning }}</div></div><el-tag type="warning">注意</el-tag></div>
                        <div v-for="check in doctor?.report?.checks" :key="`${check.label}-${check.detail}`" class="status-line"><div><strong>{{ friendlyCheck(check.label, check.detail).title }}</strong><div v-if="check.level !== 'ok'" class="muted small">{{ friendlyCheck(check.label, check.detail).detail }}</div></div><el-tag :type="tagType(check.level)">{{ check.level === 'ok' ? '正常' : check.level === 'warn' ? '注意' : '处理' }}</el-tag></div>
                    </div>
                </el-tab-pane>
                <el-tab-pane label="工具与技能" name="capabilities"><CapabilitiesPanel :setup="setup" :busy="busy" :save-capabilities="saveCapabilities" /></el-tab-pane>
                <el-tab-pane label="运行日志" name="logs">
                    <div class="pane-toolbar"><el-input-number v-model="lines" :min="1" :max="5000" :controls="false" style="width: 100px" /><el-button :icon="Refresh" @click="startLogStream">应用</el-button></div>
                    <el-alert v-if="logError" type="error" :closable="false" :title="logError" style="margin-bottom: 12px" />
                    <div class="log-list">
                        <div v-for="entry in logEntries" :key="entry.key" class="log-row">
                            <div class="log-main">
                                <time class="log-time">{{ entry.time }}</time>
                                <el-tag size="small" effect="plain" :type="entry.tagType">{{ entry.level }}</el-tag>
                                <div class="log-content">
                                    <div class="log-title">{{ entry.title }}</div>
                                    <div v-if="entry.detail" class="log-detail">{{ entry.detail }}</div>
                                </div>
                                <div class="log-actions">
                                    <span v-for="item in entry.meta" :key="item" class="log-meta">{{ item }}</span>
                                    <el-button size="small" @click="toggleLogDetails(entry.key)">{{ expandedLogs.has(entry.key) ? "收起" : "详情" }}</el-button>
                                </div>
                            </div>
                            <pre v-if="expandedLogs.has(entry.key)" class="log-raw">{{ entry.pretty }}</pre>
                        </div>
                    </div>
                </el-tab-pane>
                <el-tab-pane label="软件更新" name="update">
                    <div class="pane-toolbar"><el-button type="primary" :icon="Download" :disabled="busy" @click="emit('update')">检查并更新</el-button></div>
                    <OperationPanel v-if="operation?.kind === 'update'" :operation="operation" @cancel="emit('cancelOperation', $event)" />
                </el-tab-pane>
        </el-tabs>
    </div>
</template>
