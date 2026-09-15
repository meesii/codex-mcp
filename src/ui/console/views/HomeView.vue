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
    if (props.result?.ready) return "检查已通过";
    if (!publicUrl.value) return "需要公网地址";
    if (!props.setup?.passwordConfigured) return "需要设置密码";
    return props.result ? "还有检查项需要处理" : "等待连接检查";
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
    <div>
        <div class="page-heading">
            <h1>概览</h1>
            <p>查看 MCP、ChatGPT 连接和项目状态。需要操作时直接进入对应页面。</p>
        </div>

        <div class="metric-grid">
            <el-card class="metric-card" shadow="never"><div class="metric-label">MCP 服务</div><div class="metric-value">{{ loading ? "…" : running ? "运行中" : "未启动" }}</div><div class="metric-detail">{{ status?.runtime.runtime?.mode === "local" ? "仅本机" : status?.runtime.runtime?.mode ?? "等待启动" }}</div></el-card>
            <el-card class="metric-card" shadow="never"><div class="metric-label">ChatGPT 连接</div><div class="metric-value">{{ configured ? "已配置" : "未配置" }}</div><div class="metric-detail">{{ connectionDetail }}</div></el-card>
            <el-card class="metric-card" shadow="never"><div class="metric-label">项目</div><div class="metric-value">{{ activeProjects.length }}</div><div class="metric-detail">{{ projects.length - activeProjects.length }} 个已停用</div></el-card>
            <el-card class="metric-card" shadow="never"><div class="metric-label">会话绑定</div><div class="metric-value">{{ conversationCount }}</div><div class="metric-detail">当前项目选择记录</div></el-card>
        </div>

        <div class="content-grid">
            <el-card shadow="never">
                <div class="section-heading">
                    <div><h2>开始使用</h2><p>按当前状态只显示下一步最有用的操作。</p></div>
                </div>
                <div v-if="!activeProjects.length" class="inline-actions"><el-button type="primary" :icon="FolderAdd" @click="emit('add')">添加项目</el-button><span class="muted small">项目注册不会启动 MCP 服务。</span></div>
                <div v-else-if="!running && !configured" class="inline-actions"><el-button type="primary" :icon="Link" @click="emit('navigate', 'connect')">配置 ChatGPT 连接</el-button><el-button :icon="VideoPlay" :loading="busy" @click="emit('start', 'local')">仅本机启动</el-button></div>
                <div v-else-if="!running" class="inline-actions"><el-button type="primary" :icon="VideoPlay" :loading="busy" @click="emit('start', 'public')">启动公网服务</el-button><el-button :loading="busy" @click="emit('start', 'local')">仅本机启动</el-button><span class="muted small">当前默认：{{ preferredMode === 'public' ? '公网' : '本机' }}</span></div>
                <div v-else class="inline-actions"><el-button v-if="liveMode === 'local' && !configured" type="primary" :icon="Link" @click="emit('navigate', 'connect')">配置 ChatGPT 连接</el-button><el-button v-else-if="liveMode === 'local' && configured" type="primary" :loading="busy" @click="emit('start', 'public')">切换到公网</el-button><el-button v-else-if="liveMode === 'public'" :loading="busy" @click="emit('start', 'local')">切换到本机</el-button><el-button v-if="liveMode === 'public'" type="primary" :icon="Refresh" :loading="busy" @click="emit('check')">检查连接</el-button><el-button :icon="Tools" @click="emit('repair')">检查并修复</el-button><el-button text type="danger" :icon="VideoPause" :disabled="busy" @click="emit('stop')">停止服务</el-button></div>

                <div style="margin-top: 22px">
                    <div class="status-line"><span class="status-label">ChatGPT 地址</span><div class="inline-actions" style="justify-content: flex-end"><code class="small break-all">{{ publicUrl || "尚未配置" }}</code><el-button v-if="publicUrl" text :icon="CopyDocument" @click="copyUrl" /></div></div>
                    <div class="status-line"><span class="status-label">当前项目</span><div class="inline-actions" style="justify-content: flex-end"><el-tag v-for="project in activeProjects.slice(0, 5)" :key="project.id" effect="plain" @click="emit('navigate', 'projects')">{{ project.name }}</el-tag><el-button v-if="activeProjects.length > 5" text @click="emit('navigate', 'projects')">+{{ activeProjects.length - 5 }}</el-button></div></div>
                </div>
            </el-card>

            <el-card shadow="never">
                <div class="section-heading"><div><h2>状态</h2><p>常用运行信息。</p></div></div>
                <div class="status-line"><span class="status-label">Controller</span><el-tag type="success" effect="light">运行中</el-tag></div>
                <div class="status-line"><span class="status-label">MCP Runtime</span><el-tag :type="running ? 'success' : 'info'" effect="light">{{ running ? (liveMode === 'public' ? '公网运行中' : '本机运行中') : '未启动' }}</el-tag></div>
                <div class="status-line"><span class="status-label">默认启动</span><el-tag effect="plain">{{ preferredMode === 'public' ? '公网模式' : '本机模式' }}</el-tag></div>
                <div class="status-line"><span class="status-label">公网地址</span><el-tag :type="publicUrl ? 'success' : 'warning'" effect="light">{{ publicUrl ? "已配置" : "未配置" }}</el-tag></div>
                <div class="status-line"><span class="status-label">连接密码</span><el-tag :type="setup?.passwordConfigured ? 'success' : 'warning'" effect="light">{{ setup?.passwordConfigured ? "已设置" : "未设置" }}</el-tag></div>
            </el-card>
        </div>

        <ConnectionResult style="margin-top: 16px" :result="result" @action="(action) => action === 'start' ? emit('start', configured ? 'public' : 'local') : action === 'projects' ? emit('add') : action === 'repair' ? emit('repair') : emit('navigate', 'connect')" />
    </div>
</template>
