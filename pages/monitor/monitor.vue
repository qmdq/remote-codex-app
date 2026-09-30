<script setup lang="ts">
import { computed, nextTick, onUnmounted, ref } from "vue";
import { onHide, onShow } from "@dcloudio/uni-app";
import type { AgentEnvelope, AgentMetrics, TerminalSessionInfo } from "../../types/agent";
import { agent } from "../../utils/agent";
import GlassNavbar from "../../components/glass-navbar/GlassNavbar.vue";
import LiquidTabBar from "../../components/liquid-tabbar/LiquidTabBar.vue";
import TerminalView from "../../components/terminal-view/TerminalView.vue";
import { useIosTabTransition } from "../../utils/page-transition";
import { createScreenViewer, type ScreenViewerMeasure } from "../../utils/screen-viewer";
import { syncTheme, themeClass } from "../../utils/theme";

const { entering, replay } = useIosTabTransition();

const emptyMetrics: AgentMetrics = {
  cpu_percent: null,
  memory_percent: null,
  memory_used_bytes: null,
  disk_percent: null,
  net_sent_bytes_per_sec: null,
  net_recv_bytes_per_sec: null,
  process_count: null,
};

const metrics = ref<AgentMetrics>({ ...emptyMetrics });
const connectionState = ref(agent.state);
const screenOn = ref(false);
const screenData = ref("");
const screenTransition = ref(false);
const screenInfo = ref("屏幕监控未开启");
const fullScreen = ref(false);
const fullscreenLive = ref(false);
const frameWidth = ref(0);
const frameHeight = ref(0);
const frameOriginX = ref(0);
const frameOriginY = ref(0);
const frameRealWidth = ref(0);
const frameRealHeight = ref(0);
const screenQuality = ref(1920);
const screenFps = ref(30);
const settingsOpen = ref(false);
const controlsOpen = ref(false);
const keyboardOpen = ref(false);
const remoteKeyboardText = ref("");
const remoteKeyboardFocused = ref(false);
const updatedAt = ref("--:--:--");
const terminalOpen = ref(false);
const terminalStarting = ref(false);
const terminalClosing = ref(false);
const terminalSessionId = ref("");
const terminalCwd = ref("");
const terminalShell = ref("");
const terminalMode = ref<"pty" | "pipe" | "">("");
const terminalLineEnding = ref("\n");
const terminalCols = ref(80);
const terminalRows = ref(24);
const terminalPipeInput = ref("");
const terminalHistory = ref<string[]>([]);
const terminalHistoryIndex = ref<number | null>(null);
const terminalError = ref("");
const terminalExitCode = ref<number | null>(null);
const terminalViewRef = ref<any>(null);
let terminalResizeTimer: number | null = null;
let pageActive = true;
let terminalSendQueue = Promise.resolve();
let resumeScreenAfterShow = false;
let screenTransitionTimer: number | null = null;
let screenTransitionMinimumTimer: number | null = null;
let screenTransitionStartedAt = 0;

const measureFrame: ScreenViewerMeasure = async () => {
  const measured = await new Promise<any>((resolve) => {
    const query = uni.createSelectorQuery();
    query.select(".screen-surface").boundingClientRect((rect) => resolve(rect));
    query.exec();
  });
  if (measured && Number(measured.width) > 0 && Number(measured.height) > 0) {
    return {
      left: Number(measured.left || 0),
      top: Number(measured.top || 0),
      width: Number(measured.width),
      height: Number(measured.height),
    };
  }

  const info = uni.getSystemInfoSync();
  const availableWidth = Math.max(1, Number(info.windowWidth || 375) - 20);
  const availableHeight = Math.max(1, Number(info.windowHeight || 667)
    - Number(info.statusBarHeight || 0) - 96);
  return { left: 10, top: 0, width: availableWidth, height: availableHeight };
};

const screenViewer = createScreenViewer({
  frameWidth: () => frameWidth.value,
  frameHeight: () => frameHeight.value,
  active: () => Boolean(fullScreen.value && fullscreenLive.value),
  measure: measureFrame,
  sendInput: async (action, point) => {
    await agent.sendScreenInput({
      action,
      x: point.x,
      y: point.y,
      screen_width: frameWidth.value,
      screen_height: frameHeight.value,
      origin_x: frameOriginX.value,
      origin_y: frameOriginY.value,
      real_width: frameRealWidth.value,
      real_height: frameRealHeight.value,
    });
  },
  onError: (message) => {
    screenInfo.value = message;
  },
});

const qualityOptions = [
  { width: 720, label: "720" },
  { width: 1080, label: "1080" },
  { width: 1280, label: "1280" },
  { width: 1440, label: "1440" },
  { width: 1920, label: "1920" },
];

const fpsOptions = [
  { value: 20, label: "20帧" },
  { value: 30, label: "30帧" },
  { value: 60, label: "60帧" },
];

const terminalKeys = [
  { label: "Ctrl+C", data: "\x03" },
  { label: "Tab", data: "\t" },
  { label: "ESC", data: "\x1b" },
  { label: "↑", data: "\x1b[A" },
  { label: "↓", data: "\x1b[B" },
  { label: "Enter", data: "\r" },
];

const terminalStatus = computed(() => {
  if (terminalClosing.value) return "正在断开";
  if (terminalStarting.value) return "正在连接";
  if (terminalSessionId.value) {
    return `${terminalMode.value === "pty" ? "PTY" : "管道"} · ${terminalCols.value}×${terminalRows.value}`;
  }
  if (terminalExitCode.value != null) return `已退出 · ${terminalExitCode.value}`;
  return terminalError.value || "未连接";
});

const withPage = async (callback: () => Promise<void> | void) => {
  if (!pageActive) return;
  await callback();
};

const stopScreenTransition = () => {
  if (screenTransitionTimer != null) {
    clearTimeout(screenTransitionTimer);
    screenTransitionTimer = null;
  }
  if (screenTransitionMinimumTimer != null) {
    clearTimeout(screenTransitionMinimumTimer);
    screenTransitionMinimumTimer = null;
  }
  screenTransition.value = false;
};

const startScreenTransition = (duration = 900) => {
  if (screenTransitionTimer != null) clearTimeout(screenTransitionTimer);
  if (screenTransitionMinimumTimer != null) clearTimeout(screenTransitionMinimumTimer);
  screenTransitionStartedAt = Date.now();
  screenTransition.value = true;
  screenTransitionTimer = setTimeout(() => {
    screenTransitionTimer = null;
    screenTransition.value = false;
  }, duration);
};

const finishScreenTransition = () => {
  if (!screenTransition.value) return;
  if (screenTransitionTimer != null) {
    clearTimeout(screenTransitionTimer);
    screenTransitionTimer = null;
  }
  const remaining = Math.max(0, 260 - (Date.now() - screenTransitionStartedAt));
  screenTransitionMinimumTimer = setTimeout(() => {
    screenTransitionMinimumTimer = null;
    screenTransition.value = false;
  }, remaining);
};

const frameMatchesScreenSettings = () => {
  if (!screenFrameRealWidth.value) return true;
  return frameWidth.value === Math.min(screenQuality.value, screenFrameRealWidth.value);
};

onUnmounted(() => {
  pageActive = false;
  stopScreenTransition();
  if (terminalResizeTimer != null) {
    clearTimeout(terminalResizeTimer);
    terminalResizeTimer = null;
  }
  (uni as any).offWindowResize?.(handleWindowResize);
});

const lockLandscapePlus = () => {
  // #ifdef APP-PLUS
  plus.screen.lockOrientation("landscape");
  // #endif
};

const unlockOrientationPlus = () => {
  // #ifdef APP-PLUS
  plus.screen.lockOrientation("portrait-primary");
  // #endif
};

const lockLandscape = () => {
  try {
    uni.setPageOrientation({
      orientation: "landscape-primary",
      fail: () => lockLandscapePlus(),
    });
  } catch {
    lockLandscapePlus();
  }
};

const unlockOrientation = () => {
  try {
    uni.setPageOrientation({
      orientation: "portrait-primary",
      fail: () => unlockOrientationPlus(),
    });
  } catch {
    unlockOrientationPlus();
  }
};

const pct = (value: number | null) => (value == null ? "--" : String(Math.round(value)));
const bytes = (value: number | null) => {
  if (value == null) return "-- GB";
  return `${(value / 1024 ** 3).toFixed(1)} GB`;
};
const rate = (value: number | null) => {
  if (value == null) return "-- KB/s";
  return value > 1048576 ? `${(value / 1048576).toFixed(1)} MB/s` : `${Math.max(1, Math.round(value / 1024))} KB/s`;
};

const enqueueTerminalInput = (data: string) => {
  if (!data || !terminalSessionId.value || terminalStarting.value) return;
  terminalSendQueue = terminalSendQueue.then(async () => {
    if (!terminalSessionId.value || terminalStarting.value) return;
    await agent.sendTerminalInput(data);
  }).catch((error: any) => {
    terminalError.value = error?.message || "终端输入失败";
  });
};

const resetTerminalEditState = () => {
  terminalPipeInput.value = "";
  terminalHistory.value = [];
  terminalHistoryIndex.value = null;
};

const setPipeInput = (value: string) => {
  terminalPipeInput.value = value;
};

const resetTerminalOutput = () => {
  terminalViewRef.value?.reset();
};

const appendTerminalOutput = (value: string) => {
  terminalViewRef.value?.write(value);
};

const scheduleTerminalResize = (delay = 80) => {
  if (terminalResizeTimer != null) {
    clearTimeout(terminalResizeTimer);
  }
  terminalResizeTimer = setTimeout(() => {
    terminalResizeTimer = null;
    terminalViewRef.value?.resize();
  }, delay);
};

const handleTerminalPipeInput = (event: any) => {
  if (!terminalSessionId.value || terminalStarting.value) {
    terminalPipeInput.value = "";
    return;
  }
  terminalHistoryIndex.value = null;
  terminalPipeInput.value = String(event?.detail?.value ?? event?.target?.value ?? "");
};

const handleTerminalPipeKey = (event: KeyboardEvent) => {
  if (!terminalSessionId.value || terminalStarting.value) return;
  const key = event.key;
  if (key === "Enter") {
    event.preventDefault();
    void submitTerminalCommand();
    return;
  }
  if (key === "ArrowUp" || key === "ArrowDown") {
    event.preventDefault();
    movePipeHistory(key === "ArrowUp" ? -1 : 1);
  }
};

const handleTerminalReady = () => {
  terminalViewRef.value?.resize();
};

const handleTerminalFailure = () => {
  if (terminalStarting.value) {
    terminalStarting.value = false;
    terminalError.value = "终端组件加载失败";
    uni.showToast({ title: terminalError.value, icon: "none" });
  }
};

const handleTerminalResize = async (event: any) => {
  const cols = Number(event?.cols || 0);
  const rows = Number(event?.rows || 0);
  if (!cols || !rows || (cols === terminalCols.value && rows === terminalRows.value)) return;
  try {
    const info = await agent.resizeTerminal(cols, rows);
    terminalCols.value = Number(info.cols || cols);
    terminalRows.value = Number(info.rows || rows);
  } catch {
    // Fit changes are best effort; the next layout pass will retry.
  }
};

const handleWindowResize = () => {
  scheduleTerminalResize(120);
  if (fullScreen.value) void screenViewer.handleViewportChange();
};

const applyTerminalReady = (payload: Record<string, any>) => {
  const info = payload as TerminalSessionInfo;
  terminalSessionId.value = String(info.session_id || "");
  terminalCwd.value = String(info.cwd || "");
  terminalShell.value = String(info.shell || "");
  terminalMode.value = info.mode === "pty" ? "pty" : "pipe";
  terminalLineEnding.value = String(info.line_ending || "\n");
  terminalCols.value = Number(info.cols || 80);
  terminalRows.value = Number(info.rows || 24);
  terminalClosing.value = false;
  terminalStarting.value = false;
  terminalExitCode.value = null;
  terminalError.value = "";
  resetTerminalOutput();
  resetTerminalEditState();
  terminalOpen.value = true;
  terminalViewRef.value?.resize();
};

const handleTerminalDisconnected = () => {
  if (!terminalSessionId.value && !terminalStarting.value) return;
  terminalSessionId.value = "";
  terminalStarting.value = false;
  terminalExitCode.value = null;
  terminalError.value = "连接已断开";
  resetTerminalEditState();
  appendTerminalOutput("\n[连接已断开]\n");
};

const handleMessage = (message: AgentEnvelope) => {
  if (message.type === "metrics") {
    metrics.value = { ...emptyMetrics, ...(message.payload || {}) } as AgentMetrics;
    updatedAt.value = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  }
  if (message.type === "screen.frame") {
    screenData.value = `data:image/jpeg;base64,${message.payload?.data || ""}`;
    const width = Number(message.payload?.width || 0);
    const height = Number(message.payload?.height || 0);
    frameWidth.value = width;
    frameHeight.value = height;
    frameOriginX.value = Number(message.payload?.origin_x || 0);
    frameOriginY.value = Number(message.payload?.origin_y || 0);
    frameRealWidth.value = Number(message.payload?.real_width || 0);
    frameRealHeight.value = Number(message.payload?.real_height || 0);
    const fps = Number(message.payload?.fps || screenFps.value);
    screenInfo.value = width && height ? `${width} × ${height} · ${fps}fps` : "等待画面";
    if (screenTransition.value && frameMatchesScreenSettings()) finishScreenTransition();
  }
  if (message.type === "terminal.ready") {
    applyTerminalReady(message.payload || {});
  }
  if (message.type === "terminal.output") {
    const sessionId = String(message.payload?.session_id || "");
    if (!terminalSessionId.value || sessionId === terminalSessionId.value) {
      appendTerminalOutput(String(message.payload?.data || ""));
    }
  }
  if (message.type === "terminal.exit") {
    const sessionId = String(message.payload?.session_id || "");
    if (!terminalClosing.value && (!terminalSessionId.value || sessionId === terminalSessionId.value)) {
      terminalExitCode.value = Number(message.payload?.exit_code ?? -1);
      terminalSessionId.value = "";
      terminalStarting.value = false;
      resetTerminalEditState();
      appendTerminalOutput(`\n[进程已退出 ${terminalExitCode.value}]\n`);
    }
  }
  if (message.type === "error" && message.payload?.code === "screen.unavailable") {
    screenOn.value = false;
    screenData.value = "";
    screenInfo.value = "PC 屏幕采集不可用";
    stopScreenTransition();
  }
  if (message.type === "error" && String(message.payload?.code || "").startsWith("terminal.")) {
    terminalError.value = String(message.payload?.message || "终端操作失败");
    terminalStarting.value = false;
  }
};

const toggleScreen = () => {
  if (agent.state !== "online") return;
  if (screenOn.value) {
    agent.unsubscribeScreen();
    screenOn.value = false;
    screenData.value = "";
    screenInfo.value = "屏幕监控未开启";
  } else {
    stopScreenTransition();
    agent.subscribeScreen(screenFps.value, screenQuality.value);
    screenOn.value = true;
    screenInfo.value = "等待画面";
  }
};

const updateScreenSettings = (width: number, fps: number) => {
  screenQuality.value = width;
  screenFps.value = fps;
  if (agent.state !== "online" || !screenOn.value) return;
  screenInfo.value = "切换画面设置…";
  startScreenTransition();
  agent.subscribeScreen(fps, width);
};

const openTerminal = async () => {
  if (agent.state !== "online") {
    uni.showToast({ title: "设备未连接", icon: "none" });
    return;
  }
  if (!agent.selectedProject) {
    uni.showToast({ title: "请先选择项目", icon: "none" });
    return;
  }
  if (agent.supportsTerminal === false) {
    uni.showToast({ title: "当前 Agent 不支持终端", icon: "none" });
    return;
  }
  if (terminalClosing.value) return;
  terminalOpen.value = true;
  if (terminalSessionId.value || terminalStarting.value) {
    scheduleTerminalResize(0);
    return;
  }
  terminalStarting.value = true;
  terminalError.value = "";
  terminalExitCode.value = null;
  resetTerminalOutput();
  resetTerminalEditState();
  try {
    const info = await agent.startTerminal(agent.selectedProject.id, terminalCols.value, terminalRows.value);
    applyTerminalReady(info);
  } catch (error: any) {
    terminalStarting.value = false;
    terminalError.value = error?.message || "终端连接失败";
    appendTerminalOutput(`${terminalError.value}\n`);
    uni.showToast({ title: terminalError.value, icon: "none" });
  }
};

const closeTerminalSession = async (closePanel = true) => {
  if (terminalClosing.value) return;
  const hadSession = Boolean(terminalSessionId.value);
  terminalClosing.value = hadSession;
  terminalSessionId.value = "";
  terminalStarting.value = false;
  resetTerminalEditState();
  if (closePanel) terminalOpen.value = false;
  if (!hadSession || agent.state !== "online") {
    terminalClosing.value = false;
    return;
  }
  try {
    await agent.closeTerminal();
  } catch {
    // The connection may already be closing; the backend also cleans up on disconnect.
  } finally {
    terminalClosing.value = false;
    terminalExitCode.value = null;
    terminalError.value = "已断开";
  }
};

const toggleTerminalSession = () => {
  if (terminalSessionId.value || terminalOpen.value || terminalStarting.value) {
    void closeTerminalSession(true);
    return;
  }
  void openTerminal();
};

const hideTerminal = () => {
  terminalOpen.value = false;
};

const submitTerminal = async () => {
  if (!terminalSessionId.value || terminalStarting.value) return;
  const value = terminalPipeInput.value;
  terminalPipeInput.value = "";
  terminalHistoryIndex.value = null;
  if (value && terminalHistory.value[terminalHistory.value.length - 1] !== value) {
    terminalHistory.value.push(value);
  }
  appendTerminalOutput(`${value}\n`);
  try {
    await agent.sendTerminalInput(`${value}${terminalLineEnding.value}`);
  } catch (error: any) {
    terminalError.value = error?.message || "终端输入失败";
  }
};

const movePipeHistory = (direction: -1 | 1) => {
  const history = terminalHistory.value;
  if (!history.length) return;
  const currentIndex = terminalHistoryIndex.value;
  if (direction < 0) {
    terminalHistoryIndex.value = currentIndex == null
      ? history.length - 1
      : Math.max(0, currentIndex - 1);
  } else {
    if (currentIndex == null) return;
    if (currentIndex >= history.length - 1) {
      terminalHistoryIndex.value = null;
      terminalPipeInput.value = "";
      return;
    }
    terminalHistoryIndex.value = currentIndex + 1;
  }
  setPipeInput(history[terminalHistoryIndex.value] || "");
};

const submitTerminalCommand = async () => {
  if (!terminalSessionId.value || terminalStarting.value) return;
  await submitTerminal();
};

const sendTerminalKey = async (data: string) => {
  if (!terminalSessionId.value || terminalStarting.value) return;
  try {
    if (terminalMode.value === "pipe" && data === "\x03") {
      setPipeInput("");
      terminalHistoryIndex.value = null;
      appendTerminalOutput("^C\n");
    }
    if (terminalMode.value === "pipe" && (data === "\r" || data === "\n")) {
      await submitTerminal();
      return;
    }
    if (terminalMode.value === "pipe" && (data === "\x1b[A" || data === "\x1b[B")) {
      movePipeHistory(data === "\x1b[A" ? -1 : 1);
      return;
    }
    if (terminalMode.value === "pipe" && data === "\x7f") {
      setPipeInput(terminalPipeInput.value.slice(0, -1));
      return;
    }
    if (terminalMode.value === "pipe" && data === "\t") {
      setPipeInput(`${terminalPipeInput.value}\t`);
      return;
    }
    await agent.sendTerminalInput(data);
  } catch (error: any) {
    terminalError.value = error?.message || "终端按键失败";
  }
};

const handleTerminalQuickKey = async (data: string) => {
  await sendTerminalKey(data);
};

const enterFullScreen = () => {
  if (!screenData.value) return;
  fullScreen.value = true;
  settingsOpen.value = false;
  controlsOpen.value = false;
  screenViewer.reset();
  startScreenTransition(700);
  lockLandscape();
  fullscreenLive.value = screenOn.value;
  if (agent.state === "online" && !screenOn.value) {
    agent.subscribeScreen(screenFps.value, screenQuality.value);
    screenOn.value = true;
    fullscreenLive.value = true;
    screenInfo.value = "等待画面";
  }
  setTimeout(() => {
    if (fullScreen.value) void screenViewer.handleViewportChange();
  }, 260);
};

const sendScreenCommand = async (action: any, payload: Record<string, any> = {}) => {
  if (!pageActive || !fullscreenLive.value || agent.state !== "online") return;
  try {
    await agent.sendScreenInput({
      action,
      x: frameWidth.value / 2,
      y: frameHeight.value / 2,
      screen_width: frameWidth.value,
      screen_height: frameHeight.value,
      origin_x: frameOriginX.value,
      origin_y: frameOriginY.value,
      real_width: frameRealWidth.value,
      real_height: frameRealHeight.value,
      ...payload,
    });
  } catch (error: any) {
    screenInfo.value = error?.message || "控制指令发送失败";
  }
};

const sendMouseAction = async (action: "double_click" | "right_click" | "middle_click") => {
  if (!pageActive || !fullscreenLive.value || agent.state !== "online") return;
  try {
    await screenViewer.sendAtCursor(action as any);
  } catch (error: any) {
    screenInfo.value = error?.message || "鼠标指令发送失败";
  }
};

const setInputMode = (mode: "mouse" | "touch") => {
  screenViewer.inputMode.value = mode;
  if (mode === "touch") {
    keyboardOpen.value = false;
    remoteKeyboardText.value = "";
  }
};

const toggleKeyboard = async () => {
  keyboardOpen.value = !keyboardOpen.value;
  if (!keyboardOpen.value) {
    remoteKeyboardText.value = "";
    remoteKeyboardFocused.value = false;
    return;
  }
  remoteKeyboardFocused.value = false;
  await nextTick();
  remoteKeyboardFocused.value = true;
};

const sendRemoteKeyboardInput = (event: any) => {
  remoteKeyboardText.value = String(event?.detail?.value ?? remoteKeyboardText.value);
};

const sendRemoteKeyboardText = async () => {
  const text = remoteKeyboardText.value;
  if (!text) return;
  await sendScreenCommand("text", { text });
  remoteKeyboardText.value = "";
};

const sendRemoteKeyboardEnter = async () => {
  await sendRemoteKeyboardText();
  await sendScreenCommand("key", { key: "enter" });
};

const exitFullScreen = () => {
  fullScreen.value = false;
  controlsOpen.value = false;
  settingsOpen.value = false;
  unlockOrientation();
  fullscreenLive.value = false;
  screenViewer.reset();
  if (screenOn.value && screenData.value) startScreenTransition(520);
};

const toggleSettings = () => {
  settingsOpen.value = !settingsOpen.value;
};

const toggleControls = () => {
  controlsOpen.value = !controlsOpen.value;
  if (!controlsOpen.value) settingsOpen.value = false;
};

const onScreenTouchStart = async (event: any) => {
  await withPage(() => screenViewer.beginGesture(event));
};

const onScreenTouchMove = (event: any) => {
  withPage(() => screenViewer.moveGesture(event));
};

const onScreenTouchEnd = (event: any) => {
  withPage(() => screenViewer.endGesture(event));
};

onShow(() => {
  pageActive = true;
  syncTheme();
  replay();
  connectionState.value = agent.state;
  agent.onMessage = handleMessage;
  agent.subscribeMetrics();
  agent.onStateChange = (state) => {
    connectionState.value = state;
    if (state !== "online") {
      handleTerminalDisconnected();
    }
  };
  (uni as any).offWindowResize?.(handleWindowResize);
  (uni as any).onWindowResize?.(handleWindowResize);
  if (resumeScreenAfterShow && agent.state === "online") {
    screenData.value = "";
    agent.subscribeScreen(screenFps.value, screenQuality.value);
    screenOn.value = true;
    screenInfo.value = "等待画面";
    startScreenTransition(1200);
  }
  if (fullScreen.value) void screenViewer.handleViewportChange();
});

onHide(() => {
  pageActive = false;
  void closeTerminalSession(false);
  (uni as any).offWindowResize?.(handleWindowResize);
  resumeScreenAfterShow = screenOn.value;
  if (agent.onMessage === handleMessage) {
    agent.onMessage = null;
  }
  agent.unsubscribeMetrics();
  agent.unsubscribeScreen();
  screenOn.value = false;
  stopScreenTransition();
});
</script>

<template>
  <view class="screen" :class="themeClass">
    <GlassNavbar
      title="DEV-STUDIO"
      :subtitle="`${connectionState === 'online' ? '在线' : connectionState === 'connecting' ? '连接中' : '离线'} · ${updatedAt}`"
      :theme-class="themeClass"
    >
      <template #right>
      <button class="screen-toggle" :class="{ on: screenOn }" @click="toggleScreen">
        {{ screenOn ? "停止画面" : "开启画面" }}
      </button>
      </template>
    </GlassNavbar>
    <view class="tab-content" :class="{ 'ios-page-enter': entering }">
      <view class="card metric-card">
      <view class="metric-top">
        <text>CPU</text>
        <view class="metric-value">
          <text class="big">{{ pct(metrics.cpu_percent) }}</text>
          <text class="unit">%</text>
        </view>
      </view>
      <view class="track"><view class="value cpu" :style="{ width: `${metrics.cpu_percent || 0}%` }" /></view>
      <text class="metric-hint mono">采样周期 2s · Agent 实时推送</text>
    </view>

    <view class="grid2">
      <view class="card mini-card">
        <text class="mini-label">内存</text>
        <view class="metric-value">
          <text class="big">{{ pct(metrics.memory_percent) }}</text>
          <text class="unit">%</text>
        </view>
        <view class="track"><view class="value memory" :style="{ width: `${metrics.memory_percent || 0}%` }" /></view>
        <text class="mini-foot mono">{{ bytes(metrics.memory_used_bytes) }} 已用</text>
      </view>
      <view class="card mini-card">
        <text class="mini-label">磁盘</text>
        <view class="metric-value">
          <text class="big">{{ pct(metrics.disk_percent) }}</text>
          <text class="unit">%</text>
        </view>
        <view class="track"><view class="value disk" :style="{ width: `${metrics.disk_percent || 0}%` }" /></view>
        <text class="mini-foot mono">system volume</text>
      </view>
    </view>

    <view class="card stats-card">
      <view class="stat-row">
        <text class="stat-label">上行</text>
        <text class="stat-value mono">{{ rate(metrics.net_sent_bytes_per_sec) }}</text>
      </view>
      <view class="stat-row">
        <text class="stat-label">下行</text>
        <text class="stat-value mono">{{ rate(metrics.net_recv_bytes_per_sec) }}</text>
      </view>
      <view class="stat-row">
        <text class="stat-label">进程</text>
        <text class="stat-value mono">{{ metrics.process_count ?? "--" }}</text>
      </view>
    </view>

    <view class="card terminal-entry-card">
      <view class="terminal-entry-copy">
        <text class="terminal-entry-title">远程终端</text>
        <text class="terminal-entry-meta mono">{{ terminalStatus }}</text>
      </view>
      <button
        class="terminal-entry-button"
        :class="{ active: Boolean(terminalSessionId) }"
        :disabled="terminalStarting || terminalClosing"
        @click.stop="toggleTerminalSession"
      >{{ terminalClosing ? "断开中" : terminalStarting ? "连接中" : terminalSessionId ? "关闭" : "打开" }}</button>
    </view>

    <view class="card screen-panel">
      <view class="panel-head">
        <text>PC 画面</text>
        <text class="mono live" :class="{ on: screenOn }">{{ screenOn ? "LIVE" : "OFF" }}</text>
      </view>
      <view v-if="screenData" class="frame stage-frame" @click="enterFullScreen">
        <image
          :src="screenData"
          mode="widthFix"
          class="stage-image"
          :class="{ refreshing: screenTransition }"
        />
        <view v-if="screenTransition" class="screen-transition">
          <view class="loading-veil compact">
            <view class="loading-orbit pulse" />
            <text class="loading-text">正在同步画面</text>
          </view>
        </view>
      </view>
      <view v-else class="frame empty-frame">
        <view class="loading-veil">
          <view v-if="screenOn" class="loading-orbit pulse" />
          <text :class="{ 'loading-text': screenOn }">{{ screenInfo }}</text>
        </view>
      </view>
      <view v-if="screenData" class="stage-hint">
        <text>点击进入全屏触摸</text>
      </view>
      <text class="frame-info mono">{{ screenInfo }}</text>
    </view>
    </view>
    <LiquidTabBar current="monitor" :theme-class="themeClass" />

    <view v-if="fullScreen && !terminalOpen" class="screen-fullscreen" :class="themeClass">
      <button
        class="viewer-launch-button"
        :class="{ open: controlsOpen }"
        @click.stop="toggleControls"
      >
        <text>{{ controlsOpen ? "收起" : "开始" }}</text>
      </button>
      <view v-if="controlsOpen" class="fullscreen-toolbar">
        <text class="fullscreen-title mono">{{ screenInfo }}</text>
        <view class="fullscreen-actions">
          <button class="fullscreen-button viewer-button" :class="{ active: screenViewer.fitActive.value }" @click.stop="screenViewer.fit()">适应</button>
          <button class="fullscreen-button viewer-button" @click.stop="screenViewer.actualSize()">1:1</button>
          <button class="fullscreen-button viewer-button icon" @click.stop="screenViewer.zoomOut()">-</button>
          <text class="zoom-label mono">{{ screenViewer.percentLabel.value }}</text>
          <button class="fullscreen-button viewer-button icon" @click.stop="screenViewer.zoomIn()">+</button>
          <button class="fullscreen-button settings-toggle" :class="{ active: settingsOpen }" @click.stop="toggleSettings">设置</button>
          <button class="fullscreen-button" :disabled="!screenOn" @click.stop="toggleScreen">
            {{ screenOn ? "停止" : "开启" }}
          </button>
          <button class="fullscreen-button exit" @click.stop="exitFullScreen">退出</button>
        </view>
      </view>
      <view v-if="controlsOpen && settingsOpen" class="screen-settings">
        <view class="setting-group">
          <button
            v-for="option in qualityOptions"
            :key="option.width"
            class="setting-button"
            :class="{ active: screenQuality === option.width }"
            @click.stop="updateScreenSettings(option.width, screenFps)"
          >{{ option.label }}</button>
        </view>
        <view class="setting-group">
          <button
            v-for="option in fpsOptions"
            :key="option.value"
            class="setting-button"
            :class="{ active: screenFps === option.value }"
            @click.stop="updateScreenSettings(screenQuality, option.value)"
          >{{ option.label }}</button>
        </view>
      </view>
      <view
        class="screen-surface"
        @touchstart.stop.prevent="onScreenTouchStart"
        @touchmove.stop.prevent="onScreenTouchMove"
        @touchend.stop.prevent="onScreenTouchEnd"
        @touchcancel.stop.prevent="onScreenTouchEnd"
        @mousedown.stop.prevent="onScreenTouchStart"
        @mousemove.stop="onScreenTouchMove"
        @mouseup.stop.prevent="onScreenTouchEnd"
      >
        <image
          v-if="screenData"
          :src="screenData"
          mode="scaleToFill"
          class="fullscreen-frame"
          :class="{ refreshing: screenTransition }"
          :style="screenViewer.frameStyle.value"
        />
        <view v-if="screenData && screenTransition" class="screen-transition">
          <view class="loading-veil compact">
            <view class="loading-orbit pulse" />
            <text class="loading-text">正在同步画面</text>
          </view>
        </view>
        <view
          v-if="screenData && screenViewer.inputMode.value === 'mouse'"
          class="remote-cursor"
          :style="screenViewer.cursorStyle.value"
        />
        <view v-if="!screenData" class="fullscreen-empty">
          <text>{{ screenInfo }}</text>
        </view>
      </view>
      <view v-if="controlsOpen" class="screen-controls">
        <button
          class="control-button mode"
          :class="{ active: screenViewer.inputMode.value === 'mouse' }"
          @click.stop="setInputMode('mouse')"
        >鼠标</button>
        <button
          class="control-button mode"
          :class="{ active: screenViewer.inputMode.value === 'touch' }"
          @click.stop="setInputMode('touch')"
        >触摸</button>
        <button class="control-button" @click.stop="sendMouseAction('double_click')">双击</button>
        <button class="control-button" @click.stop="sendMouseAction('right_click')">右键</button>
        <button class="control-button" @click.stop="sendScreenCommand('scroll', { delta: 3 })">上滚</button>
        <button class="control-button" @click.stop="sendScreenCommand('scroll', { delta: -3 })">下滚</button>
        <button
          class="control-button"
          :class="{ active: keyboardOpen }"
          @click.stop="toggleKeyboard"
        >键盘</button>
        <button class="control-button" @click.stop="sendScreenCommand('key', { key: 'escape' })">ESC</button>
        <button class="control-button" @click.stop="sendScreenCommand('key', { key: 'enter' })">回车</button>
      </view>
      <view v-if="controlsOpen && keyboardOpen" class="remote-keyboard-bar">
        <input
          class="remote-keyboard-input"
          :value="remoteKeyboardText"
          :focus="remoteKeyboardFocused"
          confirm-type="send"
          placeholder="输入到 PC"
          placeholder-class="remote-keyboard-placeholder"
          @input="sendRemoteKeyboardInput"
          @confirm="sendRemoteKeyboardEnter"
        />
        <button class="keyboard-key primary" @click.stop="sendRemoteKeyboardText">发送</button>
        <button class="keyboard-key" @click.stop="sendScreenCommand('key', { key: 'backspace' })">删除</button>
        <button class="keyboard-key" @click.stop="sendScreenCommand('key', { key: 'up' })">↑</button>
        <button class="keyboard-key" @click.stop="sendScreenCommand('key', { key: 'down' })">↓</button>
        <button class="keyboard-key" @click.stop="sendScreenCommand('key', { key: 'left' })">←</button>
        <button class="keyboard-key" @click.stop="sendScreenCommand('key', { key: 'right' })">→</button>
      </view>
    </view>

    <view v-if="terminalOpen" class="terminal-fullscreen" :class="themeClass">
      <view class="terminal-toolbar">
        <view class="terminal-heading">
          <text class="terminal-title">终端</text>
          <text class="terminal-meta mono">{{ terminalShell || terminalStatus }}</text>
          <text v-if="terminalCwd" class="terminal-meta mono">{{ terminalCwd }}</text>
        </view>
        <view class="terminal-toolbar-actions">
          <button
            class="terminal-toolbar-button"
            :class="{ danger: Boolean(terminalSessionId) }"
            :disabled="terminalStarting || terminalClosing"
            @touchstart.stop
            @click.stop="toggleTerminalSession"
          >{{ terminalClosing ? "断开中" : terminalSessionId ? "断开" : "连接" }}</button>
          <button class="terminal-toolbar-button" @touchstart.stop @click="hideTerminal">收起</button>
        </view>
      </view>
      <view class="terminal-surface">
        <TerminalView
          ref="terminalViewRef"
          :session-id="terminalSessionId"
          :theme-class="themeClass"
          :disabled="!terminalSessionId || terminalStarting"
          @input="enqueueTerminalInput"
          @resize="handleTerminalResize"
          @ready="handleTerminalReady"
          @failure="handleTerminalFailure"
        />
      </view>
      <view v-if="terminalMode === 'pipe'" class="terminal-command-bar">
        <view class="terminal-command-field">
          <input
            class="terminal-command-input"
            type="text"
            v-model="terminalPipeInput"
            :disabled="!terminalSessionId || terminalStarting"
            :cursor-spacing="18"
            :maxlength="-1"
            :adjust-position="true"
            :confirm-hold="false"
            confirm-type="send"
            autocomplete="off"
            autocapitalize="off"
            autocorrect="off"
            spellcheck="false"
            @input="handleTerminalPipeInput"
            @keydown="handleTerminalPipeKey"
            @confirm="submitTerminalCommand"
          />
        </view>
        <button
          class="terminal-send-button"
          :disabled="!terminalSessionId || terminalStarting"
          @touchstart.stop
          @click.stop="submitTerminalCommand"
        >发送</button>
      </view>
      <scroll-view class="terminal-key-row" scroll-x>
        <view class="terminal-key-track">
          <button
            v-for="key in terminalKeys"
            :key="key.label"
            class="terminal-key"
            :disabled="!terminalSessionId"
            @touchstart.stop
            @click="handleTerminalQuickKey(key.data)"
          >{{ key.label }}</button>
        </view>
      </scroll-view>
    </view>
  </view>
</template>

<style>
.screen {
  padding-top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 52px + 14px);
  padding-bottom: calc(100px + env(safe-area-inset-bottom, 0px));
}
.head {
  display: none;
}
.screen-toggle {
  height: 30px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9px;
  background: #101728;
  color: #8b93a7;
  font-size: 10.5px;
  line-height: 28px;
}
.theme-light .screen-toggle {
  border-color: rgba(24, 39, 61, 0.14) !important;
  background: rgba(255, 255, 255, 0.52) !important;
  color: #6a7688 !important;
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
}
.screen-toggle.on {
  border-color: rgba(232, 112, 58, 0.55);
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
}
.theme-light .screen-toggle.on {
  border-color: rgba(232, 112, 58, 0.5) !important;
  background: rgba(232, 112, 58, 0.12) !important;
  color: #c2410c !important;
}
.metric-card {
  padding: 15px;
}
.metric-top,
.metric-value {
  display: flex;
  align-items: flex-end;
}
.metric-top {
  justify-content: space-between;
  color: #8b93a7;
  font-size: 12px;
}
.metric-value {
  gap: 2px;
}
.big {
  color: #e7ecf5;
  font-size: 26px;
  font-weight: 750;
  line-height: 1;
}
.unit {
  color: #5c6579;
  font-size: 12px;
}
.track {
  height: 6px;
  margin-top: 12px;
  overflow: hidden;
  border-radius: 3px;
  background: #1a2238;
}
.value {
  height: 100%;
  border-radius: 3px;
  background: linear-gradient(90deg, #e8703a, #f0a06a);
  transition: width 0.8s ease;
}
.value.memory {
  background: linear-gradient(90deg, #b45cf0, #7dd3fc);
}
.value.disk {
  background: linear-gradient(90deg, #38bdf8, #34d399);
}
.metric-hint {
  display: block;
  margin-top: 10px;
  color: #5c6579;
  font-size: 10px;
}
.grid2 {
  display: flex;
  gap: 10px;
  margin-top: 12px;
}
.mini-card {
  flex: 1;
  min-width: 0;
  padding: 13px;
}
.mini-label {
  display: block;
  color: #8b93a7;
  font-size: 11px;
}
.mini-card .big {
  font-size: 23px;
}
.mini-card .track {
  margin-top: 10px;
}
.mini-foot {
  display: block;
  margin-top: 9px;
  color: #5c6579;
  font-size: 10px;
}
.stats-card {
  margin-top: 12px;
  padding: 7px 14px;
}
.stat-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  height: 37px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
}
.stat-row:last-child {
  border-bottom: 0;
}
.stat-label {
  color: #8b93a7;
  font-size: 12px;
}
.stat-value {
  color: #e7ecf5;
  font-size: 15px;
  font-weight: 650;
}
.terminal-entry-card {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  margin-top: 12px;
  padding: 13px 14px;
}
.terminal-entry-copy {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 3px;
}
.terminal-entry-title {
  color: #c4cdde;
  font-size: 13px;
  font-weight: 650;
}
.terminal-entry-meta {
  overflow: hidden;
  color: #5c6579;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.terminal-entry-button {
  flex: none;
  width: 68px;
  height: 31px;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9px;
  background: #101728;
  color: #9aa6bc;
  font-size: 11px;
  line-height: 29px;
}
.terminal-entry-button.active {
  border-color: rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.1);
  color: #9bdcff;
}
.terminal-entry-button[disabled] {
  opacity: 0.55;
}
.screen-panel {
  margin-top: 12px;
  overflow: hidden;
  padding: 12px;
}
.panel-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 10px;
  color: #c4cdde;
  font-size: 13px;
}
.live {
  color: #5c6579;
  font-size: 10px;
  letter-spacing: 1px;
}
.live.on {
  color: #f87171;
}
.frame {
  display: block;
  width: 100%;
  border-radius: 10px;
}

.stage-frame {
  position: relative;
  overflow: hidden;
}

.stage-image {
  display: block;
  width: 100%;
  border-radius: 10px;
  transition: filter 180ms ease, opacity 180ms ease;
}
.empty-frame {
  min-height: 168px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #2a3a60;
  background: #070a12;
  color: #5c6579;
  font-size: 12px;
}
.frame-info {
  display: block;
  margin-top: 9px;
  color: #5c6579;
  font-size: 10px;
}

.stage-hint {
  display: flex;
  justify-content: center;
  margin-top: 7px;
  padding: 6px 10px;
  border: 1px solid rgba(232, 112, 58, 0.24);
  border-radius: 99px;
  background: rgba(232, 112, 58, 0.08);
  color: #f0a06a;
  font-size: 10.5px;
}

.screen-fullscreen {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 999;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 0;
  background: rgba(3, 6, 13, 0.97);
}

.viewer-launch-button {
  position: absolute;
  top: 50%;
  right: calc(env(safe-area-inset-right, 0px) + 12px);
  z-index: 6;
  height: 44px;
  min-width: 44px;
  padding: 0 14px;
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 99px;
  background: rgba(13, 21, 38, 0.82);
  color: #dce6f7;
  font-size: 12px;
  line-height: 42px;
  box-shadow: 0 10px 24px rgba(0, 0, 0, 0.26);
  backdrop-filter: blur(16px) saturate(150%);
  -webkit-backdrop-filter: blur(16px) saturate(150%);
  transform: translateY(-50%);
  transition: transform 180ms cubic-bezier(0.34, 1.36, 0.44, 1), background-color 180ms ease, color 180ms ease;
}

.viewer-launch-button.open {
  border-color: rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.14);
  color: #9bdcff;
}

.viewer-launch-button:active {
  transform: translateY(-50%) scale(0.94);
}

.fullscreen-toolbar {
  position: absolute;
  top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 8px);
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  right: calc(env(safe-area-inset-right, 0px) + 10px);
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 40px;
  pointer-events: none;
}

.screen-settings {
  position: absolute;
  top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 56px);
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  right: calc(env(safe-area-inset-right, 0px) + 10px);
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-top: 0;
  overflow-x: auto;
  pointer-events: auto;
}

.setting-group {
  display: flex;
  gap: 6px;
}

.setting-button {
  height: 27px;
  min-width: 45px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 99px;
  background: rgba(19, 28, 48, 0.78);
  color: #8b93a7;
  font-size: 10.5px;
  line-height: 25px;
}

.setting-button.active {
  border-color: rgba(232, 112, 58, 0.5);
  background: rgba(232, 112, 58, 0.14);
  color: #f0a06a;
}

.fullscreen-title {
  min-width: 0;
  max-width: 20%;
  overflow: hidden;
  color: #8b93a7;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.fullscreen-actions {
  display: flex;
  flex: none;
  min-width: 0;
  gap: 7px;
  flex-wrap: nowrap;
  justify-content: flex-end;
  pointer-events: auto;
}

.zoom-label {
  flex: none;
  min-width: 42px;
  color: #a9b7d3;
  font-size: 10.5px;
  line-height: 31px;
  text-align: center;
}

.fullscreen-button {
  height: 31px;
  padding: 0 11px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 99px;
  background: rgba(18, 26, 46, 0.82);
  color: #a9b7d3;
  font-size: 11px;
  line-height: 29px;
}

.fullscreen-button.exit {
  border-color: rgba(232, 112, 58, 0.38);
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
}

.fullscreen-button.settings-toggle.active {
  border-color: rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.12);
  color: #9bdcff;
}

.fullscreen-button.viewer-button.icon {
  min-width: 31px;
  padding: 0;
}

.fullscreen-button.viewer-button.active {
  border-color: rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.12);
  color: #9bdcff;
}

.screen-surface {
  position: relative;
  flex: 1;
  min-height: 0;
  width: 100%;
  margin-top: 0;
  overflow: hidden;
  touch-action: none;
  border-radius: 0;
  background: #02040a;
  display: flex;
  align-items: center;
  justify-content: center;
}

.screen-transition {
  position: absolute;
  inset: 0;
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(3, 7, 15, 0.44);
  backdrop-filter: blur(6px);
  -webkit-backdrop-filter: blur(6px);
  animation: screen-veil-in 160ms ease both;
}

.fullscreen-frame.refreshing {
  filter: blur(2px) saturate(88%);
}

.stage-image.refreshing {
  filter: blur(2px) saturate(88%);
}

.fullscreen-frame {
  position: absolute;
  left: 50%;
  top: 50%;
  transform-origin: center center;
  will-change: width, height, transform;
}

.remote-cursor {
  position: absolute;
  left: 50%;
  top: 50%;
  z-index: 3;
  width: 22px;
  height: 22px;
  pointer-events: none;
  background: rgba(255, 255, 255, 0.94);
  border: 1.5px solid rgba(15, 23, 42, 0.92);
  border-radius: 50%;
  box-shadow: 0 0 0 2px rgba(56, 189, 248, 0.26), 0 4px 12px rgba(0, 0, 0, 0.35);
  transform: translate(-3px, -3px) scale(1);
  transition: transform 120ms cubic-bezier(0.34, 1.48, 0.44, 1);
}

.remote-cursor::after {
  content: "";
  position: absolute;
  left: 9px;
  top: 9px;
  width: 4px;
  height: 4px;
  border-radius: 50%;
  background: #0f172a;
}

.fullscreen-empty {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #2a3a60;
  color: #5c6579;
  font-size: 12px;
}

.screen-controls {
  position: absolute;
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  right: calc(env(safe-area-inset-right, 0px) + 10px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);
  z-index: 4;
  display: flex;
  gap: 6px;
  margin-top: 0;
  overflow: hidden;
  pointer-events: auto;
}

.control-button {
  flex: 1;
  min-width: 0;
  height: 29px;
  padding: 0 6px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 9px;
  background: rgba(18, 26, 46, 0.78);
  color: #a9b7d3;
  font-size: 10.5px;
  line-height: 27px;
}

.control-button.active {
  border-color: rgba(56, 189, 248, 0.44);
  background: rgba(56, 189, 248, 0.14);
  color: #9bdcff;
}

.remote-keyboard-bar {
  position: absolute;
  right: calc(env(safe-area-inset-right, 0px) + 10px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 46px);
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  z-index: 5;
  display: flex;
  gap: 6px;
  align-items: center;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 13px;
  background: rgba(12, 19, 34, 0.9);
  backdrop-filter: blur(18px) saturate(150%);
  -webkit-backdrop-filter: blur(18px) saturate(150%);
}

.remote-keyboard-input {
  flex: 1;
  min-width: 0;
  height: 32px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  background: rgba(3, 7, 16, 0.82);
  color: #dbe6f6;
  font-size: 11.5px;
}

.remote-keyboard-placeholder {
  color: #667085;
}

.keyboard-key {
  flex: none;
  min-width: 42px;
  height: 32px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  background: rgba(24, 35, 60, 0.88);
  color: #a9b7d3;
  font-size: 10.5px;
  line-height: 30px;
}

.keyboard-key.primary {
  border-color: rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.16);
  color: #9bdcff;
}

.fullscreen-hint {
  display: none;
  margin-top: 9px;
  color: #68738a;
  font-size: 10.5px;
  text-align: center;
}

.theme-light.screen-fullscreen {
  background: rgba(244, 246, 249, 0.97);
}

.theme-light.screen-fullscreen .fullscreen-title,
.theme-light.screen-fullscreen .fullscreen-hint {
  color: #687386;
}

.theme-light.screen-fullscreen .fullscreen-button {
  border-color: rgba(24, 39, 61, 0.14);
  background: rgba(255, 255, 255, 0.86);
  color: #5f6b7e;
}

.theme-light.screen-fullscreen .viewer-launch-button {
  border-color: rgba(24, 39, 61, 0.14);
  background: rgba(255, 255, 255, 0.86);
  color: #5f6b7e;
}

.theme-light.screen-fullscreen .fullscreen-button.settings-toggle.active {
  border-color: rgba(2, 132, 199, 0.38);
  background: rgba(56, 189, 248, 0.14);
  color: #0369a1;
}

.theme-light.screen-fullscreen .setting-button,
.theme-light.screen-fullscreen .control-button {
  border-color: rgba(24, 39, 61, 0.13);
  background: rgba(255, 255, 255, 0.82);
  color: #63707f;
}

.theme-light.screen-fullscreen .setting-button.active {
  border-color: rgba(232, 112, 58, 0.38);
  background: rgba(232, 112, 58, 0.12);
  color: #c2410c;
}

.theme-light.screen-fullscreen .control-button.active {
  border-color: rgba(2, 132, 199, 0.38);
  background: rgba(56, 189, 248, 0.14);
  color: #0369a1;
}

.theme-light.screen-fullscreen .remote-keyboard-bar {
  border-color: rgba(24, 39, 61, 0.12);
  background: rgba(255, 255, 255, 0.86);
}

.theme-light.screen-fullscreen .remote-keyboard-input {
  border-color: rgba(24, 39, 61, 0.12);
  background: rgba(247, 249, 252, 0.92);
  color: #26364d;
}

.theme-light.screen-fullscreen .keyboard-key {
  border-color: rgba(24, 39, 61, 0.12);
  background: rgba(255, 255, 255, 0.82);
  color: #607086;
}

.theme-light.screen-fullscreen .keyboard-key.primary {
  border-color: rgba(2, 132, 199, 0.38);
  background: rgba(56, 189, 248, 0.14);
  color: #0369a1;
}

.theme-light.screen-fullscreen .fullscreen-button.exit {
  border-color: rgba(232, 112, 58, 0.3);
  background: rgba(232, 112, 58, 0.1);
  color: #c2410c;
}

.theme-light.screen-fullscreen .screen-surface {
  border: 1px solid rgba(24, 39, 61, 0.12);
  background: #e8ebf1;
}

.theme-light .terminal-entry-title {
  color: #26364d;
}

.theme-light .terminal-entry-meta {
  color: #718096;
}

.theme-light .terminal-entry-button {
  border-color: rgba(24, 39, 61, 0.14);
  background: rgba(255, 255, 255, 0.72);
  color: #607086;
}

.theme-light .terminal-entry-button.active {
  border-color: rgba(2, 132, 199, 0.36);
  background: rgba(56, 189, 248, 0.12);
  color: #0369a1;
}

.terminal-fullscreen {
  position: fixed;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  width: 100vw;
  height: 100vh;
  z-index: 1000;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 8px) 0 calc(env(safe-area-inset-bottom, 0px) + 6px);
  background: #030611;
}

.terminal-toolbar {
  display: flex;
  align-items: center;
  flex: none;
  gap: 8px;
  min-height: 44px;
  padding: 0 10px 8px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.terminal-heading {
  display: flex;
  flex: 1;
  min-width: 0;
  flex-direction: column;
  gap: 2px;
}

.terminal-title {
  color: #e7ecf5;
  font-size: 13px;
  font-weight: 700;
}

.terminal-meta {
  display: block;
  max-width: 100%;
  overflow: hidden;
  color: #6d7890;
  font-size: 9.5px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.terminal-toolbar-actions {
  display: flex;
  flex: none;
  gap: 6px;
}

.terminal-toolbar-button {
  min-width: 52px;
  height: 30px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 9px;
  background: #111a2d;
  color: #a9b7d3;
  font-size: 10.5px;
  line-height: 28px;
}

.terminal-toolbar-button.danger {
  border-color: rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.08);
  color: #fda4af;
}

.terminal-toolbar-button[disabled],
.terminal-key[disabled] {
  opacity: 0.42;
}

.terminal-surface {
  display: flex;
  flex-direction: column;
  flex: 1;
  flex-basis: 0;
  width: auto;
  height: auto;
  box-sizing: border-box;
  min-height: 0;
  min-width: 0;
  position: relative;
  margin: 8px 10px 0;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: #060912;
}

.terminal-surface .terminal-view {
  flex: 1;
  width: 100%;
  height: auto;
  min-height: 0;
}

.terminal-command-bar {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
  height: 40px;
  margin: 6px 10px 0;
}

.terminal-command-field {
  display: flex;
  flex: 1;
  min-width: 0;
  height: 36px;
  align-items: center;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 9px;
  background: #0d1424;
}

.terminal-command-input {
  flex: 1;
  width: 100%;
  height: 34px;
  padding: 0 9px;
  background: transparent;
  color: #e2e8f0;
  font-size: 12px;
  line-height: 34px;
}

.terminal-send-button {
  flex: none;
  min-width: 50px;
  height: 36px;
  padding: 0 10px;
  border: 1px solid rgba(56, 189, 248, 0.32);
  border-radius: 9px;
  background: rgba(56, 189, 248, 0.12);
  color: #7dd3fc;
  font-size: 11px;
  line-height: 34px;
}

.terminal-send-button[disabled] {
  opacity: 0.42;
}

.terminal-key-row {
  flex: none;
  height: 42px;
  margin-top: 6px;
  white-space: nowrap;
}

.terminal-key-track {
  display: inline-flex;
  gap: 6px;
  height: 36px;
  padding: 0 10px;
}

.terminal-key {
  min-width: 54px;
  height: 32px;
  padding: 0 10px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: #111a2d;
  color: #9eabc2;
  font-size: 10.5px;
  line-height: 30px;
}

.theme-light.terminal-fullscreen {
  background: #f4f6f9;
}

.theme-light.terminal-fullscreen .terminal-toolbar {
  border-bottom-color: rgba(24, 39, 61, 0.1);
}

.theme-light.terminal-fullscreen .terminal-title {
  color: #26364d;
}

.theme-light.terminal-fullscreen .terminal-meta {
  color: #718096;
}

.theme-light.terminal-fullscreen .terminal-toolbar-button,
.theme-light.terminal-fullscreen .terminal-key {
  border-color: rgba(24, 39, 61, 0.14);
  background: rgba(255, 255, 255, 0.86);
  color: #607086;
}

.theme-light.terminal-fullscreen .terminal-command-field {
  border-color: rgba(24, 39, 61, 0.14);
  background: rgba(255, 255, 255, 0.88);
}

.theme-light.terminal-fullscreen .terminal-command-input {
  color: #26364d;
}

.theme-light.terminal-fullscreen .terminal-send-button {
  border-color: rgba(2, 132, 199, 0.28);
  background: rgba(2, 132, 199, 0.08);
  color: #0369a1;
}

.theme-light .terminal-caret {
  background: #0284c7;
  box-shadow: 0 0 4px rgba(2, 132, 199, 0.35);
}

.theme-light.terminal-fullscreen .terminal-toolbar-button.danger {
  border-color: rgba(220, 38, 38, 0.25);
  background: rgba(220, 38, 38, 0.07);
  color: #b91c1c;
}

@keyframes screen-veil-in {
  from {
    opacity: 0;
  }
  to {
    opacity: 1;
  }
}

</style>
