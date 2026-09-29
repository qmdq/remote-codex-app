<script setup lang="ts">
import { computed, nextTick, ref, watch } from "vue";
import { onHide, onShow, onUnload } from "@dcloudio/uni-app";
import type {
  CodexThreadStatus,
  CodexThreadSummary,
  ConnectionState,
  McpServer,
  PendingTurnSnapshot,
  TimelineItem,
} from "../../types/agent";
import { agent } from "../../utils/agent";
import GlassNavbar from "../../components/glass-navbar/GlassNavbar.vue";
import LiquidTabBar from "../../components/liquid-tabbar/LiquidTabBar.vue";
import { chooseImageSource, type SelectedImage } from "../../utils/image-source";
import { parseMarkdown } from "../../utils/markdown";
import { useIosTabTransition } from "../../utils/page-transition";
import { createScreenViewer, type ScreenViewerMeasure } from "../../utils/screen-viewer";
import { syncTheme, themeClass } from "../../utils/theme";

const { entering, replay } = useIosTabTransition();

interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  body: string;
  ts: string;
  imagePath?: string;
  imageLocalUrl?: string;
  turnId?: string;
  status?: PendingTurn["status"];
}

interface PendingTurn extends PendingTurnSnapshot {
  queued?: boolean;
}

interface FileReference {
  kind: "file";
  path: string;
  label: string;
}

interface WebReference {
  kind: "web";
  path: string;
  label: string;
}

type MessageReference = FileReference | WebReference;

interface ThreadActivity {
  id: string;
  icon: "command" | "file" | "think";
  title: string;
  detail: string;
  status: "running" | "success" | "failed";
  ts: string;
}

interface ThreadCommand {
  id: string;
  title: string;
  command: string;
  output: string;
  exitCode: number | null;
  status: "running" | "success" | "failed";
  ts: string;
}

interface ThreadFileChange {
  id: string;
  path: string;
  additions: number;
  deletions: number;
  name: string;
  status: "running" | "success" | "failed";
  ts: string;
}

interface ThreadStatus {
  id: string;
  title: string;
  detail: string;
  output: string;
  ts: string;
}

interface PreviewFile {
  path: string;
  name: string;
  kind: "text" | "image" | "binary";
  mime: string;
  size: number;
  truncated: boolean;
  content: string;
  dataUrl: string;
}

const prompt = ref("");
const selectedImage = ref<SelectedImage | null>(null);
const uploadingImage = ref(false);
const imageUploadPercent = ref(0);
const state = ref<ConnectionState>(agent.state);
const projectName = ref(agent.selectedProject?.name || "未选择项目");
const sandbox = ref<"read_only" | "workspace_write">(agent.selectedProject?.default_sandbox || "workspace_write");
const models = ref<string[]>(agent.models.choices);
const model = ref(agent.selectedProject?.model || agent.models.default);
const running = ref(false);
const queuedPrompts = ref<{ id: string; text: string; ts: string }[]>([]);
const followupGuideOpen = ref(false);
const continueAvailable = ref(false);
const manualInterruptRequested = ref(false);
const editingTurnId = ref("");
const editDraft = ref("");
const replies = ref<TimelineItem[]>([]);
const sentTurns = ref<PendingTurn[]>([]);
const sendErrors = ref<ThreadStatus[]>([]);
const hiddenEditedMessageIds = ref<Set<string>>(new Set());
const revealedThreadIds = ref<Set<string>>(new Set());
const animatedThreadIds = ref<Set<string>>(new Set());
const historyThreadIds = ref<Set<string>>(new Set());
let entranceSeeded = false;
let entranceScheduling = false;
let entranceBootstrapping = false;
let activeLocalMessageId = "";
let entranceQueue: string[] = [];
let entranceBootstrapTimer: ReturnType<typeof setTimeout> | null = null;
let entranceRevealTimer: ReturnType<typeof setInterval> | null = null;
let queuedDispatchTimer: ReturnType<typeof setTimeout> | null = null;
let queuedDispatchToken = 0;
let queuedDispatchItem: { id: string; text: string; ts: string } | null = null;
let manualInterruptBaseSeq = 0;
let activeTurnId = "";
let activeStartedAt = 0;
let activeLiveIds = new Set<string>();
const resetEntrance = () => {
  entranceSeeded = false;
  entranceScheduling = false;
  entranceBootstrapping = false;
  activeLocalMessageId = "";
  entranceQueue = [];
  activeTurnId = "";
  activeStartedAt = 0;
  activeLiveIds = new Set<string>();
  hiddenEditedMessageIds.value = new Set();
  revealedThreadIds.value = new Set();
  revealedThreadOrder.value = [];
  animatedThreadIds.value = new Set();
  if (entranceBootstrapTimer) {
    clearTimeout(entranceBootstrapTimer);
    entranceBootstrapTimer = null;
  }
  if (entranceRevealTimer) {
    clearInterval(entranceRevealTimer);
    entranceRevealTimer = null;
  }
};
const revealedThreadOrder = ref<string[]>([]);
const activities = computed(() => replies.value.filter((item) => {
  if (item.kind === "agent.event" && item.type === "turn.status") return false;
  if (item.type === "thread.started") return false;
  if (item.type === "item.completed" && item.body && item.itemType === "agent_message") return false;
  if (item.type === "item.started") {
    const matched = replies.value.some((done) => {
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
    if (matched) return false;
  }
  if (item.type === "item.completed") {
    return item.itemType !== "agent_message";
  }
  return item.type.startsWith("item.");
}));
const historyMessages = ref<ChatMessage[]>([]);
let historyRequestId = 0;
let currentProjectId = agent.selectedProject?.id || "";
let currentSessionId = agent.selectedProject?.current_session_id || "";
let currentThreadId = agent.selectedProject?.codex_thread_id || "";
const withPendingIdentity = (
  turn: PendingTurn,
  projectId = agent.selectedProject?.id || "",
  sessionId = agent.selectedProject?.current_session_id || null,
  threadId = agent.selectedProject?.codex_thread_id || null,
): PendingTurn => ({
  ...turn,
  projectId,
  sessionId,
  threadId,
});
const restorePendingTurns = () => {
  const project = agent.selectedProject;
  const stored = project
    ? agent.pendingTurnsFor(
      project.id,
      project.current_session_id || null,
      { exactSession: true },
    ).map((turn) => ({ ...turn }))
    : [];
  sentTurns.value = stored;
  if (!stored.length) return;
  const runningTurn = stored.find((turn) => turn.status === "running");
  if (!runningTurn) return;
  activeLocalMessageId = runningTurn.id;
  activeTurnId = runningTurn.turnId;
  activeStartedAt = runningTurn.startedAt;
  activeLiveIds = new Set();
  entranceBootstrapping = false;
  scheduleEntrance();
};
const publishPendingTurns = () => {
  const project = agent.selectedProject;
  if (!project) return;
  agent.setPendingTurns(
    project.id,
    project.current_session_id || null,
    sentTurns.value.map((turn) => withPendingIdentity(turn, project.id, project.current_session_id || null, project.codex_thread_id || null)),
  );
};
const resetConversationView = () => {
  replies.value = [];
  historyMessages.value = [];
  hiddenEditedMessageIds.value = new Set();
  historyThreadIds.value = new Set();
  sendErrors.value = [];
  queuedPrompts.value = [];
  followupGuideOpen.value = false;
  continueAvailable.value = false;
  manualInterruptRequested.value = false;
  queuedDispatchToken += 1;
  queuedDispatchItem = null;
  manualInterruptBaseSeq = 0;
  if (queuedDispatchTimer) {
    clearTimeout(queuedDispatchTimer);
    queuedDispatchTimer = null;
  }
  resetEntrance();
  restorePendingTurns();
};
const scrollIntoView = ref("");
let scrollNonce = 0;
let scrollRetryTimer: ReturnType<typeof setTimeout> | null = null;
let scrollFramePending = false;
const pageActive = ref(true);
const notices = ref<{ id: number; text: string; tone: "info" | "error" }[]>([]);
const screenActive = ref(false);
const screenOn = ref(false);
const screenData = ref("");
const screenInfo = ref("PC 屏幕未开启");
const screenFrameWidth = ref(0);
const screenFrameHeight = ref(0);
const screenFrameOriginX = ref(0);
const screenFrameOriginY = ref(0);
const screenFrameRealWidth = ref(0);
const screenFrameRealHeight = ref(0);
const screenQuality = ref(1920);
const screenFps = ref(30);
const screenSettingsOpen = ref(false);
const screenControlsCollapsed = ref(true);
const screenControlsOpen = ref(false);
const screenFull = ref(false);
const screenFullLive = ref(false);
const fullscreenButton = ref({ x: 0, y: 14 });
const fullscreenButtonDragging = ref(false);
let fullscreenButtonStart: { x: number; y: number; moved: number } | null = null;
const inlineScreenDragging = ref(false);
const inlineScreenPosition = ref({ x: 12, y: 320 });
let inlineScreenStart: { x: number; y: number; originX: number; originY: number; moved: number } | null = null;

const measureScreenFrame: ScreenViewerMeasure = async () => {
  const measured = await new Promise<any>((resolve) => {
    const query = uni.createSelectorQuery();
    query.select(".screen-full-surface").boundingClientRect((rect) => resolve(rect));
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
  frameWidth: () => screenFrameWidth.value,
  frameHeight: () => screenFrameHeight.value,
  active: () => Boolean(screenFull.value && screenFullLive.value),
  measure: measureScreenFrame,
  sendInput: async (action, point) => {
    await agent.sendScreenInput({
      action,
      x: point.x,
      y: point.y,
      screen_width: screenFrameWidth.value,
      screen_height: screenFrameHeight.value,
      origin_x: screenFrameOriginX.value,
      origin_y: screenFrameOriginY.value,
      real_width: screenFrameRealWidth.value,
      real_height: screenFrameRealHeight.value,
    });
  },
  onError: (message) => {
    screenInfo.value = message;
  },
});
const previewFile = ref<PreviewFile | null>(null);
const previewLoading = ref(false);
const previewEditing = ref(false);
const previewDraft = ref("");
const previewSaving = ref(false);
const previewDirty = computed(() => previewEditing.value && previewDraft.value !== (previewFile.value?.content || ""));
const expandedCommands = ref<Set<string>>(new Set());
const revertingFiles = ref<Set<string>>(new Set());
const revertedFiles = ref<Set<string>>(new Set());
const keyboardHeight = ref(0);
const keyboardOpen = computed(() => keyboardHeight.value > 0);
const webviewResizesWithKeyboard = () => process.env.UNI_PLATFORM === "app";
const effectiveKeyboardHeight = computed(() => {
  if (webviewResizesWithKeyboard()) return 0;
  return keyboardHeight.value;
});
const chatScreenStyle = computed(() => ({
  "--effective-keyboard-height": `${effectiveKeyboardHeight.value}px`,
  height: keyboardOpen.value && webviewResizesWithKeyboard()
    ? "100%"
    : undefined,
}));
const handleKeyboardHeightChange = (result: { height: number }) => {
  keyboardHeight.value = Math.max(0, Number(result?.height || 0));
};
const previewMarkdown = computed(() => Boolean(previewFile.value && /\.(md|markdown)$/i.test(previewFile.value.name)));
const previewBlocks = computed(() => previewMarkdown.value ? parseMarkdown(previewFile.value?.content || "") : []);
const previewTextLines = computed(() => previewFile.value?.kind === "text" ? previewFile.value.content.split(/\r?\n/) : []);
const previewHtml = computed(() => Boolean(previewFile.value && /\.(html?|xhtml)$/i.test(previewFile.value.name)));

const messageBody = (value: any): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((part) => messageBody(part))
      .filter((part) => part.trim())
      .join("\n");
  }
  if (value && typeof value === "object") {
    for (const key of ["body", "text", "content", "message", "value"]) {
      const text = messageBody(value[key]);
      if (text.trim()) return text;
    }
  }
  return "";
};

const normalizedBody = (value: string) => value.replace(/\r\n/g, "\n").trim();
const messageKey = (item: { role: "user" | "assistant"; body: string }) => (
  `${item.role}\0${normalizedBody(item.body)}`
);

const chatMessages = computed<ChatMessage[]>(() => {
  const pendingUsers = sentTurns.value
    .filter((turn) => !turn.confirmed)
    .map((turn) => ({
      id: turn.id,
      role: "user" as const,
      body: turn.text,
      imagePath: turn.imagePath,
      imageLocalUrl: turn.imageLocalUrl,
      ts: turn.ts,
      turnId: turn.turnId,
      status: turn.status,
    }));
  const assistant = replies.value
    .filter((item) => item.type === "item.completed" && item.body)
    .map((item) => ({
      id: item.id,
      role: "assistant" as const,
      body: item.body || "",
      ts: item.ts,
    }));
  const historical = historyMessages.value
    .map((item: any) => ({
      id: String(item.id),
      role: item.role === "assistant" ? "assistant" as const : "user" as const,
      body: messageBody(item),
      ts: String(item.ts || ""),
    }))
    .filter((item) => !hiddenEditedMessageIds.value.has(item.id))
    .filter((item) => item.body.trim());

  // Prefer persisted Codex history. Keep a live assistant item only when the
  // history snapshot has not yet caught up with it.
  const historyCounts = new Map<string, number>();
  for (const item of historical) {
    const key = messageKey(item);
    historyCounts.set(key, (historyCounts.get(key) || 0) + 1);
  }
  const liveAssistants: ChatMessage[] = [];
  for (const item of assistant) {
    const key = messageKey(item);
    const count = historyCounts.get(key) || 0;
    if (count > 0) {
      historyCounts.set(key, count - 1);
      continue;
    }
    liveAssistants.push(item);
  }

  return [...pendingUsers, ...liveAssistants, ...historical]
    .sort((left, right) => timestampOf(left.ts) - timestampOf(right.ts));
});

const activityIconText = (icon: ThreadActivity["icon"]) => icon === "command" ? ">_" : icon === "file" ? "≡" : "…";

const activityClass = (item: ThreadActivity) => [
  item.icon,
  item.status,
];

const activityTitle = (item: ThreadActivity) => item.title;

const activityDetail = (item: ThreadActivity) => item.detail;

const commandOutput = (output: string) => output.replace(/\r\n/g, "\n").trim() || "无输出";

const commandResult = (status: ThreadActivity["status"], exitCode: number | null) => {
  if (status === "running") return "运行中";
  if (status === "failed") return `失败${exitCode === null ? "" : ` · ${exitCode}`}`;
  return `成功${exitCode === null ? "" : ` · ${exitCode}`}`;
};

const commandTitle = (item: ThreadCommand) => `${item.status === "running" ? "正在运行" : "已运行"} ${item.command || "命令"}`;

const toggleStatus = (id: string) => {
  const next = new Set(expandedCommands.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedCommands.value = next;
};

const toggleCommand = (id: string) => {
  const next = new Set(expandedCommands.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  expandedCommands.value = next;
};

const fileBaseName = (path: string) => path.replace(/\\/g, "/").split("/").pop() || path;

const errorSummary = (value: string) => {
  const text = value.replace(/\s+/g, " ").trim();
  return text.slice(0, 110) || "";
};

const errorDetail = (value: any): string => {
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map((item) => errorDetail(item)).filter((item) => item.trim()).join("\n");
  if (value && typeof value === "object") {
    for (const key of ["message", "error", "detail", "reason", "text", "body", "value"]) {
      const text = errorDetail(value[key]);
      if (text.trim()) return text;
    }
  }
  return "";
};

const failedTurnIds = computed(() => new Set(
  sentTurns.value
    .filter((turn) => turn.status === "failed" || turn.status === "interrupted")
    .map((turn) => turn.turnId)
));

const failedTurns = computed(() => sentTurns.value
  .filter((turn) => turn.status === "failed" || turn.status === "interrupted")
  .map((turn) => {
    const status = replies.value.find((item) => (
      item.kind === "agent.event" &&
      item.type === "turn.status" &&
      item.turnId === turn.turnId
    ));

    const detail = replies.value.find((item) => (
      item.kind === "codex.event" &&
      (item.type === "turn.failed" || item.type === "turn.interrupted") &&
      item.turnId === turn.turnId
    ));
    const output = errorDetail(detail?.detail || status?.detail || "");
    return {
      id: `${turn.id}-status`,
      title: turn.status === "failed" ? "任务失败" : "任务已中断",
      detail: errorSummary(output) || formatTime(detail?.ts || status?.ts || turn.ts),
      output,
      ts: detail?.ts || status?.ts || turn.ts,
    };
  }));

const eventFailures = computed(() => replies.value
  .filter((item) => (
    item.kind === "codex.event" &&
    (item.type === "turn.failed" || item.type === "turn.interrupted") &&
    !(item.turnId && failedTurnIds.value.has(item.turnId))
  ))
  .map((item) => ({
    id: item.id,
    title: item.type === "turn.failed" ? "任务失败" : "任务已中断",
    detail: errorSummary(errorDetail(item.detail) || "Codex 任务失败"),
    output: errorDetail(item.detail),
    ts: item.ts,
  })));

const threadStream = computed(() => {
  const messages = chatMessages.value.map((item) => ({
    id: item.id,
    kind: "message" as const,
    role: item.role,
    body: item.body,
    imagePath: item.imagePath,
    imageLocalUrl: item.imageLocalUrl,
    ts: item.ts,
  }));
  const actions = activities.value
    .filter((item) => item.itemType !== "command_execution" && item.itemType !== "file_change")
    .map((item) => ({
      id: item.id,
      kind: "activity" as const,
      icon: /文件/.test(item.title)
        ? "file" as const
        : "think" as const,
      title: item.title,
      detail: item.detail,
      status: item.status === "success" ? "success" as const
        : item.status === "danger" ? "failed" as const
          : "running" as const,
      ts: item.ts,
    }));
  const completedFiles = activities.value
    .filter((item) => item.itemType === "file_change")
    .sort((left, right) => timestampOf(left.ts) - timestampOf(right.ts));
  const fileCards = new Map<string, TimelineItem>();
  for (let index = completedFiles.length - 1; index >= 0; index -= 1) {
    const item = completedFiles[index];
    const path = item.path || item.itemId || "";
    if (!path || revertedFiles.value.has(path)) continue;
    const existing = fileCards.get(path);
    if (!existing || timestampOf(item.ts) > timestampOf(existing.ts)) {
      fileCards.set(path, item);
    }
  }
  const fileChanges: ThreadFileChange[] = [...fileCards.values()].map((item) => {
    const path = item.path || item.itemId || "";
    return {
      id: item.id,
      path,
      additions: item.additions ?? 0,
      deletions: item.deletions ?? 0,
      name: fileBaseName(path),
      status: item.status === "warning"
        ? "running" as const
        : item.status === "danger" ? "failed" as const : "success" as const,
      ts: item.ts,
    };
  });
  const commands: ThreadCommand[] = activities.value
    .filter((item) => item.itemType === "command_execution" || /已运行|运行了命令/.test(item.title))
    .map((item) => ({
      id: item.id,
      title: "",
      command: item.command || item.detail,
      output: item.output || "",
      exitCode: item.exitCode,
      status: item.status === "success" ? "success" as const
        : item.status === "danger" ? "failed" as const
          : "running" as const,
      ts: item.ts,
    }))
    .map((item) => ({ ...item, title: commandTitle(item) }));
  const failures = failedTurns.value.map((item) => ({
    id: item.id,
    kind: "status" as const,
    title: item.title,
    detail: item.detail,
    output: item.output,
    ts: item.ts,
  }));
  const sendFailures = sendErrors.value.map((item) => ({
    ...item,
    kind: "status" as const,
  }));
  const timelineFailureItems = eventFailures.value.map((item) => ({
    ...item,
    kind: "status" as const,
  }));
  const queued = queuedPrompts.value.map((item) => ({
    id: item.id,
    kind: "message" as const,
    role: "user" as const,
    body: item.text,
    imagePath: "",
    imageLocalUrl: "",
    ts: item.ts,
  }));
  return [
    ...messages,
    ...queued,
    ...actions,
    ...fileChanges.map((item) => ({ ...item, kind: "file-change" as const })),
    ...commands.map((item) => ({ ...item, kind: "command" as const })),
    ...failures,
    ...timelineFailureItems,
    ...sendFailures,
  ]
    .sort((left, right) => timestampOf(left.ts) - timestampOf(right.ts))
    .map((item) => {
      const live = item.id === activeLocalMessageId || activeLiveIds.has(item.id);
      return {
        ...item,
        live,
        animationDelay: live && animatedThreadIds.value.has(item.id)
          ? Math.min(revealedThreadOrder.value.indexOf(item.id), 8) * 90
          : 0,
      };
    });
});

const thinking = computed(() => (
  sentTurns.value.some((item) => item.status === "running") ||
  agent.hasRunningTurn(
    agent.selectedProject?.id || "",
    agent.selectedProject?.current_session_id || "",
  )
));
const thinkingLabel = computed(() => (
  uploadingImage.value ? "正在上传附件"
    : running.value || entranceBootstrapping ? "正在启动执行"
      : "Codex 正在思考"
));
const visibleThreadStream = computed(() => threadStream.value.filter((item) => (
  revealedThreadIds.value.has(item.id) || historyThreadIds.value.has(item.id)
)));
const itemIsLive = (item: TimelineItem | { id: string; ts: string; turnId?: string }) => {
  if (item.turnId && item.turnId === activeTurnId) return true;
  const time = timestampOf(item.ts);
  return activeStartedAt > 0 && Number.isFinite(time) && time >= activeStartedAt;
};
const entranceDelayStyle = (delay: number) => ({ animationDelay: `${delay}ms` });

const clearEntranceTimers = () => {
  if (entranceBootstrapTimer) {
    clearTimeout(entranceBootstrapTimer);
    entranceBootstrapTimer = null;
  }
  if (entranceRevealTimer) {
    clearInterval(entranceRevealTimer);
    entranceRevealTimer = null;
  }
  entranceScheduling = false;
  if (scrollRetryTimer) {
    clearTimeout(scrollRetryTimer);
    scrollRetryTimer = null;
  }
  scrollFramePending = false;
};

const seedEntrance = () => {
  if (entranceSeeded) return;
  entranceSeeded = true;
  const ids = threadStream.value.map((item) => item.id);
  revealedThreadIds.value = new Set(ids);
  revealedThreadOrder.value = ids;
};

const shouldReveal = (id: string) => {
  if (revealedThreadIds.value.has(id)) return false;
  if (id === activeLocalMessageId) return true;
  if (entranceBootstrapping) return false;
  if (historyThreadIds.value.has(id)) return true;
  const item = threadStream.value.find((entry) => entry.id === id);
  if (!item) return false;
  return itemIsLive(item) || !activeStartedAt || timestampOf(item.ts) < activeStartedAt;
};

const pumpEntrance = () => {
  if (entranceRevealTimer || entranceScheduling) return;
  entranceScheduling = true;
  entranceRevealTimer = setInterval(() => {
    const nextId = entranceQueue.find((id) => shouldReveal(id));
    if (!nextId) {
      if (entranceRevealTimer) clearInterval(entranceRevealTimer);
      entranceRevealTimer = null;
      entranceScheduling = false;
      return;
    }
    entranceQueue = entranceQueue.filter((id) => id !== nextId);
    if (!revealedThreadIds.value.has(nextId)) {
      revealedThreadIds.value.add(nextId);
      revealedThreadOrder.value.push(nextId);
      animatedThreadIds.value.add(nextId);
    }
    scrollToBottom();
  }, 90);
};

const scheduleEntrance = () => {
  if (!entranceSeeded) return;
  const candidates = threadStream.value.filter((item) => shouldReveal(item.id)).map((item) => item.id);
  entranceQueue = [
    ...entranceQueue,
    ...candidates,
  ];
  if (candidates.length) pumpEntrance();
};

watch(replies, () => {
  if (!activeTurnId || !activeStartedAt) return;
  for (const item of replies.value) {
    if (
      (item.turnId && item.turnId === activeTurnId) ||
      timestampOf(item.ts) >= activeStartedAt
    ) activeLiveIds.add(item.id);
  }
});

watch(threadStream, (items) => {
  if (activeStartedAt) {
    for (const item of items) {
      if (itemIsLive(item)) activeLiveIds.add(item.id);
    }
  }
  scheduleEntrance();
});

watch(
  () => [
    visibleThreadStream.value.length,
    visibleThreadStream.value[visibleThreadStream.value.length - 1]?.id || "",
  ],
  () => {
    if (scrollFramePending) return;
    scrollFramePending = true;
    nextTick(() => {
      scrollFramePending = false;
      scrollToBottom();
    });
  },
  { flush: "post" },
);

const modelIndex = computed(() => Math.max(0, models.value.indexOf(model.value)));
const markdownBlocks = (body: string) => parseMarkdown(body);
const messageImagePath = (item: ChatMessage) => {
  if (item.imagePath) return item.imagePath;
  if (item.imageLocalUrl) return "";
  const match = item.body.match(/\[用户上传图片：([^\]]+)\]/);
  return match?.[1] || "";
};
const messageImageSrc = (item: ChatMessage) => {
  const path = messageImagePath(item);
  if (item.imageLocalUrl) return item.imageLocalUrl;
  if (!path || !agent.previewInfo) return "";
  try {
    return agent.getPreviewUrl(path);
  } catch {
    return "";
  }
};
const displayMessageBody = (item: ChatMessage) => item.body
  .replace(/\n*\[用户上传图片：[^\]]+\]/g, "")
  .trim();
const fileReferences = (body: string): FileReference[] => {
  const projectRoot = String(agent.selectedProject?.normalized_path || "").replace(/\\/g, "/").replace(/\/$/, "");
  const found = new Map<string, FileReference>();
  const add = (raw: string, label = "") => {
    let path = raw.trim().replace(/[),.;:`]+$/g, "").replace(/\\/g, "/");
    if (projectRoot && path.toLowerCase().startsWith(`${projectRoot.toLowerCase()}/`)) {
      path = path.slice(projectRoot.length + 1);
    }
    if (path.includes("://") || path.startsWith("/") || /^[A-Za-z]:\//.test(path) || path.includes("..")) return;
    if (!/\.(?:py|ts|tsx|js|jsx|vue|md|json|css|scss|yaml|yml|txt|sql|go|rs|java|cpp|c|h|sh|png|jpe?g|gif|webp|bmp)$/i.test(path)) return;
    found.set(path, { path, label: label || path.split("/").pop() || path });
  };
  const markdownLink = /\[([^\]]+)\]\(([^)]+)\)/g;
  let match: RegExpExecArray | null;
  while ((match = markdownLink.exec(body))) add(match[2], match[1]);
  for (const token of body.match(/(?:^|[\s(])(?:[\w.-]+\/)*[\w.-]+\.(?:py|ts|tsx|js|jsx|vue|md|json|css|scss|yaml|yml|txt|sql|go|rs|java|cpp|c|h|sh)\b/gi) || []) {
    add(token.trim());
  }
  return [...found.values()].slice(0, 8);
};

const webReferences = (body: string): WebReference[] => {
  const found = new Map<string, WebReference>();
  const add = (path: string) => {
    const normalized = path.trim().replace(/[),.;:!?`]+$/, "").replace(/\\/g, "/");
    if (!normalized || normalized.startsWith("/") || normalized.includes("..")) return;
    if (!/\.html?$/i.test(normalized)) return;
    found.set(normalized, {
      kind: "web",
      path: normalized,
      label: normalized.split("/").pop() || "网页预览",
    });
  };
  const pattern = /(?:https?:\/\/)(?:localhost|127(?:\.\d{1,3}){3}|10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2})(?::\d+)?\/([^\s<>"`]*)/gi;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(body))) {
    let path = decodeURIComponent(match[1].replace(/[),.;:!?]+$/, ""))
      .replace(/[),.;:!?]+$/, "")
      .split("#")[0]
      .replace(/\\/g, "/")
      .replace(/^\/+/, "");
    path = path.split("?")[0];
    if (!path) path = "index.html";
    if (path.includes("..")) continue;
    add(path);
  }
  const bareBody = body.replace(/https?:\/\/[^\s<>`"']+/gi, " ");
  for (const token of bareBody.match(/(?:[\w.-]+\/)*[\w.-]+\.html?\b/gi) || []) add(token);
  return [...found.values()].slice(0, 4);
};

const messageReferences = (body: string): MessageReference[] => [
  ...webReferences(body),
  ...fileReferences(body),
].slice(0, 8);

const connectionText = computed(() => {
  if (state.value === "online") return "通道正常";
  if (state.value === "connecting" || state.value === "pairing") return "连接中";
  return "离线";
});

const connectionTone = computed(() => (
  state.value === "online" ? "ok" : state.value === "offline" ? "off" : "mid"
));

const notice = (text: string, tone: "info" | "error" = "info") => {
  const item = { id: Date.now() + Math.random(), text, tone };
  notices.value = [item];
  setTimeout(() => {
    if (!pageActive.value) return;
    notices.value = notices.value.filter((entry) => entry.id !== item.id);
  }, 2200);
};

const padTime = (value: number) => String(value).padStart(2, "0");

const formatTime = (value: string) => {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "--:--" : `${padTime(date.getHours())}:${padTime(date.getMinutes())}`;
};

const timestampOf = (value: string) => {
  const time = Date.parse(value);
  return Number.isNaN(time) ? Number.POSITIVE_INFINITY : time;
};

const timelineTerminalStatus = (item: TimelineItem): "completed" | "interrupted" | "failed" | "running" => {
  if (item.kind === "codex.event") {
    if (item.type === "turn.completed") return "completed";
    if (item.type === "turn.interrupted") return "interrupted";
    if (item.type === "turn.failed") return "failed";
    return "running";
  }
  if (item.kind !== "agent.event" || item.type !== "turn.status") return "running";
  if (item.title.includes("已完成")) return "completed";
  if (item.title.includes("已中断")) return "interrupted";
  if (item.title.includes("失败")) return "failed";
  return "running";
};

const restoreQueuedPrompt = (item: { id: string; text: string; ts: string }) => {
  if (queuedPrompts.value.some((entry) => entry.id === item.id)) return;
  queuedPrompts.value = [item, ...queuedPrompts.value];
};

const dispatchQueuedPrompt = (delay: number) => {
  const nextQueued = queuedPrompts.value.shift();
  if (!nextQueued) return;
  const dispatchToken = ++queuedDispatchToken;
  queuedDispatchItem = nextQueued;
  if (queuedDispatchTimer) clearTimeout(queuedDispatchTimer);
  queuedDispatchTimer = setTimeout(() => {
    queuedDispatchTimer = null;
    if (dispatchToken !== queuedDispatchToken) return;
    queuedDispatchItem = null;
    if (!nextQueued.text.trim() || thinking.value) {
      restoreQueuedPrompt(nextQueued);
      return;
    }
    prompt.value = nextQueued.text;
    void send().then((sent) => {
      if (sent) return;
      restoreQueuedPrompt(nextQueued);
      notice("追加提示词发送失败，已恢复排队", "error");
    });
  }, delay);
};

const scrollToBottom = () => {
  nextTick(() => {
    if (!pageActive.value) return;
    scrollNonce += 1;
    scrollIntoView.value = `chat-bottom-${scrollNonce}`;
    if (scrollRetryTimer) clearTimeout(scrollRetryTimer);
    scrollRetryTimer = setTimeout(() => {
      scrollRetryTimer = null;
      if (!pageActive.value) return;
      scrollNonce += 1;
      scrollIntoView.value = `chat-bottom-${scrollNonce}`;
    }, 140);
  });
};

let historyRefreshTimer: ReturnType<typeof setTimeout> | null = null;
const scheduleHistoryRefresh = (delay = 800) => {
  if (!pageActive.value) return;
  if (historyRefreshTimer) clearTimeout(historyRefreshTimer);
  historyRefreshTimer = setTimeout(() => {
    historyRefreshTimer = null;
    loadHistory();
  }, delay);
};

const syncConversation = (items: TimelineItem[]) => {
  const ordered = [...items].reverse();
  replies.value = ordered;
  const previousStatuses = new Map(
    sentTurns.value.map((turn) => [turn.turnId, turn.status]),
  );
  const nextTurns = sentTurns.value.map((turn) => {
    if (!turn.turnId || turn.status !== "running") return turn;
    const status = ordered.find((item) => (
      item.kind === "agent.event" &&
      item.type === "turn.status" &&
      item.turnId === turn.turnId
    ));
    const failure = ordered.find((item) => (
      item.kind === "codex.event" &&
      (item.type === "turn.failed" || item.type === "turn.interrupted") &&
      item.turnId === turn.turnId
    ));
    if (!status && !failure) return turn;
    const source = status || failure;
    const stateText = status
      ? status.title
      : source!.type === "turn.failed" ? "任务失败" : "任务已中断";
    const nextStatus = stateText.includes("已完成")
      ? "completed" as const
      : stateText.includes("失败")
        ? "failed" as const
        : stateText.includes("已中断")
          ? "interrupted" as const
          : "running" as const;
    if (nextStatus === "running") return turn;
    return { ...turn, status: nextStatus };
  });
  sentTurns.value = nextTurns;
  publishPendingTurns();
  const terminalTurn = ordered.find((item) => {
    const status = timelineTerminalStatus(item);
    if (status === "running" || !item.turnId) return false;
    const previousStatus = previousStatuses.get(item.turnId);
    if (previousStatus !== "running") {
      const wasManualInterrupt = previousStatus === "interrupted" && manualInterruptRequested.value;
      const wasCompletedAfterStop = previousStatus === "interrupted" && status === "completed";
      if (!wasManualInterrupt && !wasCompletedAfterStop) return false;
    }
    return sentTurns.value.some((turn) => turn.turnId === item.turnId);
  });
  const latestTerminalTurn = [...ordered].reverse().find((item) => timelineTerminalStatus(item) !== "running");
  const manualInterruptTurn = (
    manualInterruptRequested.value &&
    latestTerminalTurn &&
    timelineTerminalStatus(latestTerminalTurn) === "interrupted" &&
    Number(latestTerminalTurn.seq || 0) > manualInterruptBaseSeq
  ) || undefined;
  if (terminalTurn || manualInterruptTurn) {
    scheduleHistoryRefresh();
    const status = terminalTurn ? timelineTerminalStatus(terminalTurn) : "interrupted";
    const manualStopFailed = manualInterruptRequested.value && status === "failed";
    if (status === "interrupted" || manualStopFailed) {
      manualInterruptRequested.value = false;
      manualInterruptBaseSeq = 0;
      continueAvailable.value = true;
      if (queuedPrompts.value.length) dispatchQueuedPrompt(180);
    } else {
      continueAvailable.value = false;
      manualInterruptRequested.value = false;
      manualInterruptBaseSeq = 0;
      if (status === "completed" && queuedPrompts.value.length) dispatchQueuedPrompt(90);
    }
  }
  scrollToBottom();
};

const loadHistory = async () => {
  const requestId = ++historyRequestId;
  const project = agent.selectedProject;
  currentProjectId = project?.id || "";
  currentSessionId = project?.current_session_id || "";
  currentThreadId = project?.codex_thread_id || "";
  if (agent.state !== "online" || !project) {
    historyMessages.value = [];
    if (!project) sentTurns.value = [];
    return;
  }
  try {
    const result = await agent.loadCodexHistory(project, 100);
    if (
      requestId !== historyRequestId ||
      agent.selectedProject?.id !== project.id ||
      currentProjectId !== project.id ||
      currentSessionId !== (project.current_session_id || "") ||
      currentThreadId !== (project.codex_thread_id || "")
    ) return;
    const messages = result.messages
      .map((item: any) => ({
        ...item,
        body: messageBody(item),
      }))
      .filter((item) => item.body.trim());
    historyMessages.value = messages;
    historyThreadIds.value = new Set(messages.map((item) => String(item.id)));
    if (activeStartedAt) {
      for (const item of messages) {
        if (timestampOf(String(item.ts || "")) >= activeStartedAt) {
          activeLiveIds.add(String(item.id));
        }
      }
    }

    const userMessages = messages.filter((item: any) => item.role === "user");
    sentTurns.value = sentTurns.value
      .map((turn) => {
        if (turn.confirmed) return turn;
        const index = userMessages.findIndex((item: any) => (
          normalizedBody(item.body) === normalizedBody(turn.text) &&
          timestampOf(item.ts) >= turn.startedAt - 15000
        ));
        if (index < 0) return turn;
        userMessages.splice(index, 1);
        return { ...turn, confirmed: true };
      })
      .filter((turn) => !(turn.confirmed && turn.status !== "running"));
    publishPendingTurns();
    scrollToBottom();
  } catch {
    if (
      requestId === historyRequestId &&
      agent.selectedProject?.id === project.id &&
      currentProjectId === project.id &&
      currentSessionId === (project.current_session_id || "") &&
      currentThreadId === (project.codex_thread_id || "")
    ) {
      historyMessages.value = [];
    }
  }
};

const modelLabel = (value: string) => (value === "default" ? "跟随 Codex" : value);

const sessionLabel = (thread: CodexThreadSummary) => {
  const title = String(thread.title || "").trim();
  if (title) return title;
  const date = new Date(thread.updated_at);
  if (Number.isNaN(date.getTime())) return "会话";
  return `会话 · ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
};

const sessionDetail = (thread: CodexThreadSummary) => {
  const date = new Date(thread.updated_at);
  const time = Number.isNaN(date.getTime()) ? "时间未知" : `${date.getMonth() + 1}月${date.getDate()}日 ${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
  return `${time} · ${thread.model || "跟随 Codex"} · ${thread.reasoning_effort || "default"}`;
};
const runningTurnSignature = computed(() => agent.runningTurnSignature());
watch(runningTurnSignature, () => {
  if (!pageActive.value || sessionMenuOpen.value || sessionSheet.value !== "sessions") return;
  refreshSessionRunningState();
}, { flush: "sync" });
const refreshSessionRunningState = async () => {
  const project = agent.selectedProject;
  if (!project || agent.state !== "online") return;
  try {
    const snapshot = await agent.listThreads(project);
    threadList.value = snapshot.sessions;
    archivedThreadList.value = snapshot.archived_sessions || [];
    threadIsNew.value = snapshot.is_new_thread;
  } catch {
    // Keep the previous list; running state also refreshes when the sheet reopens.
  }
};

const sessionMenuOpen = ref(false);
const sessionSheet = ref<"none" | "status" | "goal" | "reasoning" | "sessions" | "mcp" | "fork" | "side">("none");
const sessionBusy = ref(false);
const sessionStatus = ref<CodexThreadStatus | null>(null);
const goalDraft = ref("");
const threadList = ref<CodexThreadSummary[]>([]);
const archivedThreadList = ref<CodexThreadSummary[]>([]);
const threadIsNew = ref(false);
const mcpServers = ref<McpServer[]>([]);
const forkPrompt = ref("");
const sidePrompt = ref("");
const reasoningOptions = ["default", "minimal", "low", "medium", "high", "xhigh"];
const sessionStatusLabel = computed(() => {
  const status = sessionStatus.value;
  if (!status?.available) return "暂无会话";
  return sessionLabel({
    session_id: agent.selectedProject?.current_session_id || "",
    thread_id: status.thread_id || "",
    current: true,
    title: status.title || agent.selectedProject?.session_title || "",
    model: status.model || "default",
    reasoning_effort: status.reasoning_effort || "default",
    updated_at: status.updated_at || "",
  });
});
const commandItems = [
  { id: "new", icon: "+", label: "新聊天", detail: "开启一个空会话" },
  { id: "sessions", icon: "≡", label: "会话", detail: "切换或恢复历史会话" },
  { id: "status", icon: "%", label: "状态", detail: "上下文与用量" },
  { id: "fork", icon: "⑂", label: "分支", detail: "从当前会话分叉" },
  { id: "side", icon: "›", label: "侧聊", detail: "临时会话不落盘" },
  { id: "compress", icon: "↓", label: "压缩", detail: "生成上下文摘要" },
  { id: "reasoning", icon: "◆", label: "推理", detail: "思考强度" },
  { id: "goal", icon: "◎", label: "目标", detail: "设置当前目标" },
  { id: "mcp", icon: "M", label: "MCP", detail: "服务器状态" },
  { id: "archive", icon: "▣", label: "归档", detail: "归档当前会话" },
  { id: "remove-project", icon: "×", label: "移除项目", detail: "仅移出远程列表" },
];
const slashOpen = ref(false);
const followupGuides = [
  { label: "继续", prompt: "继续完成当前任务。" },
  { label: "先定位", prompt: "先复现并定位最小原因，确认后再继续修改。" },
  { label: "解释方案", prompt: "先说明当前判断、修改方案和影响范围，再继续执行。" },
  { label: "补检查", prompt: "完成后运行相关检查，只报告仍然失败的问题。" },
  { label: "收敛改动", prompt: "停止扩展改动，只保留完成当前目标所需的最小修改。" },
  { label: "总结", prompt: "停止继续执行，总结已完成内容、验证结果和剩余风险。" },
];

watch(sessionMenuOpen, (open) => {
  if (!open) sessionSheet.value = "none";
});

const closeSessionMenu = () => {
  sessionMenuOpen.value = false;
  sessionSheet.value = "none";
};

const toggleCommandMenu = () => {
  slashOpen.value = false;
  sessionMenuOpen.value = !sessionMenuOpen.value;
  if (sessionMenuOpen.value) refreshThreadStatus();
};

const sessionStatusLine = computed(() => {
  if (!sessionStatus.value) return "未读取";
  if (!sessionStatus.value.available) return "暂无 Codex 会话";
  const percent = sessionStatus.value.context_percent;
  const effort = sessionStatus.value.reasoning_effort || "default";
  return `${percent === null || percent === undefined ? "上下文未知" : `上下文 ${percent}%`} · ${effort}`;
});

const formatTokens = (value?: number | null) => {
  if (!value && value !== 0) return "未知";
  if (value >= 1000000) return `${(value / 1000000).toFixed(1)}M`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)}K`;
  return String(value);
};

const contextPercent = (value?: number | null, fallback = "未知") => (
  value === null || value === undefined ? fallback : String(value)
);

const refreshThreadStatus = async () => {
  const project = agent.selectedProject;
  if (!project || agent.state !== "online") return;
  try {
    sessionStatus.value = await agent.loadThreadStatus(project);
  } catch {
    sessionStatus.value = { available: false };
  }
};

const runCommand = async (id: string) => {
  const project = agent.selectedProject;
  if (!project) {
    notice("请先选择项目", "error");
    return;
  }
  if (agent.state !== "online") {
    notice("请先连接 PC Agent", "error");
    return;
  }
  if (id === "new") {
    sessionBusy.value = true;
    try {
      await agent.newThread(project);
      resetConversationView();
      notice("已开启新聊天");
      closeSessionMenu();
    } catch (error: any) {
      notice(error?.message || "新聊天失败", "error");
    } finally {
      sessionBusy.value = false;
    }
    return;
  }
  if (id === "archive") {
    uni.showModal({
      title: "归档当前会话？",
      content: "项目会保留，并自动开启一个新的空会话。",
      success: async (result) => {
        if (!result.confirm) return;
        sessionBusy.value = true;
        try {
          await agent.archiveThread();
          notice("已归档");
          closeSessionMenu();
        } catch (error: any) {
          notice(error?.message || "归档失败", "error");
        } finally {
          sessionBusy.value = false;
        }
      },
    });
    return;
  }
  if (id === "remove-project") {
    uni.showModal({
      title: "移除项目？",
      content: `${project.name} 将从远程项目列表移除，本地目录和 Codex 历史记录保留。`,
      confirmText: "移除",
      confirmColor: "#e11d48",
      success: async (result) => {
        if (!result.confirm) return;
        sessionBusy.value = true;
        try {
          await agent.deleteProject(project);
          closeSessionMenu();
          notice("项目已移除，本地文件未删除");
          uni.switchTab({ url: "/pages/projects/projects" });
        } catch (error: any) {
          notice(error?.message || "项目移除失败", "error");
        } finally {
          sessionBusy.value = false;
        }
      },
    });
    return;
  }
  if (id === "compress") {
    sessionBusy.value = true;
    try {
      await agent.compressThread();
      notice("压缩任务已启动");
      closeSessionMenu();
    } catch (error: any) {
      notice(error?.message || "压缩失败", "error");
    } finally {
      sessionBusy.value = false;
    }
    return;
  }
  if (id === "status") {
    sessionSheet.value = "status";
    await refreshThreadStatus();
    return;
  }
  if (id === "goal") {
    goalDraft.value = project.goal || "";
    sessionSheet.value = "goal";
    return;
  }
  if (id === "reasoning") {
    sessionSheet.value = "reasoning";
    return;
  }
  if (id === "fork" || id === "side") {
    if (id === "fork") forkPrompt.value = "";
    if (id === "side") sidePrompt.value = "";
    sessionSheet.value = id as "fork" | "side";
    return;
  }
  sessionBusy.value = true;
  try {
    if (id === "sessions") {
      const snapshot = await agent.listThreads(project);
      threadList.value = snapshot.sessions;
      archivedThreadList.value = snapshot.archived_sessions || [];
      threadIsNew.value = snapshot.is_new_thread;
      sessionSheet.value = "sessions";
    } else if (id === "mcp") {
      const result = await agent.listMcpServers();
      mcpServers.value = result.servers;
      if (!result.available) notice(result.detail || "MCP 不可用", "error");
      sessionSheet.value = "mcp";
    }
  } catch (error: any) {
    notice(error?.message || "读取失败", "error");
  } finally {
    sessionBusy.value = false;
  }
};

const slashQuery = computed(() => {
  const text = prompt.value.trimStart();
  return text.startsWith("/") ? text.slice(1).trim().toLowerCase() : "";
});

const slashItems = computed(() => {
  const query = slashQuery.value;
  if (!query) return commandItems;
  return commandItems.filter((item) => (
    item.label.toLowerCase().includes(query) ||
    item.detail.toLowerCase().includes(query) ||
    item.id.toLowerCase().includes(query)
  ));
});

watch(prompt, (value) => {
  slashOpen.value = value.trimStart().startsWith("/");
});

const chooseSlashCommand = async (id: string) => {
  slashOpen.value = false;
  prompt.value = "";
  sessionMenuOpen.value = true;
  await runCommand(id);
};

const closeSlashMenu = () => {
  slashOpen.value = false;
};

const chooseFollowupGuide = (text: string) => {
  prompt.value = prompt.value.trim() ? `${prompt.value.trim()}\n\n${text}` : text;
};

const saveGoal = async () => {
  const project = agent.selectedProject;
  if (!project || !goalDraft.value.trim()) return;
  sessionBusy.value = true;
  try {
    await agent.setProjectGoal(project, goalDraft.value.trim());
    notice("目标已保存");
    closeSessionMenu();
  } catch (error: any) {
    notice(error?.message || "目标保存失败", "error");
  } finally {
    sessionBusy.value = false;
  }
};

const chooseReasoning = async (effort: string) => {
  const project = agent.selectedProject;
  if (!project) return;
  sessionBusy.value = true;
  try {
    await agent.setProjectReasoning(project, effort);
    await refreshThreadStatus();
    if (sessionStatus.value) {
      sessionStatus.value = { ...sessionStatus.value, reasoning_effort: effort };
    }
    notice(`推理：${effort}`);
    closeSessionMenu();
  } catch (error: any) {
    notice(error?.message || "推理设置失败", "error");
  } finally {
    sessionBusy.value = false;
  }
};

const chooseThread = async (sessionOrThreadId: string) => {
  const project = agent.selectedProject;
  if (!project) return;
  sessionBusy.value = true;
  resetConversationView();
  try {
    await agent.selectThread(project, sessionOrThreadId);
    await loadHistory();
    entranceSeeded = true;
    notice("会话已切换");
    closeSessionMenu();
  } catch (error: any) {
    notice(error?.message || "会话切换失败", "error");
  } finally {
    sessionBusy.value = false;
  }
};

const deleteThread = (thread: CodexThreadSummary) => {
  const project = agent.selectedProject;
  if (!project || sessionBusy.value) return;
  uni.showModal({
    title: "删除会话？",
    content: `${sessionLabel(thread)} 将从远程列表移除，PC 原始 Codex 记录保留。`,
    confirmText: "删除",
    confirmColor: "#e11d48",
    success: async (result) => {
      if (!result.confirm) return;
      sessionBusy.value = true;
      try {
        await agent.deleteThread(project, thread.session_id || thread.thread_id || "");
        threadList.value = threadList.value.filter((item) => item.session_id !== thread.session_id);
        archivedThreadList.value = archivedThreadList.value.filter(
          (item) => item.session_id !== thread.session_id,
        );
        notice("会话已删除");
        closeSessionMenu();
      } catch (error: any) {
        notice(error?.message || "会话删除失败", "error");
      } finally {
        sessionBusy.value = false;
      }
    },
  });
};

const startThreadFromList = async () => {
  const project = agent.selectedProject;
  if (!project || sessionBusy.value) return;
  sessionBusy.value = true;
  try {
    await agent.newThread(project);
    resetConversationView();
    notice("已开启新聊天");
    closeSessionMenu();
  } catch (error: any) {
    notice(error?.message || "新聊天失败", "error");
  } finally {
    sessionBusy.value = false;
  }
};

const startFork = async () => {
  const text = forkPrompt.value.trim();
  if (!text) return;
  sessionBusy.value = true;
  try {
    await agent.forkThread(text, false);
    notice("分支任务已启动");
    closeSessionMenu();
  } catch (error: any) {
    notice(error?.message || "分支失败", "error");
  } finally {
    sessionBusy.value = false;
  }
};

const startSide = async () => {
  const text = sidePrompt.value.trim();
  if (!text) return;
  sessionBusy.value = true;
  try {
    await agent.forkThread(text, true);
    notice("侧聊任务已启动");
    closeSessionMenu();
  } catch (error: any) {
    notice(error?.message || "侧聊失败", "error");
  } finally {
    sessionBusy.value = false;
  }
};

const changeModel = async (event: any) => {
  const next = models.value[Number(event.detail.value)] || model.value;
  if (next === model.value || !agent.selectedProject) return;
  const previous = model.value;
  model.value = next;
  if (agent.state !== "online") return;
  try {
    const selected = await agent.setProjectModel(agent.selectedProject, next);
    model.value = selected.model || next;
    notice(`模型：${modelLabel(model.value)}`);
  } catch (error: any) {
    model.value = previous;
    notice(error?.message || "模型切换失败", "error");
  }
};

const send = async () => {
  if (slashOpen.value) {
    slashOpen.value = false;
    notice("请选择命令，或删除 / 后发送普通消息", "error");
    return;
  }
  const text = prompt.value.trim();
  const image = selectedImage.value;
  if (!text && !image) {
    notice("请输入内容或选择图片", "error");
    return;
  }
  if (!agent.selectedProject) {
    notice("请先选择项目", "error");
    return;
  }
  if (thinking.value) {
    if (image) {
      notice("执行中暂不能排队图片，请先停止任务", "error");
      return;
    }
    queuedPrompts.value = [
      ...queuedPrompts.value,
      {
        id: `queued_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`,
        text,
        ts: new Date().toISOString(),
      },
    ];
    prompt.value = "";
    activeLocalMessageId = queuedPrompts.value[queuedPrompts.value.length - 1].id;
    notice(`已追加提示词，任务完成后自动发送（排队 ${queuedPrompts.value.length} 条）`);
    return;
  }

  const localId = `msg_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const project = agent.selectedProject;
  let imagePath = "";
  if (image) uploadingImage.value = true;
  sentTurns.value = [...sentTurns.value, {
    id: localId,
    turnId: "",
    text,
    imagePath,
    imageLocalUrl: image?.localUrl || "",
    ts: new Date().toISOString(),
    startedAt: Date.now(),
    status: "running",
    confirmed: false,
    projectId: project.id,
    sessionId: project.current_session_id || null,
    threadId: project.codex_thread_id || null,
  }];
  publishPendingTurns();
  prompt.value = "";
  running.value = true;
  continueAvailable.value = false;
  clearEntranceTimers();
  entranceQueue = [];
  entranceBootstrapping = true;
  activeLocalMessageId = localId;
  activeTurnId = "";
  activeStartedAt = Date.now();
  activeLiveIds = new Set();
  scrollToBottom();

  try {
    if (image) {
      imageUploadPercent.value = 0;
      const extension = image.name.split(".").pop()?.toLowerCase() || "jpg";
      imagePath = `remote-uploads/image-${Date.now()}.${extension}`;
      await agent.uploadFile(
        image,
        imagePath,
        false,
        () => undefined,
        (progress) => {
          imageUploadPercent.value = progress.total
            ? Math.min(100, Math.round(progress.received / progress.total * 100))
            : 100;
        },
        () => false,
      );
      sentTurns.value = sentTurns.value.map((item) => (
        item.id === localId ? { ...item, imagePath } : item
      ));
      publishPendingTurns();
    }
    const finalPrompt = imagePath ? `${text}\n\n[用户上传图片：${imagePath}]`.trim() : text;
    if (!finalPrompt.trim()) throw new Error("请输入内容");
    const started = await agent.startTurn(finalPrompt, sandbox.value, project);
    const isStillOrigin = (
      agent.selectedProject?.id === project.id &&
      (
        project.current_session_id
          ? (agent.selectedProject.current_session_id || "") === project.current_session_id
          : (
            !(agent.selectedProject.current_session_id) ||
            agent.selectedProject.current_session_id === started.sessionId
          )
      )
    );
    const startedSessionId = started.sessionId || project.current_session_id || null;
    agent.attachPendingTurn(localId, {
      turnId: started.turnId,
      sessionId: startedSessionId,
      threadId: started.threadId,
    });
    if (
      !agent.selectedProject ||
      agent.selectedProject.id !== project.id ||
      !isStillOrigin
    ) {
      throw new Error("发送期间会话已切换，请回原会话查看任务");
    }
    if (!started.turnId) throw new Error("服务未返回任务编号");
    sentTurns.value = sentTurns.value.map((item) => (
      item.id === localId
        ? {
            ...item,
            turnId: started.turnId,
            text: finalPrompt,
            sessionId: startedSessionId || item.sessionId,
            threadId: started.threadId || agent.selectedProject?.codex_thread_id || item.threadId,
          }
        : item
    ));
    publishPendingTurns();
    activeTurnId = started.turnId;
    entranceBootstrapTimer = setTimeout(() => {
      entranceBootstrapTimer = null;
      entranceBootstrapping = false;
      scheduleEntrance();
    }, 260);
    selectedImage.value = null;
    imageUploadPercent.value = 0;
    notice("已发送");
    return true;
  } catch (error: any) {
    const message = String(error?.message || "发送失败");
    const globalTurn = agent.pendingTurns.find((item) => item.id === localId);
    const turnWasStarted = Boolean(globalTurn?.turnId);
    const stillOnOrigin = (
      agent.selectedProject?.id === project.id &&
      (
        project.current_session_id
          ? (agent.selectedProject.current_session_id || "") === project.current_session_id
          : (
            !(agent.selectedProject.current_session_id) ||
            agent.selectedProject.current_session_id === startedSessionId
          )
      )
    );
    const turnMovedToAnotherSession = turnWasStarted && !stillOnOrigin;
    if (turnMovedToAnotherSession) {
      running.value = false;
      uploadingImage.value = false;
      entranceBootstrapping = false;
      if (entranceBootstrapTimer) {
        clearTimeout(entranceBootstrapTimer);
        entranceBootstrapTimer = null;
      }
      return false;
    }
    sentTurns.value = turnWasStarted
      ? sentTurns.value.map((item) => (
        item.id === localId ? { ...item, status: "failed" as const } : item
      ))
      : sentTurns.value.filter((item) => item.id !== localId);
    if (!turnWasStarted) agent.removePendingTurn(localId);
    sendErrors.value = [{
      id: `send-error-${Date.now()}`,
      title: "发送失败",
      detail: message,
      output: message,
      ts: new Date().toISOString(),
    }, ...sendErrors.value].slice(0, 20);
    prompt.value = text;
    selectedImage.value = image || null;
    notice(error?.message || "发送失败", "error");
    scrollToBottom();
    return false;
  } finally {
    running.value = false;
    uploadingImage.value = false;
    if (!sentTurns.value.some((item) => item.id === localId && item.turnId)) {
      entranceBootstrapping = false;
      if (entranceBootstrapTimer) {
        clearTimeout(entranceBootstrapTimer);
        entranceBootstrapTimer = null;
      }
    }
  }
};

const interrupt = async () => {
  const hadRunning = sentTurns.value.some((item) => item.status === "running");
  manualInterruptRequested.value = true;
  manualInterruptBaseSeq = Math.max(0, ...replies.value
    .filter((item) => timelineTerminalStatus(item) !== "running")
    .map((item) => Number(item.seq || 0)));
  continueAvailable.value = false;
  sentTurns.value = sentTurns.value.map((item) => (
    item.status === "running" ? { ...item, status: "interrupted" } : item
  ));
  publishPendingTurns();
  try {
    await agent.interruptTurn();
    notice("正在暂停任务");
  } catch (error: any) {
    manualInterruptRequested.value = false;
    manualInterruptBaseSeq = 0;
    if (!hadRunning) notice(error?.message || "当前没有运行中任务", "error");
  }
};

const continueTurn = async () => {
  if (thinking.value || running.value) return;
  continueAvailable.value = false;
  prompt.value = "继续";
  const sent = await send();
  if (!sent) continueAvailable.value = true;
};

const startEditMessage = (message: ChatMessage) => {
  if (thinking.value) {
    notice("当前任务运行中，可先停止或排队新消息", "error");
    return;
  }
  editingTurnId.value = message.id;
  editDraft.value = normalizedBody(message.body);
};

const cancelEditTurn = () => {
  editingTurnId.value = "";
  editDraft.value = "";
};

const cancelQueuedPrompt = (id?: string) => {
  if (!id || queuedDispatchItem?.id === id) {
    queuedDispatchToken += 1;
    queuedDispatchItem = null;
    if (queuedDispatchTimer) {
      clearTimeout(queuedDispatchTimer);
      queuedDispatchTimer = null;
    }
  }
  queuedPrompts.value = id
    ? queuedPrompts.value.filter((item) => item.id !== id)
    : [];
  if (!queuedPrompts.value.some((item) => item.id === activeLocalMessageId)) {
    activeLocalMessageId = "";
  }
  notice(id ? "已取消追加提示词" : "已取消全部追加提示词");
};

const submitComposer = () => {
  if (thinking.value && !prompt.value.trim() && !selectedImage.value) {
    interrupt();
    return;
  }
  if (continueAvailable.value && !thinking.value && !prompt.value.trim() && !selectedImage.value) {
    void continueTurn();
    return;
  }
  send();
};

const submitEditTurn = async () => {
  const text = editDraft.value.trim();
  if (!text) return;
  const originalMessageId = editingTurnId.value;
  editingTurnId.value = "";
  editDraft.value = "";
  const restoredPrompt = prompt.value;
  const restoredImage = selectedImage.value;
  const hiddenIds = new Set(hiddenEditedMessageIds.value);
  hiddenIds.add(originalMessageId);
  hiddenEditedMessageIds.value = hiddenIds;
  prompt.value = text;
  selectedImage.value = null;
  const ok = await send();
  if (!ok) {
    const restoredHiddenIds = new Set(hiddenEditedMessageIds.value);
    restoredHiddenIds.delete(originalMessageId);
    hiddenEditedMessageIds.value = restoredHiddenIds;
  }
  prompt.value = ok ? restoredPrompt : prompt.value;
  selectedImage.value = ok ? restoredImage : selectedImage.value;
};

const openFiles = () => {
  uni.navigateTo({ url: "/pages/files/files" });
};

const openScreenControl = () => {
  screenActive.value = !screenActive.value;
  if (screenActive.value) resetInlineScreenPosition();
  if (screenActive.value && agent.state === "online") {
    agent.subscribeScreen(screenFps.value, screenQuality.value);
    screenOn.value = true;
    screenInfo.value = "等待画面";
  } else {
    if (agent.state === "online") agent.unsubscribeScreen();
    if (screenFull.value) exitScreenFull();
    screenOn.value = false;
    screenData.value = "";
    screenInfo.value = "PC 屏幕未开启";
  }
};

const handleScreenMessage = (message: any) => {
  if (message.type === "screen.frame") {
    screenData.value = `data:image/jpeg;base64,${message.payload?.data || ""}`;
    const width = Number(message.payload?.width || 0);
    const height = Number(message.payload?.height || 0);
    screenFrameWidth.value = width;
    screenFrameHeight.value = height;
    screenFrameOriginX.value = Number(message.payload?.origin_x || 0);
    screenFrameOriginY.value = Number(message.payload?.origin_y || 0);
    screenFrameRealWidth.value = Number(message.payload?.real_width || 0);
    screenFrameRealHeight.value = Number(message.payload?.real_height || 0);
    screenInfo.value = width && height ? `${width} × ${height}` : "等待画面";
  }
  if (message.type === "error" && message.payload?.code === "screen.unavailable") {
    screenOn.value = false;
    screenData.value = "";
    screenInfo.value = "PC 屏幕采集不可用";
  }
};

const inlineScreenStyle = computed(() => ({
  transform: `translate3d(${inlineScreenPosition.value.x}px, ${inlineScreenPosition.value.y}px, 0)`,
}));

const resetInlineScreenPosition = () => {
  const info = uni.getSystemInfoSync();
  const width = Number(info.windowWidth || 375);
  const height = Number(info.windowHeight || 667);
  const bodyHeight = Math.min(230, Math.max(150, width * 0.31));
  const cardHeight = bodyHeight + 38;
  inlineScreenPosition.value = {
    x: 12,
    y: 84,
  };
};

const clampInlineScreenPosition = () => {
  const info = uni.getSystemInfoSync();
  const width = Number(info.windowWidth || 375);
  const height = Number(info.windowHeight || 667);
  const bodyHeight = Math.min(230, Math.max(150, width * 0.31));
  const cardHeight = bodyHeight + 38;
  inlineScreenPosition.value = {
    x: Math.max(0, Math.min(width - 24, inlineScreenPosition.value.x)),
    y: Math.max(84, Math.min(height - cardHeight - 180, inlineScreenPosition.value.y)),
  };
};

const onInlineScreenStart = (event: any) => {
  const point = event?.touches?.[0] || event?.changedTouches?.[0] || event;
  if (!point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return;
  inlineScreenDragging.value = true;
  inlineScreenStart = {
    x: Number(point.clientX),
    y: Number(point.clientY),
    originX: inlineScreenPosition.value.x,
    originY: inlineScreenPosition.value.y,
    moved: 0,
  };
};

const onInlineScreenMove = (event: any) => {
  const start = inlineScreenStart;
  const point = event?.touches?.[0] || event?.changedTouches?.[0] || event;
  if (!start || !point || !Number.isFinite(point.clientX) || !Number.isFinite(point.clientY)) return;
  inlineScreenPosition.value = {
    x: start.originX + Number(point.clientX) - start.x,
    y: start.originY + Number(point.clientY) - start.y,
  };
  clampInlineScreenPosition();
  start.moved = Math.max(
    start.moved,
    Math.abs(Number(point.clientX) - start.x) + Math.abs(Number(point.clientY) - start.y),
  );
};

const onInlineScreenEnd = () => {
  if (!inlineScreenDragging.value) return;
  inlineScreenDragging.value = false;
  inlineScreenStart = null;
  clampInlineScreenPosition();
};

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

const enterScreenFull = () => {
  if (!screenData.value) return;
  screenFull.value = true;
  screenSettingsOpen.value = false;
  screenControlsCollapsed.value = true;
  screenControlsOpen.value = false;
  screenViewer.reset();
  lockLandscape();
  screenFullLive.value = screenOn.value;
  if (agent.state === "online" && !screenOn.value) {
    agent.subscribeScreen(screenFps.value, screenQuality.value);
    screenOn.value = true;
    screenFullLive.value = true;
  }
  setTimeout(() => {
    if (screenFull.value) void screenViewer.handleViewportChange();
  }, 260);
};

const exitScreenFull = () => {
  screenFull.value = false;
  screenControlsOpen.value = false;
  screenSettingsOpen.value = false;
  unlockOrientation();
  screenFullLive.value = false;
  screenViewer.reset();
};

const handleChatWindowResize = () => {
  if (screenFull.value) void screenViewer.handleViewportChange();
};

const toggleScreenSettings = () => {
  screenSettingsOpen.value = !screenSettingsOpen.value;
};

const toggleScreenControlsPanel = () => {
  screenControlsOpen.value = !screenControlsOpen.value;
  if (screenControlsOpen.value) {
    screenControlsCollapsed.value = false;
  } else {
    screenSettingsOpen.value = false;
    screenControlsCollapsed.value = true;
  }
};

const toggleScreenControls = () => {
  screenControlsCollapsed.value = !screenControlsCollapsed.value;
};

const onScreenFullTouchStart = async (event: any) => {
  await screenViewer.beginGesture(event);
};

const onScreenFullTouchMove = (event: any) => {
  screenViewer.moveGesture(event);
};

const onScreenFullTouchEnd = (event: any) => {
  screenViewer.endGesture(event);
};

const updateChatScreenSettings = (width: number, fps: number) => {
  screenQuality.value = width;
  screenFps.value = fps;
  if (agent.state !== "online" || !screenOn.value) return;
  screenInfo.value = "切换画面设置…";
  agent.subscribeScreen(fps, width);
};

const sendScreenFixedCommand = async (action: any, payload: Record<string, any> = {}) => {
  if (!screenFullLive.value || agent.state !== "online") return;
  try {
    await agent.sendScreenInput({
      action,
      x: screenFrameWidth.value / 2,
      y: screenFrameHeight.value / 2,
      screen_width: screenFrameWidth.value,
      screen_height: screenFrameHeight.value,
      origin_x: screenFrameOriginX.value,
      origin_y: screenFrameOriginY.value,
      real_width: screenFrameRealWidth.value,
      real_height: screenFrameRealHeight.value,
      ...payload,
    });
  } catch (error: any) {
    screenInfo.value = error?.message || "控制指令发送失败";
  }
};

const chatQualityOptions = [
  { width: 720, label: "720" },
  { width: 1080, label: "1080" },
  { width: 1280, label: "1280" },
  { width: 1440, label: "1440" },
  { width: 1920, label: "1920" },
];

const chatFpsOptions = [
  { value: 20, label: "20帧" },
  { value: 30, label: "30帧" },
  { value: 60, label: "60帧" },
];

const onFullscreenButtonStart = (event: any) => {
  const point = event?.touches?.[0] || event?.changedTouches?.[0] || event;
  if (!point) return;
  fullscreenButtonDragging.value = true;
  fullscreenButtonStart = {
    x: Number(point.clientX || 0),
    y: Number(point.clientY || 0),
    moved: 0,
  };
};

const onFullscreenButtonMove = (event: any) => {
  const start = fullscreenButtonStart;
  const point = event?.touches?.[0] || event?.changedTouches?.[0];
  if (!start || !point) return;
  const left = Number(point.clientX || 0) - 38;
  const top = Number(point.clientY || 0) - 18;
  const maxX = Number(uni.getSystemInfoSync().windowWidth || 375) - 92;
  const maxY = Number(uni.getSystemInfoSync().windowHeight || 667) - 64;
  fullscreenButton.value = {
    x: Math.max(-18, Math.min(maxX, left)),
    y: Math.max(8, Math.min(maxY, top)),
  };
  start.moved = Math.max(start.moved, Math.abs(point.clientX - start.x) + Math.abs(point.clientY - start.y));
};

const onFullscreenButtonEnd = () => {
  fullscreenButtonDragging.value = false;
  const moved = fullscreenButtonStart?.moved || 0;
  fullscreenButtonStart = null;
  if (moved < 8) enterScreenFull();
};

const chooseImage = async () => {
  if (uploadingImage.value) return;
  try {
    selectedImage.value = await chooseImageSource();
  } catch (error: any) {
    const message = String(error?.message || "");
    if (!/cancel|cancelIonic|取消/i.test(message)) notice(message || "图片选择失败", "error");
  }
};

const clearImage = () => {
  if (uploadingImage.value) return;
  selectedImage.value = null;
  imageUploadPercent.value = 0;
};

const openPreviewInWebView = () => {
  if (!previewFile.value) return;
  try {
    const url = agent.getPreviewUrl(previewFile.value.path);
    uni.navigateTo({
      url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=${encodeURIComponent(previewFile.value.name)}`,
    });
  } catch (error: any) {
    notice(error?.message || "网页预览不可用", "error");
  }
};

const openWebReference = (path: string) => {
  try {
    const url = agent.getPreviewUrl(path);
    uni.navigateTo({
      url: `/pages/webview/webview?url=${encodeURIComponent(url)}&title=${encodeURIComponent(path.split("/").pop() || "网页预览")}`,
    });
  } catch (error: any) {
    notice(error?.message || "网页预览不可用", "error");
  }
};

const textReferencePattern = /\.(?:py|ts|tsx|js|jsx|vue|md|json|css|scss|html?|xhtml|yaml|yml|txt|sql|go|rs|java|cpp|c|h|sh)$/i;
const canEditReference = (reference: MessageReference) => reference.kind === "web" || textReferencePattern.test(reference.path);

const openEditReference = (path: string) => {
  previewLoading.value = true;
  previewEditing.value = false;
  agent.readFile(path, 768 * 1024)
    .then((result) => {
      previewFile.value = result;
      previewDraft.value = result.content;
      if (result.truncated) {
        notice("文件过大，已打开只读预览", "error");
      } else {
        previewEditing.value = true;
      }
    })
    .catch((error: any) => notice(error?.message || "文件读取失败", "error"))
    .finally(() => {
      previewLoading.value = false;
    });
};

const openFileReference = (path: string) => {
  previewLoading.value = true;
  previewEditing.value = false;
  agent.readFile(path, 768 * 1024)
    .then((result) => {
      previewFile.value = result;
      previewDraft.value = result.content;
    })
    .catch((error: any) => notice(error?.message || "文件读取失败", "error"))
    .finally(() => {
      previewLoading.value = false;
    });
};

const startPreviewEditing = () => {
  if (!previewFile.value || previewFile.value.kind !== "text" || previewFile.value.truncated) return;
  previewDraft.value = previewFile.value.content;
  previewEditing.value = true;
};

const closePreview = () => {
  if (previewDirty.value) {
    uni.showModal({
      title: "放弃修改？",
      content: "未保存的内容会丢失。",
      confirmText: "放弃",
      success: (result) => {
        if (result.confirm) {
          previewEditing.value = false;
          previewFile.value = null;
        }
      },
    });
    return;
  }
  previewEditing.value = false;
  previewFile.value = null;
};

const savePreview = async () => {
  if (!previewFile.value || previewFile.value.kind !== "text" || previewSaving.value) return;
  previewSaving.value = true;
  try {
    await agent.writeFile(previewFile.value.path, previewDraft.value);
    const refreshed = await agent.readFile(previewFile.value.path, 768 * 1024);
    previewFile.value = refreshed;
    previewDraft.value = refreshed.content;
    previewEditing.value = false;
    notice("文件已保存");
  } catch (error: any) {
    notice(error?.message || "文件保存失败", "error");
  } finally {
    previewSaving.value = false;
  }
};

const requestRevertFile = (path: string) => {
  if (revertingFiles.value.has(path)) return;
  uni.showModal({
    title: "撤销修改？",
    content: `将把 ${fileBaseName(path)} 恢复到 Git 记录的版本。`,
    confirmText: "撤销",
    success: (result) => {
      if (result.confirm) void revertFileChange(path);
    },
  });
};

const revertFileChange = async (path: string) => {
  const next = new Set(revertingFiles.value);
  next.add(path);
  revertingFiles.value = next;
  try {
    await agent.revertFile(path);
    const cleared = new Set(revertedFiles.value);
    cleared.add(path);
    revertedFiles.value = cleared;
    notice("已撤销文件修改");
  } catch (error: any) {
    notice(error?.message || "撤销失败", "error");
  } finally {
    const done = new Set(revertingFiles.value);
    done.delete(path);
    revertingFiles.value = done;
  }
};

onShow(() => {
  pageActive.value = true;
  syncTheme();
  state.value = agent.state;
  projectName.value = agent.selectedProject?.name || "未选择项目";
  sandbox.value = agent.selectedProject?.default_sandbox || sandbox.value;
  models.value = [...agent.models.choices];
  model.value = agent.selectedProject?.model || agent.models.default;

  agent.onStateChange = (next) => {
    if (!pageActive.value) return;
    state.value = next;
    if (next === "online") {
      models.value = [...agent.models.choices];
      model.value = agent.selectedProject?.model || agent.models.default;
      loadHistory();
      if (screenActive.value) {
        agent.subscribeScreen(screenFps.value, screenQuality.value);
        screenOn.value = true;
        screenInfo.value = "等待画面";
      }
    }
  };
  agent.onProjectsChange = (_, selected) => {
    if (!pageActive.value) return;
    projectName.value = selected?.name || "未选择项目";
    model.value = selected?.model || agent.models.default;
    if (
      currentProjectId !== (selected?.id || "") ||
      currentSessionId !== (selected?.current_session_id || "") ||
      currentThreadId !== (selected?.codex_thread_id || "")
    ) {
      currentProjectId = selected?.id || "";
      currentSessionId = selected?.current_session_id || "";
      currentThreadId = selected?.codex_thread_id || "";
      resetConversationView();
    }
    loadHistory();
  };
  agent.onTimelineChange = (items) => {
    if (!pageActive.value) return;
    syncConversation(items);
  };
  agent.onMessage = handleScreenMessage;
  (uni as any).offWindowResize?.(handleChatWindowResize);
  (uni as any).onWindowResize?.(handleChatWindowResize);
  if (screenFull.value) void screenViewer.handleViewportChange();
  if (screenActive.value && agent.state === "online") {
    agent.subscribeScreen(screenFps.value, screenQuality.value);
    screenOn.value = true;
    screenInfo.value = "等待画面";
  }

  replay();

  if (!entranceSeeded) seedEntrance();
  if (entranceBootstrapping) {
    if (entranceBootstrapTimer) {
      clearTimeout(entranceBootstrapTimer);
      entranceBootstrapTimer = null;
    }
    entranceBootstrapping = false;
    scheduleEntrance();
  }
  syncConversation(agent.timeline);
  restorePendingTurns();
  loadHistory().finally(() => scrollToBottom());
  if (agent.state === "online") {
    agent.loadProjects().catch(() => undefined);
  }

  uni.onKeyboardHeightChange?.(handleKeyboardHeightChange);
});

onHide(() => {
  pageActive.value = false;
  keyboardHeight.value = 0;
  uni.offKeyboardHeightChange?.(handleKeyboardHeightChange);
  if (agent.onMessage === handleScreenMessage) {
    agent.onMessage = null;
  }
  if (agent.onStateChange) agent.onStateChange = null;
  if (agent.onProjectsChange) agent.onProjectsChange = null;
  if (agent.onTimelineChange) agent.onTimelineChange = null;
  if (screenFull.value) exitScreenFull();
  (uni as any).offWindowResize?.(handleChatWindowResize);
  if (screenActive.value && agent.state === "online") {
    agent.unsubscribeScreen();
  }
  screenOn.value = false;
  clearEntranceTimers();
});

onUnload(() => {
  pageActive.value = false;
  keyboardHeight.value = 0;
  (uni as any).offWindowResize?.(handleChatWindowResize);
  uni.offKeyboardHeightChange?.(handleKeyboardHeightChange);
  if (agent.onMessage === handleScreenMessage) agent.onMessage = null;
  if (agent.onStateChange) agent.onStateChange = null;
  if (agent.onProjectsChange) agent.onProjectsChange = null;
  if (agent.onTimelineChange) agent.onTimelineChange = null;
  if (historyRefreshTimer) {
    clearTimeout(historyRefreshTimer);
    historyRefreshTimer = null;
  }
  clearEntranceTimers();
});
</script>

<template>
  <view class="chat-screen" :class="[themeClass, { 'keyboard-open': keyboardOpen }]" :style="chatScreenStyle">
    <GlassNavbar
      title="会话"
      :subtitle="projectName"
      :theme-class="themeClass"
    >
      <template #right>
        <view class="nav-connection" :class="connectionTone">
          <view class="signal-dot" />
          <text class="nav-connection-text">{{ connectionText }}</text>
        </view>
      </template>
    </GlassNavbar>
    <view class="tab-content chat-layout" :class="{ 'ios-page-enter': entering }">
      <scroll-view
      class="chat-scroll"
      scroll-y
      :scroll-into-view="scrollIntoView"
      :scroll-with-animation="false"
    >
      <view class="thread">
        <block v-for="entry in visibleThreadStream" :key="entry.id">
          <template v-if="entry.kind === 'status'">
            <view
              class="status-row"
              :class="{ open: expandedCommands.has(entry.id) }"
              :style="entranceDelayStyle(entry.animationDelay)"
              @click="entry.output ? toggleStatus(entry.id) : undefined"
            >
              <view class="status-icon">!</view>
              <view class="activity-copy">
                <text class="status-title">{{ entry.title }}</text>
                <text class="status-meta mono">{{ entry.detail || formatTime(entry.ts) }}</text>
              </view>
              <text v-if="entry.output" class="status-chevron mono">⌄</text>
            </view>
            <view v-if="entry.output && expandedCommands.has(entry.id)" class="status-output">
              <text class="status-output-text mono">{{ entry.output }}</text>
            </view>
          </template>
          <template v-else-if="entry.kind === 'activity'">
            <view
              class="activity-row"
              :class="activityClass(entry)"
              :style="entranceDelayStyle(entry.animationDelay)"
            >
              <view class="activity-icon mono">{{ activityIconText(entry.icon) }}</view>
              <view class="activity-copy">
                <text class="activity-title">{{ activityTitle(entry) }}</text>
                <text v-if="activityDetail(entry)" class="activity-detail mono">{{ activityDetail(entry) }}</text>
              </view>
              <text class="activity-time mono">{{ formatTime(entry.ts) }}</text>
            </view>
          </template>
          <template v-else-if="entry.kind === 'file-change'">
            <view
              class="file-change-pill"
              :class="entry.status"
              :style="entranceDelayStyle(entry.animationDelay)"
            >
              <view class="file-change-icon">
                <view class="mask-icon icon-edit" />
              </view>
              <view class="file-change-copy" @click.stop="openFileReference(entry.path)">
                <text class="file-change-text">已编辑 {{ entry.name }}</text>
                <view class="file-change-stats">
                  <text class="file-change-add">+{{ entry.additions }}</text>
                  <text class="file-change-del">-{{ entry.deletions }}</text>
                </view>
              </view>
              <view class="file-change-actions">
                <button
                  class="file-change-action icon-only"
                  aria-label="审核文件"
                  @click.stop="openFileReference(entry.path)"
                >
                  <view class="mask-icon icon-document" />
                </button>
                <button
                  class="file-change-action icon-only undo"
                  aria-label="撤销修改"
                  :disabled="revertingFiles.has(entry.path) || entry.status === 'running'"
                  @click.stop="requestRevertFile(entry.path)"
                >
                  <view class="mask-icon icon-undo" />
                </button>
              </view>
            </view>
          </template>
          <template v-else-if="entry.kind === 'command'">
            <view
              class="shell-card"
              :class="entry.status"
              :style="entranceDelayStyle(entry.animationDelay)"
              @click="toggleCommand(entry.id)"
            >
              <view class="shell-head">
                <view class="shell-title">
                  <view class="shell-icon">
                    <view class="mask-icon icon-command shell-glyph" />
                  </view>
                    <text class="shell-label">{{ entry.title || "命令执行" }}</text>
                </view>
                <view class="shell-head-right">
                  <text class="shell-result" :class="entry.status">{{ commandResult(entry.status, entry.exitCode) }}</text>
                  <view class="shell-chevron" :class="{ open: expandedCommands.has(entry.id) }">
                    <text class="shell-chevron-glyph">⌄</text>
                  </view>
                </view>
              </view>
              <view v-if="expandedCommands.has(entry.id)" class="shell-output">
                <text class="shell-output-text mono">{{ commandOutput(entry.output) }}</text>
              </view>
            </view>
          </template>
          <template v-else>
            <view v-if="entry.role === 'assistant'" class="assistant-meta">
            <text class="assistant-name">Codex</text>
            <text class="message-time mono">{{ formatTime(entry.ts) }}</text>
          </view>
          <view
            class="message-row"
            :class="[entry.role, { 'message-enter': entry.role === 'assistant' && entry.live }]"
            :style="entranceDelayStyle(entry.animationDelay)"
          >
            <view class="bubble">
              <view
                v-if="entry.role === 'user'"
                class="message-edit-row"
              >
                <button class="message-edit-button" aria-label="编辑消息" @click.stop="startEditMessage(entry)">
                  <view class="mask-icon icon-edit" />
                </button>
              </view>
              <image
                v-if="entry.role === 'user' && messageImagePath(entry)"
                class="message-image"
                :src="messageImageSrc(entry)"
                mode="aspectFill"
                @click="openFileReference(messageImagePath(entry))"
              />
              <text v-if="entry.role === 'user' && displayMessageBody(entry)" class="message-text">{{ displayMessageBody(entry) }}</text>
              <view v-else class="markdown-content">
                <block v-for="(block, blockIndex) in markdownBlocks(entry.body)" :key="`${entry.id}-${blockIndex}`">
                  <rich-text v-if="block.type === 'paragraph'" class="markdown-paragraph" :nodes="block.html" />
                  <rich-text
                    v-else-if="block.type === 'heading'"
                    class="markdown-heading"
                    :class="`heading-${block.level}`"
                    :nodes="block.html"
                  />
                  <view v-else-if="block.type === 'list'" class="markdown-list">
                    <view v-for="(entry, entryIndex) in block.items" :key="entryIndex" class="markdown-list-item">
                      <text class="list-marker">{{ block.ordered ? `${entryIndex + 1}.` : "•" }}</text>
                      <rich-text :nodes="entry" />
                    </view>
                  </view>
                  <rich-text v-else-if="block.type === 'quote'" class="markdown-quote" :nodes="block.html" />
                  <scroll-view v-else class="markdown-code-scroll" scroll-x>
                    <view class="markdown-code">
                      <text v-if="block.language" class="code-language mono">{{ block.language }}</text>
                      <text class="code-text mono">{{ block.text }}</text>
                    </view>
                  </scroll-view>
                </block>
                <view v-if="messageReferences(entry.body).length" class="file-reference-list">
                  <view
                    v-for="reference in messageReferences(entry.body)"
                    :key="`${reference.kind}-${reference.path}`"
                    class="file-reference"
                    :class="{ web: reference.kind === 'web' }"
                  >
                    <view class="file-reference-icon">
                      <view class="mask-icon" :class="reference.kind === 'web' ? 'icon-web' : 'icon-document'" />
                    </view>
                    <view
                      class="file-reference-copy"
                      @click="reference.kind === 'web' ? openWebReference(reference.path) : openFileReference(reference.path)"
                    >
                      <text class="file-reference-label">{{ reference.kind === "web" ? "预览网页" : reference.label }}</text>
                      <text class="file-reference-path mono">{{ reference.path }}</text>
                    </view>
                    <view class="file-reference-actions">
                      <button
                        v-if="reference.kind === 'web'"
                        class="reference-action preview"
                        @click.stop="openWebReference(reference.path)"
                      >预览</button>
                      <button
                        v-if="canEditReference(reference)"
                        class="reference-action edit"
                        @click.stop="openEditReference(reference.path)"
                      >
                        <view class="mask-icon icon-edit" />
                      </button>
                    </view>
                  </view>
                </view>
              </view>
            </view>
          </view>
          </template>
        </block>

        <view v-if="thinking" class="thinking">
          <view class="thinking-dots"><view /><view /><view /></view>
          <text class="thinking-text">{{ thinkingLabel }}</text>
          <view class="thinking-progress">
            <view class="thinking-progress-value" />
          </view>
          <view class="thinking-shimmer"><view /></view>
        </view>

        <view v-if="!chatMessages.length && !thinking" class="empty-state">
          <view class="empty-mark">✳</view>
          <text class="empty-title">给 Codex 发送第一条消息</text>
          <text class="empty-description">发送后会一直留在当前会话页等待回复。</text>
        </view>
        <view :id="scrollIntoView" class="chat-bottom-anchor" />
      </view>
      </scroll-view>

    <view
      v-if="screenActive"
      class="inline-screen"
      :class="[themeClass, { dragging: inlineScreenDragging }]"
      :style="inlineScreenStyle"
    >
      <view
        class="inline-screen-head"
        @touchstart.stop.prevent="onInlineScreenStart"
        @touchmove.stop.prevent="onInlineScreenMove"
        @touchend.stop.prevent="onInlineScreenEnd"
        @touchcancel.stop.prevent="onInlineScreenEnd"
        @mousedown.stop.prevent="onInlineScreenStart"
        @mousemove.stop="onInlineScreenMove"
        @mouseup.stop.prevent="onInlineScreenEnd"
      >
        <text class="inline-screen-title">PC 屏幕</text>
        <text class="inline-screen-info mono">{{ screenInfo }}</text>
        <button
          class="inline-screen-close"
          @touchstart.stop
          @touchend.stop
          @mousedown.stop
          @click="openScreenControl"
        >关闭</button>
      </view>
      <view class="inline-screen-body">
        <image
          v-if="screenData"
          class="inline-screen-frame"
          :src="screenData"
          mode="aspectFit"
        />
        <view v-else class="inline-screen-empty">
          <text>{{ screenOn ? "等待画面…" : screenInfo }}</text>
        </view>
        <view
          class="fullscreen-float-button"
          :class="{ dragging: fullscreenButtonStart != null }"
          :style="{ left: `${fullscreenButton.x}px`, top: `${fullscreenButton.y}px` }"
          @touchstart.stop.prevent="onFullscreenButtonStart"
          @touchmove.stop.prevent="onFullscreenButtonMove"
          @touchend.stop.prevent="onFullscreenButtonEnd"
          @touchcancel.stop.prevent="onFullscreenButtonEnd"
          @mousedown.stop.prevent="onFullscreenButtonStart"
          @mousemove.stop="onFullscreenButtonMove"
          @mouseup.stop.prevent="onFullscreenButtonEnd"
        >
          <text>全屏</text>
        </view>
      </view>
    </view>

    <view v-if="screenFull" class="screen-fullscreen" :class="themeClass">
      <button
        class="viewer-launch-button"
        :class="{ open: screenControlsOpen }"
        @click.stop="toggleScreenControlsPanel"
      >
        <text>{{ screenControlsOpen ? "收起" : "开始" }}</text>
      </button>
      <view v-if="screenControlsOpen" class="screen-full-toolbar">
        <text class="screen-full-title mono">{{ screenInfo }}</text>
        <view class="screen-full-actions">
          <button class="screen-full-button viewer-button" :class="{ active: screenViewer.fitActive.value }" @click.stop="screenViewer.fit()">适应</button>
          <button class="screen-full-button viewer-button" @click.stop="screenViewer.actualSize()">1:1</button>
          <button class="screen-full-button viewer-button icon" @click.stop="screenViewer.zoomOut()">-</button>
          <text class="screen-zoom-label mono">{{ screenViewer.percentLabel.value }}</text>
          <button class="screen-full-button viewer-button icon" @click.stop="screenViewer.zoomIn()">+</button>
          <button class="screen-full-button settings-toggle" :class="{ active: screenSettingsOpen }" @click.stop="toggleScreenSettings">设置</button>
          <button class="screen-full-button exit" @click.stop="exitScreenFull">退出</button>
        </view>
      </view>
      <view v-if="screenControlsOpen && screenSettingsOpen" class="chat-screen-settings">
        <view class="chat-setting-group">
          <button
            v-for="option in chatQualityOptions"
            :key="option.width"
            class="chat-setting-button"
            :class="{ active: screenQuality === option.width }"
            @click.stop="updateChatScreenSettings(option.width, screenFps)"
          >{{ option.label }}</button>
        </view>
        <view class="chat-setting-group">
          <button
            v-for="option in chatFpsOptions"
            :key="option.value"
            class="chat-setting-button"
            :class="{ active: screenFps === option.value }"
            @click.stop="updateChatScreenSettings(screenQuality, option.value)"
          >{{ option.label }}</button>
        </view>
      </view>
      <view
        class="screen-full-surface"
        @touchstart.stop.prevent="onScreenFullTouchStart"
        @touchmove.stop.prevent="onScreenFullTouchMove"
        @touchend.stop.prevent="onScreenFullTouchEnd"
        @touchcancel.stop.prevent="onScreenFullTouchEnd"
        @mousedown.stop.prevent="onScreenFullTouchStart"
        @mousemove.stop="onScreenFullTouchMove"
        @mouseup.stop.prevent="onScreenFullTouchEnd"
      >
        <image
          v-if="screenData"
          class="screen-full-frame"
          :src="screenData"
          mode="scaleToFill"
          :style="screenViewer.frameStyle.value"
        />
        <view v-else class="screen-full-empty">
          <text>{{ screenOn ? "等待画面…" : screenInfo }}</text>
        </view>
      </view>
      <view
        v-if="screenControlsOpen"
        class="chat-screen-controls"
        :class="{ collapsed: screenControlsCollapsed }"
      >
        <button
          class="chat-controls-toggle"
          :class="{ collapsed: screenControlsCollapsed }"
          @click.stop="toggleScreenControls"
        >{{ screenControlsCollapsed ? "控制" : "收起" }}</button>
        <view v-if="!screenControlsCollapsed" class="chat-control-buttons">
          <button class="chat-control-button" @click.stop="sendScreenFixedCommand('right_click')">右键</button>
          <button class="chat-control-button" @click.stop="sendScreenFixedCommand('double_click')">双击</button>
          <button class="chat-control-button" @click.stop="sendScreenFixedCommand('scroll', { delta: 3 })">上滚</button>
          <button class="chat-control-button" @click.stop="sendScreenFixedCommand('scroll', { delta: -3 })">下滚</button>
          <button class="chat-control-button" @click.stop="sendScreenFixedCommand('key', { key: 'escape' })">ESC</button>
          <button class="chat-control-button" @click.stop="sendScreenFixedCommand('key', { key: 'enter' })">回车</button>
        </view>
      </view>
    </view>

    <view v-if="previewLoading || previewFile" class="preview-layer">
      <view class="preview-backdrop" @click="closePreview" />
      <view class="preview-drawer">
        <view class="preview-drawer-head">
          <view class="preview-file-meta">
            <view class="preview-file-icon">
              <view class="mask-icon icon-document" />
            </view>
            <view class="preview-file-copy">
              <text class="preview-file-name">{{ previewFile?.name || "读取文件" }}</text>
              <text class="preview-file-path mono">{{ previewFile?.path || "正在读取…" }}</text>
            </view>
          </view>
          <view class="preview-drawer-actions">
            <button
              v-if="previewFile?.kind === 'text' && previewHtml"
              class="preview-action web"
              @click="openPreviewInWebView"
            >网页</button>
            <button
              v-if="previewFile?.kind === 'text' && !previewEditing"
              class="preview-action"
              @click="startPreviewEditing"
            >编辑</button>
            <button
              v-if="previewEditing"
              class="preview-action"
              :disabled="previewSaving"
              @click="previewEditing = false"
            >取消</button>
            <button
              v-if="previewEditing"
              class="preview-action save"
              :disabled="previewSaving || !previewDirty"
              @click="savePreview"
            >{{ previewSaving ? "保存中" : "保存" }}</button>
            <button class="preview-close" @click="closePreview">关闭</button>
          </view>
        </view>

        <view v-if="previewLoading" class="preview-loading">
          <view class="thinking-dots"><view /><view /><view /></view>
          <text>正在读取文件</text>
        </view>
        <template v-else-if="previewFile">
          <text v-if="previewFile.truncated" class="preview-truncated">内容较大，当前只显示部分内容。</text>
          <image
            v-if="previewFile.kind === 'image' && previewFile.dataUrl"
            class="preview-image"
            :src="previewFile.dataUrl"
            mode="widthFix"
          />
          <textarea
            v-else-if="previewFile.kind === 'text' && previewEditing"
            v-model="previewDraft"
            class="preview-editor mono"
            :maxlength="-1"
            :auto-height="false"
          />
          <view v-else-if="previewFile.kind === 'text' && previewMarkdown" class="preview-markdown">
            <block v-for="(block, index) in previewBlocks" :key="index">
              <rich-text v-if="block.type === 'paragraph'" :nodes="block.html" />
              <rich-text v-else-if="block.type === 'heading'" :class="`preview-heading heading-${block.level}`" :nodes="block.html" />
              <view v-else-if="block.type === 'list'" class="preview-list">
                <view v-for="(entry, entryIndex) in block.items" :key="entryIndex" class="preview-list-item">
                  <text class="list-marker">{{ block.ordered ? `${entryIndex + 1}.` : "•" }}</text>
                  <rich-text :nodes="entry" />
                </view>
              </view>
              <rich-text v-else-if="block.type === 'quote'" class="preview-quote" :nodes="block.html" />
              <scroll-view v-else class="preview-code-scroll" scroll-x>
                <view class="preview-code"><text v-if="block.language" class="preview-language mono">{{ block.language }}</text><text class="preview-code-text mono">{{ block.text }}</text></view>
              </scroll-view>
            </block>
          </view>
          <scroll-view v-else-if="previewFile.kind === 'text'" class="preview-source" scroll-y>
            <view v-for="(line, index) in previewTextLines" :key="index" class="preview-source-line">
              <text class="preview-source-no mono">{{ index + 1 }}</text>
              <text class="preview-source-text mono">{{ line || " " }}</text>
            </view>
          </scroll-view>
          <view v-else class="preview-binary">
            <text>该文件类型暂不支持直接预览</text>
            <text class="mono">{{ previewFile.mime }} · {{ previewFile.size }} B</text>
          </view>
        </template>
      </view>
    </view>

      <view class="composer" :class="{ 'ios-page-enter': entering }">
        <view v-if="slashOpen" class="slash-panel">
          <view class="slash-head">
            <text class="slash-title">命令</text>
            <button class="slash-close" @click="closeSlashMenu">×</button>
          </view>
          <scroll-view class="slash-list" scroll-y>
            <template v-if="slashItems.length">
              <button
                v-for="item in slashItems"
                :key="item.id"
                class="slash-item"
                :disabled="sessionBusy"
                @click="chooseSlashCommand(item.id)"
              >
                <view class="slash-icon"><text>{{ item.icon }}</text></view>
                <view class="slash-copy">
                  <text class="slash-label">{{ item.label }}</text>
                  <text class="slash-detail">{{ item.detail }}</text>
                </view>
              </button>
            </template>
            <text v-else class="slash-empty">没有匹配的命令</text>
          </scroll-view>
        </view>

      <view v-if="sessionMenuOpen" class="command-panel">
        <view class="command-head">
          <view class="command-heading">
            <text class="command-title">Codex 会话</text>
            <text class="command-status">{{ sessionStatusLine }}</text>
          </view>
          <button class="command-close" :disabled="sessionBusy" @click="closeSessionMenu">×</button>
        </view>

        <scroll-view class="command-scroll" scroll-y>
          <view class="command-grid">
            <button
              v-for="item in commandItems"
              :key="item.id"
              class="command-tile"
              :class="{ danger: item.id === 'remove-project' }"
              :disabled="sessionBusy"
              @click="runCommand(item.id)"
            >
              <view class="command-icon"><text>{{ item.icon }}</text></view>
              <view class="command-copy">
                <text class="command-label">{{ item.label }}</text>
                <text class="command-detail">{{ item.detail }}</text>
              </view>
            </button>
          </view>

          <view v-if="sessionBusy" class="command-busy">
            <view class="command-spinner" />
            <text>正在处理</text>
          </view>

          <view v-if="sessionSheet === 'status'" class="command-sub">
            <template v-if="sessionStatus?.available">
              <view class="command-row">
                <text class="command-row-label">会话</text>
                <text class="command-row-value">{{ sessionStatusLabel }}</text>
              </view>
              <view class="command-row">
                <text class="command-row-label">模型</text>
                <text class="command-row-value">{{ sessionStatus.model || "跟随配置" }}</text>
              </view>
              <view class="command-row">
                <text class="command-row-label">上下文</text>
                <text class="command-row-value">{{ contextPercent(sessionStatus.context_percent) }}% · {{ formatTokens(sessionStatus.used_tokens) }} / {{ formatTokens(sessionStatus.context_window) }}</text>
              </view>
              <view class="command-row">
                <text class="command-row-label">限额</text>
                <text class="command-row-value">{{ sessionStatus.rate_limits ? "已读取" : "未知" }}</text>
              </view>
              <view class="command-row">
                <text class="command-row-label">Thread</text>
                <text class="command-row-value mono">{{ sessionStatus.thread_id || "-" }}</text>
              </view>
            </template>
            <text v-else class="command-empty">暂无可读取的 Codex 会话状态</text>
          </view>

          <view v-else-if="sessionSheet === 'goal'" class="command-form">
            <textarea
              v-model="goalDraft"
              class="command-textarea"
              :maxlength="-1"
              auto-height
              placeholder="告诉 Codex 这个项目当前要完成什么…"
              placeholder-class="prompt-placeholder"
            />
            <button class="command-primary" :disabled="sessionBusy || !goalDraft.trim()" @click="saveGoal">保存目标</button>
          </view>

          <view v-else-if="sessionSheet === 'reasoning'" class="command-form">
            <view class="command-chips">
              <button
                v-for="effort in reasoningOptions"
                :key="effort"
                class="command-chip"
                :class="{ active: sessionStatus?.reasoning_effort === effort }"
                :disabled="sessionBusy"
                @click="chooseReasoning(effort)"
              >{{ effort }}</button>
            </view>
          </view>

          <view v-else-if="sessionSheet === 'sessions'" class="command-list">
            <button
              class="command-item"
              :class="{ active: threadIsNew }"
              :disabled="sessionBusy"
              @click="startThreadFromList"
            >
              <view class="command-item-main">
                <text class="command-item-title">新会话</text>
                <text class="command-item-detail">发送第一句后自动生成标题</text>
              </view>
              <text v-if="threadIsNew" class="command-item-time">当前</text>
            </button>
            <view
              v-for="thread in threadList"
              :key="thread.session_id || thread.thread_id"
              class="command-item"
              :class="{ active: thread.current }"
              :disabled="sessionBusy"
              @click="chooseThread(thread.session_id || thread.thread_id || '')"
            >
            <view class="command-item-main">
                <text class="command-item-title">{{ sessionLabel(thread) }}</text>
                <text class="command-item-detail">{{ sessionDetail(thread) }} · 上下文 {{ contextPercent(thread.context_percent, "?") }}%</text>
              </view>
              <view class="command-item-actions">
                <text v-if="thread.running" class="command-running-badge">运行中</text>
                <text class="command-item-time">{{ thread.updated_at }}</text>
                <button
                  class="command-item-delete"
                  :disabled="sessionBusy"
                  @click.stop="deleteThread(thread)"
                >删除</button>
              </view>
            </view>
            <view v-if="archivedThreadList.length" class="command-group-label">
              <text>历史</text>
            </view>
            <view
              v-for="thread in archivedThreadList"
              :key="`archived-${thread.session_id || thread.thread_id}`"
              class="command-item"
              :disabled="sessionBusy"
              @click="chooseThread(thread.session_id || thread.thread_id || '')"
            >
            <view class="command-item-main">
                <text class="command-item-title">{{ sessionLabel(thread) }}</text>
                <text class="command-item-detail">{{ sessionDetail(thread) }} · 已归档</text>
              </view>
              <view class="command-item-actions">
                <text v-if="thread.running" class="command-running-badge">运行中</text>
                <text class="command-item-time">{{ thread.updated_at }}</text>
                <button
                  class="command-item-delete"
                  :disabled="sessionBusy"
                  @click.stop="deleteThread(thread)"
                >删除</button>
              </view>
            </view>
            <text v-if="!threadList.length && !archivedThreadList.length" class="command-empty">没有找到本项目的会话</text>
          </view>

          <view v-else-if="sessionSheet === 'mcp'" class="command-list">
            <view v-for="server in mcpServers" :key="server.name" class="command-item static">
              <view class="command-item-main">
                <text class="command-item-title">{{ server.name }}</text>
                <text class="command-item-detail">{{ server.detail }}</text>
              </view>
              <text class="command-state" :class="{ on: server.enabled }">{{ server.enabled ? "启用" : "停用" }}</text>
            </view>
            <text v-if="!mcpServers.length" class="command-empty">没有配置可用的 MCP 服务器</text>
          </view>

          <view v-else-if="sessionSheet === 'fork'" class="command-form">
            <textarea
              v-model="forkPrompt"
              class="command-textarea"
              :maxlength="-1"
              auto-height
              placeholder="基于当前会话分叉后的第一句话…"
              placeholder-class="prompt-placeholder"
            />
            <button class="command-primary" :disabled="sessionBusy || !forkPrompt.trim()" @click="startFork">启动分支</button>
          </view>

          <view v-else-if="sessionSheet === 'side'" class="command-form">
            <textarea
              v-model="sidePrompt"
              class="command-textarea"
              :maxlength="-1"
              auto-height
            placeholder="问一个不进入正式会话的临时问题…"
              placeholder-class="prompt-placeholder"
            />
            <button class="command-primary" :disabled="sessionBusy || !sidePrompt.trim()" @click="startSide">启动侧聊</button>
          </view>
        </scroll-view>
      </view>

      <view class="toolbar">
        <picker
          class="model-picker"
          mode="selector"
          :range="models"
          :value="modelIndex"
          @change="changeModel"
        >
          <view class="model-button">
            <text class="model-label">模型</text>
            <text class="model-value">{{ modelLabel(model) }}</text>
            <text class="model-chevron">▾</text>
          </view>
        </picker>

        <button class="command-button" :class="{ active: sessionMenuOpen }" @click="toggleCommandMenu">命令</button>

        <view class="sandbox-group">
          <button
            class="tool-button"
            :class="{ active: sandbox === 'read_only' }"
            @click="sandbox = 'read_only'"
          >只读</button>
          <button
            class="tool-button"
            :class="{ active: sandbox === 'workspace_write' }"
            @click="sandbox = 'workspace_write'"
          >写入</button>
        </view>

        <button class="files-button" @click="openFiles">文件</button>

        <button class="screen-button" @click="openScreenControl">屏幕</button>

        <button class="image-button" :disabled="uploadingImage" @click="chooseImage">图片</button>

      </view>

      <view v-if="selectedImage" class="attachment-bar">
        <image class="attachment-thumb" :src="selectedImage.localUrl" mode="aspectFill" />
        <view class="attachment-copy">
          <text class="attachment-name">{{ selectedImage.name }}</text>
          <view v-if="uploadingImage" class="attachment-progress">
            <view class="attachment-progress-track">
              <view class="attachment-progress-value" :style="{ width: `${imageUploadPercent}%` }" />
            </view>
            <text class="attachment-progress-text mono">{{ imageUploadPercent }}%</text>
          </view>
        </view>
        <button class="attachment-remove" :disabled="uploadingImage" @click="clearImage">×</button>
      </view>

      <view v-if="thinking && !editingTurnId" class="followup-guide" :class="{ open: followupGuideOpen }">
        <button class="followup-guide-toggle" @click="followupGuideOpen = !followupGuideOpen">
          <text>引导</text>
          <text class="followup-chevron">{{ followupGuideOpen ? "收起" : "展开" }}</text>
        </button>
        <scroll-view v-if="followupGuideOpen" class="followup-guide-scroll" scroll-x :show-scrollbar="false">
          <view class="followup-guide-list">
            <button
              v-for="guide in followupGuides"
              :key="guide.label"
              class="followup-guide-chip"
              @click="chooseFollowupGuide(guide.prompt)"
            >{{ guide.label }}</button>
          </view>
        </scroll-view>
      </view>

      <view v-if="queuedPrompts.length" class="queued-bar">
        <view class="queued-copy">
          <text class="queued-label">已追加 {{ queuedPrompts.length }} 条提示词，任务停止或完成后依次发送</text>
          <view v-for="item in queuedPrompts" :key="item.id" class="queued-item">
            <text class="queued-text">{{ item.text }}</text>
            <button class="queued-remove" @click="cancelQueuedPrompt(item.id)">×</button>
          </view>
        </view>
        <button class="queued-remove queued-clear" @click="cancelQueuedPrompt()">清空</button>
      </view>

      <view class="composer-main">
        <textarea
          v-model="prompt"
          class="prompt-input"
          :maxlength="-1"
          auto-height
          :adjust-position="false"
          placeholder="描述要修复的问题、要实现的页面，或要跑的检查…"
          placeholder-class="prompt-placeholder"
        />
        <button
          v-if="!editingTurnId"
          class="send-button"
          :class="{
            busy: running,
            stop: thinking && !prompt.trim() && !selectedImage,
            continue: continueAvailable && !thinking && !prompt.trim() && !selectedImage,
            append: thinking && (prompt.trim() || selectedImage),
          }"
          :disabled="running"
          @click="submitComposer"
        >
          <view v-if="running" class="send-spinner" />
          <view v-else-if="thinking && !prompt.trim() && !selectedImage" class="stop-glyph" />
          <text v-else-if="continueAvailable && !thinking && !prompt.trim() && !selectedImage">继续</text>
          <text v-else>↑</text>
        </button>
      </view>

      <view v-if="editingTurnId" class="edit-sheet">
        <view class="edit-head">
          <text class="edit-title">编辑消息</text>
        </view>
        <textarea
          v-model="editDraft"
          class="edit-textarea"
          :maxlength="-1"
          :adjust-position="false"
          placeholder="修改后将以新的任务发送"
          placeholder-class="prompt-placeholder"
        />
        <view class="edit-actions">
          <button class="edit-cancel" @click="cancelEditTurn">取消</button>
          <button class="edit-send" :disabled="!editDraft.trim()" @click="submitEditTurn">发送</button>
        </view>
      </view>
    </view>
    </view>

    <LiquidTabBar v-show="!keyboardOpen" current="chat" :theme-class="themeClass" />

    <view class="notice-layer">
      <view v-if="notices.length" class="notice" :class="notices[notices.length - 1].tone">
        <text>{{ notices[notices.length - 1].text }}</text>
      </view>
    </view>
  </view>
</template>

<style>
.chat-screen {
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  height: calc(100vh - var(--window-top, 0px) - var(--window-bottom, 0px));
  min-height: 0;
  padding-top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 52px);
  display: flex;
  flex-direction: column;
  overflow: hidden;
  overflow-x: clip;
  background: #05070d;
}

.chat-screen.keyboard-open {
  height: calc(
    100vh - var(--effective-keyboard-height, 0px) - var(--window-top, 0px) - var(--window-bottom, 0px)
  );
}

.nav-connection {
  display: flex;
  align-items: center;
  gap: 6px;
  height: 30px;
  padding: 0 10px;
  border: 1px solid currentColor;
  border-radius: 99px;
  opacity: 0.94;
}

.nav-connection-text {
  color: inherit;
  font-size: 10px;
  white-space: nowrap;
}
.signal-dot {
  width: 7px;
  height: 7px;
  flex: none;
  border-radius: 50%;
  background: currentColor;
}
.chat-scroll {
  flex: 1;
  width: 100%;
  min-height: 0;
  box-sizing: border-box;
}
.chat-bottom-anchor {
  height: 1px;
}
.thread {
  width: 100%;
  max-width: 720px;
  margin: 0 auto;
  padding: 18px 14px;
  box-sizing: border-box;
}

.assistant-meta {
  display: flex;
  align-items: baseline;
  gap: 7px;
  margin: 0 0 5px 2px;
}
.assistant-name {
  color: #f0a06a;
  font-size: 8px;
  font-weight: 650;
}
.message-time {
  color: #667089;
  font-size: 7.5px;
}
.message-row {
  display: flex;
  width: 100%;
  margin-bottom: 16px;
}
.activity-row {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  width: 100%;
  margin: 0 0 6px 2px;
}
.activity-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex: none;
  margin-top: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: #a9b7d3;
  font-size: 7.5px;
  line-height: 13px;
}
.activity-icon.file {
  border-color: rgba(125, 211, 252, 0.22);
  background: rgba(56, 189, 248, 0.08);
  color: #7dd3fc;
}
.activity-icon.think {
  border-color: rgba(196, 181, 253, 0.2);
  background: rgba(167, 139, 250, 0.08);
  color: #c4b5fd;
}
.activity-row.running .activity-icon {
  border-color: rgba(240, 160, 106, 0.32);
  background: rgba(240, 160, 106, 0.1);
  color: #f0a06a;
  animation: thinking 1s ease-in-out infinite;
}
.activity-row.failed .activity-icon {
  border-color: rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.1);
  color: #f87171;
}
.activity-copy {
  flex: 1;
  min-width: 0;
}
.activity-title {
  display: block;
  color: #b9c4d8;
  font-size: 8px;
  font-weight: 500;
  line-height: 13px;
}
.activity-detail {
  display: block;
  margin-top: 1px;
  overflow: hidden;
  color: #66738f;
  font-size: 8px;
  line-height: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.activity-time {
  flex: none;
  margin-top: 1px;
  color: #5a667f;
  font-size: 7.5px;
}
.file-change-pill {
  display: flex;
  align-items: center;
  max-width: 100%;
  gap: 5px;
  margin: 0 0 6px 2px;
  padding: 3px 6px;
  border: 1px solid rgba(255, 255, 255, 0.09);
  border-radius: 8px;
  background: #161b28;
  overflow: hidden;
  box-sizing: border-box;
}
.file-change-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 11px;
  height: 11px;
  flex: none;
  border-radius: 4px;
  background: rgba(125, 211, 252, 0.12);
  color: #7dd3fc;
  font-size: 7px;
  font-weight: 700;
  line-height: 11px;
}
.file-change-copy {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  flex: 1;
  min-width: 0;
}
.file-change-stats {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.file-change-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  flex: none;
}
.file-change-action {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 19px;
  height: 19px;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.05);
  color: #a6b2c8;
  transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), background-color 0.16s ease;
}
.file-change-action.mask-icon,
.file-change-action .mask-icon {
  width: 10px;
  height: 10px;
}
.file-change-action.icon-only:active {
  transform: scale(0.92);
}
.file-change-action:disabled {
  opacity: 0.42;
}
.file-change-action.undo {
  color: #f0a06a;
}
.file-change-text,
.file-change-add,
.file-change-del {
  font-size: 7.5px;
  line-height: 11px;
}
.file-change-text {
  overflow: hidden;
  color: #c8d2e4;
  text-overflow: ellipsis;
  white-space: nowrap;
  flex: 1;
  min-width: 0;
}
.file-change-add {
  color: #8ce6b0;
}
.file-change-del {
  color: #f87171;
  flex: none;
}
.file-change-add {
  flex: none;
}
.file-change-pill.running {
  border-color: rgba(240, 160, 106, 0.24);
}
.file-change-pill.running .file-change-text {
  color: #f0a06a;
}
.file-change-pill.running .file-change-icon {
  background: rgba(240, 160, 106, 0.12);
  color: #f0a06a;
  animation: thinking 1s ease-in-out infinite;
}
.file-change-pill.failed {
  border-color: rgba(248, 113, 113, 0.3);
}
.file-change-pill.failed .file-change-icon {
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
}
.file-change-pill.failed .file-change-text {
  color: #fca5a5;
}
.shell-card {
  width: 100%;
  margin: 0 0 5px 0;
  border: 1px solid #252c3b;
  border-radius: 8px;
  background: #111622;
  overflow: hidden;
  box-sizing: border-box;
  transition: border-color 0.16s ease, background-color 0.16s ease;
}
.shell-card.running {
  border-color: #3b465b;
  background: #131925;
}
.shell-card.failed {
  border-color: rgba(248, 113, 113, 0.42);
}
.shell-head {
  display: flex;
  align-items: center;
  gap: 7px;
  width: 100%;
  min-height: 24px;
  padding: 3px 6px;
  box-sizing: border-box;
}
.shell-title {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: 1;
  min-width: 0;
}
.shell-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  flex: none;
  border: 1px solid #30394b;
  border-radius: 6px;
  background: #1a2130;
}
.shell-card.running .shell-icon {
  border-color: rgba(240, 160, 106, 0.32);
  background: rgba(240, 160, 106, 0.1);
  animation: thinking 1s ease-in-out infinite;
}
.shell-card.failed .shell-icon {
  border-color: rgba(248, 113, 113, 0.28);
  background: rgba(248, 113, 113, 0.1);
}
.shell-glyph {
  width: 8px;
  height: 8px;
  color: #a9b7d3;
}
.shell-card.running .shell-glyph {
  color: #f0a06a;
}
.shell-card.failed .shell-glyph {
  color: #f87171;
}
.shell-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #c5cede;
  font-size: 8px;
  font-weight: 500;
  line-height: 12px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.shell-head-right {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.shell-result {
  font-size: 7.5px;
  line-height: 12px;
  font-weight: 500;
}
.shell-result.running {
  color: #f0a06a;
}
.shell-result.success {
  color: #8ce6b0;
}
.shell-result.failed {
  color: #f87171;
}
.shell-chevron {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 15px;
  height: 15px;
  border-radius: 6px;
  background: #1a2130;
  transition: transform 0.16s ease;
}
.shell-chevron.open {
  transform: rotate(180deg);
}
.shell-chevron-glyph {
  color: #7381a1;
  font-size: 8px;
  line-height: 15px;
}
.shell-output {
  margin: 0 8px 7px;
  padding: 7px 8px;
  border: 1px solid #252c3b;
  border-radius: 6px;
  background: #0b0f18;
  max-height: 180px;
  overflow: hidden;
  box-sizing: border-box;
}
.shell-output-text {
  display: block;
  color: #aebdd8;
  font-size: 9px;
  line-height: 1.6;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.status-row {
  display: flex;
  align-items: flex-start;
  gap: 6px;
  width: 100%;
  margin: 0 0 7px 2px;
  border-radius: 8px;
}
.status-row.open {
  margin-bottom: 6px;
}
.status-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 14px;
  height: 14px;
  flex: none;
  margin-top: 1px;
  border: 1px solid rgba(248, 113, 113, 0.32);
  border-radius: 50%;
  background: rgba(248, 113, 113, 0.12);
  color: #f87171;
  font-size: 8px;
  font-weight: 700;
  line-height: 12px;
}
.status-title {
  display: block;
  color: #fca5a5;
  font-size: 8px;
  font-weight: 650;
  line-height: 12px;
}
.status-meta {
  display: block;
  overflow: hidden;
  margin-top: 1px;
  color: #66738f;
  font-size: 7.5px;
  line-height: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.status-chevron {
  flex: none;
  margin-top: 1px;
  color: #7381a1;
  font-size: 8px;
  line-height: 12px;
  transition: transform 0.16s ease;
}
.status-row.open .status-chevron {
  transform: rotate(180deg);
}
.status-output {
  width: 100%;
  margin: -6px 0 12px 28px;
  padding: 7px 8px;
  border: 1px solid rgba(248, 113, 113, 0.18);
  border-radius: 8px;
  background: #0b1020;
  box-sizing: border-box;
}
.status-output-text {
  display: block;
  max-height: 180px;
  overflow: hidden;
  color: #ffb4b4;
  font-size: 9px;
  line-height: 1.55;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.message-row.user {
  justify-content: flex-end;
}
.message-row.assistant {
  justify-content: flex-start;
}
.bubble {
  max-width: min(92%, 680px);
  padding: 10px 13px;
  border-radius: 8px;
  overflow: hidden;
}
.message-edit-row {
  display: flex;
  justify-content: flex-end;
  margin: -2px 2px 4px 0;
}
.message-edit-button {
  display: flex;
  align-items: center;
  justify-content: center;
  height: 24px;
  width: 26px;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.08);
  color: rgba(196, 208, 227, 0.86);
  opacity: 0.82;
  box-shadow: 0 6px 14px rgba(3, 6, 14, 0.16);
  backdrop-filter: blur(14px) saturate(150%);
  -webkit-backdrop-filter: blur(14px) saturate(150%);
  transition:
    transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1),
    opacity 0.16s ease,
    background-color 0.16s ease,
    border-color 0.16s ease,
    color 0.16s ease;
}
.message-edit-button .mask-icon {
  width: 13px;
  height: 13px;
}
.message-edit-button:active {
  transform: scale(0.92);
  opacity: 1;
  border-color: rgba(232, 112, 58, 0.36);
  background: rgba(232, 112, 58, 0.14);
  color: #f0a06a;
}
.message-row.user .bubble {
  border: 1px solid rgba(232, 112, 58, 0.24);
  border-bottom-right-radius: 2px;
  background: #232634;
}
.message-row.assistant .bubble {
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-bottom-left-radius: 2px;
  background: #161b28;
}
.message-text {
  display: block;
  width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
  color: #e7ecf5;
  font-size: 13px;
  line-height: 1.65;
}
.markdown-content {
  display: block;
  color: #e7ecf5;
  font-size: 13px;
  line-height: 1.65;
  overflow-wrap: anywhere;
}
.file-reference-list {
  display: flex;
  flex-direction: column;
  gap: 6px;
  margin-top: 11px;
}
.file-reference {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 9px;
  border: 1px solid rgba(125, 211, 252, 0.18);
  border-radius: 7px;
  background: rgba(56, 189, 248, 0.06);
}
.file-reference.web {
  border-color: rgba(196, 181, 253, 0.22);
  background: rgba(167, 139, 250, 0.08);
}
.file-reference-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 20px;
  height: 20px;
  flex: none;
  border-radius: 5px;
  background: rgba(125, 211, 252, 0.13);
  color: #7dd3fc;
  font-size: 10px;
  font-weight: 700;
}
.file-reference.web .file-reference-icon,
.file-reference.web .file-reference-arrow {
  color: #c4b5fd;
}
.file-reference.web .file-reference-label {
  color: #ede9fe;
}
.file-reference-copy {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-width: 0;
}
.file-reference-label,
.file-reference-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.file-reference-label {
  color: #dbeafe;
  font-size: 11px;
}
.file-reference-path {
  margin-top: 2px;
  color: #7d8db0;
  font-size: 9px;
}
.file-reference-arrow {
  flex: none;
  color: #7dd3fc;
  font-size: 15px;
}
.file-reference-actions {
  display: flex;
  align-items: center;
  gap: 5px;
  flex: none;
}
.reference-action {
  height: 24px;
  margin: 0;
  padding: 0 8px;
  border: 1px solid rgba(125, 211, 252, 0.24);
  border-radius: 99px;
  background: rgba(56, 189, 248, 0.08);
  color: #bae6fd;
  font-size: 10px;
  line-height: 22px;
}
.reference-action.preview {
  border-color: rgba(196, 181, 253, 0.28);
  background: rgba(167, 139, 250, 0.1);
  color: #ddd6fe;
}
.reference-action.edit {
  border-color: rgba(251, 191, 36, 0.28);
  background: rgba(251, 191, 36, 0.08);
  color: #fde68a;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 25px;
  height: 25px;
  padding: 0;
}
.reference-action.edit .mask-icon {
  width: 13px;
  height: 13px;
}
.reference-action::after {
  border: 0;
}
.markdown-content :deep(div),
.markdown-content :deep(p) {
  margin: 0;
}
.markdown-paragraph,
.markdown-heading,
.markdown-quote {
  display: block;
}
.markdown-paragraph + .markdown-paragraph,
.markdown-paragraph + .markdown-list,
.markdown-list + .markdown-paragraph,
.markdown-code-scroll + .markdown-paragraph,
.markdown-paragraph + .markdown-code-scroll,
.markdown-heading + .markdown-paragraph,
.markdown-quote + .markdown-paragraph {
  margin-top: 9px;
}
.markdown-heading {
  display: block;
  margin: 3px 0 7px;
  color: #f3f6fb;
  font-weight: 700;
}
.heading-1 { font-size: 18px; }
.heading-2 { font-size: 16px; }
.heading-3 { font-size: 14px; }
.heading-4,
.heading-5,
.heading-6 { font-size: 13px; }
.markdown-list {
  display: block;
  margin-top: 5px;
}
.markdown-list-item {
  display: flex;
  align-items: flex-start;
  gap: 7px;
  margin: 4px 0;
}
.list-marker {
  flex: none;
  min-width: 14px;
  color: #f0a06a;
}
.markdown-quote {
  margin-top: 7px;
  padding-left: 10px;
  border-left: 2px solid rgba(240, 160, 106, 0.7);
  color: #a9b7d3;
}
.markdown-code-scroll {
  display: block;
  width: 100%;
  margin-top: 8px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 6px;
  background: #0b1020;
}
.markdown-code {
  min-width: 100%;
  padding: 10px 11px;
  box-sizing: border-box;
}
.code-language {
  display: block;
  margin-bottom: 5px;
  color: #e0a77b;
  font-size: 10px;
  text-transform: uppercase;
}
.code-text {
  display: block;
  color: #d8e0ef;
  font-size: 11px;
  line-height: 1.65;
  white-space: pre;
}

.thinking {
  position: relative;
  display: inline-flex;
  align-items: center;
  gap: 7px;
  padding: 7px 10px;
  border: 1px solid #252c3b;
  border-radius: 9px;
  background: #111622;
  max-width: 100%;
  animation: message-enter 0.24s ease-out both;
}
.thinking-dots {
  display: flex;
  align-items: center;
  gap: 4px;
}
.thinking-dots view {
  width: 6px;
  height: 6px;
  border-radius: 50%;
  background: #e8703a;
  animation: thinking 1s ease-in-out infinite;
}
.thinking-dots view:nth-child(2) {
  animation-delay: 0.14s;
}
.thinking-dots view:nth-child(3) {
  animation-delay: 0.28s;
}
.thinking-text {
  flex: none;
  color: #a9b7d3;
  font-size: 11px;
}
.thinking-progress {
  width: 42px;
  height: 3px;
  flex: none;
  border-radius: 99px;
  background: rgba(232, 112, 58, 0.16);
  overflow: hidden;
}
.thinking-progress-value {
  width: 18px;
  height: 3px;
  border-radius: 99px;
  background: #e8703a;
  animation: execution-progress 1.15s cubic-bezier(0.65, 0, 0.35, 1) infinite;
}
.thinking-shimmer {
  position: absolute;
  left: 1px;
  right: 1px;
  bottom: 1px;
  height: 2px;
  border-radius: 0 0 8px 8px;
  overflow: hidden;
}
.thinking-shimmer view {
  width: 38%;
  height: 100%;
  background: linear-gradient(90deg, rgba(232, 112, 58, 0), #e8703a, rgba(232, 112, 58, 0));
  animation: chat-shimmer 1.6s linear infinite;
}

.preview-layer {
  position: fixed;
  left: 0;
  right: 0;
  top: 0;
  bottom: 0;
  z-index: 1002;
  display: flex;
  padding: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 8px)
    calc(env(safe-area-inset-right, 0px) + 8px)
    calc(env(safe-area-inset-bottom, 0px) + 8px)
    calc(env(safe-area-inset-left, 0px) + 8px);
  box-sizing: border-box;
}
.preview-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.68);
}
.preview-drawer {
  position: relative;
  display: flex;
  flex-direction: column;
  width: 100%;
  min-height: 0;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 14px;
  overflow: hidden;
  background: #0b1020;
  box-shadow: 0 20px 50px rgba(0, 0, 0, 0.45);
  animation: preview-in 0.24s cubic-bezier(0.32, 0.72, 0, 1);
}
.preview-drawer-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 10px;
  min-height: 54px;
  flex: none;
  padding: 9px 10px;
  box-sizing: border-box;
  border-bottom: 1px solid rgba(255, 255, 255, 0.08);
  background: #111827;
}
.preview-file-meta {
  display: flex;
  align-items: center;
  gap: 9px;
  flex: 1 1 170px;
  min-width: 0;
}
.preview-file-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  flex: none;
  border-radius: 7px;
  background: rgba(56, 189, 248, 0.16);
  color: #7dd3fc;
  font-size: 12px;
  font-weight: 700;
}
.preview-file-copy {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.preview-file-name,
.preview-file-path {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.preview-file-name {
  color: #edf3ff;
  font-size: 13px;
  font-weight: 650;
}
.preview-file-path {
  margin-top: 3px;
  color: #71809d;
  font-size: 10px;
}
.preview-drawer-actions {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 6px;
  flex: 1 1 180px;
  min-width: 0;
}
.preview-action,
.preview-close {
  height: 28px;
  padding: 0 10px;
  border: 1px solid #2a3b60;
  border-radius: 6px;
  background: #142039;
  color: #b9c7e2;
  font-size: 11px;
  line-height: 26px;
}
.preview-action,
.preview-close {
  flex: none;
}
.preview-action.save {
  border-color: rgba(140, 230, 176, 0.4);
  background: rgba(140, 230, 176, 0.1);
  color: #8ce6b0;
}
.preview-close {
  border-color: rgba(248, 113, 113, 0.35);
  background: rgba(248, 113, 113, 0.08);
  color: #fca5a5;
}
.preview-loading,
.preview-binary {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  flex: 1;
  color: #8b93a7;
  font-size: 12px;
}
.preview-truncated {
  display: block;
  padding: 8px 12px;
  color: #fbbf24;
  font-size: 11px;
  border-bottom: 1px solid rgba(251, 191, 36, 0.12);
}
.preview-image {
  width: 100%;
  max-height: calc(100vh - 80px);
  object-fit: contain;
}
.preview-editor {
  display: block;
  width: 100%;
  height: 0;
  min-height: 0;
  flex: 1 1 0;
  padding: 14px;
  box-sizing: border-box;
  border: 0;
  outline: none;
  background: #080d19;
  color: #dbe4f5;
  font-size: 11px;
  line-height: 1.7;
  white-space: pre;
  overflow: auto;
}
.preview-markdown {
  height: 0;
  min-height: 0;
  flex: 1 1 0;
  padding: 16px;
  overflow-y: auto;
  touch-action: pan-y;
  color: #dbe4f5;
  font-size: 13px;
  line-height: 1.75;
}
.preview-source {
  height: 0;
  min-height: 0;
  flex: 1 1 0;
  background: #080d19;
  touch-action: pan-y;
}
.preview-source-line {
  display: flex;
  gap: 10px;
  min-height: 19px;
  padding: 0 12px;
}
.preview-source-no {
  width: 30px;
  flex: none;
  color: #4f5c76;
  font-size: 10px;
  line-height: 19px;
  text-align: right;
}
.preview-source-text {
  color: #dbe4f5;
  font-size: 11px;
  line-height: 19px;
  white-space: pre;
}
@keyframes preview-in {
  from { transform: translateY(14px) scale(0.99); opacity: 0.5; }
  to { transform: translateX(0); opacity: 1; }
}

.empty-state {
  padding-top: 88px;
  display: flex;
  flex-direction: column;
  align-items: center;
  text-align: center;
}
.empty-mark {
  width: 50px;
  height: 50px;
  display: flex;
  align-items: center;
  justify-content: center;
  margin-bottom: 14px;
  border-radius: 17px;
  background: conic-gradient(from 210deg, #e8703a, #b45cf0, #38bdf8, #e8703a);
  color: #150a10;
  font-size: 22px;
  font-weight: 800;
}
.empty-title {
  color: #e7ecf5;
  font-size: 16px;
  font-weight: 700;
}
.empty-description {
  max-width: 270px;
  margin-top: 7px;
  color: #8b93a7;
  font-size: 12px;
  line-height: 1.7;
}

.composer {
  position: relative;
  flex: none;
  width: 100%;
  max-width: 100%;
  box-sizing: border-box;
  padding: 8px 10px calc(10px + 82px + env(safe-area-inset-bottom, 0px));
  border-top: 1px solid rgba(255, 255, 255, 0.06);
  background: #0a0e18;
}

.keyboard-open .composer {
  position: fixed;
  right: 0;
  bottom: 0;
  left: 0;
  z-index: 20;
  padding-bottom: 10px;
}
.toolbar {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px 7px;
  width: 100%;
  min-height: 30px;
  margin-bottom: 8px;
}
.model-picker {
  flex: 0 0 auto;
  min-width: 0;
  max-width: 52vw;
  overflow: hidden;
}
.model-button {
  height: 29px;
  display: flex;
  align-items: center;
  gap: 5px;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  overflow: hidden;
}
.model-label {
  flex: none;
  color: #8b93a7;
  font-size: 11px;
}
.model-value {
  min-width: 0;
  max-width: 28vw;
  overflow: hidden;
  color: #dbe4f5;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.model-chevron {
  flex: none;
  color: #67738f;
  font-size: 9px;
}
.sandbox-group {
  display: flex;
  align-items: center;
  gap: 6px;
  flex: none;
}
.tool-button {
  height: 29px;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 27px;
}
.tool-button.active {
  border-color: rgba(232, 112, 58, 0.65);
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
}
.stop-button {
  height: 29px;
  flex: none;
  margin-left: 7px;
  padding: 0 10px;
  border: 1px solid rgba(248, 113, 113, 0.42);
  border-radius: 99px;
  background: rgba(248, 113, 113, 0.08);
  color: #f87171;
  font-size: 11px;
  line-height: 27px;
  opacity: 0.55;
}
.stop-button:disabled {
  color: #f87171;
}
.stop-button:not(:disabled) {
  opacity: 1;
}

.files-button {
  height: 29px;
  flex: none;
  margin-left: 7px;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 27px;
}

.image-button {
  height: 29px;
  flex: none;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 27px;
}

.screen-button {
  height: 29px;
  flex: none;
  margin-left: 7px;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 27px;
}

.command-button {
  height: 29px;
  flex: none;
  margin-left: 7px;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 11px;
  line-height: 27px;
}

.command-button.active {
  border-color: rgba(232, 112, 58, 0.65);
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
}

.command-panel {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% - 8px);
  height: min(50vh, 430px);
  max-height: calc(100vh - 118px);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  background: rgba(13, 18, 31, 0.86);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  z-index: 7;
}

.slash-panel {
  position: absolute;
  left: 8px;
  right: 8px;
  bottom: calc(100% - 8px);
  height: min(50vh, 430px);
  max-height: calc(100vh - 118px);
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 16px;
  background: rgba(13, 18, 31, 0.86);
  box-shadow: 0 24px 70px rgba(0, 0, 0, 0.42);
  backdrop-filter: blur(24px) saturate(180%);
  -webkit-backdrop-filter: blur(24px) saturate(180%);
  z-index: 7;
}

.slash-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  padding: 11px 11px 0;
}

.slash-title {
  color: #dbe4f5;
  font-size: 13px;
  font-weight: 650;
}

.slash-close {
  width: 24px;
  height: 24px;
  flex: none;
  margin: 0;
  padding: 0;
  border: 1px solid #2a3b60;
  border-radius: 50%;
  background: #142039;
  color: #a9b7d3;
  font-size: 14px;
  line-height: 22px;
}

.slash-list {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  padding: 9px 11px 11px;
  box-sizing: border-box;
}

.slash-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.055);
  text-align: left;
}

.slash-item + .slash-item {
  margin-top: 7px;
}

.slash-item:active {
  transform: scale(0.985);
}

.slash-item:disabled {
  opacity: 0.55;
}

.slash-icon {
  width: 28px;
  height: 28px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(232, 112, 58, 0.2);
  border-radius: 8px;
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
  font-size: 12px;
}

.slash-copy {
  min-width: 0;
  flex: 1;
}

.slash-label {
  display: block;
  color: #dbe4f5;
  font-size: 11px;
  line-height: 1.3;
}

.slash-detail {
  display: block;
  margin-top: 2px;
  color: #77839c;
  font-size: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.slash-empty {
  display: block;
  padding: 12px 2px;
  color: #8b93a7;
  font-size: 10px;
  text-align: center;
}

.command-scroll {
  flex: 1 1 auto;
  min-height: 0;
  max-height: none;
  padding: 11px;
  box-sizing: border-box;
}

.command-head {
  display: flex;
  flex: none;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 9px;
}

.command-heading {
  min-width: 0;
}

.command-title {
  display: block;
  color: #dbe4f5;
  font-size: 13px;
  font-weight: 650;
}

.command-status {
  display: block;
  margin-top: 2px;
  color: #8b93a7;
  font-size: 10px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-close {
  width: 26px;
  height: 26px;
  flex: none;
  border: 1px solid #2a3b60;
  border-radius: 50%;
  background: #142039;
  color: #a9b7d3;
  font-size: 15px;
  line-height: 24px;
}

.command-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 7px;
}

.command-tile {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 44px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.055);
  text-align: left;
  transition: transform 0.18s cubic-bezier(0.34, 1.56, 0.64, 1), opacity 0.18s ease;
}

.command-tile:disabled {
  opacity: 0.55;
}

.command-tile:active {
  transform: scale(0.97);
}

.command-tile.danger {
  border-color: rgba(225, 29, 72, 0.32);
  background: rgba(225, 29, 72, 0.08);
}

.command-tile.danger .command-label {
  color: #fb7185;
}

.command-tile.danger .command-detail {
  color: rgba(251, 113, 133, 0.68);
}

.command-tile.danger .command-icon {
  border-color: rgba(225, 29, 72, 0.24);
  background: rgba(225, 29, 72, 0.12);
  color: #fb7185;
}

.command-icon {
  width: 28px;
  height: 28px;
  flex: none;
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px solid rgba(232, 112, 58, 0.2);
  border-radius: 8px;
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
  font-size: 12px;
}

.command-copy {
  min-width: 0;
  flex: 1;
}

.command-label {
  display: block;
  color: #dbe4f5;
  font-size: 11px;
  line-height: 1.3;
}

.command-detail {
  display: block;
  margin-top: 2px;
  color: #77839c;
  font-size: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-busy {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 7px;
  margin-top: 8px;
  color: #8b93a7;
  font-size: 10px;
}

.command-spinner {
  width: 11px;
  height: 11px;
  border: 2px solid rgba(240, 160, 106, 0.22);
  border-top-color: #f0a06a;
  border-radius: 50%;
  animation: command-spin 0.8s linear infinite;
}

.command-sub {
  margin-top: 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 9px;
}

.command-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 10px;
}

.command-row + .command-row {
  margin-top: 7px;
}

.command-row-label {
  flex: none;
  width: 44px;
  color: #77839c;
  font-size: 10px;
  line-height: 18px;
}

.command-row-value {
  min-width: 0;
  flex: 1;
  color: #cfd9ee;
  font-size: 10px;
  line-height: 18px;
  text-align: right;
  overflow-wrap: anywhere;
}

.command-form {
  margin-top: 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 9px;
}

.command-textarea {
  width: 100%;
  min-height: 62px;
  max-height: 112px;
  box-sizing: border-box;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 10px;
  background: rgba(0, 0, 0, 0.22);
  padding: 8px;
  color: #dbe4f5;
  font-size: 11px;
  line-height: 1.55;
}

.command-primary {
  height: 30px;
  margin-top: 7px;
  border: 1px solid rgba(232, 112, 58, 0.45);
  border-radius: 9px;
  background: rgba(232, 112, 58, 0.14);
  color: #f0a06a;
  font-size: 11px;
  line-height: 28px;
}

.command-primary:disabled {
  opacity: 0.45;
}

.command-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}

.command-chip {
  min-width: 54px;
  height: 27px;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 99px;
  background: rgba(255, 255, 255, 0.06);
  color: #a9b7d3;
  font-size: 10px;
  line-height: 25px;
  text-transform: uppercase;
}

.command-chip.active {
  border-color: rgba(232, 112, 58, 0.6);
  background: rgba(232, 112, 58, 0.13);
  color: #f0a06a;
}

.command-list {
  margin-top: 9px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
  padding-top: 9px;
}

.command-group-label {
  margin: 12px 0 6px;
}

.command-group-label text {
  color: #9fb6d4;
  font-size: 10px;
  font-weight: 650;
}

.command-item {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 42px;
  padding: 7px;
  border: 1px solid rgba(255, 255, 255, 0.07);
  border-radius: 10px;
  background: rgba(255, 255, 255, 0.04);
  text-align: left;
}

.command-item + .command-item,
.command-item + .command-empty,
.command-empty + .command-item {
  margin-top: 6px;
}

.command-item.static,
.command-item:disabled {
  opacity: 0.96;
}

.command-item.active {
  border-color: rgba(232, 112, 58, 0.42);
  background: rgba(232, 112, 58, 0.1);
}

.command-item-main {
  min-width: 0;
  flex: 1;
}

.command-item-title {
  display: block;
  color: #dbe4f5;
  font-size: 11px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-item-detail {
  display: block;
  margin-top: 2px;
  color: #77839c;
  font-size: 9px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.command-item-time {
  flex: none;
  max-width: 68px;
  color: #6a748c;
  font-size: 9px;
  text-align: right;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.command-running-badge {
  flex: none;
  padding: 2px 5px;
  border-radius: 5px;
  background: rgba(232, 112, 58, 0.16);
  color: #f0a06a;
  font-size: 9px;
  line-height: 15px;
}
.command-item-actions {
  display: flex;
  flex: none;
  align-items: center;
  gap: 6px;
}
.command-item-delete {
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

.command-state {
  flex: none;
  padding: 3px 7px;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 99px;
  color: #8b93a7;
  font-size: 9px;
}

.command-state.on {
  border-color: rgba(140, 230, 176, 0.32);
  background: rgba(140, 230, 176, 0.09);
  color: #8ce6b0;
}

.command-empty {
  display: block;
  padding: 10px 2px;
  color: #8b93a7;
  font-size: 10px;
  text-align: center;
}

@keyframes command-spin {
  to { transform: rotate(360deg); }
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .command-panel {
    background: #101728;
  }
}

.image-button:disabled {
  opacity: 0.55;
}

.attachment-bar {
  display: flex;
  align-items: center;
  gap: 9px;
  width: 100%;
  min-height: 58px;
  margin-bottom: 8px;
  padding: 8px;
  border: 1px solid #253353;
  border-radius: 12px;
  background: #101728;
  box-sizing: border-box;
}

.attachment-thumb {
  width: 40px;
  height: 40px;
  flex: none;
  border-radius: 8px;
  background: #05070d;
}

.attachment-copy {
  flex: 1;
  min-width: 0;
}

.attachment-name {
  display: block;
  overflow: hidden;
  color: #dbe4f5;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.attachment-progress {
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 6px;
}

.attachment-progress-track {
  flex: 1;
  height: 3px;
  border-radius: 99px;
  background: #1d2942;
  overflow: hidden;
}

.attachment-progress-value {
  height: 3px;
  border-radius: 99px;
  background: #e8703a;
}

.attachment-progress-text {
  color: #8b93a7;
  font-size: 10px;
}

.attachment-remove {
  width: 26px;
  height: 26px;
  flex: none;
  margin: 0;
  padding: 0;
  border: 1px solid #253353;
  border-radius: 50%;
  background: #0e1526;
  color: #8b93a7;
  font-size: 14px;
  line-height: 23px;
}

.followup-guide {
  margin-top: 8px;
}

.followup-guide-toggle {
  display: flex;
  width: 68px;
  height: 26px;
  align-items: center;
  justify-content: space-between;
  margin: 0;
  padding: 0 8px;
  border: 1px solid rgba(232, 112, 58, 0.22);
  border-radius: 8px;
  background: rgba(232, 112, 58, 0.08);
  color: #f0a06a;
  font-size: 10px;
  line-height: 24px;
}

.followup-chevron {
  color: #98a3ba;
  font-size: 9px;
}

.followup-guide-scroll {
  width: 100%;
  height: 30px;
  margin-top: 6px;
  white-space: nowrap;
}

.followup-guide-list {
  display: flex;
  width: max-content;
  gap: 6px;
  padding: 1px 2px 2px;
  box-sizing: border-box;
}

.followup-guide-chip {
  flex: none;
  height: 27px;
  min-width: 52px;
  margin: 0;
  padding: 0 9px;
  border: 1px solid rgba(255, 255, 255, 0.1);
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.06);
  color: #c8d2e6;
  font-size: 10px;
  line-height: 25px;
}

.followup-guide-chip:active {
  border-color: rgba(232, 112, 58, 0.5);
  background: rgba(232, 112, 58, 0.13);
}

.composer-main {
  display: flex;
  width: 100%;
  max-width: 100%;
  align-items: flex-end;
  gap: 8px;
}

.message-image {
  width: 190px;
  height: 138px;
  margin-bottom: 7px;
  border: 1px solid #2c395c;
  border-radius: 11px;
  background: #05070d;
}
.prompt-input {
  display: block;
  flex: 1 1 0;
  width: 0;
  min-width: 0;
  min-height: 42px;
  max-height: 118px;
  box-sizing: border-box;
  padding: 10px 12px;
  border: 1px solid #223052;
  border-radius: 13px;
  background: #0e1526;
  color: #e7ecf5;
  font-size: 13px;
  line-height: 1.55;
}
.prompt-placeholder {
  color: #5c6579;
}
.send-button {
  width: 42px;
  height: 42px;
  flex: none;
  border-radius: 13px;
  background: #e8703a;
  color: #ffffff;
  font-size: 19px;
  line-height: 42px;
}
.send-button.busy {
  position: relative;
  background: #b85a30;
  color: transparent;
  transition: background-color 0.18s ease, transform 0.18s ease;
}
.send-spinner {
  position: absolute;
  top: 13px;
  left: 13px;
  width: 16px;
  height: 16px;
  border: 2px solid rgba(255, 255, 255, 0.34);
  border-top-color: #ffffff;
  border-radius: 50%;
  animation: send-rotate 0.78s linear infinite;
}

.send-button.stop {
  background: #dc2626;
}
.send-button.append {
  background: #e8703a;
}
.send-button.continue {
  width: 52px;
  background: #0f766e;
  font-size: 13px;
}
.send-button.stop:active {
  transform: scale(0.94);
}
.stop-glyph {
  display: block;
  width: 13px;
  height: 13px;
  margin: 14px auto 0;
  border-radius: 3px;
  background: #ffffff;
}

.edit-sheet {
  margin-top: 8px;
  padding: 10px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  border-radius: 12px;
  background: #101728;
}
.edit-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 7px;
}
.edit-title {
  color: #dbe4f5;
  font-size: 12px;
}
.edit-textarea {
  display: block;
  width: 100%;
  height: 96px;
  box-sizing: border-box;
  padding: 8px 10px;
  border: 1px solid #223052;
  border-radius: 9px;
  background: #0e1526;
  color: #e7ecf5;
  font-size: 13px;
  line-height: 1.5;
  overflow-y: auto;
}
.edit-actions {
  display: flex;
  justify-content: flex-end;
  gap: 7px;
  margin-top: 7px;
}
.edit-cancel,
.edit-send {
  width: auto;
  height: 29px;
  margin: 0;
  padding: 0 11px;
  border-radius: 99px;
  font-size: 11px;
  line-height: 27px;
}
.edit-cancel {
  border: 1px solid rgba(255, 255, 255, 0.12);
  background: rgba(255, 255, 255, 0.05);
  color: #a9b7d3;
}
.edit-send {
  border: 1px solid transparent;
  background: #e8703a;
  color: #ffffff;
}
.edit-send[disabled] {
  opacity: 0.5;
}

.queued-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  margin-top: 8px;
  padding: 8px 9px;
  border: 1px solid rgba(232, 112, 58, 0.24);
  border-radius: 11px;
  background: rgba(232, 112, 58, 0.08);
}
.queued-copy {
  min-width: 0;
  flex: 1;
}
.queued-item {
  display: flex;
  align-items: center;
  gap: 6px;
  min-width: 0;
  margin-top: 4px;
}
.queued-item .queued-text {
  flex: 1;
  min-width: 0;
}
.queued-label {
  display: block;
  margin-bottom: 3px;
  color: #f0a06a;
  font-size: 10px;
}
.queued-text {
  display: block;
  overflow: hidden;
  color: #e7ecf5;
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  text-overflow: ellipsis;
}
.queued-remove {
  width: 24px;
  height: 24px;
  flex: none;
  margin: 0;
  padding: 0;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 50%;
  background: rgba(255, 255, 255, 0.05);
  color: #a9b7d3;
  font-size: 14px;
  line-height: 22px;
}
.queued-clear {
  width: auto;
  padding: 0 7px;
  border-radius: 7px;
  font-size: 10px;
}

.notice-layer {
  position: fixed;
  top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 64px);
  left: 0;
  right: 0;
  display: flex;
  justify-content: center;
  padding: 0 14px;
  box-sizing: border-box;
  pointer-events: none;
}
.notice {
  max-width: 100%;
  box-sizing: border-box;
  padding: 8px 15px;
  border: 1px solid #33436e;
  border-radius: 99px;
  background: #1b2540;
  color: #dbe4f5;
  font-size: 12px;
  line-height: 1.45;
  text-align: center;
  box-shadow: 0 10px 28px rgba(0, 0, 0, 0.42);
}
.notice text {
  display: block;
  overflow-wrap: anywhere;
  white-space: normal;
}
.notice.error {
  border-color: rgba(248, 113, 113, 0.45);
  background: rgba(68, 23, 26, 0.94);
  color: #ffd9d9;
}

.theme-light.chat-screen {
  --focus-ring: rgba(232, 112, 58, 0.18);
  --shadow-soft: 0 1px 2px rgba(24, 39, 61, 0.04), 0 8px 22px rgba(24, 39, 61, 0.05);
  --success-light: #15803d;
  --danger-light: #dc2626;
  --warning-light: #d97706;
  background:
    radial-gradient(640px 420px at 88% -10%, rgba(232, 112, 58, 0.07), transparent 62%),
    radial-gradient(560px 440px at -10% 104%, rgba(56, 189, 248, 0.06), transparent 62%),
    #f4f6f9;
}

.chat-layout .chat-scroll {
  flex: 1;
  min-height: 0;
}

.inline-screen {
  position: fixed;
  top: 0;
  left: 0;
  right: auto;
  bottom: auto;
  width: calc(100vw - 24px);
  z-index: 996;
  overflow: hidden;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 18px;
  background: rgba(10, 14, 24, 0.88);
  box-shadow: 0 18px 40px rgba(0, 0, 0, 0.38);
  backdrop-filter: blur(24px) saturate(170%);
  -webkit-backdrop-filter: blur(24px) saturate(170%);
  transition: transform 0.3s cubic-bezier(0.34, 1.28, 0.44, 1), box-shadow 0.24s ease;
  will-change: transform;
}

.inline-screen.dragging {
  transition: none;
  box-shadow: 0 24px 54px rgba(0, 0, 0, 0.44);
}

.inline-screen-head {
  display: flex;
  align-items: center;
  gap: 8px;
  height: 38px;
  padding: 0 10px;
  border-bottom: 1px solid rgba(255, 255, 255, 0.07);
}

.inline-screen-title {
  flex: none;
  color: #dbe4f5;
  font-size: 12px;
  font-weight: 650;
}

.inline-screen-info {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  color: #8b93a7;
  font-size: 10px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.inline-screen-close {
  width: auto;
  height: 26px;
  flex: none;
  margin: 0;
  padding: 0 10px;
  border: 1px solid #253353;
  border-radius: 99px;
  background: #101728;
  color: #a9b7d3;
  font-size: 10px;
  line-height: 24px;
}

.inline-screen-body {
  height: 31vw;
  max-height: 230px;
  min-height: 150px;
  position: relative;
  background: #02040a;
}

.inline-screen-frame,
.inline-screen-empty {
  width: 100%;
  height: 100%;
}

.inline-screen-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  color: #5c6579;
  font-size: 12px;
}

.fullscreen-float-button {
  position: fixed;
  top: 14px;
  left: 8px;
  z-index: 997;
  display: flex;
  align-items: center;
  justify-content: center;
  width: 54px;
  height: 30px;
  border: 1px solid rgba(232, 112, 58, 0.38);
  border-radius: 99px;
  background: rgba(20, 26, 42, 0.9);
  color: #f0a06a;
  font-size: 11px;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.34);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
  transition: transform 0.22s cubic-bezier(0.34, 1.36, 0.44, 1);
}

.fullscreen-float-button.dragging {
  transform: scale(1.06);
}

.screen-fullscreen {
  position: fixed;
  inset: 0;
  z-index: 999;
  display: flex;
  flex-direction: column;
  box-sizing: border-box;
  padding: 0;
  background: rgba(3, 6, 13, 0.98);
}

.viewer-launch-button {
  position: absolute;
  top: 50%;
  right: calc(env(safe-area-inset-right, 0px) + 12px);
  z-index: 6;
  height: 42px;
  min-width: 42px;
  padding: 0 14px;
  border: 1px solid rgba(232, 112, 58, 0.38);
  border-radius: 99px;
  background: rgba(26, 27, 39, 0.88);
  color: #f0a06a;
  font-size: 12px;
  line-height: 40px;
  box-shadow: 0 10px 22px rgba(0, 0, 0, 0.34);
  backdrop-filter: blur(18px) saturate(160%);
  -webkit-backdrop-filter: blur(18px) saturate(160%);
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

.screen-full-toolbar {
  position: absolute;
  top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 8px);
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  right: calc(env(safe-area-inset-right, 0px) + 10px);
  z-index: 4;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  min-height: 36px;
  pointer-events: none;
}

.screen-full-title {
  min-width: 0;
  max-width: 18%;
  overflow: hidden;
  color: #8b93a7;
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}

.screen-full-button {
  height: 30px;
  flex: none;
  padding: 0 11px;
  border: 1px solid rgba(232, 112, 58, 0.38);
  border-radius: 99px;
  background: rgba(232, 112, 58, 0.1);
  color: #f0a06a;
  font-size: 11px;
  line-height: 28px;
}

.screen-full-actions {
  display: flex;
  flex: none;
  min-width: 0;
  gap: 7px;
  pointer-events: auto;
}

.screen-zoom-label {
  flex: none;
  min-width: 42px;
  color: #8b93a7;
  font-size: 10.5px;
  line-height: 30px;
  text-align: center;
}

.screen-full-button.settings-toggle.active {
  border-color: rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.12);
  color: #9bdcff;
}

.screen-full-button.viewer-button.icon {
  min-width: 30px;
  padding: 0;
}

.screen-full-button.viewer-button.active {
  border-color: rgba(56, 189, 248, 0.42);
  background: rgba(56, 189, 248, 0.12);
  color: #9bdcff;
}

.chat-screen-settings {
  position: absolute;
  top: calc(var(--status-bar-height, 0px) + env(safe-area-inset-top, 0px) + 52px);
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

.chat-setting-group {
  display: flex;
  gap: 6px;
}

.chat-setting-button {
  height: 26px;
  min-width: 44px;
  padding: 0 8px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 99px;
  background: rgba(19, 28, 48, 0.78);
  color: #8b93a7;
  font-size: 10.5px;
  line-height: 24px;
}

.chat-setting-button.active {
  border-color: rgba(232, 112, 58, 0.5);
  background: rgba(232, 112, 58, 0.14);
  color: #f0a06a;
}

.screen-full-surface {
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

.screen-full-frame,
.screen-full-empty {
  position: absolute;
}

.screen-full-frame {
  left: 50%;
  top: 50%;
  transform-origin: center center;
  will-change: width, height, transform;
}

.screen-full-empty {
  inset: 0;
  width: 100%;
  height: 100%;
}

.screen-full-empty {
  display: flex;
  align-items: center;
  justify-content: center;
  border: 1px dashed #2a3a60;
  color: #5c6579;
  font-size: 12px;
}

.chat-screen-controls {
  position: absolute;
  left: calc(env(safe-area-inset-left, 0px) + 10px);
  right: calc(env(safe-area-inset-right, 0px) + 10px);
  bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);
  z-index: 4;
  display: flex;
  align-items: center;
  gap: 6px;
  margin-top: 0;
  pointer-events: auto;
}

.chat-screen-controls.collapsed {
  position: absolute;
  left: 50%;
  bottom: calc(env(safe-area-inset-bottom, 0px) + 10px);
  z-index: 5;
  justify-content: center;
  margin-top: 0;
  transform: translateX(-50%);
}

.chat-controls-toggle {
  flex: none;
  min-width: 66px;
  height: 28px;
  padding: 0 10px;
  border: 1px solid rgba(56, 189, 248, 0.28);
  border-radius: 9px;
  background: rgba(17, 32, 50, 0.86);
  color: #9bdcff;
  font-size: 10.5px;
  line-height: 26px;
}

.chat-controls-toggle.collapsed {
  border-color: rgba(232, 112, 58, 0.34);
  background: rgba(26, 27, 39, 0.88);
  color: #f0a06a;
}

.chat-control-buttons {
  display: flex;
  flex: 1;
  min-width: 0;
  gap: 6px;
}

.chat-control-button {
  flex: 1;
  min-width: 0;
  height: 28px;
  padding: 0 5px;
  border: 1px solid rgba(255, 255, 255, 0.11);
  border-radius: 9px;
  background: rgba(18, 26, 46, 0.78);
  color: #a9b7d3;
  font-size: 10.5px;
  line-height: 26px;
}

.screen-full-hint {
  display: none;
  margin-top: 8px;
  color: #68738a;
  font-size: 10.5px;
  text-align: center;
}

.theme-light.chat-screen .fullscreen-float-button {
  border-color: rgba(232, 112, 58, 0.28);
  background: rgba(255, 255, 255, 0.9);
  color: #c2410c;
}

.theme-light.chat-screen .screen-fullscreen {
  background: rgba(244, 246, 249, 0.98);
}

.theme-light.chat-screen .screen-full-title,
.theme-light.chat-screen .screen-full-hint {
  color: #687386;
}

.theme-light.chat-screen .screen-full-button {
  border-color: rgba(232, 112, 58, 0.3);
  background: rgba(232, 112, 58, 0.1);
  color: #c2410c;
}

.theme-light.chat-screen .viewer-launch-button {
  border-color: rgba(24, 39, 61, 0.14);
  background: rgba(255, 255, 255, 0.86);
  color: #5f6b7e;
}

.theme-light.chat-screen .screen-full-button.settings-toggle.active {
  border-color: rgba(2, 132, 199, 0.38);
  background: rgba(56, 189, 248, 0.14);
  color: #0369a1;
}

.theme-light.chat-screen .chat-setting-button,
.theme-light.chat-screen .chat-control-button,
.theme-light.chat-screen .chat-controls-toggle {
  border-color: rgba(24, 39, 61, 0.13);
  background: rgba(255, 255, 255, 0.82);
  color: #63707f;
}

.theme-light.chat-screen .chat-controls-toggle.collapsed {
  border-color: rgba(232, 112, 58, 0.3);
  color: #c2410c;
}

.theme-light.chat-screen .chat-setting-button.active {
  border-color: rgba(232, 112, 58, 0.38);
  background: rgba(232, 112, 58, 0.12);
  color: #c2410c;
}

.theme-light.chat-screen .screen-full-surface {
  border: 1px solid rgba(24, 39, 61, 0.12);
  background: #e8ebf1;
}

.theme-light.chat-screen .inline-screen {
  border-color: rgba(255, 255, 255, 0.78);
  background: rgba(255, 255, 255, 0.88);
  box-shadow: 0 16px 34px rgba(24, 39, 61, 0.14);
}

.theme-light.chat-screen .inline-screen-head {
  border-bottom-color: rgba(24, 39, 61, 0.09);
}

.theme-light.chat-screen .inline-screen-title {
  color: #26324a;
}

.theme-light.chat-screen .inline-screen-info {
  color: #687386;
}

.theme-light.chat-screen .inline-screen-close {
  border-color: rgba(24, 39, 61, 0.14);
  background: rgba(255, 255, 255, 0.86);
  color: #5f6b7e;
}

.theme-light.chat-screen .inline-screen-body {
  background: #dfe4ec;
}

.theme-light.chat-screen .project-name,
.theme-light.chat-screen .message-time,
.theme-light.chat-screen .activity-time {
  color: #7a8496;
}

.theme-light.chat-screen .assistant-name,
.theme-light.chat-screen .file-change-pill.running .file-change-text,
.theme-light.chat-screen .shell-result.running {
  color: #c2410c;
}

.theme-light.chat-screen .assistant-meta {
  color: var(--text-secondary);
}

.theme-light.chat-screen .activity-icon,
.theme-light.chat-screen .shell-icon {
  border-color: rgba(24, 39, 61, 0.12);
  background: #f2f4f8;
  color: #64748b;
}

.theme-light.chat-screen .activity-icon.file,
.theme-light.chat-screen .file-change-icon,
.theme-light.chat-screen .preview-file-icon {
  border-color: rgba(14, 116, 144, 0.14);
  background: #e8f6fd;
  color: #0e7490;
}

.theme-light.chat-screen .activity-icon.think,
.theme-light.chat-screen .file-reference.web,
.theme-light.chat-screen .reference-action.preview {
  border-color: rgba(124, 58, 237, 0.14);
  background: #f6f4ff;
}

.theme-light.chat-screen .activity-icon.think,
.theme-light.chat-screen .file-reference.web .file-reference-icon,
.theme-light.chat-screen .file-reference.web .file-reference-arrow,
.theme-light.chat-screen .reference-action.preview {
  color: #7c3aed;
}

.theme-light.chat-screen .activity-row.running .activity-icon,
.theme-light.chat-screen .shell-card.running .shell-icon,
.theme-light.chat-screen .file-change-pill.running .file-change-icon {
  border-color: rgba(217, 119, 6, 0.2);
  background: #fff4e6;
  color: #d97706;
}

.theme-light.chat-screen .activity-row.failed .activity-icon,
.theme-light.chat-screen .shell-card.failed .shell-icon,
.theme-light.chat-screen .file-change-pill.failed .file-change-icon {
  border-color: rgba(220, 38, 38, 0.16);
  background: #feecec;
  color: #dc2626;
}

.theme-light.chat-screen .activity-title,
.theme-light.chat-screen .shell-label,
.theme-light.chat-screen .model-label,
.theme-light.chat-screen .thinking-text {
  color: #46536a;
}

.theme-light.chat-screen .activity-detail,
.theme-light.chat-screen .status-meta,
.theme-light.chat-screen .file-change-text,
.theme-light.chat-screen .file-reference-path,
.theme-light.chat-screen .preview-file-path,
.theme-light.chat-screen .attachment-progress-text {
  color: #67748a;
}

.theme-light.chat-screen .status-title {
  color: #dc2626;
}

.theme-light.chat-screen .status-chevron {
  color: #7a8496;
}

.theme-light.chat-screen .status-output {
  border-color: rgba(220, 38, 38, 0.16);
  background: #fff7f7;
}

.theme-light.chat-screen .status-output-text {
  color: #b91c1c;
}

.theme-light.chat-screen .file-change-pill,
.theme-light.chat-screen .shell-card,
.theme-light.chat-screen .file-reference,
.theme-light.chat-screen .attachment-bar,
.theme-light.chat-screen .message-image,
.theme-light.chat-screen .model-button,
.theme-light.chat-screen .tool-button,
.theme-light.chat-screen .files-button,
.theme-light.chat-screen .screen-button,
.theme-light.chat-screen .image-button,
.theme-light.chat-screen .attachment-remove {
  border-color: rgba(24, 39, 61, 0.13);
  background: #ffffff;
  box-shadow: var(--shadow-soft);
}

.theme-light.chat-screen .file-change-pill.running {
  border-color: rgba(217, 119, 6, 0.24);
}

.theme-light.chat-screen .file-change-pill.failed,
.theme-light.chat-screen .shell-card.failed {
  border-color: rgba(220, 38, 38, 0.24);
}

.theme-light.chat-screen .shell-chevron {
  background: #eef1f6;
}

.theme-light.chat-screen .shell-chevron-glyph,
.theme-light.chat-screen .model-chevron {
  color: #7a8496;
}
.theme-light.chat-screen .file-change-action {
  border-color: rgba(24, 39, 61, 0.12);
  background: #f5f7fa;
  color: #536079;
}
.theme-light.chat-screen .file-change-action.undo {
  background: #fff4e9;
  color: #c2410c;
}
.theme-light.chat-screen .file-change-action:disabled {
  opacity: 0.45;
}
.theme-light.chat-screen .file-change-text,
.theme-light.chat-screen .shell-output-text,
.theme-light.chat-screen .model-value,
.theme-light.chat-screen .attachment-name {
  color: #2c384d;
}

.theme-light.chat-screen .tool-button,
.theme-light.chat-screen .shell-glyph {
  color: #68758a;
}

.theme-light.chat-screen .file-change-add,
.theme-light.chat-screen .shell-result.success {
  color: var(--success-light);
}

.theme-light.chat-screen .file-change-del,
.theme-light.chat-screen .shell-result.failed {
  color: var(--danger-light);
}

.theme-light.chat-screen .shell-card.running {
  border-color: rgba(217, 119, 6, 0.24);
  background: #ffffff;
}

.theme-light.chat-screen .shell-output {
  border-color: rgba(24, 39, 61, 0.08);
  background: #f6f7fa;
}

.theme-light.chat-screen .status-icon {
  border-color: rgba(220, 38, 38, 0.18);
  background: #feecec;
  color: var(--danger-light);
}

.theme-light.chat-screen .status-title,
.theme-light.chat-screen .file-change-pill.failed .file-change-text {
  color: #b91c1c;
}

.theme-light.chat-screen .message-row.user .bubble {
  border-color: rgba(232, 112, 58, 0.24);
  background: linear-gradient(152deg, #fff3ea, #ffeadf);
  box-shadow: var(--shadow-soft);
}

.theme-light.chat-screen .message-row.assistant .bubble,
.theme-light.chat-screen .thinking {
  border-color: rgba(24, 39, 61, 0.1);
  background: #ffffff;
  box-shadow: var(--shadow-soft);
}

.theme-light.chat-screen .thinking-progress {
  background: rgba(224, 99, 37, 0.14);
}

.theme-light.chat-screen .thinking-progress-value {
  background: #e06325;
}

.theme-light.chat-screen .thinking-shimmer view {
  background: linear-gradient(90deg, rgba(224, 99, 37, 0), #e06325, rgba(224, 99, 37, 0));
}

.theme-light.chat-screen .message-text,
.theme-light.chat-screen .markdown-content,
.theme-light.chat-screen .preview-markdown {
  color: #273246;
}

.theme-light.chat-screen .file-reference,
.theme-light.chat-screen .reference-action {
  border-color: rgba(2, 132, 199, 0.18);
  background: #f3fbff;
}

.theme-light.chat-screen .file-reference.web,
.theme-light.chat-screen .reference-action.preview {
  border-color: rgba(124, 58, 237, 0.16);
  background: #f6f4ff;
}

.theme-light.chat-screen .file-reference-icon,
.theme-light.chat-screen .file-reference-arrow,
.theme-light.chat-screen .reference-action {
  color: #0369a1;
}

.theme-light.chat-screen .file-reference.web .file-reference-label {
  color: #6d28d9;
}

.theme-light.chat-screen .file-reference-label {
  color: #1d4ed8;
}

.theme-light.chat-screen .reference-action.preview {
  border-color: rgba(124, 58, 237, 0.18);
  color: #6d28d9;
}

.theme-light.chat-screen .reference-action.edit {
  border-color: rgba(180, 83, 9, 0.2);
  background: #fff8e9;
  color: #a16207;
}

.theme-light.chat-screen .markdown-heading,
.theme-light.chat-screen .preview-file-name {
  color: #1f2937;
}

.theme-light.chat-screen .markdown-quote {
  border-left-color: rgba(217, 119, 6, 0.72);
  color: #556379;
}

.theme-light.chat-screen .list-marker {
  color: #d97706;
}

.theme-light.chat-screen .markdown-code-scroll {
  border-color: rgba(24, 39, 61, 0.1);
  background: #f4f6fa;
}

.theme-light.chat-screen .markdown-code {
  background: transparent;
}

.theme-light.chat-screen .code-language {
  color: #b45309;
}

.theme-light.chat-screen .code-text,
.theme-light.chat-screen .preview-source-text,
.theme-light.chat-screen .preview-editor {
  color: #333f54;
}

.theme-light.chat-screen .preview-backdrop {
  background: rgba(31, 41, 55, 0.36);
}

.theme-light.chat-screen .preview-drawer {
  border-color: rgba(24, 39, 61, 0.1);
  background: #ffffff;
  box-shadow: 0 18px 44px rgba(24, 39, 61, 0.16);
}

.theme-light.chat-screen .preview-drawer-head {
  border-bottom-color: rgba(24, 39, 61, 0.1);
  background: #fbfcfe;
}

.theme-light.chat-screen .preview-action,
.theme-light.chat-screen .preview-close {
  border-color: rgba(24, 39, 61, 0.13);
  background: #ffffff;
  color: #445066;
}

.theme-light.chat-screen .preview-action.save {
  border-color: rgba(21, 128, 61, 0.24);
  background: #effaf3;
  color: #15803d;
}

.theme-light.chat-screen .preview-close {
  border-color: rgba(220, 38, 38, 0.22);
  background: #fff1f1;
  color: #dc2626;
}

.theme-light.chat-screen .preview-loading,
.theme-light.chat-screen .preview-binary {
  color: #67748a;
}

.theme-light.chat-screen .preview-truncated {
  border-bottom-color: rgba(180, 83, 9, 0.16);
  background: #fff8e9;
  color: #a16207;
}

.theme-light.chat-screen .preview-editor {
  background: #ffffff;
}

.theme-light.chat-screen .preview-source {
  background: #fbfcfd;
}

.theme-light.chat-screen .preview-source-no {
  color: #a4aebd;
}

.theme-light.chat-screen .empty-mark {
  color: #ffffff;
}

.theme-light.chat-screen .empty-title,
.theme-light.chat-screen .attachment-name {
  color: #202b3c;
}

.theme-light.chat-screen .empty-description {
  color: #66748b;
}

.theme-light.chat-screen .composer {
  border-top-color: rgba(24, 39, 61, 0.1);
  background: rgba(255, 255, 255, 0.9);
  box-shadow: 0 -8px 24px rgba(24, 39, 61, 0.05);
}

.theme-light.chat-screen .command-button {
  border-color: rgba(24, 39, 61, 0.13);
  background: #ffffff;
  color: #4c586d;
  box-shadow: var(--shadow-soft);
}

.theme-light.chat-screen .command-button.active {
  border-color: rgba(224, 99, 37, 0.38);
  background: #fff1e8;
  color: #c2410c;
}

.theme-light.chat-screen .slash-panel {
  border-color: rgba(24, 39, 61, 0.1);
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 18px 52px rgba(24, 39, 61, 0.14);
}

.theme-light.chat-screen .slash-title,
.theme-light.chat-screen .slash-label {
  color: #1f2937;
}

.theme-light.chat-screen .slash-detail {
  color: #68758a;
}

.theme-light.chat-screen .slash-close {
  border-color: rgba(24, 39, 61, 0.13);
  background: #ffffff;
  color: #4c586d;
}

.theme-light.chat-screen .slash-item {
  border-color: rgba(24, 39, 61, 0.1);
  background: rgba(255, 255, 255, 0.74);
}

.theme-light.chat-screen .slash-icon {
  border-color: rgba(224, 99, 37, 0.18);
  background: #fff1e8;
  color: #c2410c;
}

.theme-light.chat-screen .slash-empty {
  color: #68758a;
}

.theme-light.chat-screen .command-panel {
  border-color: rgba(24, 39, 61, 0.1);
  background: rgba(255, 255, 255, 0.86);
  box-shadow: 0 18px 52px rgba(24, 39, 61, 0.14);
}

.theme-light.chat-screen .command-title,
.theme-light.chat-screen .command-label,
.theme-light.chat-screen .command-item-title {
  color: #1f2937;
}

.theme-light.chat-screen .command-status,
.theme-light.chat-screen .command-detail,
.theme-light.chat-screen .command-row-label,
.theme-light.chat-screen .command-item-detail,
.theme-light.chat-screen .command-item-time,
.theme-light.chat-screen .command-empty,
.theme-light.chat-screen .command-busy {
  color: #68758a;
}

.theme-light.chat-screen .command-close {
  border-color: rgba(24, 39, 61, 0.13);
  background: #ffffff;
  color: #4c586d;
}

.theme-light.chat-screen .command-tile,
.theme-light.chat-screen .command-item,
.theme-light.chat-screen .command-chip {
  border-color: rgba(24, 39, 61, 0.1);
  background: rgba(255, 255, 255, 0.74);
}

.theme-light.chat-screen .command-icon {
  border-color: rgba(224, 99, 37, 0.18);
  background: #fff1e8;
  color: #c2410c;
}

.theme-light.chat-screen .command-tile.danger {
  border-color: rgba(190, 18, 60, 0.22);
  background: rgba(254, 226, 232, 0.72);
}

.theme-light.chat-screen .command-tile.danger .command-label {
  color: #be123c;
}

.theme-light.chat-screen .command-tile.danger .command-detail {
  color: rgba(190, 18, 60, 0.72);
}

.theme-light.chat-screen .command-tile.danger .command-icon {
  border-color: rgba(190, 18, 60, 0.18);
  background: #ffffff;
  color: #be123c;
}

.theme-light.chat-screen .command-row-value,
.theme-light.chat-screen .command-chip {
  color: #38445a;
}

.theme-light.chat-screen .command-sub,
.theme-light.chat-screen .command-form,
.theme-light.chat-screen .command-list {
  border-top-color: rgba(24, 39, 61, 0.1);
}

.theme-light.chat-screen .command-textarea {
  border-color: rgba(24, 39, 61, 0.12);
  background: #ffffff;
  color: #253044;
}

.theme-light.chat-screen .command-primary {
  border-color: rgba(224, 99, 37, 0.34);
  background: #fff1e8;
  color: #c2410c;
}

.theme-light.chat-screen .command-chip.active,
.theme-light.chat-screen .command-item.active {
  border-color: rgba(224, 99, 37, 0.34);
  background: #fff1e8;
}

.theme-light.chat-screen .command-chip.active {
  color: #c2410c;
}

.theme-light.chat-screen .command-state {
  border-color: rgba(24, 39, 61, 0.12);
  color: #67748a;
}

.theme-light.chat-screen .command-state.on {
  border-color: rgba(21, 128, 61, 0.24);
  background: #effaf3;
  color: #15803d;
}

@supports not ((backdrop-filter: blur(1px)) or (-webkit-backdrop-filter: blur(1px))) {
  .theme-light.chat-screen .command-panel {
    background: #ffffff;
  }
}

.theme-light.chat-screen .prompt-input {
  border-color: rgba(24, 39, 61, 0.14);
  background: #ffffff;
  color: #253044;
  box-shadow: 0 1px 2px rgba(24, 39, 61, 0.04);
}

.theme-light.chat-screen .prompt-placeholder {
  color: #97a1b1;
}

.theme-light.chat-screen .tool-button.active {
  border-color: rgba(224, 99, 37, 0.4) !important;
  background: #fff1e8 !important;
  color: #c2410c;
}

.theme-light.chat-screen .stop-button {
  border-color: rgba(220, 38, 38, 0.24);
  background: #fff1f1;
  color: #dc2626;
}

.theme-light.chat-screen .message-edit-button {
  border-color: rgba(24, 39, 61, 0.08);
  background: rgba(255, 255, 255, 0.74);
  color: rgba(83, 97, 117, 0.9);
  box-shadow: 0 6px 14px rgba(24, 39, 61, 0.07);
}

.theme-light.chat-screen .message-edit-button:active {
  border-color: rgba(224, 99, 37, 0.28);
  background: #fff1e8;
  color: #c2410c;
}

.theme-light.chat-screen .attachment-progress-track {
  background: #e5e9f0;
}

.theme-light.chat-screen .attachment-thumb {
  background: #f2f4f8;
}

.theme-light.chat-screen .files-button,
.theme-light.chat-screen .image-button,
.theme-light.chat-screen .attachment-remove {
  color: #4c586d;
}

.theme-light.chat-screen .attachment-progress-value {
  background: #e06325;
}

.theme-light.chat-screen .followup-guide-toggle {
  border-color: rgba(224, 99, 37, 0.18);
  background: #fff1e8;
  color: #c2410c;
}

.theme-light.chat-screen .followup-chevron {
  color: #8a6553;
}

.theme-light.chat-screen .followup-guide-chip {
  border-color: rgba(24, 39, 61, 0.1);
  background: #ffffff;
  color: #38445a;
}

.theme-light.chat-screen .send-button {
  background: linear-gradient(145deg, #f88b4c, #e06325);
  box-shadow: 0 6px 18px rgba(224, 99, 37, 0.2);
}

.theme-light.chat-screen .send-button.stop {
  background: #dc2626;
  box-shadow: 0 6px 18px rgba(220, 38, 38, 0.18);
}

.theme-light.chat-screen .send-button.append {
  background: linear-gradient(145deg, #f88b4c, #e06325);
}

.theme-light.chat-screen .edit-sheet {
  border-color: rgba(24, 39, 61, 0.1);
  background: #ffffff;
}

.theme-light.chat-screen .edit-title {
  color: #374357;
}

.theme-light.chat-screen .edit-textarea {
  border-color: rgba(24, 39, 61, 0.14);
  background: #f7f8fa;
  color: #253044;
}

.theme-light.chat-screen .edit-cancel,
.theme-light.chat-screen .queued-remove {
  border-color: rgba(24, 39, 61, 0.12);
  background: rgba(24, 39, 61, 0.03);
  color: #667387;
}

.theme-light.chat-screen .queued-bar {
  border-color: rgba(224, 99, 37, 0.18);
  background: #fff6f1;
}

.theme-light.chat-screen .queued-label {
  color: #c2410c;
}

.theme-light.chat-screen .queued-text {
  color: #374357;
}

.theme-light.chat-screen .notice,
.theme-light.chat-screen .notice.error {
  border-color: rgba(24, 39, 61, 0.1);
  background: rgba(255, 255, 255, 0.96);
  color: #374357;
  box-shadow: 0 12px 32px rgba(24, 39, 61, 0.12);
}

.theme-light.chat-screen .notice.error {
  border-color: rgba(220, 38, 38, 0.2);
  background: rgba(255, 243, 243, 0.96);
  color: #b91c1c;
}

@keyframes thinking {
  0%,
  100% {
    opacity: 0.35;
    transform: scale(0.85);
  }
  50% {
    opacity: 1;
    transform: scale(1.1);
  }
}
@keyframes execution-progress {
  0% {
    transform: translateX(-18px);
  }
  100% {
    transform: translateX(42px);
  }
}
@keyframes chat-shimmer {
  0% {
    transform: translateX(-120%);
  }
  100% {
    transform: translateX(280%);
  }
}
@keyframes send-rotate {
  to {
    transform: rotate(360deg);
  }
}
@keyframes message-enter {
  from {
    opacity: 0;
    transform: translateY(7px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.message-enter {
  animation: message-enter 0.36s cubic-bezier(0.22, 1, 0.36, 1) both;
}
</style>
