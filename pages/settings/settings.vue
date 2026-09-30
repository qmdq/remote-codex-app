<script setup lang="ts">
import { computed, ref } from "vue";
import { onShow } from "@dcloudio/uni-app";
import type { ConnectionState } from "../../types/agent";
import { agent } from "../../utils/agent";
import GlassNavbar from "../../components/glass-navbar/GlassNavbar.vue";
import LiquidTabBar from "../../components/liquid-tabbar/LiquidTabBar.vue";
import {
  isKeepScreenOnEnabled,
  setKeepScreenOnPreference,
} from "../../utils/keep-screen-on";
import { useIosTabTransition } from "../../utils/page-transition";
import { setThemeMode, syncTheme, theme, themeMode, type ThemePreference } from "../../utils/theme";

const { entering, replay } = useIosTabTransition();

const serverUrl = ref(agent.settings.serverUrl);
const token = ref(agent.settings.token);
const deviceName = ref(agent.settings.deviceName);
const state = ref<ConnectionState>(agent.state);
const detail = ref("");
const notice = ref("");
const noticeTone = ref<"info" | "error" | "ok">("info");
const keepScreenOn = ref(isKeepScreenOnEnabled());
const keepScreenOnBusy = ref(false);

const paired = computed(() => Boolean(agent.settings.token));
const stateText = computed(() => {
  if (state.value === "online") return "已连接";
  if (state.value === "connecting") return "连接中";
  if (state.value === "pairing") return "配对中";
  return "离线";
});

const setNotice = (text: string, tone: "info" | "error" | "ok" = "info") => {
  notice.value = text;
  noticeTone.value = tone;
};

const saveServer = () => {
  if (!paired.value) {
    uni.navigateTo({ url: "/pages/pair/pair?step=1" });
    return;
  }
  if (!/^wss?:\/\//i.test(serverUrl.value.trim())) {
    setNotice("地址必须以 ws:// 或 wss:// 开头", "error");
    return;
  }
  agent.saveSettings({
    serverUrl: serverUrl.value.trim(),
    deviceName: deviceName.value.trim() || "RemoteCodex Phone",
    token: token.value.trim(),
  });
  setNotice("已保存并重新连接", "ok");
};

const connect = () => {
  if (!paired.value) {
    uni.navigateTo({ url: "/pages/pair/pair" });
    return;
  }
  agent.connect();
  setNotice("正在连接");
};

const connectionActionText = computed(() => (
  state.value === "connecting" || state.value === "pairing" ? "连接中" : "连接"
));

const connectionBusy = computed(() => state.value === "connecting" || state.value === "pairing");

const disconnect = () => {
  agent.disconnect();
  setNotice("已断开连接");
};

const startPairing = () => {
  uni.navigateTo({ url: "/pages/pair/pair" });
};

const resetPairing = () => {
  uni.showModal({
    title: "重新配对",
    content: "将断开当前连接并清除本机设备 Token。旧设备如需失效，请在 PC 管理页吊销。",
    confirmText: "重新配对",
    cancelText: "取消",
    success: (result) => {
      if (!result.confirm) return;
      agent.savePairingServer(serverUrl.value, deviceName.value);
      agent.pairingResetRequested = true;
      token.value = "";
      setNotice("已清除本机 Token，请使用新的配对码", "ok");
      uni.navigateTo({ url: "/pages/pair/pair?step=1" });
    },
  });
};

const changeKeepScreenOn = async (event: { detail: { value: boolean } }) => {
  if (keepScreenOnBusy.value) return;

  const next = Boolean(event.detail.value);
  const previous = keepScreenOn.value;
  keepScreenOn.value = next;
  keepScreenOnBusy.value = true;
  let applied = false;
  try {
    applied = await setKeepScreenOnPreference(next);
  } finally {
    keepScreenOnBusy.value = false;
  }

  if (!applied) {
    keepScreenOn.value = previous;
    setNotice("屏幕常亮设置未能应用，请重启 App 后重试", "error");
    return;
  }
  setNotice(next ? "已开启屏幕常亮" : "已关闭屏幕常亮", "ok");
};

onShow(() => {
  syncTheme();
  replay();
  keepScreenOn.value = isKeepScreenOnEnabled();
  serverUrl.value = agent.settings.serverUrl;
  token.value = agent.settings.token;
  deviceName.value = agent.settings.deviceName;
  state.value = agent.state;
  agent.onStateChange = (next, nextDetail) => {
    state.value = next;
    detail.value = nextDetail;
    if (next === "online") {
      setNotice("连接成功", "ok");
    }
  };
});
</script>

<template>
  <view class="screen" :class="`theme-${theme}`">
    <GlassNavbar
      title="连接"
      subtitle="设备配对与外观设置"
      :theme-class="`theme-${theme}`"
    >
      <template #right>
        <view class="theme-segment nav-theme-segment">
          <button :class="{ active: themeMode === 'dark' }" @click="setThemeMode('dark')">深色</button>
          <button :class="{ active: themeMode === 'light' }" @click="setThemeMode('light')">浅色</button>
          <button :class="{ active: themeMode === 'auto' }" @click="setThemeMode('auto')">自动</button>
        </view>
      </template>
    </GlassNavbar>
    <view class="tab-content" :class="{ 'ios-page-enter': entering }">
      <view class="hero">
      <view class="device-mark">PC</view>
      <view class="hero-main">
        <text class="device-name">{{ deviceName || "RemoteCodex Phone" }}</text>
        <view class="status-row">
          <view class="status-dot" :class="state" />
          <text>{{ stateText }}</text>
          <text class="sep">·</text>
          <text class="status-detail mono">{{ detail || state }}</text>
        </view>
      </view>
      <view class="paired-tag" :class="{ ok: paired }">{{ paired ? "已配对" : "未配对" }}</view>
    </view>

    <view class="card status-card">
      <view class="status-row-line">
        <text class="label">服务器</text>
        <text class="value mono">{{ serverUrl || "未设置" }}</text>
      </view>
      <view class="status-row-line">
        <text class="label">Token</text>
        <text class="value mono">{{ paired ? "已保存" : "未保存" }}</text>
      </view>
      <view class="actions">
        <button v-if="!paired" class="primary" @click="startPairing">开始配对</button>
        <button v-else-if="state === 'online'" class="ghost" @click="disconnect">断开</button>
        <button v-else class="primary" :disabled="connectionBusy" @click="connect">{{ connectionActionText }}</button>
      </view>
    </view>

    <view v-if="paired" class="card panel">
      <view class="panel-head">
        <text>设备信息</text>
        <text class="panel-tag mono">{{ /^wss:/i.test(serverUrl) ? "TLS" : "明文" }}</text>
      </view>
      <text class="field-label">PC WebSocket 地址</text>
      <input v-model="serverUrl" class="input input-text mono" placeholder="ws://192.168.1.20:7800" placeholder-class="placeholder" />
      <text class="field-label">设备名</text>
      <input v-model="deviceName" class="input input-text" placeholder="RemoteCodex Phone" placeholder-class="placeholder" />
      <text class="field-label">设备 Token</text>
      <input v-model="token" class="input input-text mono" placeholder="自动保存" placeholder-class="placeholder" />
      <button class="ghost save" @click="saveServer">{{ state === 'online' ? "保存配置" : "保存并连接" }}</button>
      <button class="ghost save danger" @click="resetPairing">重新配对</button>
    </view>

    <view v-else class="card panel pair-guide">
      <text class="guide-title">完成首次配对</text>
      <text class="guide-text">在 PC 启动 Agent 并生成配对码，然后 App 会引导你完成服务器地址、6 位配对码和 PC 审批。</text>
      <button class="primary" @click="startPairing">进入配对页面</button>
    </view>

    <view class="card preference-panel">
      <view class="preference-row">
        <view class="preference-copy">
          <text class="preference-title">保持屏幕常亮</text>
          <text class="preference-description">防止查看远程画面或终端时屏幕自动熄灭</text>
        </view>
        <switch
          :checked="keepScreenOn"
          :disabled="keepScreenOnBusy"
          color="#e8703a"
          @change="changeKeepScreenOn"
        />
      </view>
    </view>

    <text v-if="notice" class="notice" :class="noticeTone">{{ notice }}</text>
    </view>
    <LiquidTabBar current="settings" :theme-class="`theme-${theme}`" />
  </view>
</template>

<style>
.screen {
  padding-top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 52px + 16px);
  padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px));
}
.theme-segment {
  display: flex;
  flex: none;
  padding: 3px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  background: #0e1526;
}
.theme-segment button {
  min-width: 42px;
  height: 28px;
  padding: 0 8px;
  border-radius: 6px;
  color: #8b93a7;
  font-size: 11px;
  line-height: 28px;
}
.nav-theme-segment {
  border-color: rgba(255, 255, 255, 0.18);
  background: rgba(16, 23, 40, 0.32);
  backdrop-filter: blur(14px);
  -webkit-backdrop-filter: blur(14px);
}
.theme-segment button.active {
  background: #263149;
  color: #f0a06a;
}
.theme-light .nav-theme-segment {
  border-color: rgba(255, 255, 255, 0.72) !important;
  background: rgba(255, 255, 255, 0.54) !important;
}
.theme-light .theme-segment button {
  color: #6a7688 !important;
}
.theme-light .theme-segment button.active {
  background: rgba(232, 112, 58, 0.12) !important;
  color: #c2410c !important;
}
.hero {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 14px;
}
.device-mark {
  width: 46px;
  height: 46px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 14px;
  background: linear-gradient(145deg, #1b2445, #101a30);
  color: #f0a06a;
  font-size: 13px;
  font-weight: 750;
}
.hero-main {
  flex: 1;
  min-width: 0;
}
.device-name {
  display: block;
  overflow: hidden;
  font-size: 16px;
  font-weight: 700;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-row {
  display: flex;
  align-items: center;
  gap: 5px;
  margin-top: 4px;
  color: #8b93a7;
  font-size: 11px;
}
.status-detail {
  max-width: 46vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  background: #f87171;
}
.status-dot.connecting {
  background: #fbbf24;
}
.status-dot.online {
  background: #34d399;
  box-shadow: 0 0 8px rgba(52, 211, 153, 0.7);
}
.sep {
  color: #5c6579;
}
.paired-tag {
  padding: 3px 9px;
  border: 1px solid rgba(248, 113, 113, 0.38);
  border-radius: 99px;
  color: #f87171;
  font-size: 10px;
}
.paired-tag.ok {
  border-color: rgba(52, 211, 153, 0.4);
  color: #8ce6b0;
}
.status-card,
.panel {
  margin-bottom: 12px;
  padding: 14px;
}
.status-row-line {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 34px;
}
.label {
  color: #8b93a7;
  font-size: 12px;
}
.value {
  max-width: 65%;
  overflow: hidden;
  color: #e7ecf5;
  font-size: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.actions {
  display: flex;
  gap: 10px;
  margin-top: 13px;
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
  font-size: 13px;
  line-height: 39px;
}
.ghost[disabled] {
  opacity: 0.4;
}
.ghost.danger {
  border-color: rgba(248, 113, 113, 0.32);
  color: #f87171;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 12px;
  color: #c4cdde;
  font-size: 13px;
  font-weight: 650;
}
.panel-tag {
  padding: 3px 8px;
  border: 1px solid #253353;
  border-radius: 99px;
  color: #7d8db0;
  font-size: 10px;
}
.field-label {
  display: block;
  margin-top: 12px;
  margin-bottom: 7px;
  color: #8b93a7;
  font-size: 12px;
}
.panel .field-label:first-of-type {
  margin-top: 0;
}
.input-text {
  height: 43px;
  padding: 0 12px;
  font-size: 13px;
}
.save {
  margin-top: 15px;
}
.guide-title {
  display: block;
  color: #e7ecf5;
  font-size: 15px;
  font-weight: 700;
}
.guide-text {
  display: block;
  margin-top: 8px;
  color: #8b93a7;
  font-size: 12px;
  line-height: 1.8;
}
.pair-guide .primary {
  width: 100%;
  margin-top: 15px;
}
.preference-panel {
  margin-bottom: 12px;
  padding: 14px;
}
.preference-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  min-height: 42px;
}
.preference-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 4px;
}
.preference-title {
  color: #e7ecf5;
  font-size: 13px;
  font-weight: 650;
}
.preference-description {
  color: #8b93a7;
  font-size: 11px;
  line-height: 1.5;
}
.preference-panel switch {
  flex: none;
  transform: scale(0.82);
  transform-origin: right center;
}
.notice {
  display: block;
  padding: 9px 14px;
  border: 1px solid #33436e;
  border-radius: 12px;
  background: #1b2540;
  color: #dbe4f5;
  font-size: 12px;
  text-align: center;
}
.notice.error {
  border-color: rgba(248, 113, 113, 0.4);
  background: rgba(68, 23, 26, 0.9);
  color: #ffd9d9;
}
.notice.ok {
  border-color: rgba(52, 211, 153, 0.4);
  background: rgba(52, 211, 153, 0.08);
  color: #8ce6b0;
}
.theme-light .theme-segment {
  border-color: var(--line);
  background: #edf0f5;
}
.theme-light .theme-segment button.active {
  background: #ffffff;
  color: #c95421;
  box-shadow: 0 1px 3px rgba(26, 39, 57, 0.14);
}
.theme-light .theme-description {
  color: var(--text-secondary);
}
.theme-light .preference-title {
  color: var(--text-primary);
}
.theme-light .preference-description {
  color: var(--text-secondary);
}
</style>
