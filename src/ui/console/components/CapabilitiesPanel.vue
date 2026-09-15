<script setup lang="ts">
import { ref, watch } from "vue";
import type { CapabilityConfig, SetupSummary } from "../api.js";

const props = defineProps<{
    setup?: SetupSummary;
    busy: boolean;
    saveCapabilities: (config: CapabilityConfig) => Promise<void>;
}>();

const capabilities = ref<CapabilityConfig>();
const dirty = ref(false);

watch(
    () => props.setup?.capabilities,
    (value) => {
        if (dirty.value) return;
        capabilities.value = value ? cloneCapabilityConfig(value) : undefined;
    },
    { immediate: true, deep: true },
);

function cloneCapabilityConfig(value: CapabilityConfig): CapabilityConfig {
    return {
        sync: value.sync,
        priority: [...value.priority],
        sources: Object.fromEntries(
            Object.entries(value.sources).map(([id, source]) => [id, { ...source }]),
        ),
    };
}

function updateSource(id: string, key: "enabled" | "mcp" | "skills", value: boolean): void {
    const config = capabilities.value;
    const source = config?.sources[id];
    if (!config || !source) return;
    config.sources[id] = { ...source, [key]: value };
    dirty.value = true;
}
function updateSync(value: boolean): void {
    if (!capabilities.value) return;
    capabilities.value.sync = value ? "watch" : "startup";
    dirty.value = true;
}
function resetDraft(): void {
    capabilities.value = props.setup?.capabilities ? cloneCapabilityConfig(props.setup.capabilities) : undefined;
    dirty.value = false;
}
async function save(): Promise<void> {
    if (!capabilities.value) return;
    await props.saveCapabilities(cloneCapabilityConfig(capabilities.value));
    dirty.value = false;
    capabilities.value = props.setup?.capabilities ? cloneCapabilityConfig(props.setup.capabilities) : capabilities.value;
}

function detected(id: string): boolean {
    return props.setup?.detections.some((item) => item.label.toLowerCase().includes(id === "agents" ? "agent" : id)) ?? false;
}
</script>

<template>
    <div>
        <div class="section-heading">
            <div><div class="inline-actions"><h2>工具与技能</h2><el-tag v-if="dirty" type="warning" size="small" effect="plain">未保存</el-tag></div><p>按需读取本机已有的 Codex、Claude Code 和 Agent Skills 配置。</p></div>
            <div class="inline-actions"><el-button v-if="dirty" text :disabled="busy" @click="resetDraft">放弃修改</el-button><el-button type="primary" :disabled="!capabilities || !dirty || busy" @click="save">保存设置</el-button></div>
        </div>
        <template v-if="capabilities">
            <div class="capability-row">
                <div class="capability-title">
                    <div><strong>自动同步</strong><div class="muted small">来源配置变化后自动刷新，不需要重启 Runtime。</div></div>
                    <el-switch :model-value="capabilities.sync === 'watch'" @change="updateSync(Boolean($event))" />
                </div>
            </div>
            <div v-for="id in ['agents', 'codex', 'claude']" :key="id" class="capability-row">
                <div class="capability-title">
                    <div>
                        <div class="inline-actions"><strong>{{ id === 'agents' ? 'Agent Skills' : id === 'codex' ? 'Codex' : 'Claude Code' }}</strong><el-tag v-if="detected(id)" size="small" effect="plain">已检测到</el-tag></div>
                        <div class="muted small">允许 codex-mcp 读取这个来源中的工具和技能。</div>
                    </div>
                    <el-switch :model-value="capabilities.sources[id]?.enabled ?? false" @change="updateSource(id, 'enabled', Boolean($event))" />
                </div>
                <div v-if="capabilities.sources[id]?.enabled" class="capability-options">
                    <el-checkbox v-if="id !== 'agents'" :model-value="capabilities.sources[id]?.mcp ?? false" @change="updateSource(id, 'mcp', Boolean($event))">读取 MCP 配置</el-checkbox>
                    <el-checkbox :model-value="capabilities.sources[id]?.skills ?? false" @change="updateSource(id, 'skills', Boolean($event))">读取技能</el-checkbox>
                </div>
            </div>
        </template>
        <el-skeleton v-else :rows="3" animated />
    </div>
</template>
