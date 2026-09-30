<template>
  <view class="liquid-tabbar" :class="themeClass" @touchmove="pressMove" @touchend="pressFinish" @touchcancel="pressEnd">
    <view class="tabbar-material" />
    <view class="tabbar-items">
      <view class="liquid-indicator" :class="{ dragging: indicatorDragging }" :style="indicatorStyle" />
      <view
        v-for="(item, index) in tabs"
        :key="item.key"
        class="tabbar-item"
        :class="{ active: isActive(item), pressed: pressedIndex === index }"
        @click="go(item, index)"
        @touchstart="pressStart(index)"
        @touchcancel="pressEnd"
        @mousedown="pressStart(index)"
        @mouseup="pressEnd"
        @mouseleave="pressEnd"
      >
        <view class="tab-icon-shell" :class="{ released: releasedIndex === index }">
          <image
            class="tab-icon"
            :src="isActive(item) ? item.activeIcon : item.icon"
            mode="aspectFit"
          />
        </view>
        <text class="tab-label">{{ item.label }}</text>
      </view>
    </view>
  </view>
</template>

<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";

let navigationLock = false;
let navigationTimeout: ReturnType<typeof setTimeout> | null = null;
let pressMoved = false;

const routeKey = (url: string) => url.replace(/^\//, "").split("?")[0];

const switchTabOnce = (url: string) => {
  const route = routeKey(url);
  if (navigationLock) return;
  navigationLock = true;
  if (navigationTimeout) clearTimeout(navigationTimeout);
  const finish = () => {
    navigationLock = false;
    if (navigationTimeout) {
      clearTimeout(navigationTimeout);
      navigationTimeout = null;
    }
  };
  navigationTimeout = setTimeout(finish, 180);
  uni.switchTab({
    url,
    complete: finish,
  });
};

const props = defineProps<{
  current: "projects" | "chat" | "events" | "monitor" | "settings";
  themeClass?: string;
}>();

const tabs = [
  {
    key: "projects" as const,
    label: "项目",
    url: "/pages/projects/projects",
    icon: "/static/projects.png",
    activeIcon: "/static/projects-active.png",
  },
  {
    key: "chat" as const,
    label: "会话",
    url: "/pages/index/index",
    icon: "/static/task.png",
    activeIcon: "/static/task-active.png",
  },
  {
    key: "events" as const,
    label: "执行",
    url: "/pages/events/events",
    icon: "/static/events.png",
    activeIcon: "/static/events-active.png",
  },
  {
    key: "monitor" as const,
    label: "设备",
    url: "/pages/monitor/monitor",
    icon: "/static/monitor.png",
    activeIcon: "/static/monitor-active.png",
  },
  {
    key: "settings" as const,
    label: "连接",
    url: "/pages/settings/settings",
    icon: "/static/settings.png",
    activeIcon: "/static/settings-active.png",
  },
];

const pressedIndex = ref(-1);
const indicatorDragging = ref(false);
const indicatorTarget = ref(-1);
const releasedIndex = ref(-1);
const initialWindowWidth = Number(uni.getSystemInfoSync().windowWidth || 375);
const initialIndicatorWidth = Math.max(1, (initialWindowWidth - 24) / tabs.length);
const initialIndicatorIndex = Math.max(0, tabs.findIndex((item) => item.key === props.current));
const indicatorLeft = ref(initialIndicatorWidth * initialIndicatorIndex);
const indicatorWidth = ref(initialIndicatorWidth);
let releaseTimer: ReturnType<typeof setTimeout> | null = null;
let resizeHandler: (() => void) | null = null;

const isActive = (item: (typeof tabs)[number]) => props.current === item.key;

const indicatorIndex = computed(() => {
  if (indicatorTarget.value >= 0) return indicatorTarget.value;
  const index = tabs.findIndex((item) => item.key === props.current);
  return index < 0 ? 0 : index;
});

const indicatorStyle = computed(() => {
  return {
    width: indicatorWidth.value ? `${indicatorWidth.value}px` : "20%",
    left: "0px",
    transform: `translate3d(${indicatorLeft.value}px, 0, 0) scaleX(${indicatorDragging.value ? 1.02 : 1})`,
  };
});

const measureIndicator = async () => {
  const windowWidth = Number(uni.getSystemInfoSync().windowWidth || 0);
  if (windowWidth <= 0) return;
  const width = Math.max(1, (windowWidth - 24) / tabs.length);
  if (Math.abs(width - indicatorWidth.value) < 0.5) return;
  indicatorWidth.value = width;
  indicatorLeft.value = Math.max(0, indicatorIndex.value) * width;
};

watch(indicatorIndex, () => {
  measureIndicator();
});

onMounted(() => {
  uni.hideTabBar({ animation: false });
  resizeHandler = () => measureIndicator();
  uni.onWindowResize?.(resizeHandler);
  setTimeout(measureIndicator, 60);
  setTimeout(measureIndicator, 240);
});

onUnmounted(() => {
  if (resizeHandler) uni.offWindowResize?.(resizeHandler);
  if (releaseTimer) clearTimeout(releaseTimer);
});

const pressStart = (index: number) => {
  if (releaseTimer && releasedIndex.value === index) {
    clearTimeout(releaseTimer);
    releaseTimer = null;
    releasedIndex.value = -1;
  }
  pressedIndex.value = index;
  indicatorTarget.value = index;
  indicatorDragging.value = true;
  pressMoved = false;
};

const pressMove = (event: any) => {
  if (pressedIndex.value < 0) return;
  const point = event?.touches?.[0];
  const windowWidth = Number(uni.getSystemInfoSync().windowWidth || 0);
  if (!point || !Number.isFinite(point.clientX) || !(windowWidth > 0)) return;
  const trackWidth = Math.max(1, windowWidth - 24);
  const itemWidth = trackWidth / tabs.length;
  const index = Math.floor((point.clientX - 12) / itemWidth);
  const next = Math.max(0, Math.min(tabs.length - 1, index));
  if (next !== indicatorTarget.value) {
    pressMoved = true;
    indicatorTarget.value = next;
    pressedIndex.value = next;
    measureIndicator();
    uni.vibrateShort?.({ type: "light", fail: () => undefined });
  }
};

const pressFinish = () => {
  const wasPressed = pressedIndex.value >= 0;
  const moved = pressMoved;
  const index = indicatorTarget.value;
  pressEnd();
  if (!wasPressed || !moved) return;

  const target = index >= 0 ? tabs[index] : null;
  if (target && target.key !== props.current) {
    switchTabOnce(target.url);
  }
};

const pressEnd = () => {
  if (pressedIndex.value >= 0) releasedIndex.value = pressedIndex.value;
  pressedIndex.value = -1;
  indicatorTarget.value = -1;
  indicatorDragging.value = false;
  if (releaseTimer) clearTimeout(releaseTimer);
  releaseTimer = setTimeout(() => {
    releasedIndex.value = -1;
    releaseTimer = null;
  }, 560);
};

const go = (item: (typeof tabs)[number], index: number) => {
  if (item.key === props.current) return;
  uni.vibrateShort?.({ type: "medium", fail: () => undefined });
  switchTabOnce(item.url);
};
</script>

<style>
.liquid-tabbar {
  --tabbar-bottom: calc(10px + env(safe-area-inset-bottom, 0px));
  position: fixed;
  right: 12px;
  bottom: var(--tabbar-bottom);
  left: 12px;
  z-index: 997;
  height: 64px;
}

.tabbar-material {
  position: absolute;
  inset: 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 22px;
  background:
    linear-gradient(126deg, rgba(255, 255, 255, 0.17) 0%, rgba(255, 255, 255, 0.04) 30%, transparent 52%),
    linear-gradient(180deg, rgba(17, 24, 42, 0.78), rgba(7, 10, 18, 0.66));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.14),
    inset 0 -16px 26px rgba(255, 255, 255, 0.02),
    0 16px 34px rgba(3, 6, 14, 0.34);
  backdrop-filter: blur(20px) saturate(172%);
  -webkit-backdrop-filter: blur(20px) saturate(172%);
}

.tabbar-material::after {
  content: "";
  position: absolute;
  top: -58px;
  left: 6%;
  width: 38%;
  height: 108px;
  background: linear-gradient(90deg, transparent, rgba(255, 255, 255, 0.09), rgba(232, 112, 58, 0.11), transparent);
  filter: blur(16px);
  transform: rotate(13deg);
  pointer-events: none;
}

.tabbar-items {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  align-items: center;
}

.tabbar-item {
  z-index: 1;
}

.liquid-indicator {
  position: absolute;
  top: 4px;
  left: 0;
  bottom: 4px;
  width: 20%;
  transform-origin: 50% 50%;
  border: 1px solid rgba(232, 112, 58, 0.24);
  border-radius: 20px;
  background:
    radial-gradient(58% 38% at 50% 0%, rgba(255, 255, 255, 0.24), transparent 68%),
    linear-gradient(160deg, rgba(232, 112, 58, 0.24), rgba(232, 112, 58, 0.05) 58%, transparent);
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.16),
    0 8px 20px rgba(232, 112, 58, 0.16);
  transition:
    transform 0.34s cubic-bezier(0.22, 1, 0.36, 1),
    width 0.2s cubic-bezier(0.22, 1, 0.36, 1);
  will-change: transform;
}

.liquid-indicator.dragging {
  transition-duration: 0.18s;
}

.tabbar-item {
  position: relative;
  display: flex;
  min-width: 0;
  height: 100%;
  flex: 1;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 3px;
  overflow: hidden;
}

.tab-icon-shell {
  position: relative;
  display: flex;
  width: 38px;
  height: 28px;
  align-items: center;
  justify-content: center;
  border-radius: 14px;
  transition: transform 0.28s cubic-bezier(0.32, 1.38, 0.48, 1);
}

.tabbar-item.pressed .tab-icon-shell {
  transform: scale(0.78, 0.9) translateY(2px);
}

.tab-icon-shell.released {
  animation: tab-jelly 0.54s cubic-bezier(0.28, 1.32, 0.42, 1);
}

.tabbar-item.active .tab-icon-shell.released {
  animation-name: tab-jelly-active;
}

.tabbar-item.active .tab-icon-shell {
  transform: translateY(-1px) scale(1.05);
}

@keyframes tab-jelly {
  0% { transform: scale(0.78, 0.9) translateY(2px); }
  38% { transform: scale(1.14, 0.88) translateY(-1px); }
  64% { transform: scale(0.93, 1.09) translateY(0); }
  84% { transform: scale(1.05, 0.96); }
  100% { transform: scale(1, 1); }
}

@keyframes tab-jelly-active {
  0% { transform: scale(0.78, 0.9) translateY(2px); }
  38% { transform: scale(1.16, 0.88) translateY(-2px); }
  64% { transform: scale(0.93, 1.12) translateY(0); }
  84% { transform: scale(1.07, 0.99) translateY(-1px); }
  100% { transform: translateY(-1px) scale(1.05); }
}

.tab-icon {
  width: 22px;
  height: 22px;
}

.tab-label {
  position: relative;
  z-index: 1;
  overflow: hidden;
  max-width: 100%;
  color: #7e879c;
  font-size: 10px;
  line-height: 13px;
  text-overflow: ellipsis;
  white-space: nowrap;
  transition: transform 0.34s cubic-bezier(0.22, 1.18, 0.26, 1);
}

.tabbar-item.pressed .tab-label {
  transform: scale(0.94);
}

.tabbar-item.active .tab-label {
  color: #f0a06a;
  font-weight: 650;
}

.theme-light.liquid-tabbar .tabbar-material {
  border-color: rgba(255, 255, 255, 0.76);
  background:
    linear-gradient(126deg, rgba(255, 255, 255, 0.86) 0%, rgba(255, 255, 255, 0.22) 32%, transparent 54%),
    linear-gradient(180deg, rgba(255, 255, 255, 0.92), rgba(244, 246, 249, 0.78));
  box-shadow:
    inset 0 1px 0 rgba(255, 255, 255, 0.9),
    0 14px 30px rgba(24, 39, 61, 0.1);
  backdrop-filter: blur(28px) saturate(160%);
  -webkit-backdrop-filter: blur(28px) saturate(160%);
}

.theme-light.liquid-tabbar .tab-label {
  color: #687386;
}

.theme-light.liquid-tabbar .liquid-indicator {
  border-color: rgba(232, 112, 58, 0.22);
  background:
    radial-gradient(58% 38% at 50% 0%, rgba(255, 255, 255, 0.72), transparent 68%),
    linear-gradient(160deg, rgba(232, 112, 58, 0.16), rgba(232, 112, 58, 0.04) 58%, transparent);
}

.theme-light.liquid-tabbar .tabbar-item.active .tab-label {
  color: #c2410c;
}

</style>
