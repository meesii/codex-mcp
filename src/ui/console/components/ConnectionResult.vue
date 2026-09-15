<script setup lang="ts">
import { CircleCheck, WarningFilled, Clock } from "@element-plus/icons-vue";
import type { ConnectionCheck } from "../api.js";

defineProps<{ result?: ConnectionCheck }>();
const emit = defineEmits<{ action: [value: "start" | "connect" | "projects" | "repair"] }>();

function iconFor(state: ConnectionCheck["checks"][number]["state"]) {
    return state === "passed" ? CircleCheck : state === "failed" ? WarningFilled : Clock;
}
function colorFor(state: ConnectionCheck["checks"][number]["state"]): string {
    return state === "passed" ? "var(--el-color-success)" : "var(--el-color-warning)";
}
</script>

<template>
    <el-card v-if="result" shadow="never">
        <div class="section-heading">
            <div>
                <h2>{{ result.ready ? "连接检查通过" : "还有检查项需要处理" }}</h2>
                <p>{{ result.ready ? "服务已准备好，可以在 ChatGPT 中使用这个 MCP 连接。" : "按下面提示处理后再重新检查。" }}</p>
            </div>
            <el-tag :type="result.ready ? 'success' : 'warning'">{{ result.ready ? "已就绪" : "未就绪" }}</el-tag>
        </div>
        <div v-for="item in result.checks" :key="item.id" class="status-line">
            <div class="inline-actions" style="align-items: flex-start">
                <el-icon :style="{ color: colorFor(item.state), marginTop: '2px' }"><component :is="iconFor(item.state)" /></el-icon>
                <div><strong>{{ item.label }}</strong><div class="muted small" style="margin-top: 4px">{{ item.detail }}</div></div>
            </div>
            <el-button v-if="item.action" text type="primary" @click="emit('action', item.action)">去处理</el-button>
        </div>
        <div class="muted small" style="margin-top: 12px">检查时间 {{ new Date(result.checkedAt).toLocaleTimeString("zh-CN") }}</div>
    </el-card>
</template>
