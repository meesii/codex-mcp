<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref, watch } from "vue";
import {
    Connection, FolderOpened, HomeFilled, Refresh, Tools,
} from "@element-plus/icons-vue";
import zhCn from "element-plus/es/locale/lang/zh-cn";
import { ElMessage } from "element-plus/es/components/message/index";
import { ElMessageBox } from "element-plus/es/components/message-box/index";
import "element-plus/es/components/message/style/css";
import "element-plus/es/components/message-box/style/css";
import {
    api, consoleVersion, followOperation, friendlyError,
    type CapabilityConfig, type ConnectionCheck, type ConsoleSnapshot, type ControllerStatus, type Conversation,
    type OperationSnapshot, type Project, type SetupSummary,
} from "./api.js";
import AddProjectDialog from "./components/AddProjectDialog.vue";
import HomeView from "./views/HomeView.vue";
import ProjectsView from "./views/ProjectsView.vue";
import ConnectView from "./views/ConnectView.vue";
import MaintenanceView from "./views/MaintenanceView.vue";

type Page = "home" | "projects" | "connect" | "maintenance";
type OperationScope = "connect" | "maintenance";

const navigation = [
    { id: "home" as const, label: "概览", icon: HomeFilled },
    { id: "projects" as const, label: "项目", icon: FolderOpened },
    { id: "connect" as const, label: "连接", icon: Connection },
    { id: "maintenance" as const, label: "系统", icon: Tools },
];

const page = ref<Page>("home");
const addOpen = ref(false);
const controllerClosed = ref(false);
const status = ref<ControllerStatus>();
const projects = ref<Project[]>([]);
const conversations = ref<Conversation[]>([]);
const setup = ref<SetupSummary>();
const connectionResult = ref<ConnectionCheck>();
const loading = ref(true);
const refreshing = ref(false);
const busyOwners = ref(0);
const loadError = ref("");
const syncError = ref("");
const zones = ref<string[]>([]);
const operations = ref<Partial<Record<OperationScope, OperationSnapshot>>>({});
const operationCleanups = new Map<string, { close: () => void; release: () => void }>();
let pollTimer: number | undefined;
let liveRefresh: Promise<void> | undefined;
const LIVE_SYNC_MS = 2_000;

const busy = computed(() => busyOwners.value > 0 || refreshing.value);
const running = computed(() => status.value?.runtime.running === true);
const pageTitle = computed(() => navigation.find((item) => item.id === page.value)?.label ?? "概览");
const liveRuntime = computed(() => status.value?.runtime.runtime);
const checkContext = computed(() => JSON.stringify([
    status.value?.runtime.running,
    status.value?.runtime.runtime?.pid,
    setup.value?.config.publicAccess,
    setup.value?.passwordConfigured,
    projects.value.map((project) => [project.id, project.active]),
]));
watch(checkContext, () => { connectionResult.value = undefined; });

function applySnapshot(snapshot: ConsoleSnapshot): void {
    status.value = snapshot.status;
    projects.value = snapshot.status.runtime.projects ?? [];
    conversations.value = snapshot.conversations;
    if (setup.value) {
        setup.value = {
            ...setup.value,
            config: snapshot.setup.config,
            passwordConfigured: snapshot.setup.passwordConfigured,
        };
    }
}

async function refreshLive(showError = false): Promise<void> {
    if (controllerClosed.value) return;
    if (liveRefresh) return await liveRefresh;
    liveRefresh = (async () => {
        try {
            applySnapshot(await api<ConsoleSnapshot>("/api/console/snapshot"));
            syncError.value = "";
            if (showError) loadError.value = "";
        } catch (error) {
            syncError.value = friendlyError(error);
            if (showError) loadError.value = syncError.value;
        }
    })();
    try { await liveRefresh; }
    finally { liveRefresh = undefined; }
}

async function refreshAll(showError = true): Promise<void> {
    refreshing.value = true;
    try {
        if (liveRefresh) await liveRefresh;
        const results = await Promise.allSettled([
            api<ConsoleSnapshot>("/api/console/snapshot"),
            api<SetupSummary>("/api/setup/summary"),
        ]);
        if (results[0].status === "fulfilled") { applySnapshot(results[0].value); syncError.value = ""; }
        if (results[1].status === "fulfilled") setup.value = results[1].value;
        const failed = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
        if (failed && showError) loadError.value = friendlyError(failed.reason);
        else if (!failed) loadError.value = "";
    } finally {
        refreshing.value = false;
        loading.value = false;
    }
}

function syncPageFromLocation(): void {
    const requested = window.location.hash.replace(/^#/, "");
    const match = navigation.find((item) => item.id === requested || (requested === "system" && item.id === "maintenance"));
    if (match) page.value = match.id;
}
function refreshWhenVisible(): void {
    if (document.visibilityState === "visible") void refreshLive(false);
}

onMounted(() => {
    syncPageFromLocation();
    void refreshAll();
    pollTimer = window.setInterval(() => {
        if (document.visibilityState === "visible" && !refreshing.value) void refreshLive(false);
    }, LIVE_SYNC_MS);
    window.addEventListener("focus", refreshWhenVisible);
    window.addEventListener("popstate", syncPageFromLocation);
    window.addEventListener("hashchange", syncPageFromLocation);
    document.addEventListener("visibilitychange", refreshWhenVisible);
});
onBeforeUnmount(() => {
    if (pollTimer !== undefined) window.clearInterval(pollTimer);
    window.removeEventListener("focus", refreshWhenVisible);
    window.removeEventListener("popstate", syncPageFromLocation);
    window.removeEventListener("hashchange", syncPageFromLocation);
    document.removeEventListener("visibilitychange", refreshWhenVisible);
    for (const owner of operationCleanups.values()) { owner.close(); owner.release(); }
    operationCleanups.clear();
});

function claimBusy(): () => void {
    busyOwners.value += 1;
    let active = true;
    return () => {
        if (!active) return;
        active = false;
        busyOwners.value = Math.max(0, busyOwners.value - 1);
    };
}

async function runAction(action: () => Promise<void>, successMessage?: string): Promise<boolean> {
    const release = claimBusy();
    try {
        await action();
        if (successMessage) ElMessage.success(successMessage);
        return true;
    } catch (error) {
        ElMessage.error(friendlyError(error));
        return false;
    } finally {
        release();
    }
}

async function startOperation(
    scope: OperationScope,
    path: string,
    body: unknown,
    successMessage: string,
    onDone?: (result: unknown) => void | Promise<void>,
): Promise<void> {
    const release = claimBusy();
    try {
        const response = await api<{ operation: OperationSnapshot }>(path, { method: "POST", body });
        const finish = async (snapshot: OperationSnapshot): Promise<void> => {
            const owner = operationCleanups.get(snapshot.id);
            try {
                if (snapshot.state === "succeeded") {
                    await onDone?.(snapshot.result);
                    ElMessage.success(successMessage);
                } else if (snapshot.state === "failed") {
                    ElMessage.error(friendlyError(snapshot.error ?? "操作未完成"));
                }
            } catch (error) {
                ElMessage.error(friendlyError(error));
            } finally {
                owner?.release();
                operationCleanups.delete(snapshot.id);
            }
        };
        const close = followOperation(response.operation, (snapshot) => {
            operations.value = { ...operations.value, [scope]: snapshot };
        }, (snapshot) => { void finish(snapshot); });
        operationCleanups.set(response.operation.id, { close, release });
    } catch (error) {
        release();
        ElMessage.error(friendlyError(error));
    }
}

async function confirmAction(title: string, description: string, confirmLabel: string, action: () => unknown | Promise<unknown>, danger = false): Promise<void> {
    try {
        await ElMessageBox.confirm(description, title, {
            confirmButtonText: confirmLabel,
            cancelButtonText: "取消",
            type: danger ? "warning" : "info",
            distinguishCancelAndClose: true,
        });
        await action();
    } catch (error) {
        if (error === "cancel" || error === "close") return;
        throw error;
    }
}

function navigate(next: Page): void {
    page.value = next;
    const hash = next === "maintenance" ? "system" : next;
    if (window.location.hash !== `#${hash}`) window.history.pushState(null, "", `#${hash}`);
}
function handleMenuSelect(value: string): void { navigate(value as Page); }

function startRuntime(mode: "local" | "public"): void {
    void runAction(async () => {
        connectionResult.value = undefined;
        await api("/api/runtime/start", {
            method: "POST",
            body: mode === "local"
                ? { local: true, noTunnel: true, tunnelLogs: false, intentSpecified: true }
                : { local: false, noTunnel: false, tunnelLogs: false, intentSpecified: true },
        });
        await refreshLive(false);
    }, mode === "local" ? "MCP 已以本机模式启动" : "MCP 已以公网模式启动");
}
function restartRuntime(): void {
    void runAction(async () => {
        connectionResult.value = undefined;
        await api("/api/runtime/restart", { method: "POST", body: {} });
        await refreshLive(false);
    }, "MCP 服务已重新启动");
}
function stopRuntime(): void {
    void confirmAction("停止 MCP 服务？", "ChatGPT 和其他客户端将暂时无法使用项目。控制面板会继续运行。", "停止服务", () => runAction(async () => {
        connectionResult.value = undefined;
        await api("/api/runtime/stop", { method: "POST", body: {} });
        await refreshLive(false);
    }, "MCP 服务已停止"), true);
}
function shutdownAll(): void {
    void confirmAction("完全关闭 codex-mcp？", "MCP 服务、Cloudflare 公网连接和 Web 控制台都会退出。项目、连接设置和密码都会保留。", "完全关闭", () => runAction(async () => {
        await api("/api/controller/shutdown", { method: "POST", body: {} });
        if (pollTimer !== undefined) window.clearInterval(pollTimer);
        pollTimer = undefined;
        controllerClosed.value = true;
    }, "codex-mcp 已关闭"), true);
}
async function addProject(path: string): Promise<boolean> {
    return await runAction(async () => {
        await api("/api/projects", { method: "POST", body: { path } });
        connectionResult.value = undefined;
        await refreshLive(false);
    }, "项目已添加");
}
function reactivateProject(project: Project): void {
    void runAction(async () => {
        await api("/api/projects", { method: "POST", body: { path: project.path } });
        connectionResult.value = undefined;
        await refreshLive(false);
    }, "项目已重新启用");
}
function removeProject(project: Project): void {
    void confirmAction(`停用“${project.name}”？`, "项目文件不会被删除，但 ChatGPT 将不能再选择这个项目；已有的 ChatGPT 会话关联记录也会清除。", "停用项目", () => runAction(async () => {
        await api(`/api/projects/${encodeURIComponent(project.id)}`, { method: "DELETE", body: {} });
        await refreshLive(false);
    }, "项目已停用"), true);
}
function cleanupConversations(project: Project, conversationIds: string[]): void {
    if (!conversationIds.length) return;
    void confirmAction("解除 ChatGPT 会话关联？", `将让 ${conversationIds.length} 个 ChatGPT 会话忘记之前选择的项目。不会删除 ChatGPT 对话，也不会删除项目文件。`, "解除关联", () => runAction(async () => {
        await api(`/api/projects/${encodeURIComponent(project.id)}/conversations/cleanup`, { method: "POST", body: { conversationIds } });
        await refreshLive(false);
    }, "ChatGPT 会话关联已清理"), true);
}
function discoverCloudflare(): void {
    void startOperation("connect", "/api/setup/cloudflare/discover", { forceLogin: false }, "已读取可用域名", (result) => {
        zones.value = (result as { zones?: string[] } | undefined)?.zones ?? [];
    });
}
function applyCloudflare(zone: string, prefix: string, overwrite: boolean): void {
    const action = () => startOperation("connect", "/api/setup/public/cloudflare", { zone, prefix, allowDnsOverwrite: overwrite }, "ChatGPT 连接地址已配置", () => refreshLive(false));
    if (!overwrite) { void action(); return; }
    void confirmAction("允许替换同名 DNS 记录？", `如果 ${prefix}.${zone} 已被其他服务使用，原记录会被替换。`, "允许并继续", action, true);
}
function applyExternal(domain: string): void {
    void startOperation("connect", "/api/setup/public/external", { domain }, "自有域名已保存并通过检查", () => refreshLive(false));
}
function updateTunnelProtocol(protocol: "http2" | "quic"): void {
    void runAction(async () => {
        connectionResult.value = undefined;
        await api("/api/setup/tunnel-protocol", { method: "POST", body: { protocol } });
        await refreshLive(false);
    }, `Cloudflare 连接协议已切换为 ${protocol === "http2" ? "HTTP/2" : "QUIC"}`);
}
function checkPublicAccess(): void {
    void runAction(async () => {
        connectionResult.value = undefined;
        connectionResult.value = await api<ConnectionCheck>("/api/connection-check", { method: "POST", body: {} });
    });
}
async function savePassword(password: string): Promise<void> {
    await runAction(async () => {
        await api("/api/auth/password", { method: "POST", body: { password } });
        await refreshLive(false);
    }, "连接密码已保存");
}
async function generatePassword(): Promise<string | undefined> {
    let password: string | undefined;
    await runAction(async () => {
        password = (await api<{ password: string }>("/api/auth/generate", { method: "POST", body: {} })).password;
        await refreshLive(false);
    }, "安全密码已生成并设置");
    return password;
}
async function saveCapabilities(config: CapabilityConfig): Promise<void> {
    await runAction(async () => {
        const sources = { ...config.sources, agents: { ...config.sources.agents, mcp: false } };
        await api("/api/setup/capabilities", { method: "POST", body: { config: { ...config, priority: ["agents", "codex", "claude"], sources } } });
        await refreshAll(false);
    }, "工具设置已保存");
}
function runDoctor(fix: boolean): void {
    const action = () => startOperation("maintenance", "/api/doctor", { fix }, fix ? "检查和修复已完成" : "服务检查已完成");
    if (!fix) { void action(); return; }
    void confirmAction("检查并修复常见问题？", "只会恢复缺失的文件搜索组件、创建缺失目录和清理失效状态，不会删除项目或配置。", "开始修复", action);
}
function selfUpdate(): void {
    void confirmAction("检查并安装最新版本？", "更新期间 MCP 服务和 Web 控制台会短暂重启，项目、连接设置和密码都会保留。", "检查并更新", () => startOperation("maintenance", "/api/update", {}, "新版本已安装", (result) => {
        const reloadUrl = (result as { reloadUrl?: string } | undefined)?.reloadUrl;
        if (reloadUrl) window.setTimeout(() => { window.location.href = reloadUrl; }, 800);
    }));
}
function cancelOperation(id: string): void {
    void runAction(async () => { await api(`/api/operations/${encodeURIComponent(id)}`, { method: "DELETE", body: {} }); }, "已请求取消操作");
}
function handleResultAction(action: "start" | "connect" | "projects" | "repair"): void {
    if (action === "start") startRuntime(setup.value?.config.publicAccess && setup.value.passwordConfigured ? "public" : "local");
    else if (action === "projects") addOpen.value = true;
    else if (action === "repair") { navigate("maintenance"); runDoctor(true); }
    else navigate("connect");
}
</script>

<template>
    <el-config-provider :locale="zhCn">
    <div v-if="controllerClosed" class="console-closed">
        <div class="console-closed-card">
            <div class="console-logo">C</div>
            <h1>codex-mcp 已关闭</h1>
            <p>MCP 服务和 Web 控制台都已退出，项目、连接设置和密码仍然保留。</p>
            <code>codex-mcp open</code>
        </div>
    </div>
    <div v-else class="console-shell">
        <aside class="console-sidebar">
            <div class="console-brand">
                <span class="console-brand-text">codex-mcp</span>
            </div>
            <el-menu class="console-menu" :default-active="page" @select="handleMenuSelect">
                <el-menu-item v-for="item in navigation" :key="item.id" :index="item.id">
                    <el-icon><component :is="item.icon" /></el-icon>
                    <template #title>{{ item.label }}</template>
                </el-menu-item>
            </el-menu>
        </aside>

        <main class="console-main">
            <header class="console-topbar">
                <el-select :model-value="page" class="console-mobile-nav" @change="handleMenuSelect"><el-option v-for="item in navigation" :key="item.id" :label="item.label" :value="item.id" /></el-select>
                <h2 class="console-title">{{ pageTitle }}</h2>
                <div class="inline-actions" style="margin-left: auto">
                    <el-tag :type="loading ? 'info' : running ? 'success' : 'warning'" effect="light">{{ loading ? "正在连接" : running ? "服务运行中" : "服务未启动" }}</el-tag>
                    <el-tag effect="plain">v{{ consoleVersion }}</el-tag>
                    <el-button circle text :icon="Refresh" :loading="refreshing" aria-label="刷新" @click="refreshAll()" />
                </div>
            </header>

            <div class="console-content">
                <el-alert v-if="loadError || syncError" type="error" :closable="false" :title="loadError || syncError" style="margin-bottom: 16px" />
                <HomeView v-if="page === 'home'" :status="status" :setup="setup" :projects="projects" :conversation-count="conversations.length" :loading="loading" :busy="busy" :result="connectionResult" @navigate="navigate" @add="addOpen = true" @start="startRuntime" @stop="stopRuntime" @check="checkPublicAccess" @repair="navigate('maintenance'); runDoctor(true)" />
                <ProjectsView v-else-if="page === 'projects'" :projects="projects" :conversations="conversations" :busy="busy" @add="addOpen = true" @reactivate="reactivateProject" @remove="removeProject" @cleanup="cleanupConversations" />
                <ConnectView v-else-if="page === 'connect'" :setup="setup" :result="connectionResult" :operation="operations.connect" :zones="zones" :busy="busy" :save-password="savePassword" :generate-password="generatePassword" @check="checkPublicAccess" @discover="discoverCloudflare" @apply-cloudflare="applyCloudflare" @apply-external="applyExternal" @update-tunnel-protocol="updateTunnelProtocol" @cancel-operation="cancelOperation" @result-action="handleResultAction" />
                <MaintenanceView v-else :status="status" :setup="setup" :operation="operations.maintenance" :busy="busy" :save-capabilities="saveCapabilities" @restart-runtime="restartRuntime" @stop-runtime="stopRuntime" @shutdown="shutdownAll" @doctor="runDoctor" @update="selfUpdate" @cancel-operation="cancelOperation" />
            </div>
        </main>

        <AddProjectDialog v-model="addOpen" :busy="busy" :add-project="addProject" />
    </div>
    </el-config-provider>
</template>
