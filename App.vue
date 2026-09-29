<script setup lang="ts">
import { onLaunch, onShow } from "@dcloudio/uni-app";
import { agent } from "./utils/agent";
import { applySavedKeepScreenOn } from "./utils/keep-screen-on";
import { startSystemThemeWatcher } from "./utils/theme";

onLaunch(() => {
  startSystemThemeWatcher();
  void applySavedKeepScreenOn();
  agent.connect();
});

onShow(() => {
  void applySavedKeepScreenOn();
});
</script>

<style>
button::after {
  border: 0;
}

button {
  margin: 0;
  padding: 0;
  overflow: visible;
  background: transparent;
}

button::after {
  border: 0;
}

.mask-icon {
  display: block;
  width: 100%;
  height: 100%;
  background-color: currentColor;
  -webkit-mask-position: center;
  -webkit-mask-repeat: no-repeat;
  -webkit-mask-size: contain;
  mask-position: center;
  mask-repeat: no-repeat;
  mask-size: contain;
}

.icon-command {
  -webkit-mask-image: url("/static/command.svg");
  mask-image: url("/static/command.svg");
}

.icon-document {
  -webkit-mask-image: url("/static/document.svg");
  mask-image: url("/static/document.svg");
}

.icon-web {
  -webkit-mask-image: url("/static/web.svg");
  mask-image: url("/static/web.svg");
}

.icon-edit {
  -webkit-mask-image: url("/static/edit.svg");
  mask-image: url("/static/edit.svg");
}

.icon-undo {
  -webkit-mask-image: url("/static/undo.svg");
  mask-image: url("/static/undo.svg");
}

.icon-edit {
  -webkit-mask-image: url("/static/edit.svg");
  mask-image: url("/static/edit.svg");
}

.icon-undo {
  -webkit-mask-image: url("/static/undo.svg");
  mask-image: url("/static/undo.svg");
}

page {
  min-height: 100%;
  background:
    radial-gradient(760px 480px at 88% -8%, rgba(232, 112, 58, 0.11), transparent 62%),
    radial-gradient(640px 520px at -12% 108%, rgba(56, 189, 248, 0.08), transparent 62%),
    #05070d;
  color: #e7ecf5;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "PingFang SC", "Microsoft YaHei", sans-serif;
  font-size: 14px;
  line-height: 1.5;
}

html.theme-dark,
body.theme-dark,
html.theme-dark page,
body.theme-dark page {
  background-color: #05070d;
  color: #e7ecf5;
}

html.theme-light,
body.theme-light,
html.theme-light page,
body.theme-light page {
  background: #f4f6f9;
  background-color: #f4f6f9;
  color: #202938;
}

.theme-dark {
  --app-bg: #05070d;
  --surface: #101728;
  --surface-raised: #161b28;
  --surface-input: #0e1526;
  --text-primary: #e7ecf5;
  --text-secondary: #8b93a7;
  --text-muted: #5c6579;
  --line: rgba(255, 255, 255, 0.09);
  --code-bg: #0b1020;
  color: var(--text-primary);
}

.theme-light {
  --app-bg: #f4f6f9;
  --surface: #ffffff;
  --surface-raised: #f7f8fb;
  --surface-input: #ffffff;
  --text-primary: #202938;
  --text-secondary: #5f6b7e;
  --text-muted: #8993a3;
  --line: rgba(24, 39, 61, 0.14);
  --code-bg: #eef1f6;
  color: var(--text-primary);
  background: var(--app-bg);
}

.theme-light.screen,
.theme-light.chat-screen,
.theme-light.pair-screen {
  background: var(--app-bg);
  color: var(--text-primary);
}

.theme-light .card,
.theme-light .entry,
.theme-light .browser-head,
.theme-light .preview,
.theme-light .project,
.theme-light .tool,
.theme-light .sync-bar,
.theme-light .codex-project,
.theme-light .codex-empty,
.theme-light .empty,
.theme-light .composer,
.theme-light .thinking,
.theme-light .model-button,
.theme-light .tool-button,
.theme-light .files-button,
.theme-light .replay,
.theme-light .filters button,
.theme-light .action,
.theme-light .screen-toggle,
.theme-light .new-project {
  border-color: var(--line) !important;
  background: var(--surface) !important;
}

.theme-light .file-change-pill,
.theme-light .shell-card,
.theme-light .shell-output,
.theme-light .file-change-list {
  border-color: var(--line);
  background: var(--surface-raised);
}

.theme-light .shell-output,
.theme-light .file-change-list {
  background: #eef1f6;
}

.theme-light .activity-copy,
.theme-light .activity-detail,
.theme-light .activity-time,
.theme-light .file-change-text,
.theme-light .file-change-item-name,
.theme-light .file-change-item-path,
.theme-light .shell-label,
.theme-light .shell-output-text,
.theme-light .chevron-glyph {
  color: var(--text-secondary);
}

.theme-light .file-change-item-name,
.theme-light .shell-output-text {
  color: var(--text-primary);
}

.theme-light .project.current {
  border-color: rgba(232, 112, 58, 0.5) !important;
  background: rgba(232, 112, 58, 0.08) !important;
}

.theme-light .message-row.assistant .bubble {
  border-color: var(--line);
  background: var(--surface);
}

.theme-light .message-row.user .bubble {
  border-color: rgba(232, 112, 58, 0.25);
  background: #fff0e7;
}

.theme-light .prompt-input,
.theme-light .input,
.theme-light .codebox {
  border-color: var(--line);
  background: var(--surface-input);
  color: var(--text-primary);
}

.theme-light .assistant-meta,
.theme-light .message-text,
.theme-light .entry-name,
.theme-light .preview-name,
.theme-light .project-name,
.theme-light .head-title,
.theme-light .hero-title,
.theme-light .device-name,
.theme-light .empty-title,
.theme-light .guide-title,
.theme-light .tool-title,
.theme-light .panel-head,
.theme-light .section-title,
.theme-light .codex-project-name,
.theme-light .value,
.theme-light .done-row .mono {
  color: var(--text-primary);
}

.theme-light .field-label,
.theme-light .label,
.theme-light .hero-sub,
.theme-light .guide-text,
.theme-light .entry-meta,
.theme-light .message-time,
.theme-light .project-path,
.theme-light .project-sub,
.theme-light .head-sub,
.theme-light .stat-label,
.theme-light .mini-label,
.theme-light .metric-top,
.theme-light .browser-head .crumb,
.theme-light .preview-note,
.theme-light .state,
.theme-light .empty-description,
.theme-light .tool-meta,
.theme-light .status-row,
.theme-light .device-mark + .hero-main {
  color: var(--text-secondary);
}

.theme-light .code,
.theme-light .code-line,
.theme-light .code-preview,
.theme-light .markdown-code {
  background: var(--code-bg);
}

.theme-light .line-text,
.theme-light .reply-body {
  color: #354155;
}

.theme-light .composer {
  border-top-color: var(--line);
}

.theme-light .notice {
  border-color: rgba(90, 108, 137, 0.24);
  background: #ffffff;
  color: #354155;
}

.theme-light .sync-title,
.theme-light .sync-sub,
.theme-light .codex-project-path,
.theme-light .codex-project-meta,
.theme-light .section-count,
.theme-light .codex-action,
.theme-light .project-icon,
.theme-light .current-tag,
.theme-light .tool-state,
.theme-light .stat-value,
.theme-light .screen-toggle,
.theme-light .big,
.theme-light .unit,
.theme-light .live,
.theme-light .frame-info,
.theme-light .done-row,
.theme-light .sub,
.theme-light .meta-row,
.theme-light .wait-title,
.theme-light .command,
.theme-light .title,
.theme-light .pair-screen .panel,
.theme-light .pair-screen .code-panel,
.theme-light .pair-screen .wait-panel,
.theme-light .pair-screen .done-panel {
  color: var(--text-secondary);
}

.theme-light .tool,
.theme-light .pair-screen .panel,
.theme-light .pair-screen .code-panel,
.theme-light .pair-screen .wait-panel,
.theme-light .pair-screen .done-panel,
.theme-light .empty-frame {
  border-color: var(--line);
  background: var(--surface);
}

.theme-light .tool-body {
  border-top-color: var(--line);
  color: #354155;
}

.theme-light .reply-body {
  border-color: rgba(232, 112, 58, 0.22);
  background: #fff0e7;
  color: #354155;
}

.theme-light .sync-bar,
.theme-light .codex-project {
  border-color: rgba(56, 142, 190, 0.22);
  background: #f3f8fc;
}

.theme-light .sync-title,
.theme-light .section-title,
.theme-light .codex-project-name {
  color: var(--text-primary);
}

.theme-light .screen-toggle,
.theme-light .filters button,
.theme-light .replay,
.theme-light .codex-action,
.theme-light .pair-screen .ghost {
  border-color: var(--line);
  background: var(--surface);
}

.mono {
  font-family: "Cascadia Code", Consolas, "JetBrains Mono", monospace;
}

.ios-page-enter {
  animation: ios-tab-enter 0.36s cubic-bezier(0.2, 0.72, 0.28, 1) both;
}

.tab-content {
  display: flex;
  flex: 1;
  flex-direction: column;
  min-height: 0;
}

.chat-layout {
  min-height: 0;
}

@keyframes ios-tab-enter {
  from {
    opacity: 0;
    transform: scale(0.984) translateY(7px);
  }
  to {
    opacity: 1;
    transform: none;
  }
}

.screen {
  box-sizing: border-box;
  min-height: 100vh;
  padding: 15px 16px calc(28px + env(safe-area-inset-bottom));
}

.card {
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 16px;
  background: #101728;
}

.field-label {
  display: block;
  margin-bottom: 7px;
  color: #8b93a7;
  font-size: 12px;
}

.input {
  width: 100%;
  box-sizing: border-box;
  border: 1px solid #223052;
  border-radius: 12px;
  background: #0e1526;
  color: #e7ecf5;
}

.placeholder {
  color: #5c6579;
}
</style>
