<script setup lang="ts">
import { computed } from "vue";
import { CircleCheck, Loading, WarningFilled, CircleClose } from "@element-plus/icons-vue";
import { friendlyError, type OperationSnapshot } from "../api.js";

const props = defineProps<{ operation?: OperationSnapshot }>();
const emit = defineEmits<{ cancel: [id: string] }>();

const presentation = computed(() => {
    const state = props.operation?.state;
    if (state === "succeeded") return { type: "success" as const, label: "已完成", icon: CircleCheck };
    if (state === "cancelled") return { type: "warning" as const, label: "已取消", icon: WarningFilled };
    if (state === "failed") return { type: "danger" as const, label: "未完成", icon: CircleClose };
    return { type: "info" as const, label: "正在处理", icon: Loading };
});

function friendlyPhase(message: string): string {
    const exact: Record<string, string> = {
        "准备中": "正在准备",
        "运行诊断": "正在检查服务",
        "执行安全本机修复": "正在修复常见问题",
        "验证公网连接": "正在检查公网连接",
        "打开 Cloudflare 登录": "正在打开 Cloudflare 登录",
        "读取 Cloudflare 登录": "正在读取 Cloudflare 账户",
        "Cloudflare 域名已读取": "可用域名已读取",
        "正在取消": "正在取消",
        "完成": "操作已完成",
    };
    return exact[message] ?? message;
}
</script>

<template>
    <el-card v-if="operation" class="operation-panel" shadow="never">
        <div class="section-heading" style="margin-bottom: 0">
            <div>
                <div class="inline-actions">
                    <el-icon :class="{ 'is-loading': operation.state === 'running' }"><component :is="presentation.icon" /></el-icon>
                    <strong>{{ friendlyPhase(operation.phase) }}</strong>
                    <el-tag :type="presentation.type" effect="light">{{ presentation.label }}</el-tag>
                </div>
                <div v-if="operation.messages.length" class="operation-messages">
                    <div v-for="(message, index) in operation.messages.slice(-8)" :key="`${index}-${message}`">{{ friendlyPhase(message) }}</div>
                </div>
                <el-alert v-if="operation.error" class="operation-panel" type="error" :closable="false" :title="friendlyError(operation.error)" />
            </div>
            <el-button v-if="operation.state === 'running'" text @click="emit('cancel', operation.id)">取消</el-button>
        </div>
    </el-card>
</template>
