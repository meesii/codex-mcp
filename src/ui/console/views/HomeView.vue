<script setup lang="ts">
import { computed } from "vue";
import { CopyDocument, FolderAdd, Link, VideoPause, VideoPlay, Refresh, Tools } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus/es/components/message/index";
import "element-plus/es/components/message/style/css";
import type { ConnectionCheck, ControllerStatus, Project, SetupSummary } from "../api.js";
import ConnectionResult from "../components/ConnectionResult.vue";

const props = defineProps<{
    status?: ControllerStatus;
    setup?: SetupSummary;
    projects: Project[];
    conversationCount: number;
    loading: boolean;
    busy: boolean;
    result?: ConnectionCheck;
}>();
const emit = defineEmits<{
    navigate: [page: "projects" | "connect" | "maintenance"];
    add: [];
    start: [mode: "local" | "public"];
    stop: [];
    check: [];
    repair: [];
}>();

const running = computed(() => props.status?.runtime.running === true);
const activeProjects = computed(() => props.projects.filter((item) => item.active));
const publicUrl = computed(() => props.setup?.config.publicAccess ? `https://${props.setup.config.publicAccess.domain}/mcp` : "");
const configured = computed(() => Boolean(publicUrl.value && props.setup?.passwordConfigured));
const connectionDetail = computed(() => {
    if (!publicUrl.value) return "缺少公网地址";
    if (!props.setup?.passwordConfigured) return "缺少密码";
    if (props.result?.ready) return "检查通过";
    return props.result ? "需处理" : "";
});
const liveMode = computed(() => props.status?.runtime.runtime?.mode === "local" ? "local" : props.status?.runtime.runtime?.mode === "public" ? "public" : undefined);
const preferredMode = computed(() => props.setup?.config.runtime?.mode ?? (publicUrl.value ? "public" : "local"));

async function copyUrl(): Promise<void> {
    if (!publicUrl.value) return;
    try { await navigator.clipboard.writeText(publicUrl.value); ElMessage.success("连接地址已复制"); }
    catch { ElMessage.error("复制失败，请手动复制"); }
}
</script>

<template>
    <div class="page-stack">
        <div class="page-surface overview-strip">
            <div class="overview-metric"><span>MCP 服务</span><strong>{{ loading ? "…" : running ? (liveMode === 'public' ? '公网运行' : '本机运行') : "未启动" }}</strong></div>
            <div class="overview-metric"><span>ChatGPT</span><strong>{{ configured ? "已配置" : "未配置" }}</strong><small v-if="connectionDetail">{{ connectionDetail }}</small></div>
            <div class="overview-metric"><span>项目</span><strong>{{ activeProjects.length }}</strong><small v-if="projects.length - activeProjects.length">{{ projects.length - activeProjects.length }} 个停用</small></div>
            <div class="overview-metric"><span>会话绑定</span><strong>{{ conversationCount }}</strong></div>
        </div>

        <div class="page-surface workspace-panel">
            <div class="workspace-actions">
                <div v-if="!activeProjects.length" class="inline-actions"><el-button type="primary" :icon="FolderAdd" @click="emit('add')">添加项目</el-button></div>
                <div v-else-if="!running && !configured" class="inline-actions"><el-button type="primary" :icon="Link" @click="emit('navigate', 'connect')">配置 ChatGPT</el-button><el-button :icon="VideoPlay" :loading="busy" @click="emit('start', 'local')">本机启动</el-button></div>
                <div v-else-if="!running" class="inline-actions"><el-button type="primary" :icon="VideoPlay" :loading="busy" @click="emit('start', 'public')">启动公网服务</el-button><el-button :loading="busy" @click="emit('start', 'local')">本机启动</el-button></div>
                <div v-else class="inline-actions"><el-button v-if="liveMode === 'local' && !configured" type="primary" :icon="Link" @click="emit('navigate', 'connect')">配置 ChatGPT</el-button><el-button v-else-if="liveMode === 'local' && configured" type="primary" :loading="busy" @click="emit('start', 'public')">切到公网</el-button><el-button v-else-if="liveMode === 'public'" :loading="busy" @click="emit('start', 'local')">切到本机</el-button><el-button v-if="liveMode === 'public'" type="primary" :icon="Refresh" :loading="busy" @click="emit('check')">检查连接</el-button><el-button :icon="Tools" @click="emit('repair')">诊断</el-button><el-button text type="danger" :icon="VideoPause" :disabled="busy" @click="emit('stop')">停止</el-button></div>
            </div>
            <div class="compact-list">
                <div class="compact-row"><span>ChatGPT 地址</span><div class="inline-actions"><code class="small break-all">{{ publicUrl || "尚未配置" }}</code><el-button v-if="publicUrl" text :icon="CopyDocument" @click="copyUrl" /></div></div>
                <div class="compact-row"><span>当前项目</span><div class="inline-actions"><el-tag v-for="project in activeProjects.slice(0, 5)" :key="project.id" effect="plain" @click="emit('navigate', 'projects')">{{ project.name }}</el-tag><el-button v-if="activeProjects.length > 5" text @click="emit('navigate', 'projects')">+{{ activeProjects.length - 5 }}</el-button></div></div>
                <div class="compact-row"><span>默认启动</span><span>{{ preferredMode === 'public' ? '公网' : '本机' }}</span></div>
            </div>
        </div>

        <ConnectionResult :result="result" @action="(action) => action === 'start' ? emit('start', configured ? 'public' : 'local') : action === 'projects' ? emit('add') : action === 'repair' ? emit('repair') : emit('navigate', 'connect')" />
    </div>
</template>
