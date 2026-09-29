<script setup lang="ts">
import { computed, ref } from "vue";
import { onLoad, onShow, onUnload } from "@dcloudio/uni-app";
import type { AgentEnvelope, ConnectionState } from "../../types/agent";
import { agent } from "../../utils/agent";
import { syncTheme, themeClass } from "../../utils/theme";

const step = ref(1);
const serverUrl = ref(agent.settings.serverUrl);
const deviceName = ref(agent.settings.deviceName);
const pairCode = ref("");
const state = ref<ConnectionState>(agent.state);
const stateDetail = ref("");
const error = ref("");
const pairedName = ref(agent.settings.deviceName);
const timers = ref<number[]>([]);

const codeCells = computed(() => pairCode.value.padEnd(6, " ").slice(0, 6).split("").map((cell) => (cell === " " ? "" : cell)));
const protocol = computed(() => (/^wss:/i.test(serverUrl.value) ? "TLS" : "明文"));
const canSubmitCode = computed(() => /^\d{6}$/.test(pairCode.value));

const stateText = computed(() => {
  if (state.value === "connecting") return "正在建立连接";
  if (state.value === "online") return "等待 PC 审批";
  return "连接已断开";
});

const setError = (text = "") => {
  error.value = text;
};

const submitServer = () => {
  if (!/^wss?:\/\//i.test(serverUrl.value.trim())) {
    setError("地址必须以 ws:// 或 wss:// 开头");
    return;
  }
  setError("");
  pairedName.value = deviceName.value.trim() || "RemoteCodex Phone";
  agent.savePairingServer(serverUrl.value, deviceName.value);
  step.value = 2;
};

const submitCode = () => {
  if (!canSubmitCode.value) {
    setError("请输入 PC 上显示的 6 位数字");
    return;
  }
  setError("");
  try {
    agent.requestPairing(pairCode.value);
    step.value = 3;
  } catch (submitError: any) {
    setError(submitError?.message || "配对请求失败");
  }
};

const backToServer = () => {
  agent.cancelPairing();
  step.value = 1;
};

const editCode = () => {
  agent.cancelPairing();
  step.value = 2;
};

const finish = () => {
  uni.switchTab({ url: "/pages/projects/projects" });
};

const handleState = (next: ConnectionState, detail: string) => {
  state.value = next;
  stateDetail.value = detail;
  if (step.value === 3 && next === "online") {
    step.value = 4;
    return;
  }
  if (step.value === 3 && next === "offline") {
    setError(detail || "配对失败，请重新输入配对码");
    const timer = setTimeout(() => {
      pairCode.value = "";
      step.value = 2;
      setError("");
    }, 1600);
    timers.value.push(timer as unknown as number);
  }
};

const handleMessage = (message: AgentEnvelope) => {
  if (message.type === "error") {
    state.value = "offline";
    stateDetail.value = String(message.payload?.message || "配对失败");
  }
};

onLoad(() => {
  if (agent.settings.token) {
    step.value = 4;
  }
});

onShow(() => {
  syncTheme();
  serverUrl.value = agent.settings.serverUrl;
  deviceName.value = agent.settings.deviceName;
  pairedName.value = agent.settings.deviceName;
  state.value = agent.state;
  agent.onStateChange = handleState;
  agent.onMessage = handleMessage;
});

onUnload(() => {
  if (agent.onStateChange === handleState) {
    agent.onStateChange = null;
  }
  if (agent.onMessage === handleMessage) {
    agent.onMessage = null;
  }
  timers.value.forEach((timer) => clearTimeout(timer));
});
</script>

<template>
  <view class="pair-screen" :class="themeClass">
    <view v-if="step === 1" class="step-body">
      <view class="hero">
        <view class="mark">✳</view>
        <text class="title">连接你的 PC</text>
        <text class="sub">填入运行 RemoteCodex Agent 的电脑地址。手机和电脑建议在同一局域网。</text>
      </view>

      <view class="card panel">
        <text class="field-label">PC WebSocket 地址</text>
        <input v-model="serverUrl" class="input input-text mono" placeholder="ws://192.168.1.20:7800" placeholder-class="placeholder" />
        <text class="field-label">设备名</text>
        <input v-model="deviceName" class="input input-text" placeholder="RemoteCodex Phone" placeholder-class="placeholder" />
        <button class="primary" @click="submitServer">下一步</button>
      </view>

      <view class="meta-row">
        <text class="mono">{{ protocol }}</text>
        <text>手机与 PC 使用同一局域网时延迟最低</text>
      </view>
    </view>

    <view v-if="step === 2" class="step-body">
      <view class="hero">
        <view class="mark">⌘</view>
        <text class="title">输入配对码</text>
        <text class="sub mono">{{ serverUrl }}</text>
        <text class="sub">在 PC 终端执行 <text class="mono">python -m app pair</text>，把 6 位数字填到下面。</text>
      </view>

      <view class="card code-panel">
        <view class="codeboxes">
          <view v-for="(cell, index) in codeCells" :key="index" class="codebox" :class="{ filled: cell }">
            <text>{{ cell }}</text>
          </view>
        </view>
        <input v-model="pairCode" class="input code-input mono" type="number" :maxlength="6" placeholder="000000" placeholder-class="placeholder" />
        <button class="primary" :disabled="!canSubmitCode" @click="submitCode">请求配对</button>
        <button class="ghost" @click="backToServer">返回修改服务器</button>
      </view>

      <view class="meta-row">
        <text>配对码 5 分钟有效</text>
        <text>审批窗口 60 秒</text>
      </view>
    </view>

    <view v-if="step === 3" class="step-body">
      <view class="hero">
        <view class="radar">
          <view /><view /><view />
          <view class="core mono">{{ pairCode.slice(0, 2) || "··" }}</view>
        </view>
        <text class="title">{{ stateText }}</text>
        <text class="sub">设备名：{{ pairedName }} · 码：{{ pairCode }}</text>
      </view>

      <view class="card wait-panel">
        <text class="wait-title">在 PC 终端执行</text>
        <view class="command mono">
          <text>python -m app pair-approve &lt;pairing-id&gt; --config config.mobile.json</text>
        </view>
        <button class="ghost" @click="editCode">取消并返回</button>
      </view>
    </view>

    <view v-if="step === 4" class="step-body">
      <view class="hero">
        <view class="okmark">✓</view>
        <text class="title">已配对</text>
        <text class="sub">{{ pairedName }} 已保存到本机。以后打开 App 会自动连接。</text>
      </view>
      <view class="card done-panel">
        <view class="done-row">
          <text>服务器</text>
          <text class="mono server">{{ agent.settings.serverUrl }}</text>
        </view>
        <view class="done-row">
          <text>设备名</text>
          <text>{{ deviceName }}</text>
        </view>
        <view class="done-row">
          <text>Token</text>
          <text class="mono">{{ agent.settings.token ? "已安全保存" : "未保存" }}</text>
        </view>
        <button class="primary" @click="finish">开始使用</button>
        <button class="ghost" @click="backToServer">重新配对</button>
      </view>
    </view>

    <view v-if="error" class="error-toast">
      <text>{{ error }}</text>
    </view>
  </view>
</template>

<style>
.pair-screen {
  position: relative;
  min-height: 100vh;
  box-sizing: border-box;
  padding: 24px 26px calc(30px + env(safe-area-inset-bottom));
}
.step-body {
  display: flex;
  flex-direction: column;
  min-height: calc(100vh - 54px - env(safe-area-inset-bottom));
}
.hero {
  display: flex;
  flex-direction: column;
  align-items: center;
  margin-top: 16px;
  text-align: center;
}
.mark {
  width: 62px;
  height: 62px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 18px;
  border-radius: 20px;
  background: conic-gradient(from 210deg, #e8703a, #b45cf0, #38bdf8, #e8703a);
  color: #150a10;
  font-size: 28px;
  font-weight: 800;
}
.title {
  font-size: 20px;
  font-weight: 750;
}
.sub {
  max-width: 302px;
  margin-top: 8px;
  color: #8b93a7;
  font-size: 12px;
  line-height: 1.8;
}
.panel,
.code-panel,
.wait-panel,
.done-panel {
  margin-top: 24px;
  padding: 15px;
}
.field-label {
  display: block;
  margin-bottom: 7px;
  color: #8b93a7;
  font-size: 12px;
}
.field-label + .field-label {
  margin-top: 14px;
}
.input-text {
  height: 44px;
  padding: 0 12px;
  font-size: 13px;
}
.primary {
  width: 100%;
  height: 43px;
  margin-top: 16px;
  border-radius: 13px;
  background: #e8703a;
  color: #fff;
  font-size: 14px;
  font-weight: 650;
  line-height: 43px;
}
.ghost {
  width: 100%;
  height: 39px;
  margin-top: 10px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 12px;
  color: #8b93a7;
  font-size: 13px;
  line-height: 37px;
}
.meta-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-top: 12px;
  color: #5c6579;
  font-size: 10.5px;
}
.codeboxes {
  display: flex;
  justify-content: space-between;
}
.codebox {
  width: 40px;
  height: 52px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid #223052;
  border-radius: 12px;
  background: #0e1526;
  color: #f0a06a;
  font-size: 21px;
  font-weight: 750;
}
.codebox.filled {
  border-color: rgba(232, 112, 58, 0.48);
}
.code-input {
  height: 43px;
  margin-top: 14px;
  text-align: center;
  color: #e7ecf5;
  font-size: 16px;
  letter-spacing: 5px;
}
.radar {
  position: relative;
  width: 120px;
  height: 120px;
  margin: 12px 0 18px;
}
.radar > view {
  position: absolute;
  inset: 0;
  border: 1.5px solid rgba(232, 112, 58, 0.5);
  border-radius: 50%;
  animation: radar 2s ease-out infinite;
}
.radar > view:nth-child(2) {
  animation-delay: 0.66s;
}
.radar > view:nth-child(3) {
  animation-delay: 1.33s;
}
.radar .core {
  inset: 38px;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 0;
  border-radius: 50%;
  background: #e8703a;
  color: #fff;
  font-size: 15px;
  font-weight: 750;
}
.wait-title {
  display: block;
  margin-bottom: 9px;
  color: #8b93a7;
  font-size: 12px;
}
.command {
  padding: 11px;
  border: 1px solid rgba(56, 189, 248, 0.25);
  border-radius: 10px;
  background: rgba(56, 189, 248, 0.07);
  color: #7dd3fc;
  font-size: 11px;
  line-height: 1.7;
  word-break: break-all;
}
.okmark {
  width: 62px;
  height: 62px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 18px;
  border-radius: 50%;
  background: rgba(52, 211, 153, 0.12);
  border: 1px solid rgba(52, 211, 153, 0.45);
  color: #34d399;
  font-size: 28px;
  font-weight: 800;
}
.done-row {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 40px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.05);
  color: #8b93a7;
  font-size: 12px;
}
.done-row:last-of-type {
  border-bottom: 0;
}
.done-row .server,
.done-row .mono {
  max-width: 62%;
  overflow: hidden;
  color: #e7ecf5;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.error-toast {
  position: fixed;
  left: 26px;
  right: 26px;
  bottom: calc(26px + env(safe-area-inset-bottom));
  padding: 10px 14px;
  border: 1px solid rgba(248, 113, 113, 0.4);
  border-radius: 99px;
  background: rgba(68, 23, 26, 0.95);
  color: #ffd9d9;
  font-size: 12px;
  text-align: center;
}
@keyframes radar {
  from {
    transform: scale(0.35);
    opacity: 1;
  }
  to {
    transform: scale(1.25);
    opacity: 0;
  }
}
</style>
