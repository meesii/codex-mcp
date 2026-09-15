<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { FolderAdd, ChatDotRound, Delete } from "@element-plus/icons-vue";
import type { Conversation, Project } from "../api.js";

const props = defineProps<{ projects: Project[]; conversations: Conversation[]; busy: boolean }>();
const emit = defineEmits<{
    add: [];
    reactivate: [project: Project];
    remove: [project: Project];
    cleanup: [project: Project, ids: string[]];
}>();

const drawerOpen = ref(false);
const drawerProject = ref<Project>();
const activeConversations = computed(() => drawerProject.value ? props.conversations.filter((item) => item.projectId === drawerProject.value!.id) : []);
function conversationCount(project: Project): number { return props.conversations.filter((item) => item.projectId === project.id).length; }
function openProject(project: Project): void { drawerProject.value = project; drawerOpen.value = true; }
watch(() => props.projects, (items) => {
    if (!drawerProject.value) return;
    const current = items.find((item) => item.id === drawerProject.value?.id);
    if (!current) { drawerOpen.value = false; drawerProject.value = undefined; return; }
    drawerProject.value = current;
}, { deep: true });
</script>

<template>
    <div>
        <div class="page-heading">
            <div class="section-heading" style="margin-bottom: 0">
                <div><h1>项目</h1><p>管理 ChatGPT 可以访问的项目，以及各项目的会话绑定。</p></div>
                <el-button type="primary" :icon="FolderAdd" @click="emit('add')">添加项目</el-button>
            </div>
        </div>

        <el-card shadow="never">
            <el-empty v-if="!projects.length" description="还没有项目"><el-button type="primary" @click="emit('add')">选择项目文件夹</el-button></el-empty>
            <el-table v-else :data="projects" style="width: 100%" @row-click="openProject">
                <el-table-column label="项目" min-width="280">
                    <template #default="{ row }"><div class="project-name">{{ row.name }}</div><div class="project-path">{{ row.path }}</div></template>
                </el-table-column>
                <el-table-column label="状态" width="110"><template #default="{ row }"><el-tag :type="row.active ? 'success' : 'info'" effect="light">{{ row.active ? "可用" : "已停用" }}</el-tag></template></el-table-column>
                <el-table-column label="会话" width="90"><template #default="{ row }">{{ conversationCount(row) }}</template></el-table-column>
                <el-table-column label="操作" width="180" align="right">
                    <template #default="{ row }"><el-button text type="primary" @click.stop="openProject(row)">管理</el-button><el-button v-if="row.active" text type="danger" :disabled="busy" @click.stop="emit('remove', row)">停用</el-button><el-button v-else text type="primary" :disabled="busy" @click.stop="emit('reactivate', row)">重新启用</el-button></template>
                </el-table-column>
            </el-table>
        </el-card>
        <p v-if="conversations.length" class="muted small" style="margin-top: 12px">会话编号只用于区分项目选择记录，不代表 ChatGPT 对话正在运行。</p>

        <el-drawer v-model="drawerOpen" :title="drawerProject?.name ?? '项目详情'" size="min(520px, 92vw)">
            <template v-if="drawerProject">
                <el-descriptions :column="1" border>
                    <el-descriptions-item label="状态"><el-tag :type="drawerProject.active ? 'success' : 'info'">{{ drawerProject.active ? "可用" : "已停用" }}</el-tag></el-descriptions-item>
                    <el-descriptions-item label="目录"><span class="break-all mono small">{{ drawerProject.path }}</span></el-descriptions-item>
                    <el-descriptions-item label="项目 ID"><span class="mono small">{{ drawerProject.id }}</span></el-descriptions-item>
                </el-descriptions>
                <div class="section-heading" style="margin-top: 24px">
                    <div><h2>会话绑定</h2><p>清除后，该 ChatGPT 会话下次使用项目工具时需要重新选择项目。</p></div>
                    <el-button v-if="activeConversations.length > 1" text type="danger" :disabled="busy" @click="emit('cleanup', drawerProject, activeConversations.map((item) => item.id))">清理全部</el-button>
                </div>
                <el-empty v-if="!activeConversations.length" :image-size="60" description="还没有会话选择过这个项目" />
                <div v-for="item in activeConversations" v-else :key="item.id" class="conversation-row">
                    <el-icon><ChatDotRound /></el-icon>
                    <div class="conversation-meta"><div>{{ item.label }} · {{ item.id.slice(0, 8) }}</div><div class="muted small">最近使用 {{ new Date(item.lastSeenAt).toLocaleString("zh-CN") }}</div></div>
                    <el-button text type="danger" :icon="Delete" :disabled="busy" @click="emit('cleanup', drawerProject, [item.id])">清除</el-button>
                </div>
                <el-button v-if="drawerProject.active" style="margin-top: 24px" type="danger" plain :disabled="busy" @click="emit('remove', drawerProject)">停用这个项目</el-button>
                <el-button v-else style="margin-top: 24px" type="primary" :disabled="busy" @click="emit('reactivate', drawerProject)">重新启用这个项目</el-button>
            </template>
        </el-drawer>
    </div>
</template>
