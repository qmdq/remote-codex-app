<script setup lang="ts">
import { computed, ref } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import type { TimelineItem } from "../../types/agent";
import { agent } from "../../utils/agent";
import GlassNavbar from "../../components/glass-navbar/GlassNavbar.vue";
import LiquidTabBar from "../../components/liquid-tabbar/LiquidTabBar.vue";
import { useIosTabTransition } from "../../utils/page-transition";
import { syncTheme, themeClass } from "../../utils/theme";

const { entering, replay } = useIosTabTransition();

const items = ref<TimelineItem[]>([]);
const latestSeq = ref(agent.latestSeq);
const filter = ref<"all" | "turns" | "agent">("all");
const syncing = ref(false);
const opened = ref(new Set<string>());

const maxSequence = (source: TimelineItem[]) => source.reduce(
  (latest, item) => Math.max(latest, item.seq || 0),
  agent.latestSeq,
);

const hasCompletedItem = (item: TimelineItem) => {
  if (item.type !== "item.started") {
    return false;
  }
  return items.value.some((done) => {
    if (done.type !== "item.completed" || done.itemType !== item.itemType) {
      return false;
    }
    if (item.itemId) {
      return done.itemId === item.itemId;
    }
    if (!item.turnId || done.turnId !== item.turnId || done.itemId) {
      return false;
    }

    const detail = item.detail.trim();
    if (detail && done.detail.trim() === detail) {
      return true;
    }
    if (item.command && done.command && item.command === done.command) {
      return true;
    }
    return Boolean(item.path && done.path && item.path === done.path);
  });
};

const isAgentTerminalFailure = (item: TimelineItem) => (
  item.kind === "agent.event" && (
    item.type === "turn.failed" ||
    item.type === "turn.interrupted" ||
    (item.type === "turn.status" && item.status === "danger")
  )
);

const hasDetailedTerminal = (item: TimelineItem) => (
  item.kind === "codex.event" && (
    item.type === "turn.failed" || item.type === "turn.interrupted"
  )
);

const visible = computed(() => {
  const source = items.value.filter((item) => {
    if (hasCompletedItem(item)) return false;
    if (!isAgentTerminalFailure(item) || !item.turnId) return true;
    return !items.value.some((detail) => detail.turnId === item.turnId && hasDetailedTerminal(detail));
  });
  if (filter.value === "turns") {
    return source.filter((item) => item.type.startsWith("turn.") || item.type.startsWith("item."));
  }
  if (filter.value === "agent") {
    return source.filter((item) => item.kind === "agent.event");
  }
  return source;
});

const statusLabel = (item: TimelineItem) => {
  if (item.status === "success") return "完成";
  if (item.status === "running") return "运行中";
  if (item.status === "warning") return "已取消";
  if (item.status === "danger") return "失败";
  return "事件";
};

const previewBody = (value: string) => value
  .replace(/\s+/g, " ")
  .trim()
  .slice(0, 74);

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--:--" : date.toLocaleTimeString("zh-CN", { hour12: false });
};

const toggle = (id: string) => {
  const next = new Set(opened.value);
  if (next.has(id)) {
    next.delete(id);
  } else {
    next.add(id);
  }
  opened.value = next;
};

const syncTimeline = () => {
  if (agent.state !== "online" || !agent.selectedProject || syncing.value) {
    return;
  }
  syncing.value = true;
  agent.syncProjectEvents()
    .catch(() => undefined)
    .finally(() => {
      syncing.value = false;
    });
};

const handleTimelineChange = (next: TimelineItem[]) => {
  items.value = next;
  latestSeq.value = maxSequence(next);
};

const handleSequenceChange = (next: number) => {
  latestSeq.value = next;
};

const clearTimelineHandlers = () => {
  if (agent.onTimelineChange === handleTimelineChange) {
    agent.onTimelineChange = null;
  }
  if (agent.onSequenceChange === handleSequenceChange) {
    agent.onSequenceChange = null;
  }
};

onShow(() => {
  syncTheme();
  replay();
  items.value = [...agent.timeline];
  latestSeq.value = maxSequence(items.value);
  agent.onTimelineChange = handleTimelineChange;
  agent.onSequenceChange = handleSequenceChange;
  syncTimeline();
});

onHide(clearTimelineHandlers);
onUnload(clearTimelineHandlers);
</script>

<template>
  <view class="screen" :class="themeClass">
    <GlassNavbar
      title="执行记录"
      :subtitle="`${visible.length} 条 · seq ${latestSeq || 0}`"
      :theme-class="themeClass"
    >
      <template #right>
        <button class="replay" :disabled="syncing" @click="syncTimeline">同步</button>
      </template>
    </GlassNavbar>
    <view class="tab-content" :class="{ 'ios-page-enter': entering }">
      <view class="filters">
      <button :class="{ active: filter === 'all' }" @click="filter = 'all'">全部</button>
      <button :class="{ active: filter === 'turns' }" @click="filter = 'turns'">任务</button>
      <button :class="{ active: filter === 'agent' }" @click="filter = 'agent'">Agent</button>
    </view>

    <view v-if="!visible.length" class="empty">
      <text>还没有执行记录。回到会话页启动任务，工具调用和状态变化会按序出现在这里。</text>
    </view>

    <view v-else class="timeline">
      <view
        v-for="(item, index) in visible"
        :key="item.id"
        class="timeline-item"
        :class="[item.status, { open: opened.has(item.id) }]"
        @click="toggle(item.id)"
      >
        <view class="timeline-rail">
          <view class="timeline-dot">
            <view v-if="item.status === 'running'" class="spin" />
          </view>
          <view v-if="index !== visible.length - 1" class="timeline-line" />
        </view>
        <view class="timeline-content">
          <view class="timeline-head">
            <text class="timeline-title">{{ item.title }}</text>
            <text class="timeline-state" :class="item.status">{{ statusLabel(item) }}</text>
          </view>
          <view class="timeline-meta">
            <text class="mono">#{{ item.seq }} · {{ item.kind }}</text>
            <text class="mono">{{ formatTime(item.ts) }}</text>
          </view>
          <view v-if="item.body && !opened.has(item.id)" class="timeline-preview">
            <text>{{ previewBody(item.body) }}</text>
          </view>
          <view v-if="item.body && opened.has(item.id)" class="timeline-body">
            <text>{{ item.body }}</text>
          </view>
          <view v-if="item.detail && (opened.has(item.id) || item.status === 'danger')" class="timeline-detail mono">
            <text>{{ item.detail }}</text>
          </view>
        </view>
      </view>
    </view>
    </view>
    <LiquidTabBar current="events" :theme-class="themeClass" />
  </view>
</template>

<style>
.screen {
  padding-top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 52px + 12px);
  padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px));
}
.head {
  display: none;
}
.head-title {
  display: block;
  font-size: 18px;
  font-weight: 700;
}
.head-sub {
  display: block;
  margin-top: 3px;
  color: #5c6579;
  font-size: 11px;
}
.replay {
  height: 31px;
  padding: 0 12px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9px;
  background: #101728;
  color: #8b93a7;
  font-size: 11px;
  line-height: 29px;
}
.theme-light .replay {
  border-color: rgba(24, 39, 61, 0.14) !important;
  background: rgba(255, 255, 255, 0.52) !important;
  color: #6a7688 !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
.filters {
  display: flex;
  gap: 8px;
  margin-bottom: 14px;
}
.filters button {
  height: 30px;
  padding: 0 13px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 28px;
}
.filters button.active {
  border-color: rgba(232, 112, 58, 0.6);
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
}
.empty {
  padding: 32px 18px;
  border: 1px dashed #2a3a60;
  border-radius: 16px;
  background: rgba(16, 23, 40, 0.5);
  color: #7d8db0;
  font-size: 13px;
  line-height: 1.8;
  text-align: center;
}
.timeline {
  border-radius: 16px;
  background: rgba(13, 19, 34, 0.58);
}
.timeline-item {
  display: flex;
  align-items: stretch;
  min-height: 50px;
}
.timeline-rail {
  position: relative;
  width: 34px;
  flex: none;
  display: flex;
  justify-content: center;
}
.timeline-dot {
  position: relative;
  z-index: 1;
  width: 16px;
  height: 16px;
  margin-top: 14px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #2b3c62;
  border-radius: 50%;
  background: #111827;
}
.timeline-line {
  position: absolute;
  top: 30px;
  bottom: 0;
  width: 1px;
  background: #1f2c48;
}
.timeline-item:last-child .timeline-line {
  display: none;
}
.timeline-content {
  flex: 1;
  min-width: 0;
  padding: 8px 10px 10px 0;
}
.timeline-item.open {
  margin: 0 -6px;
  border: 1px solid #243454;
  border-radius: 12px;
  background: #101827;
  padding-left: 6px;
}
.timeline-item.success .timeline-dot {
  border-color: rgba(52, 211, 153, 0.55);
  background: rgba(52, 211, 153, 0.13);
}
.timeline-item.warning .timeline-dot,
.timeline-item.running .timeline-dot {
  border-color: rgba(251, 191, 36, 0.55);
  background: rgba(251, 191, 36, 0.12);
}
.timeline-item.danger .timeline-dot {
  border-color: rgba(248, 113, 113, 0.55);
  background: rgba(248, 113, 113, 0.12);
}
.timeline-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.timeline-title {
  flex: 1;
  overflow: hidden;
  color: #dce4f3;
  font-size: 11px;
  font-weight: 600;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.timeline-state {
  flex: none;
  font-size: 9.5px;
}
.timeline-state.success { color: #34d399; }
.timeline-state.warning,
.timeline-state.running { color: #fbbf24; }
.timeline-state.danger { color: #f87171; }
.timeline-meta {
  display: flex;
  justify-content: space-between;
  gap: 8px;
  margin-top: 3px;
  color: #5f6c86;
  font-size: 10px;
}
.timeline-preview {
  margin-top: 6px;
  color: #8896ae;
  font-size: 10px;
  line-height: 1.5;
  overflow: hidden;
  display: -webkit-box;
  -webkit-line-clamp: 1;
  -webkit-box-orient: vertical;
}
.timeline-body {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid rgba(232, 112, 58, 0.18);
  border-radius: 9px;
  background: rgba(232, 112, 58, 0.06);
  color: #ffe3d1;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-word;
}
.timeline-detail {
  margin-top: 8px;
  padding: 9px 10px;
  border: 1px solid #20304e;
  border-radius: 9px;
  background: #0b1020;
  color: #8fa1bd;
  font-size: 9.5px;
  line-height: 1.65;
  white-space: pre-wrap;
  word-break: break-all;
}
.spin {
  width: 9px;
  height: 9px;
  border: 1.6px solid rgba(251, 191, 36, 0.3);
  border-top-color: #fbbf24;
  border-radius: 50%;
  animation: rotate 0.7s linear infinite;
}
.tool-meta {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 11px 8px;
  color: #5c6579;
  font-size: 10px;
}
.reply-body {
  margin: 0 11px 10px;
  padding: 11px;
  border: 1px solid rgba(232, 112, 58, 0.22);
  border-radius: 10px;
  background: rgba(232, 112, 58, 0.07);
  color: #ffe3d1;
  font-size: 13px;
  line-height: 1.65;
  word-break: break-word;
  white-space: pre-wrap;
}
/* expanded content lives inside each timeline row */
@keyframes rotate {
  to {
    transform: rotate(360deg);
  }
}
</style>
