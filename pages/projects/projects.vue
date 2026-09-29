<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { onHide, onShow } from "@dcloudio/uni-app";
import type { CodexProjectCandidate, CodexThreadSummary, ProjectSummary } from "../../types/agent";
import { agent } from "../../utils/agent";
import GlassNavbar from "../../components/glass-navbar/GlassNavbar.vue";
import LiquidTabBar from "../../components/liquid-tabbar/LiquidTabBar.vue";
import { useIosTabTransition } from "../../utils/page-transition";
import { syncTheme, themeClass } from "../../utils/theme";

const { entering, replay } = useIosTabTransition();

const projects = ref<ProjectSummary[]>([]);
const codexProjects = ref<CodexProjectCandidate[]>([]);
const selected = ref<ProjectSummary | null>(null);
const showForm = ref(false);
const showCodexProjects = ref(false);
const name = ref("");
const path = ref("");
const notice = ref("");
const busy = ref(false);
const syncing = ref(false);
const expandedProjectId = ref("");
const sessions = ref<CodexThreadSummary[]>([]);
const archivedSessions = ref<CodexThreadSummary[]>([]);
const sessionsNew = ref(false);
const sessionsBusy = ref(false);
let runningRefreshTimer: ReturnType<typeof setInterval> | null = null;
const runningTurnSignature = computed(() => agent.runningTurnSignature());
const refreshRunningSessions = async () => {
  const project = agent.selectedProject;
  if (!project || agent.state !== "online" || expandedProjectId.value !== project.id) return;
  try {
    const snapshot = await agent.listThreads(project);
    if (expandedProjectId.value !== project.id) return;
    sessions.value = snapshot.sessions;
    archivedSessions.value = snapshot.archived_sessions || [];
    sessionsNew.value = snapshot.is_new_thread;
  } catch {
    // The next tick or manual expansion will retry.
  }
};

const refresh = async () => {
  if (!agent.settings.token) {
    uni.navigateTo({ url: "/pages/pair/pair" });
    return;
  }
  if (agent.state !== "online") {
    notice.value = "先在连接页完成配对";
    return;
  }
  try {
    projects.value = await agent.loadProjects();
    selected.value = agent.selectedProject;
    if (!projects.value.length) {
      showForm.value = true;
    }
  } catch (error: any) {
    notice.value = error?.message || "项目加载失败";
  }
};
watch(runningTurnSignature, () => {
  void refreshRunningSessions();
}, { flush: "sync" });

const choose = async (project: ProjectSummary) => {
  if (busy.value) return;
  busy.value = true;
  notice.value = "切换中";
  try {
    await agent.selectProject(project);
    selected.value = agent.selectedProject;
    notice.value = "已切换到当前项目";
    uni.switchTab({ url: "/pages/index/index" });
  } catch (error: any) {
    notice.value = error?.message || "切换失败";
  } finally {
    busy.value = false;
  }
};

const formatSessionTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const sessionLabel = (thread: CodexThreadSummary) => {
  const title = String(thread.title || "").trim();
  if (title) return title;
  const date = new Date(thread.updated_at);
  if (Number.isNaN(date.getTime())) return "会话";
  return `会话 · ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const sessionDetail = (thread: CodexThreadSummary) => (
  `${formatSessionTime(thread.updated_at)} · ${thread.model || "跟随 Codex"} · ${thread.reasoning_effort || "default"}`
);

const toggleSessions = async (project: ProjectSummary) => {
  if (busy.value || sessionsBusy.value) return;
  if (expandedProjectId.value === project.id) {
    expandedProjectId.value = "";
    return;
  }
  expandedProjectId.value = project.id;
  if (agent.selectedProject?.id !== project.id) {
    try {
      await agent.selectProject(project);
      selected.value = agent.selectedProject;
    } catch (error: any) {
      expandedProjectId.value = "";
      notice.value = error?.message || "项目切换失败";
      return;
    }
  }
  if (!agent.selectedProject || agent.selectedProject.id !== project.id) return;
  sessionsBusy.value = true;
  try {
    const snapshot = await agent.listThreads(project);
    if (expandedProjectId.value !== project.id) return;
    sessions.value = snapshot.sessions;
    archivedSessions.value = snapshot.archived_sessions || [];
    sessionsNew.value = snapshot.is_new_thread;
  } catch (error: any) {
    notice.value = error?.message || "会话读取失败";
  } finally {
    sessionsBusy.value = false;
  }
};

const chooseSession = async (project: ProjectSummary, sessionId: string) => {
  if (busy.value || sessionsBusy.value) return;
  busy.value = true;
  notice.value = "切换会话中";
  try {
    if (agent.selectedProject?.id !== project.id) {
      await agent.selectProject(project);
    }
    await agent.selectThread(project, sessionId);
    selected.value = agent.selectedProject;
    expandedProjectId.value = project.id;
    notice.value = "已切换会话";
    uni.switchTab({ url: "/pages/index/index" });
  } catch (error: any) {
    notice.value = error?.message || "会话切换失败";
  } finally {
    busy.value = false;
  }
};

const startProjectSession = async (project: ProjectSummary) => {
  if (busy.value || sessionsBusy.value) return;
  busy.value = true;
  notice.value = "正在创建新会话";
  try {
    if (agent.selectedProject?.id !== project.id) {
      await agent.selectProject(project);
    }
    await agent.newThread(project);
    selected.value = agent.selectedProject;
    sessionsNew.value = true;
    notice.value = "已开启新会话";
    uni.switchTab({ url: "/pages/index/index" });
  } catch (error: any) {
    notice.value = error?.message || "新会话创建失败";
  } finally {
    busy.value = false;
  }
};

const syncCodexProjects = async () => {
  if (busy.value || syncing.value) return;
  if (agent.state !== "online") {
    notice.value = "先在连接页完成配对并连接";
    return;
  }
  if (agent.supportsCodexProjectSync === false) {
    notice.value = "当前 PC Agent 版本不支持同步，请重启 backend\\start.bat 后再试";
    return;
  }
  syncing.value = true;
  notice.value = "正在同步 Codex 项目和会话";
  try {
    const result = await agent.syncCodexProjectsAndSessions();
    codexProjects.value = result.projects;
    projects.value = [...agent.projects];
    selected.value = agent.selectedProject;
    showCodexProjects.value = true;
    const projectCount = result.synced_projects || 0;
    const sessionCount = result.synced_sessions || 0;
    notice.value = codexProjects.value.length
      ? `已同步 ${projectCount} 个项目 · ${sessionCount} 个会话`
      : "Codex 还没有找到项目记录";
  } catch (error: any) {
    const message = String(error?.message || "");
    notice.value = /unknown message type/i.test(message)
      ? "当前 PC Agent 版本过旧，请在电脑上重启 backend\\start.bat 后再同步"
      : message || "Codex 项目同步失败";
  } finally {
    syncing.value = false;
  }
};

const deleteSession = (project: ProjectSummary, thread: CodexThreadSummary) => {
  if (busy.value || sessionsBusy.value) return;
  uni.showModal({
    title: "删除会话？",
    content: `${sessionLabel(thread)} 将从远程列表移除，PC 原始 Codex 记录保留。`,
    confirmText: "删除",
    confirmColor: "#e11d48",
    success: async (result) => {
      if (!result.confirm) return;
      busy.value = true;
      notice.value = "正在删除会话";
      try {
        await agent.deleteThread(project, thread.session_id || thread.thread_id || "");
        projects.value = [...agent.projects];
        selected.value = agent.selectedProject;
        sessions.value = sessions.value.filter((item) => item.session_id !== thread.session_id);
        archivedSessions.value = archivedSessions.value.filter(
          (item) => item.session_id !== thread.session_id,
        );
        notice.value = "会话已删除";
      } catch (error: any) {
        notice.value = error?.message || "会话删除失败";
      } finally {
        busy.value = false;
      }
    },
  });
};

const deleteProject = (project: ProjectSummary) => {
  if (busy.value || sessionsBusy.value) return;
  uni.showModal({
    title: "移除项目？",
    content: `${project.name} 将从远程项目列表移除，本地目录和 Codex 历史记录保留。`,
    confirmText: "移除",
    confirmColor: "#e11d48",
    success: async (result) => {
      if (!result.confirm) return;
      busy.value = true;
      notice.value = "正在移除项目";
      try {
        await agent.deleteProject(project);
        projects.value = [...agent.projects];
        selected.value = agent.selectedProject;
        if (expandedProjectId.value === project.id) {
          expandedProjectId.value = "";
          sessions.value = [];
          archivedSessions.value = [];
        }
        notice.value = "项目已移除，本地文件未删除";
      } catch (error: any) {
        notice.value = error?.message || "项目移除失败";
      } finally {
        busy.value = false;
      }
    },
  });
};
const codexProjectAction = async (candidate: CodexProjectCandidate) => {
  if (busy.value || !candidate.importable) return;
  const wasImported = candidate.imported;
  if (candidate.imported && candidate.project_id) {
    busy.value = true;
    notice.value = "同步会话中";
  } else {
    busy.value = true;
    notice.value = "导入中";
  }
  try {
    await agent.importCodexProject(candidate.path, candidate.name);
    projects.value = [...agent.projects];
    selected.value = agent.selectedProject;
    candidate.imported = true;
    candidate.project_id = agent.selectedProject?.id || null;
    notice.value = wasImported ? "Codex 会话已同步" : "Codex 项目已导入";
    if (!wasImported) {
      uni.switchTab({ url: "/pages/index/index" });
    }
  } catch (error: any) {
    notice.value = error?.message || "同步失败";
  } finally {
    busy.value = false;
  }
};

const candidateTime = (value: string) => {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return "时间未知";
  return `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const create = async () => {
  if (!path.value.trim()) {
    notice.value = "请填写 PC 项目路径";
    return;
  }
  busy.value = true;
  notice.value = "创建中";
  try {
    await agent.createProject(name.value.trim(), path.value.trim());
    projects.value = [...agent.projects];
    selected.value = agent.selectedProject;
    showForm.value = false;
    name.value = "";
    path.value = "";
    notice.value = "项目已创建";
  } catch (error: any) {
    notice.value = error?.message || "创建失败";
  } finally {
    busy.value = false;
  }
};

onShow(() => {
  syncTheme();
  replay();
  refresh();
  if (runningRefreshTimer === null) {
    runningRefreshTimer = setInterval(() => {
      void refreshRunningSessions();
    }, 5000) as unknown as number;
  }
});

onHide(() => {
  if (runningRefreshTimer !== null) {
    clearInterval(runningRefreshTimer);
    runningRefreshTimer = null;
  }
});
</script>

<template>
  <view class="screen" :class="themeClass">
    <GlassNavbar
      title="项目"
      :subtitle="selected?.name || '选择一个 Codex 工作目录'"
      :theme-class="themeClass"
    />
    <view class="tab-content" :class="{ 'ios-page-enter': entering }">
      <view class="sync-bar">
      <view class="sync-copy">
        <text class="sync-title">Codex 项目</text>
        <text class="sync-sub">从本机 Codex 历史记录读取工作目录</text>
      </view>
      <button class="sync-button" :disabled="syncing" @click="syncCodexProjects">
        {{ syncing ? "读取中" : "同步" }}
      </button>
    </view>

    <view v-if="showCodexProjects" class="codex-section">
      <view class="section-heading">
        <text class="section-title">Codex 项目</text>
        <text class="section-count">{{ codexProjects.length }}</text>
      </view>
      <view v-if="!codexProjects.length" class="codex-empty">
        <text>没有发现可同步的 Codex 工作目录</text>
      </view>
      <view
        v-for="candidate in codexProjects"
        :key="candidate.path"
        class="codex-project"
        :class="{ unavailable: !candidate.importable }"
      >
        <view class="codex-project-main">
          <view class="codex-project-title-row">
            <text class="codex-project-name">{{ candidate.name }}</text>
            <text v-if="candidate.imported" class="imported-tag">已导入</text>
            <text v-else-if="!candidate.importable" class="unavailable-tag">不可访问</text>
          </view>
          <text class="codex-project-path mono">{{ candidate.path }}</text>
          <text class="codex-project-meta">{{ candidate.session_count }} 次会话 · 最近 {{ candidateTime(candidate.last_used_at) }}</text>
        </view>
        <button
          v-if="candidate.importable"
          class="codex-action"
          :disabled="busy"
          @click="codexProjectAction(candidate)"
        >
          {{ candidate.imported ? "进入" : "导入" }}
        </button>
      </view>
    </view>

    <view v-if="showForm" class="card form">
      <view>
        <text class="field-label">项目名</text>
        <input v-model="name" class="input input-text" placeholder="可选，默认取目录名" placeholder-class="placeholder" />
      </view>
      <view>
        <text class="field-label">PC 路径</text>
        <input v-model="path" class="input input-text mono" placeholder="D:\work\code\remoteAi" placeholder-class="placeholder" />
      </view>
      <view class="form-actions">
        <button class="ghost" @click="showForm = false">取消</button>
        <button class="primary" :disabled="busy" @click="create">创建</button>
      </view>
    </view>

    <view v-if="!projects.length && !showForm && !codexProjects.length" class="empty">
      <text>还没有项目。添加 PC Agent 允许目录里的项目后，就可以从这里远程驱动 Codex。</text>
    </view>

    <view
      v-for="project in projects"
      :key="project.id"
      class="project"
      :class="{ current: selected?.id === project.id }"
      @click="choose(project)"
    >
      <view class="project-row">
        <view class="project-icon">{{ project.name.slice(0, 1).toUpperCase() }}</view>
        <view class="project-main">
          <text class="project-name">{{ project.name }}</text>
          <text class="project-path mono">{{ project.normalized_path }}</text>
        </view>
        <text v-if="selected?.id === project.id" class="current-tag">当前</text>
      </view>
      <view class="project-actions">
        <button class="action" @click.stop="choose(project)">继续当前</button>
        <button class="action" @click.stop="toggleSessions(project)">历史会话</button>
        <button class="action danger-action" @click.stop="deleteProject(project)">移除项目</button>
      </view>
      <view v-if="expandedProjectId === project.id" class="session-drawer">
        <view class="session-head">
          <text class="session-heading">会话</text>
          <text v-if="sessionsBusy && expandedProjectId === project.id" class="session-loading">读取中</text>
        </view>
        <button
          class="session-item"
          :class="{ active: sessionsNew && agent.selectedProject?.id === project.id }"
          :disabled="busy || sessionsBusy"
          @click.stop="startProjectSession(project)"
        >
          <view class="session-main">
            <text class="session-title">新会话</text>
            <text class="session-detail">空上下文 · 发送第一句后创建</text>
          </view>
        </button>
        <view
          v-for="thread in sessions"
          :key="thread.session_id || thread.thread_id"
          class="session-item"
          :class="{ active: thread.current && agent.selectedProject?.id === project.id }"
          :disabled="busy || sessionsBusy"
          @click.stop="chooseSession(project, thread.session_id || thread.thread_id || '')"
        >
          <view class="session-main">
            <text class="session-title">{{ sessionLabel(thread) }}</text>
            <text class="session-detail">{{ sessionDetail(thread) }}</text>
          </view>
          <view class="session-actions">
            <text v-if="thread.running" class="session-running">运行中</text>
            <text class="session-time">{{ formatSessionTime(thread.updated_at) }}</text>
            <button
              class="session-delete"
              :disabled="busy || sessionsBusy"
              @click.stop="deleteSession(project, thread)"
            >删除</button>
          </view>
        </view>
        <view v-if="archivedSessions.length" class="session-head archived">
          <text class="session-heading">历史</text>
        </view>
        <view
          v-for="thread in archivedSessions"
          :key="`archived-${thread.session_id || thread.thread_id}`"
          class="session-item"
          :disabled="busy || sessionsBusy"
          @click.stop="chooseSession(project, thread.session_id || thread.thread_id || '')"
        >
          <view class="session-main">
            <text class="session-title">{{ sessionLabel(thread) }}</text>
            <text class="session-detail">{{ sessionDetail(thread) }} · 已归档</text>
          </view>
          <view class="session-actions">
            <text v-if="thread.running" class="session-running">运行中</text>
            <text class="session-time">{{ formatSessionTime(thread.updated_at) }}</text>
            <button
              class="session-delete"
              :disabled="busy || sessionsBusy"
              @click.stop="deleteSession(project, thread)"
            >删除</button>
          </view>
        </view>
        <text v-if="!sessions.length && !archivedSessions.length && !sessionsBusy" class="session-empty">暂无会话</text>
      </view>
    </view>

    <button class="new-project" @click="showForm = !showForm">
      {{ showForm ? "收起创建面板" : "+ 添加新项目" }}
    </button>

    <text v-if="notice" class="notice">{{ notice }}</text>
    </view>
    <LiquidTabBar current="projects" :theme-class="themeClass" />
  </view>
</template>

<style>
.screen {
  padding-top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 52px + 10px);
  padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px));
}
.sync-bar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin: 12px 0 14px;
  padding: 13px 14px;
  border: 1px solid rgba(125, 211, 252, 0.18);
  border-radius: 14px;
  background: rgba(14, 28, 48, 0.82);
}
.sync-copy {
  flex: 1;
  min-width: 0;
}
.sync-title,
.sync-sub {
  display: block;
}
.sync-title {
  color: #dbeafe;
  font-size: 13px;
  font-weight: 650;
}
.sync-sub {
  margin-top: 3px;
  overflow: hidden;
  color: #8291ad;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.sync-button {
  width: 58px;
  height: 32px;
  flex: none;
  border: 1px solid rgba(125, 211, 252, 0.35);
  border-radius: 9px;
  background: #12314a;
  color: #b7e5ff;
  font-size: 12px;
  line-height: 30px;
}
.theme-light .sync-button {
  border-color: rgba(24, 39, 61, 0.14) !important;
  background: rgba(255, 255, 255, 0.52) !important;
  color: #6a7688 !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
.codex-section {
  margin-bottom: 16px;
}
.section-heading {
  display: flex;
  align-items: center;
  gap: 7px;
  margin: 4px 2px 9px;
}
.section-title {
  color: #dbeafe;
  font-size: 13px;
  font-weight: 650;
}
.section-count {
  min-width: 17px;
  padding: 1px 5px;
  box-sizing: border-box;
  border-radius: 8px;
  background: #172b43;
  color: #8dcdf0;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}
.codex-empty {
  padding: 16px 13px;
  border: 1px dashed #29405f;
  border-radius: 12px;
  color: #7d8db0;
  font-size: 12px;
  text-align: center;
}
.codex-project {
  display: flex;
  align-items: center;
  gap: 10px;
  margin-top: 8px;
  padding: 11px 12px;
  border: 1px solid rgba(125, 211, 252, 0.16);
  border-radius: 12px;
  background: rgba(13, 23, 39, 0.88);
}
.codex-project.unavailable {
  border-color: rgba(255, 255, 255, 0.06);
  opacity: 0.72;
}
.codex-project-main {
  flex: 1;
  min-width: 0;
}
.codex-project-title-row {
  display: flex;
  align-items: center;
  gap: 7px;
}
.codex-project-name {
  overflow: hidden;
  color: #e7ecf5;
  font-size: 13px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-project-path,
.codex-project-meta {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.codex-project-path {
  margin-top: 3px;
  color: #88b8d5;
  font-size: 10px;
}
.codex-project-meta {
  margin-top: 4px;
  color: #71819e;
  font-size: 10px;
}
.imported-tag,
.unavailable-tag {
  flex: none;
  padding: 2px 5px;
  border-radius: 5px;
  font-size: 9px;
}
.imported-tag {
  background: rgba(74, 222, 128, 0.12);
  color: #86efac;
}
.unavailable-tag {
  background: rgba(148, 163, 184, 0.12);
  color: #94a3b8;
}
.codex-action {
  width: 48px;
  height: 30px;
  flex: none;
  border: 1px solid #285172;
  border-radius: 8px;
  background: #10243a;
  color: #b7e5ff;
  font-size: 11px;
  line-height: 28px;
}
.form {
  margin: 10px 0 14px;
  padding: 14px;
}
.form > view + view {
  margin-top: 12px;
}
.input-text {
  height: 43px;
  padding: 0 12px;
  font-size: 13px;
}
.form-actions {
  display: flex;
  gap: 10px;
}
.primary {
  flex: 1;
  height: 41px;
  border-radius: 12px;
  background: #e8703a;
  color: #fff;
  font-size: 14px;
  font-weight: 650;
  line-height: 41px;
}
.ghost {
  flex: 1;
  height: 41px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: #8b93a7;
  font-size: 14px;
  line-height: 39px;
}
.empty {
  padding: 28px 18px;
  border: 1px dashed #2a3a60;
  border-radius: 16px;
  background: rgba(16, 23, 40, 0.55);
  color: #7d8db0;
  font-size: 13px;
  line-height: 1.8;
  text-align: center;
}
.project {
  margin-top: 12px;
  padding: 13px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 16px;
  background: #101728;
  transition: transform 0.15s ease;
}
.project.current {
  border-color: rgba(232, 112, 58, 0.55);
  background: linear-gradient(150deg, rgba(232, 112, 58, 0.1), #101728 60%);
}
.project-row {
  display: flex;
  align-items: center;
  gap: 10px;
}
.project-icon {
  width: 34px;
  height: 34px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.06);
  border-radius: 10px;
  background: #1a2338;
  color: #f0a06a;
  font-size: 15px;
  font-weight: 700;
}
.project-main {
  flex: 1;
  min-width: 0;
}
.project-name {
  display: block;
  overflow: hidden;
  font-size: 14px;
  font-weight: 650;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.project-path {
  display: block;
  margin-top: 4px;
  color: #7dd3fc;
  font-size: 11px;
  word-break: break-all;
}
.current-tag {
  padding: 3px 8px;
  border: 1px solid rgba(232, 112, 58, 0.4);
  border-radius: 99px;
  color: #f0a06a;
  font-size: 10px;
}
.project-actions {
  display: flex;
  gap: 8px;
  margin-top: 11px;
}
.action {
  flex: 1;
  height: 32px;
  border: 1px solid #223052;
  border-radius: 9px;
  background: #0e1526;
  color: #a9b7d3;
  font-size: 12px;
  line-height: 30px;
}
.session-drawer {
  margin-top: 10px;
  padding: 9px;
  border: 1px solid rgba(125, 211, 252, 0.14);
  border-radius: 11px;
  background: rgba(7, 13, 24, 0.68);
}
.session-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
}
.session-head.archived {
  margin-top: 10px;
}
.session-heading {
  color: #9fb6d4;
  font-size: 10px;
  font-weight: 650;
}
.session-loading {
  color: #f0a06a;
  font-size: 9px;
}
.session-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 46px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 9px;
  background: rgba(255, 255, 255, 0.04);
  text-align: left;
}
.session-item + .session-item,
.session-item + .session-empty {
  margin-top: 6px;
}
.session-item.active {
  border-color: rgba(232, 112, 58, 0.45);
  background: rgba(232, 112, 58, 0.1);
}
.session-main {
  min-width: 0;
  flex: 1;
}
.session-title,
.session-detail {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.session-title {
  color: #dbe4f5;
  font-size: 11px;
}
.session-detail {
  margin-top: 2px;
  color: #71819e;
  font-size: 9px;
}
.session-time {
  flex: none;
  max-width: 66px;
  color: #67728b;
  font-size: 9px;
  text-align: right;
}
.session-running {
  flex: none;
  padding: 2px 5px;
  border-radius: 5px;
  background: rgba(232, 112, 58, 0.16);
  color: #f0a06a;
  font-size: 9px;
  line-height: 15px;
}
.session-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
.session-delete {
  width: 38px;
  height: 24px;
  min-height: 24px;
  padding: 0;
  border: 1px solid rgba(244, 63, 94, 0.28);
  border-radius: 7px;
  background: rgba(244, 63, 94, 0.12);
  color: #fda4af;
  font-size: 9px;
  line-height: 22px;
}
.session-empty {
  display: block;
  margin-top: 6px;
  color: #71819e;
  font-size: 10px;
  text-align: center;
}
.new-project {
  width: 100%;
  margin-top: 14px;
  padding: 15px;
  box-sizing: border-box;
  border: 1px dashed #2a3a60;
  border-radius: 16px;
  color: #7d8db0;
  font-size: 13px;
  line-height: 1.4;
}
.notice {
  display: block;
  margin-top: 12px;
  color: #8b93a7;
  font-size: 12px;
  text-align: center;
}

/* Project-page overrides must stay after the local dark component styles. */
.theme-light .sync-bar {
  border-color: rgba(24, 39, 61, 0.12) !important;
  background: #ffffff !important;
}

.theme-light .sync-sub {
  color: #66738a;
}

.theme-light .sync-button {
  border-color: rgba(232, 112, 58, 0.24) !important;
  background: #fff2ea !important;
  color: #bc4d17 !important;
}

.theme-light .section-count {
  min-width: 17px;
  padding: 1px 5px;
  border-radius: 8px;
  background: #fff1e9;
  box-sizing: border-box;
  color: #bc4d17;
  font-size: 10px;
  line-height: 16px;
  text-align: center;
}

.theme-light .codex-empty {
  border-color: rgba(24, 39, 61, 0.18) !important;
  background: #f8fafc !important;
  color: #5f6b7e !important;
}

.theme-light .codex-project {
  border-color: rgba(24, 39, 61, 0.12) !important;
  background: #ffffff !important;
}

.theme-light .codex-project.unavailable {
  border-color: rgba(24, 39, 61, 0.08) !important;
  background: #f8fafc !important;
}

.theme-light .codex-project-path {
  color: #66738a;
}

.theme-light .codex-project-meta {
  color: #7b8698;
}

.theme-light .imported-tag {
  background: #e9f9ef;
  color: #237a45;
}

.theme-light .unavailable-tag {
  background: #eef1f6;
  color: #66738a;
}

.theme-light .codex-action {
  border-color: rgba(232, 112, 58, 0.24) !important;
  background: #fff2ea !important;
  color: #bc4d17 !important;
}

.theme-light .ghost {
  border-color: rgba(24, 39, 61, 0.16) !important;
  background: #ffffff !important;
  color: #45536a !important;
}

.theme-light .empty {
  border-color: rgba(24, 39, 61, 0.16) !important;
  background: #ffffff !important;
  color: #5f6b7e !important;
}

.theme-light .project {
  border-color: rgba(24, 39, 61, 0.1) !important;
  background: #ffffff !important;
  box-shadow: 0 2px 10px rgba(31, 45, 70, 0.04);
}

.theme-light .project.current {
  border-color: rgba(232, 112, 58, 0.34) !important;
  background: #fffaf6 !important;
}

.theme-light .project-icon {
  border-color: rgba(24, 39, 61, 0.1) !important;
  background: #fff1e9 !important;
  color: #bc4d17 !important;
}

.theme-light .project-name {
  color: #1f2937;
}

.theme-light .project-path {
  color: #5f6b7e;
}

.theme-light .current-tag {
  border-color: rgba(232, 112, 58, 0.26);
  background: #fff1e9;
  color: #bc4d17;
}

.theme-light .action {
  border-color: rgba(24, 39, 61, 0.13) !important;
  background: #ffffff !important;
  color: #45536a !important;
  font-weight: 500;
}

.theme-light .action:active,
.theme-light .session-item:active {
  background: #f3f6fa !important;
}

.theme-light .danger-action {
  border-color: rgba(225, 29, 72, 0.22) !important;
  background: #fff1f2 !important;
  color: #b91c3c !important;
}

.theme-light .danger-action:active {
  background: #ffe4e8 !important;
}

.theme-light .session-drawer {
  border-color: rgba(24, 39, 61, 0.08) !important;
  background: #f7f8fb !important;
}

.theme-light .session-heading {
  color: #66738a;
}

.theme-light .session-item {
  border-color: rgba(24, 39, 61, 0.08) !important;
  background: #ffffff !important;
}

.theme-light .session-item.active {
  border-color: rgba(232, 112, 58, 0.28) !important;
  background: #fff6f0 !important;
}

.theme-light .session-title {
  color: #2b374a;
}

.theme-light .session-detail,
.theme-light .session-time,
.theme-light .session-empty {
  color: #78849a;
}

.theme-light .session-running {
  background: #fff1e9;
  color: #bc4d17;
}

.theme-light .session-delete {
  border-color: rgba(225, 29, 72, 0.18) !important;
  background: #fff1f2 !important;
  color: #b91c3c !important;
}

.theme-light .new-project {
  border-color: rgba(24, 39, 61, 0.17) !important;
  background: rgba(255, 255, 255, 0.78) !important;
  color: #45536a !important;
}

.theme-light .notice {
  color: #45536a;
}
</style>
