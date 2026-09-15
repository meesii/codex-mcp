<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { Download, Refresh, Tools } from "@element-plus/icons-vue";
import { api, friendlyError, type CapabilityConfig, type OperationSnapshot, type SetupSummary } from "../api.js";
import CapabilitiesPanel from "../components/CapabilitiesPanel.vue";
import OperationPanel from "../components/OperationPanel.vue";

interface DoctorResult {
    fixes?: string[];
    warnings?: string[];
    report?: { checks?: Array<{ level: "ok" | "warn" | "error"; label: string; detail: string }> };
}

const props = defineProps<{
    setup?: SetupSummary;
    operation?: OperationSnapshot;
    busy: boolean;
    saveCapabilities: (config: CapabilityConfig) => Promise<void>;
}>();
const emit = defineEmits<{ doctor: [fix: boolean]; update: []; cancelOperation: [id: string] }>();
const tab = ref("check");
const lines = ref(100);
const logs = ref("尚未读取日志。\n");
const logError = ref("");
let logSource: EventSource | undefined;

const doctor = computed(() => props.operation?.kind.startsWith("doctor") && props.operation.result ? props.operation.result as DoctorResult : undefined);

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
function stopLogStream(): void { logSource?.close(); logSource = undefined; }
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
watch(tab, (value) => value === "logs" ? startLogStream() : stopLogStream());
onBeforeUnmount(stopLogStream);

function friendlyCheck(label: string, detail: string): { title: string; detail: string } {
    const titles: Record<string, string> = {
        "Node.js": "运行环境", "Git": "Git 工具", "文件搜索": "文件搜索", "配置文件": "本机设置",
        "外部能力": "可用工具与技能", "连接密码": "连接密码", "公网地址": "ChatGPT 连接地址", "守护进程": "MCP 服务",
    };
    if (label === "连接密码" && /未设置/.test(detail)) return { title: titles[label]!, detail: "尚未设置，请前往“连接”页面完成。" };
    if (label === "公网地址" && /未设置/.test(detail)) return { title: titles[label]!, detail: "尚未配置，配置后才能从 ChatGPT 网页端连接。" };
    if (label === "守护进程" && /^pid\s/i.test(detail)) return { title: titles[label]!, detail: "服务正在本机运行。" };
    if (label === "配置文件") return { title: titles[label]!, detail: "设置文件可以正常读取。" };
    return { title: titles[label] ?? label, detail };
}
function tagType(level: "ok" | "warn" | "error"): "success" | "warning" | "danger" { return level === "ok" ? "success" : level === "warn" ? "warning" : "danger"; }
</script>

<template>
    <div>
        <div class="page-heading"><h1>系统</h1><p>管理本机能力源、诊断环境、查看日志和更新 codex-mcp。</p></div>
        <el-card shadow="never">
            <el-tabs v-model="tab">
                <el-tab-pane label="检查与修复" name="check">
                    <div class="section-heading">
                        <div><h2>服务诊断</h2><p>普通检查只读；“检查并修复”只执行安全的本机修复。</p></div>
                        <div class="inline-actions"><el-button :disabled="busy" @click="emit('doctor', false)">开始检查</el-button><el-button type="primary" :icon="Tools" :disabled="busy" @click="emit('doctor', true)">检查并修复</el-button></div>
                    </div>
                    <OperationPanel v-if="operation?.kind.startsWith('doctor')" :operation="operation" @cancel="emit('cancelOperation', $event)" />
                    <div v-if="doctor?.fixes?.length || doctor?.warnings?.length || doctor?.report?.checks?.length" style="margin-top: 18px">
                        <div v-for="fix in doctor?.fixes" :key="fix" class="status-line"><div><strong>已完成修复</strong><div class="muted small">{{ fix }}</div></div><el-tag type="success">完成</el-tag></div>
                        <div v-for="warning in doctor?.warnings" :key="warning" class="status-line"><div><strong>自动修复未完成</strong><div class="muted small">{{ warning }}</div></div><el-tag type="warning">注意</el-tag></div>
                        <div v-for="check in doctor?.report?.checks" :key="`${check.label}-${check.detail}`" class="status-line"><div><strong>{{ friendlyCheck(check.label, check.detail).title }}</strong><div class="muted small">{{ friendlyCheck(check.label, check.detail).detail }}</div></div><el-tag :type="tagType(check.level)">{{ check.level === 'ok' ? '正常' : check.level === 'warn' ? '注意' : '处理' }}</el-tag></div>
                    </div>
                </el-tab-pane>
                <el-tab-pane label="工具与技能" name="capabilities"><CapabilitiesPanel :setup="setup" :busy="busy" :save-capabilities="saveCapabilities" /></el-tab-pane>
                <el-tab-pane label="运行日志" name="logs">
                    <div class="section-heading"><div><h2>运行日志</h2><p>实时查看 Runtime、项目工具和公网连接日志。</p></div><div class="inline-actions"><el-input-number v-model="lines" :min="1" :max="5000" :controls="false" style="width: 100px" /><el-button :icon="Refresh" @click="startLogStream">应用行数</el-button></div></div>
                    <el-alert v-if="logError" type="error" :closable="false" :title="logError" style="margin-bottom: 12px" />
                    <pre class="log-view">{{ logs }}</pre>
                </el-tab-pane>
                <el-tab-pane label="软件更新" name="update">
                    <div class="section-heading"><div><h2>安装最新版本</h2><p>更新会短暂重启 MCP Runtime 和控制面板，项目与连接设置会保留。</p></div><el-button type="primary" :icon="Download" :disabled="busy" @click="emit('update')">检查并更新</el-button></div>
                    <OperationPanel v-if="operation?.kind === 'update'" :operation="operation" @cancel="emit('cancelOperation', $event)" />
                </el-tab-pane>
            </el-tabs>
        </el-card>
    </div>
</template>
