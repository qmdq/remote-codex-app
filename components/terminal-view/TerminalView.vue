<template>
  <view
    class="terminal-view"
    :class="[themeClass, { disabled }]"
    :command="terminalCommand"
    :change:command="renderjs.onCommand"
    :surface-id="surfaceId"
  >
    <view class="terminal-view-surface" :id="surfaceId" />
    <view class="terminal-view-loading" v-if="loading">
      <view class="loading-veil">
        <view class="loading-orbit pulse" />
        <text class="loading-text">{{ loadingText }}</text>
      </view>
      <button v-if="failed" class="terminal-view-retry" @click.stop="retry">重试</button>
    </view>
  </view>
</template>

<script lang="ts">
const defaultSurfaceId = "terminal-view-surface";

export default {
  props: {
    sessionId: { type: String, default: "" },
    themeClass: { type: String, default: "" },
    fontSize: { type: Number, default: 12 },
    disabled: { type: Boolean, default: false },
    surfaceId: { type: String, default: defaultSurfaceId },
  },
  emits: ["input", "resize", "ready", "failure"],
  data() {
    return {
      loading: true,
      failed: false,
      loadingText: "正在加载终端组件",
      terminalCommand: { type: "noop", data: "", seq: 0 } as { type: string; data: string; seq: number },
    };
  },
  mounted() {
    void this.initialize();
  },
  methods: {
    dispatch(type: string, data = "") {
      this.terminalCommand = { type, data, seq: this.terminalCommand.seq + 1 };
    },
    retry() {
      this.failed = false;
      this.loadingText = "正在加载终端组件";
      this.dispatch("initialize");
    },
    async initialize() {
      await this.$nextTick();
      this.dispatch("initialize");
    },
    reset() {
      this.dispatch("reset");
    },
    write(data: string) {
      if (data) this.dispatch("write", data);
    },
    focus() {
      this.dispatch("focus");
    },
    blur() {
      this.dispatch("blur");
    },
    resize() {
      this.dispatch("resize");
    },
    onTerminalReady() {
      this.loading = false;
      this.$emit("ready", {});
    },
    onTerminalFailure(payload: { message?: string }) {
      this.failed = true;
      this.loadingText = payload?.message || "终端组件初始化失败";
      this.$emit("failure", payload || {});
    },
    onTerminalInput(data: string) {
      if (!this.disabled && this.sessionId) this.$emit("input", data);
    },
    onTerminalResize(cols: number, rows: number) {
      this.$emit("resize", { cols: Number(cols || 0), rows: Number(rows || 0) });
    },
  },
};
</script>

<script module="renderjs" lang="renderjs">
import { Terminal } from "@xterm/xterm";
import { xtermCss } from "../../utils/xterm-style";

const XTERM_STYLE_ID = "remote-codex-terminal-xterm-style";

const ensureXtermStyle = () => {
  if (document.getElementById(XTERM_STYLE_ID)) return;
  const style = document.createElement("style");
  style.id = XTERM_STYLE_ID;
  style.textContent = `${xtermCss}
.terminal-view-surface .xterm .xterm-helper-textarea{left:0;top:0;width:1px;height:1px;opacity:0;z-index:1;caret-color:transparent}`;
  document.head.appendChild(style);
};

export default {
  data() {
    return {
      xterm: null,
      resizeObserver: null,
      windowResizeHandler: null,
      pointerDownHandler: null,
      touchStartHandler: null,
      mouseDownHandler: null,
      pendingWrites: [],
      initializing: false,
      retryCount: 0,
      lastCommandSeq: 0,
      resizeFrame: null,
      resizeFrameUsesRaf: false,
      lastHostWidth: 0,
      lastHostHeight: 0,
      charWidth: 7.2,
      charHeight: 14.6,
    };
  },
  props: {
    fontSize: { type: Number, default: 12 },
    disabled: { type: Boolean, default: false },
    sessionId: { type: String, default: "" },
    surfaceId: { type: String, default: "terminal-view-surface" },
  },
  mounted() {
    this.initialize();
  },
  beforeUnmount() {
    this.destroy();
  },
  methods: {
    onCommand(command) {
      if (!command || command.seq === this.lastCommandSeq) return;
      this.lastCommandSeq = command.seq;
      if (command.type === "initialize") {
        this.initialize();
        return;
      }
      if (command.type === "reset") {
        this.reset();
        return;
      }
      if (command.type === "write") {
        this.write(command.data);
        return;
      }
      if (command.type === "focus") {
        this.focus();
        return;
      }
      if (command.type === "blur") {
        this.blur();
        return;
      }
      if (command.type === "resize") this.scheduleResize();
    },
    async initialize() {
      if (this.xterm || this.initializing) return;
      this.initializing = true;
      try {
        await this.$nextTick();
        ensureXtermStyle();
        const host = this.resolveHost();
        const hostRect = host ? host.getBoundingClientRect() : null;
        if (!host || !hostRect || hostRect.width <= 0 || hostRect.height <= 0) {
          this.retryCount += 1;
          if (this.retryCount > 40) {
            const rectText = hostRect ? `${Math.round(hostRect.width)}x${Math.round(hostRect.height)}` : "0x0";
            throw new Error(host ? `终端容器尺寸异常（${rectText}）` : "找不到终端容器");
          }
          this.initializing = false;
          setTimeout(() => this.initialize(), 80);
          return;
        }

        this.retryCount = 0;
        this.xterm = new Terminal({
          fontFamily: "Consolas, SFMono-Regular, Menlo, monospace",
          fontSize: Number(this.fontSize) || 12,
          lineHeight: 1.22,
          cursorBlink: true,
          convertEol: false,
          allowProposedApi: true,
          scrollback: 5000,
          theme: {
            background: "#060912",
            foreground: "#d6deeb",
            cursor: "#9ee7ff",
            selectionBackground: "rgba(56, 189, 248, 0.24)",
          },
        });
        this.xterm.open(host);
        this.measureCharacter(host);
        this.xterm.onData((data) => {
          this.$ownerInstance.callMethod("onTerminalInput", data);
        });
        this.xterm.onResize((size) => {
          this.$ownerInstance.callMethod("onTerminalResize", {
            cols: size.cols,
            rows: size.rows,
          });
        });
        this.xterm.attachCustomKeyEventHandler((event) => {
          if (event.type === "keydown" && event.key === "Tab") event.preventDefault();
          return true;
        });

        // Android WebView only allows focus() to open the keyboard while it is
        // still inside the user gesture. Deferring this call loses that gesture.
        this.pointerDownHandler = () => this.requestFocus();
        this.touchStartHandler = () => this.requestFocus();
        this.mouseDownHandler = () => this.requestFocus();
        host.addEventListener("pointerdown", this.pointerDownHandler);
        host.addEventListener("touchstart", this.touchStartHandler, { passive: true });
        host.addEventListener("mousedown", this.mouseDownHandler);

        if (typeof ResizeObserver === "function") {
          this.resizeObserver = new ResizeObserver(() => this.scheduleResize());
          this.resizeObserver.observe(host);
        }
        this.windowResizeHandler = () => this.scheduleResize();
        window.addEventListener("resize", this.windowResizeHandler);

        if (this.pendingWrites.length) {
          const writes = this.pendingWrites.splice(0);
          writes.forEach((data) => this.xterm && this.xterm.write(data));
        }
        this.scheduleResize();
        this.initializing = false;
        this.$ownerInstance.callMethod("onTerminalReady", {});
      } catch (error) {
        this.destroy();
        this.initializing = false;
        this.$ownerInstance.callMethod("onTerminalFailure", {
          message: `终端组件初始化失败：${error && error.message ? error.message : "未知错误"}`,
        });
      }
    },
    resolveHost() {
      const root = this.$el && this.$el.nodeType === 1 ? this.$el : this.$el && this.$el.$el;
      const host = (this.surfaceId ? document.getElementById(this.surfaceId) : null) ||
        (root && root.querySelector ? root.querySelector(".terminal-view-surface") : null);
      return host || document.querySelector(".terminal-view-surface");
    },
    measureCharacter(host) {
      const spacer = document.createElement("span");
      spacer.textContent = "W";
      spacer.setAttribute("aria-hidden", "true");
      spacer.style.fontFamily = "Consolas, SFMono-Regular, Menlo, monospace";
      spacer.style.fontSize = `${Number(this.fontSize) || 12}px`;
      spacer.style.lineHeight = String(1.22);
      spacer.style.position = "absolute";
      spacer.style.visibility = "hidden";
      spacer.style.whiteSpace = "pre";
      host.appendChild(spacer);
      const rect = spacer.getBoundingClientRect();
      if (rect.width > 0 && rect.height > 0) {
        this.charWidth = rect.width;
        this.charHeight = rect.height;
      }
      spacer.remove();
    },
    resize() {
      if (!this.xterm) return;
      const host = this.resolveHost();
      if (!host) return;
      const rect = host.getBoundingClientRect();
      const hostWidth = Math.round(rect.width * 100) / 100;
      const hostHeight = Math.round(rect.height * 100) / 100;
      const cols = Math.max(2, Math.floor((rect.width - 16) / this.charWidth));
      const rows = Math.max(2, Math.floor((rect.height - 16) / this.charHeight));
      if (
        hostWidth === this.lastHostWidth &&
        hostHeight === this.lastHostHeight &&
        cols === this.xterm.cols &&
        rows === this.xterm.rows
      ) {
        return;
      }
      this.lastHostWidth = hostWidth;
      this.lastHostHeight = hostHeight;
      if (cols !== this.xterm.cols || rows !== this.xterm.rows) {
        this.xterm.resize(cols, rows);
        this.xterm.scrollToBottom();
      }
    },
    scheduleResize() {
      if (!this.xterm || this.resizeFrame != null) return;
      const apply = () => {
        this.resizeFrame = null;
        this.resize();
      };
      if (typeof requestAnimationFrame === "function") {
        this.resizeFrameUsesRaf = true;
        this.resizeFrame = requestAnimationFrame(apply);
        return;
      }
      this.resizeFrameUsesRaf = false;
      this.resizeFrame = setTimeout(apply, 0);
    },
    reset() {
      if (this.xterm) {
        this.pendingWrites.splice(0);
        this.xterm.reset();
        this.resize();
        return;
      }
      this.pendingWrites.splice(0);
      this.initialize();
    },
    write(data) {
      const value = String(data || "");
      if (!value) return;
      if (!this.xterm) {
        this.pendingWrites.push(value);
        if (!this.initializing) this.initialize();
        return;
      }
      this.xterm.write(value);
      this.xterm.scrollToBottom();
    },
    focus() {
      if (this.xterm) this.xterm.focus();
    },
    requestFocus() {
      if (!this.xterm || !this.xterm.textarea) return;
      if (document.activeElement === this.xterm.textarea) return;
      this.focus();
    },
    blur() {
      if (this.xterm) this.xterm.blur();
    },
    destroy() {
      this.cancelScheduledResize();
      if (this.resizeObserver) this.resizeObserver.disconnect();
      this.resizeObserver = null;
      if (this.windowResizeHandler) {
        window.removeEventListener("resize", this.windowResizeHandler);
        this.windowResizeHandler = null;
      }
      const host = this.xterm ? this.resolveHost() : null;
      if (host && this.pointerDownHandler) host.removeEventListener("pointerdown", this.pointerDownHandler);
      this.pointerDownHandler = null;
      if (host && this.touchStartHandler) host.removeEventListener("touchstart", this.touchStartHandler);
      this.touchStartHandler = null;
      if (host && this.mouseDownHandler) host.removeEventListener("mousedown", this.mouseDownHandler);
      this.mouseDownHandler = null;
      if (this.xterm) this.xterm.dispose();
      this.xterm = null;
      this.pendingWrites.splice(0);
      this.initializing = false;
    },
    cancelScheduledResize() {
      if (this.resizeFrame == null) return;
      if (this.resizeFrameUsesRaf && typeof cancelAnimationFrame === "function") {
        cancelAnimationFrame(this.resizeFrame);
      } else {
        clearTimeout(this.resizeFrame);
      }
      this.resizeFrame = null;
    },
  },
};
</script>

<style>
.terminal-view {
  position: relative;
  display: flex;
  width: 100%;
  height: 100%;
  box-sizing: border-box;
  flex: 1;
  min-height: 0;
  min-width: 0;
  overflow: hidden;
}

.terminal-view-surface {
  position: relative;
  display: block;
  width: 100%;
  height: 100%;
  min-width: 1px;
  min-height: 1px;
  box-sizing: border-box;
}

.terminal-view-loading {
  position: absolute;
  top: 0;
  right: 0;
  bottom: 0;
  left: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: #060912;
  color: #7b8497;
  font-size: 12px;
}

.terminal-view-retry {
  width: 84px;
  height: 30px;
  min-height: 30px;
  margin-top: 12px;
  padding: 0;
  border: 1px solid rgba(158, 231, 255, 0.35);
  border-radius: 9px;
  background: rgba(14, 25, 43, 0.9);
  color: #9ee7ff;
  font-size: 12px;
  line-height: 28px;
}

.theme-light .terminal-view-loading {
  background: #f6f8fb;
  color: #64748b;
}

.theme-light .terminal-view-retry {
  border-color: rgba(232, 112, 58, 0.28);
  background: #fff2ea;
  color: #bc4d17;
}
</style>
