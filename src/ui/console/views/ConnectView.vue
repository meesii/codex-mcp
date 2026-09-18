<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { Connection, CopyDocument, Key, MagicStick, Refresh } from "@element-plus/icons-vue";
import { ElMessage } from "element-plus/es/components/message/index";
import "element-plus/es/components/message/style/css";
import type { ConnectionCheck, OperationSnapshot, SetupSummary } from "../api.js";
import ConnectionResult from "../components/ConnectionResult.vue";
import OperationPanel from "../components/OperationPanel.vue";

const props = defineProps<{
    setup?: SetupSummary;
    result?: ConnectionCheck;
    operation?: OperationSnapshot;
    zones: string[];
    busy: boolean;
    savePassword: (password: string) => Promise<void>;
    generatePassword: () => Promise<string | undefined>;
}>();
const emit = defineEmits<{
    check: [];
    discover: [];
    applyCloudflare: [zone: string, prefix: string, overwrite: boolean];
    applyExternal: [domain: string];
    updateTunnelProtocol: [protocol: "http2" | "quic"];
    cancelOperation: [id: string];
    resultAction: [action: "start" | "connect" | "projects" | "repair"];
}>();

const cloudflareOpen = ref(false);
const externalOpen = ref(false);
const passwordOpen = ref(false);
const zone = ref("");
const prefix = ref("codex-mcp");
const overwrite = ref(false);
const externalDomain = ref("");
const password = ref("");
const generatedPassword = ref("");
const tunnelProtocol = ref<"http2" | "quic">("http2");

const access = computed(() => props.setup?.config.publicAccess);
const publicUrl = computed(() => access.value ? `https://${access.value.domain}/mcp` : "");
const savedTunnelProtocol = computed<"http2" | "quic">(() => props.setup?.config.runtime?.tunnelProtocol ?? "http2");
const tunnelProtocolChanged = computed(() => tunnelProtocol.value !== savedTunnelProtocol.value);

watch(() => props.zones, (values) => { if (values.length && !values.includes(zone.value)) zone.value = values[0] ?? ""; }, { immediate: true });
watch(savedTunnelProtocol, (value, previous) => {
    if (previous === undefined || tunnelProtocol.value === previous) tunnelProtocol.value = value;
}, { immediate: true });

async function copy(value: string): Promise<void> {
    try { await navigator.clipboard.writeText(value); ElMessage.success("已复制到剪贴板"); }
    catch { ElMessage.error("复制失败，请手动复制"); }
}
async function saveConnectionPassword(): Promise<void> {
    await props.savePassword(password.value);
    password.value = "";
    passwordOpen.value = false;
}
async function generate(): Promise<void> {
    const value = await props.generatePassword();
    if (value) generatedPassword.value = value;
}
</script>

<template>
    <div class="page-stack">
        <div class="page-surface settings-surface">
            <section class="settings-section">
                <div class="settings-heading"><h2>公网地址</h2><el-tag :type="access ? 'success' : 'warning'">{{ access ? "已配置" : "未配置" }}</el-tag></div>
                <div v-if="publicUrl" class="copy-box"><el-icon><Connection /></el-icon><code>{{ publicUrl }}</code><el-button text :icon="CopyDocument" @click="copy(publicUrl)" /></div>
                <div class="settings-actions">
                    <el-button type="primary" :icon="MagicStick" @click="cloudflareOpen = true">Cloudflare 配置</el-button>
                    <el-button @click="externalOpen = true">自有域名</el-button>
                    <template v-if="access?.kind === 'cloudflare'">
                        <el-select v-model="tunnelProtocol" class="protocol-select" :disabled="busy">
                            <el-option label="HTTP/2" value="http2" />
                            <el-option label="QUIC" value="quic" />
                        </el-select>
                        <el-button :disabled="!tunnelProtocolChanged || busy" :loading="busy" @click="emit('updateTunnelProtocol', tunnelProtocol)">应用 Cloudflare 协议</el-button>
                    </template>
                </div>
                <OperationPanel :operation="operation" @cancel="emit('cancelOperation', $event)" />
            </section>

            <section class="settings-section">
                <div class="settings-heading"><h2>连接密码</h2><el-tag :type="setup?.passwordConfigured ? 'success' : 'warning'">{{ setup?.passwordConfigured ? "已设置" : "未设置" }}</el-tag></div>
                <div class="inline-actions"><el-button :icon="Key" @click="passwordOpen = true">{{ setup?.passwordConfigured ? "更换密码" : "设置密码" }}</el-button><el-button text @click="generate">生成安全密码</el-button></div>
                <el-alert v-if="generatedPassword" style="margin-top: 14px" type="warning" :closable="false"><template #title>请保存密码明文</template><div class="copy-box" style="margin-top: 8px"><code>{{ generatedPassword }}</code><el-button text :icon="CopyDocument" @click="copy(generatedPassword)" /></div></el-alert>
            </section>

            <section class="settings-section settings-section-last">
                <div class="settings-heading"><h2>连接检查</h2><el-button type="primary" :icon="Refresh" :loading="busy" @click="emit('check')">检查</el-button></div>
            </section>
        </div>

        <ConnectionResult :result="result" @action="emit('resultAction', $event)" />

        <el-dialog v-model="cloudflareOpen" title="Cloudflare 自动配置" width="min(520px, 92vw)">
            <template v-if="zones.length">
                <el-form label-position="top">
                    <el-form-item label="域名"><el-select v-model="zone" style="width: 100%"><el-option v-for="item in zones" :key="item" :label="item" :value="item" /></el-select></el-form-item>
                    <el-form-item label="子域名前缀"><el-input v-model="prefix" /><div class="muted small" style="margin-top: 6px">最终地址：{{ prefix || 'codex-mcp' }}.{{ zone || 'example.com' }}</div></el-form-item>
                    <el-form-item><el-checkbox v-model="overwrite">允许替换同名 DNS 记录</el-checkbox></el-form-item>
                </el-form>
            </template>
            <el-empty v-else description="读取 Cloudflare 域名"><el-button type="primary" :loading="busy" @click="emit('discover')">读取可用域名</el-button></el-empty>
            <template #footer><el-button @click="cloudflareOpen = false">取消</el-button><el-button v-if="zones.length" type="primary" :disabled="!zone || !prefix.trim() || busy" @click="cloudflareOpen = false; emit('applyCloudflare', zone, prefix, overwrite)">开始配置</el-button></template>
        </el-dialog>

        <el-dialog v-model="externalOpen" title="使用自己的域名" width="min(500px, 92vw)">
            <el-form label-position="top"><el-form-item label="HTTPS 域名"><el-input v-model="externalDomain" placeholder="mcp.example.com" /><div class="muted small" style="margin-top: 6px">只填写域名，不包含 https:// 或 /mcp。</div></el-form-item></el-form>
            <template #footer><el-button @click="externalOpen = false">取消</el-button><el-button type="primary" :disabled="!externalDomain.trim() || busy" @click="externalOpen = false; emit('applyExternal', externalDomain)">保存并检查</el-button></template>
        </el-dialog>

        <el-dialog v-model="passwordOpen" :title="setup?.passwordConfigured ? '更换连接密码' : '设置连接密码'" width="min(500px, 92vw)">
            <el-form label-position="top"><el-form-item label="新密码"><el-input v-model="password" type="password" show-password autocomplete="new-password" placeholder="至少 12 个字符" /></el-form-item></el-form>
            <template #footer><el-button @click="passwordOpen = false">取消</el-button><el-button type="primary" :loading="busy" :disabled="password.length < 12" @click="saveConnectionPassword">保存密码</el-button></template>
        </el-dialog>
    </div>
</template>
