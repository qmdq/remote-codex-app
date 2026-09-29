import { ref } from "vue";
import type {
  AgentEnvelope,
  CodexProjectCandidate,
  CodexProjectSyncResult,
  CodexThreadSnapshot,
  CodexThreadSummary,
  ConnectionState,
  McpServer,
  ProjectSummary,
  RunningTurnSummary,
  SandboxMode,
  TimelineItem,
} from "../types/agent";

const SETTINGS_KEY = "remote-codex-settings";
const PROJECT_KEY = "remote-codex-project";
export const PENDING_FILE_KEY = "remote-codex-pending-file";

interface StoredSettings {
  serverUrl: string;
  token: string;
  deviceName: string;
}

export interface UploadFileSource {
  name: string;
  size: number;
  readChunkBase64(start: number, end: number): Promise<string>;
}

export interface UploadProgress {
  uploadId: string;
  received: number;
  total: number;
}

export interface PendingTurnSnapshot {
  id: string;
  turnId: string;
  text: string;
  imagePath?: string;
  imageLocalUrl?: string;
  ts: string;
  startedAt: number;
  status: "running" | "completed" | "failed" | "interrupted";
  confirmed?: boolean;
  projectId: string;
  sessionId?: string | null;
  threadId?: string | null;
}

export interface StartTurnResult {
  turnId: string;
  projectId: string;
  sessionId: string | null;
  threadId: string | null;
}

export class AgentClient {
  private socket: UniApp.SocketTask | null = null;
  private requests = new Map<string, {
    resolve: (message: AgentEnvelope) => void;
    reject: (error: Error) => void;
    timer: number;
  }>();
  private reconnectTimer: number | null = null;
  private replaySeqByScope = new Map<string, number>();
  private threadSwitching = false;
  private pendingThreadEvents: AgentEnvelope[] = [];
  private connecting = false;
  private eventSyncTimer: number | null = null;
  private eventSyncing = false;
  private projectSyncTimer: number | null = null;
  private manualClose = false;
  private pairCode = "";
  private runningTurns: RunningTurnSummary[] = [];
  private runningTurnsVersion = ref(0);
  private pendingFileDiffs = new Set<string>();

  settings: StoredSettings = {
    serverUrl: "ws://192.168.1.20:7800",
    token: "",
    deviceName: "RemoteCodex Phone",
  };
  state: ConnectionState = "offline";
  models = {
    choices: ["default"],
    default: "default",
  };
  previewInfo: { host: string; port: number } | null = null;
  projects: ProjectSummary[] = [];
  selectedProject: ProjectSummary | null = null;
  pendingTurns: PendingTurnSnapshot[] = [];
  supportsCodexProjectSync: boolean | null = null;
  supportsTerminal: boolean | null = null;
  terminalSupportsPty = false;
  timeline: TimelineItem[] = [];
  latestSeq = 0;
  onStateChange: ((state: ConnectionState, detail: string) => void) | null = null;
  onMessage: ((message: AgentEnvelope) => void) | null = null;
  onProjectsChange: ((projects: ProjectSummary[], selected: ProjectSummary | null) => void) | null = null;
  onTimelineChange: ((items: TimelineItem[]) => void) | null = null;
  onSequenceChange: ((seq: number) => void) | null = null;

  constructor() {
    const saved = uni.getStorageSync(SETTINGS_KEY) as StoredSettings | "";
    if (saved && typeof saved === "object") {
      this.settings = { ...this.settings, ...saved };
    }
    const projectId = uni.getStorageSync(PROJECT_KEY) as string;
    if (projectId) {
      this.selectedProject = { id: projectId, name: "Syncing...", normalized_path: "" };
    }
  }

  saveSettings(next: Partial<StoredSettings>) {
    this.settings = { ...this.settings, ...next };
    uni.setStorageSync(SETTINGS_KEY, this.settings);
    if (this.socket) {
      this.manualClose = true;
      this.socket.close({});
      this.cleanupAfterClose();
    }
    this.scheduleReconnect(80);
  }

  connect() {
    if (this.connecting || this.socket || !this.settings.serverUrl) {
      return;
    }
    if (!this.settings.token && !this.pairCode) {
      this.setState("offline", "未配对");
      return;
    }
    this.manualClose = false;
    this.setState("connecting", "Connecting");
    this.connecting = true;
    this.socket = uni.connectSocket({
      url: this.settings.serverUrl,
      success: () => undefined,
      fail: () => {
        this.connecting = false;
        this.socket = null;
        this.setState("offline", "Connection failed");
        this.scheduleReconnect(3000);
      },
    }) as UniApp.SocketTask;
    if (!this.socket) {
      this.connecting = false;
      this.setState("offline", "WebSocket unavailable");
      return;
    }
    this.socket.onOpen(() => {
      this.sendRaw({
        v: 1,
        id: this.newId(),
        type: this.settings.token ? "hello" : "pair.request",
        payload: this.settings.token
          ? { device_token: this.settings.token }
          : { code: this.pairCode, device_name: this.settings.deviceName },
      });
    });
    this.socket.onMessage(({ data }) => {
      try {
        this.handleMessage(JSON.parse(String(data)) as AgentEnvelope);
      } catch {
        this.setState("offline", "Invalid server message");
      }
    });
    this.socket.onClose(() => {
      this.cleanupAfterClose();
      if (!this.manualClose) {
        this.setState("offline", "Disconnected");
        this.scheduleReconnect(2500);
      }
    });
    this.socket.onError(() => {
      this.cleanupAfterClose();
      if (!this.manualClose) {
        this.setState("offline", "Connection error");
        this.scheduleReconnect(2500);
      }
    });
  }

  disconnect() {
    this.manualClose = true;
    this.clearReconnect();
    this.socket?.close({});
    this.cleanupAfterClose();
    this.setState("offline", "Disconnected");
  }

  requestPairing(code: string) {
    const normalized = code.trim();
    if (!/^\d{6}$/.test(normalized)) {
      throw new Error("请输入 6 位数字配对码");
    }
    this.pairCode = normalized;
    this.settings.token = "";
    uni.setStorageSync(SETTINGS_KEY, this.settings);
    this.disconnect();
    this.scheduleReconnect(80);
  }

  savePairingServer(serverUrl: string, deviceName: string) {
    this.pairCode = "";
    this.settings = {
      ...this.settings,
      serverUrl: serverUrl.trim(),
      deviceName: deviceName.trim() || "RemoteCodex Phone",
      token: "",
    };
    uni.setStorageSync(SETTINGS_KEY, this.settings);
    this.disconnect();
  }

  cancelPairing() {
    this.pairCode = "";
    this.disconnect();
  }

  request(type: string, payload: Record<string, any> = {}, timeout = 6000): Promise<AgentEnvelope> {
    if (!this.socket || this.state !== "online") {
      return Promise.reject(new Error("Not connected"));
    }
    const id = this.newId();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.requests.delete(id);
        reject(new Error(`${type} timed out`));
      }, timeout) as unknown as number;
      this.requests.set(id, { resolve, reject, timer });
      this.sendRaw({ v: 1, id, type, payload });
    });
  }

  async loadProjects() {
    const response = await this.request("project.list");
    this.projects = (response.payload?.projects || []) as ProjectSummary[];
    this.syncRunningTurns(response.payload?.running_turns);
    const savedId = uni.getStorageSync(PROJECT_KEY) as string;
    const nextSelected = this.projects.find((item) => item.id === savedId) || null;
    if (
      nextSelected?.id !== this.selectedProject?.id ||
      nextSelected?.current_session_id !== this.selectedProject?.current_session_id ||
      nextSelected?.codex_thread_id !== this.selectedProject?.codex_thread_id
    ) {
      this.selectedProject = nextSelected;
      this.resetTimeline();
    }
    this.notifyProjects();
    return this.projects;
  }

  async loadCodexProjects() {
    if (this.supportsCodexProjectSync === false) {
      throw new Error("当前 PC Agent 版本不支持 Codex 项目同步，请重启 backend\\start.bat 后再试");
    }
    const response = await this.request("codex.project.list", {}, 15000);
    return (response.payload?.projects || []) as CodexProjectCandidate[];
  }

  async importCodexProject(path: string, name = "") {
    const response = await this.request("codex.project.import", { path, name }, 10000);
    this.selectedProject = (response.payload?.selected || null) as ProjectSummary | null;
    this.projects = (response.payload?.projects || this.projects) as ProjectSummary[];
    if (this.selectedProject) {
      uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
    }
    this.resetTimeline(Number(response.payload?.latest_seq || 0));
    this.syncRunningTurns(response.payload?.running_turns);
    this.notifyProjects();
    await this.replay();
    return this.selectedProject;
  }

  async syncCodexProjectsAndSessions() {
    if (this.supportsCodexProjectSync === false) {
      throw new Error("当前 PC Agent 版本不支持 Codex 同步，请重启 backend\\start.bat 后再试");
    }
    const response = await this.request("codex.project.sync", {}, 60000);
    this.projects = (response.payload?.registered_projects || []) as ProjectSummary[];
    const savedId = uni.getStorageSync(PROJECT_KEY) as string;
    this.selectedProject = this.projects.find((item) => item.id === savedId)
      || this.selectedProject
      || null;
    this.notifyProjects();
    this.syncRunningTurns(response.payload?.running_turns);
    return {
      ...response.payload,
      projects: (response.payload?.projects || []) as CodexProjectCandidate[],
      registered_projects: this.projects,
    } as CodexProjectSyncResult;
  }

  async selectProject(project: ProjectSummary) {
    const response = await this.request("project.select", { project_id: project.id });
    this.selectedProject = (response.payload?.selected || project) as ProjectSummary;
    this.projects = (response.payload?.projects || this.projects) as ProjectSummary[];
    uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
    this.resetTimeline(Number(response.payload?.latest_seq || 0));
    this.notifyProjects();
    await this.replay();
  }

  async setProjectModel(project: ProjectSummary, model: string) {
    const response = await this.request("project.model", {
      project_id: project.id,
      model,
    });
    this.selectedProject = (response.payload?.selected || {
      ...project,
      model,
    }) as ProjectSummary;
    this.projects = (response.payload?.projects || this.projects) as ProjectSummary[];
    this.notifyProjects();
    return this.selectedProject;
  }

  async setProjectReasoning(project: ProjectSummary, effort: string) {
    const response = await this.request("thread.reasoning.set", {
      project_id: project.id,
      effort,
    });
    const next = String(response.payload?.reasoning_effort || effort);
    if (this.selectedProject?.id === project.id) {
      this.selectedProject = { ...this.selectedProject, reasoning_effort: next };
      this.notifyProjects();
    }
    return next;
  }

  async setProjectGoal(project: ProjectSummary, goal: string) {
    const response = await this.request("thread.goal.set", {
      project_id: project.id,
      goal,
    });
    if (this.selectedProject?.id === project.id) {
      this.selectedProject = { ...this.selectedProject, goal };
      this.notifyProjects();
    }
    return String(response.payload?.goal || goal);
  }

  async newThread(project: ProjectSummary) {
    this.threadSwitching = true;
    this.pendingThreadEvents = [];
    try {
      const response = await this.request("thread.new", { project_id: project.id });
      this.applyThreadSnapshot(response);
      this.resetTimeline(Number(response.payload?.latest_seq || 0));
      this.notifyProjects();
      await this.replay();
    } finally {
      this.threadSwitching = false;
      this.flushPendingThreadEvents();
    }
    return this.selectedProject;
  }

  async selectThread(project: ProjectSummary, sessionOrThreadId: string) {
    this.threadSwitching = true;
    this.pendingThreadEvents = [];
    const isSessionId = sessionOrThreadId.startsWith("sess_");
    try {
      const response = await this.request("thread.select", {
        project_id: project.id,
        session_id: isSessionId ? sessionOrThreadId : "",
        thread_id: isSessionId ? "" : sessionOrThreadId,
      }, 15000);
      this.applyThreadSnapshot(response);
      this.resetTimeline(Number(response.payload?.latest_seq || 0));
      this.notifyProjects();
      await this.replay();
    } finally {
      this.threadSwitching = false;
      this.flushPendingThreadEvents();
    }
    return this.selectedProject;
  }

  async listThreads(project: ProjectSummary) {
    const response = await this.request("thread.sessions", { project_id: project.id }, 20000);
    const rawSessions = Array.isArray(response.payload?.sessions)
      ? response.payload.sessions
      : [];
    const rawArchivedSessions = Array.isArray(response.payload?.archived_sessions)
      ? response.payload.archived_sessions
      : [];
    const normalizeTitle = (session: any) => ({
      ...session,
      title: String(session?.title || "").trim(),
    });
    return {
      current_session_id: response.payload?.current_session_id || null,
      current_thread_id: response.payload?.current_thread_id || null,
      is_new_thread: response.payload?.is_new_thread === true,
      sessions: rawSessions.map(normalizeTitle) as CodexThreadSummary[],
      archived_sessions: rawArchivedSessions.map(normalizeTitle) as CodexThreadSummary[],
    } as CodexThreadSnapshot;
  }

  async loadThreadStatus(project: ProjectSummary, threadId?: string) {
    const response = await this.request("thread.status", {
      project_id: project.id,
      thread_id: threadId || "",
    }, 20000);
    return response.payload as CodexThreadStatus;
  }

  async forkThread(prompt: string, ephemeral = false) {
    if (!this.selectedProject) throw new Error("Select a project first");
    const type = ephemeral ? "thread.side" : "thread.fork";
    const response = await this.request(type, {
      project_id: this.selectedProject.id,
      prompt,
      sandbox: this.selectedProject.default_sandbox || "workspace_write",
      model: this.selectedProject.model || "default",
    }, 8000);
    return String(response.payload?.turn_id || "");
  }

  async compressThread() {
    if (!this.selectedProject) throw new Error("Select a project first");
    const response = await this.request("thread.compress", {
      project_id: this.selectedProject.id,
      sandbox: this.selectedProject.default_sandbox || "workspace_write",
      model: this.selectedProject.model || "default",
    }, 8000);
    return String(response.payload?.turn_id || "");
  }

  async archiveThread() {
    if (!this.selectedProject) throw new Error("Select a project first");
    const response = await this.request("thread.archive", {
      project_id: this.selectedProject.id,
    }, 30000);
    this.selectedProject = (response.payload?.selected || null) as ProjectSummary | null;
    this.projects = (response.payload?.projects || this.projects) as ProjectSummary[];
    if (this.selectedProject) {
      uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
    }
    this.resetTimeline();
    this.notifyProjects();
  }

  async deleteThread(project: ProjectSummary, sessionOrThreadId: string) {
    const isSessionId = sessionOrThreadId.startsWith("sess_");
    if (!isSessionId) throw new Error("会话正在同步，请先刷新会话列表");
    const response = await this.request("thread.delete", {
      project_id: project.id,
      session_id: sessionOrThreadId,
    }, 30000);
    this.selectedProject = (response.payload?.selected || null) as ProjectSummary | null;
    this.projects = (response.payload?.projects || this.projects) as ProjectSummary[];
    if (this.selectedProject?.id === project.id) {
      uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
      this.resetTimeline();
    }
    this.notifyProjects();
    return response.payload as {
      session_id: string;
      deleted_current: boolean;
      replacement_session_id?: string | null;
    };
  }

  async deleteProject(project: ProjectSummary) {
    const response = await this.request("project.delete", {
      project_id: project.id,
    }, 15000);
    this.selectedProject = (response.payload?.selected || null) as ProjectSummary | null;
    this.projects = (response.payload?.projects || []) as ProjectSummary[];
    this.clearPendingTurns(project.id);
    if (this.selectedProject) {
      uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
      this.resetTimeline(Number(response.payload?.latest_seq || 0));
    } else {
      uni.removeStorageSync(PROJECT_KEY);
      this.resetTimeline();
    }
    this.syncRunningTurns(response.payload?.running_turns);
    this.notifyProjects();
    return response.payload as {
      project_id: string;
      selected: ProjectSummary | null;
      projects: ProjectSummary[];
    };
  }
  async listMcpServers() {
    const response = await this.request("mcp.list", {}, 30000);
    return {
      available: response.payload?.available !== false,
      servers: (response.payload?.servers || []) as McpServer[],
      detail: String(response.payload?.detail || ""),
    };
  }

  async createProject(name: string, path: string) {
    const response = await this.request("project.create", { name, path }, 10000);
    this.selectedProject = (response.payload?.selected || null) as ProjectSummary | null;
    this.projects = (response.payload?.projects || []) as ProjectSummary[];
    if (this.selectedProject) {
      uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
    }
    this.resetTimeline(Number(response.payload?.latest_seq || 0));
    this.notifyProjects();
    await this.replay();
  }

  async startTurn(
    prompt: string,
    sandbox: SandboxMode,
    project: ProjectSummary | null = this.selectedProject,
  ) {
    if (!project) {
      throw new Error("Select a project first");
    }
    const originSessionId = project.current_session_id || "";
    const unboundPendingTurns = originSessionId
      ? []
      : this.pendingTurns.filter((item) => (
        item.projectId === project.id &&
        !item.sessionId &&
        item.status === "running" &&
        !item.turnId
      ));
    const response = await this.request("turn.start", {
      project_id: project.id,
      session_id: originSessionId,
      prompt,
      sandbox,
      model: project.model || "default",
    }, 8000);
    this.syncRunningTurns(response.payload?.running_turns);
    const turnId = String(response.payload?.turn_id || "");
    const running = this.runningTurns.find((item) => item.turn_id === turnId);
    const responseSessionId = response.payload?.session_id || null;
    const responseThreadId = response.payload?.thread_id || null;
    const selected = (response.payload?.selected || null) as ProjectSummary | null;
    if (
      !originSessionId &&
      unboundPendingTurns.length === 1 &&
      running?.session_id &&
      running?.turn_id
    ) {
      this.attachPendingTurn(unboundPendingTurns[0].id, {
        turnId: running.turn_id,
        sessionId: running.session_id,
        threadId: running.thread_id,
      });
    }
    const selectedStillOnOrigin = Boolean(
      this.selectedProject?.id === project.id &&
      originSessionId &&
      (this.selectedProject.current_session_id || "") === originSessionId
    );
    const selectedMatchesOrigin = Boolean(
      selected &&
      selected.id === project.id &&
      (
        (selected.current_session_id || "") === originSessionId ||
        (running?.session_id && selected.current_session_id === running.session_id)
      ) &&
      selectedStillOnOrigin
    );
    const selectedBoundNewSession = Boolean(
      selected &&
      selected.id === project.id &&
      !originSessionId &&
      running?.session_id &&
      selected.current_session_id === running.session_id
    );
    if (Array.isArray(response.payload?.projects)) {
      this.projects = response.payload.projects as ProjectSummary[];
    }
    if ((selectedMatchesOrigin || selectedBoundNewSession) && selected) {
      this.selectedProject = selected;
      this.notifyProjects();
    }
    return {
      turnId,
      projectId: project.id,
      sessionId: running?.session_id || responseSessionId || String(selected?.current_session_id || "") || null,
      threadId: running?.thread_id || responseThreadId || null,
    };
  }

  registerPendingTurn(turn: PendingTurnSnapshot) {
    if (turn.turnId) {
      const existing = this.pendingTurns.find((item) => item.turnId === turn.turnId);
      if (existing) {
        this.pendingTurns = this.pendingTurns.map((item) => (
          item.turnId === turn.turnId ? { ...item, ...turn } : item
        ));
        this.syncRunningTurns([
          ...this.runningTurns.filter((item) => item.turn_id !== turn.turnId),
          {
            turn_id: turn.turnId,
            project_id: turn.projectId,
            session_id: turn.sessionId,
            thread_id: turn.threadId,
          },
        ]);
        return;
      }
    }
    this.pendingTurns = [...this.pendingTurns.filter((item) => item.id !== turn.id), turn];
    if (turn.status === "running" && turn.turnId) {
      this.syncRunningTurns([
        ...this.runningTurns,
        {
          turn_id: turn.turnId,
          project_id: turn.projectId,
          session_id: turn.sessionId,
          thread_id: turn.threadId,
        },
      ]);
    }
  }

  setPendingTurns(projectId: string, sessionId: string | null, turns: PendingTurnSnapshot[]) {
    this.pendingTurns = [...this.pendingTurns.filter((item) => (
      !(item.projectId === projectId && (
        sessionId ? item.sessionId === sessionId : !item.sessionId
      ))
    )), ...turns];
    const terminalTurnIds = new Set(turns
      .filter((item) => item.turnId && item.status !== "running")
      .map((item) => item.turnId));
    this.runningTurns = terminalTurnIds.size
      ? this.runningTurns.filter((item) => !terminalTurnIds.has(item.turn_id))
      : this.runningTurns;
    if (terminalTurnIds.size) this.runningTurnsVersion.value += 1;
  }

  updatePendingTurn(turnId: string, patch: Partial<PendingTurnSnapshot>) {
    if (!turnId) return;
    this.pendingTurns = this.pendingTurns.map((item) => (
      item.turnId === turnId ? { ...item, ...patch, turnId } : item
    ));
  }

  removePendingTurn(localId: string) {
    this.pendingTurns = this.pendingTurns.filter((item) => item.id !== localId);
  }

  attachPendingTurn(localId: string, patch: Partial<PendingTurnSnapshot>) {
    this.pendingTurns = this.pendingTurns.map((item) => (
      item.id === localId ? { ...item, ...patch } : item
    ));
  }

  clearPendingTurns(projectId?: string, sessionId?: string) {
    if (!projectId) {
      this.pendingTurns = [];
      return;
    }
    this.pendingTurns = this.pendingTurns.filter((item) => (
      item.projectId !== projectId || Boolean(sessionId && item.sessionId !== sessionId)
    ));
  }

  pendingTurnsFor(projectId: string, sessionId?: string, options?: { exactSession?: boolean }) {
    const exactSession = Boolean(options?.exactSession);
    return this.pendingTurns.filter((item) => {
      if (item.projectId !== projectId) return false;
      if (!exactSession && !sessionId) return true;
      if (exactSession) return (item.sessionId || null) === (sessionId || null);
      return item.sessionId === sessionId;
    });
  }

  hasRunningTurn(projectId: string, sessionId?: string) {
    const runningOnServer = this.runningTurns.some((item) => (
      item.project_id === projectId && item.session_id === (sessionId || "")
    ));
    if (runningOnServer) return true;
    return this.pendingTurns.some((item) => (
      item.projectId === projectId &&
      item.status === "running" &&
      (!sessionId || !item.sessionId || item.sessionId === sessionId)
    ));
  }

  runningTurnSignature() {
    void this.runningTurnsVersion.value;
    return this.runningTurns
      .map((item) => `${item.turn_id}:${item.project_id}:${item.session_id || ""}`)
      .sort()
      .join(",");
  }

  private syncRunningTurns(raw: any) {
    if (!Array.isArray(raw)) return;
    const next = raw;
    this.runningTurns = next.map((item: any) => ({
      turn_id: String(item?.turn_id || ""),
      project_id: String(item?.project_id || ""),
      session_id: item?.session_id || null,
      thread_id: item?.thread_id || null,
    })).filter((item: RunningTurnSummary) => item.turn_id && item.project_id);
    this.runningTurnsVersion.value += 1;
    this.pendingTurns = this.pendingTurns.filter((item) => (
      item.status !== "running" ||
      !item.turnId ||
      this.runningTurns.some((running) => running.turn_id === item.turnId)
    ));
  }

  getPreviewUrl(path: string) {
    if (!this.previewInfo || !this.selectedProject || !this.settings.token) {
      throw new Error("当前服务未提供网页预览");
    }
    const encodedPath = path
      .replace(/\\/g, "/")
      .split("/")
      .map((part) => encodeURIComponent(part))
      .join("/");
    const query = `token=${encodeURIComponent(this.settings.token)}&project_id=${encodeURIComponent(this.selectedProject.id)}`;
    return `http://${this.previewInfo.host}:${this.previewInfo.port}/preview/${encodedPath}?${query}`;
  }

  async interruptTurn() {
    if (!this.selectedProject) {
      throw new Error("Select a project first");
    }
    await this.request("turn.interrupt", {
      project_id: this.selectedProject.id,
      session_id: this.selectedProject.current_session_id || "",
    });
  }

  async loadCodexHistory(project = this.selectedProject, limit = 100) {
    if (!project) {
      return { messages: [] as Array<{ id: string; role: "user" | "assistant"; body: string; ts: string }>, source: "" };
    }
    const response = await this.request("codex.history", {
      project_id: project.id,
      session_id: project.current_session_id || "",
      thread_id: project.codex_thread_id || "",
      limit,
    }, 12000);
    const messages = (response.payload?.messages || []).map((item: any, index: number) => ({
      id: `${item.message_id || `${item.session_id || "history"}-${index}`}`,
      role: item.role === "assistant" ? "assistant" : "user",
      body: this.historyMessageBody(item),
      ts: String(item.ts || ""),
    }));
    return {
      messages,
      source: String(response.payload?.source || ""),
    };
  }

  private historyMessageBody(item: any) {
    const values = [item?.body, item?.text, item?.content, item?.message];
    for (const value of values) {
      const text = this.historyValueText(value);
      if (text.trim()) return text.trim();
    }
    return "";
  }

  private historyValueText(value: any): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value
        .map((part) => this.historyValueText(part))
        .filter((part) => part.trim())
        .join("\n");
    }
    if (value && typeof value === "object") {
      for (const key of ["text", "body", "content", "message", "value"]) {
        const text = this.historyValueText(value[key]);
        if (text.trim()) return text;
      }
    }
    return "";
  }

  async listFiles(path = "") {
    if (!this.selectedProject) {
      throw new Error("Select a project first");
    }
    const response = await this.request("file.list", {
      project_id: this.selectedProject.id,
      path,
    }, 10000);
    return {
      path: String(response.payload?.path || ""),
      entries: (response.payload?.entries || []) as Array<{
        name: string;
        path: string;
        type: "directory" | "file";
        size: number;
      }>,
      truncated: Boolean(response.payload?.truncated),
    };
  }

  async readFile(path: string, maxBytes = 320 * 1024) {
    if (!this.selectedProject) {
      throw new Error("Select a project first");
    }
    const response = await this.request("file.read", {
      project_id: this.selectedProject.id,
      path,
      max_bytes: maxBytes,
    }, 12000);
    return {
      path: String(response.payload?.path || path),
      name: String(response.payload?.name || ""),
      kind: String(response.payload?.kind || "binary") as "text" | "image" | "binary",
      mime: String(response.payload?.mime || "application/octet-stream"),
      size: Number(response.payload?.size || 0),
      truncated: Boolean(response.payload?.truncated),
      content: String(response.payload?.content || ""),
      dataUrl: String(response.payload?.data_url || ""),
    };
  }

  async writeFile(path: string, content: string) {
    if (!this.selectedProject) {
      throw new Error("Select a project first");
    }
    const response = await this.request("file.write", {
      project_id: this.selectedProject.id,
      path,
      content,
      encoding: "utf-8",
    }, 12000);
    return {
      path: String(response.payload?.path || path),
      name: String(response.payload?.name || ""),
      size: Number(response.payload?.size || 0),
      kind: String(response.payload?.kind || "text"),
      mime: String(response.payload?.mime || "text/plain"),
    };
  }

  async fileDiff(path: string) {
    if (!this.selectedProject) {
      throw new Error("Select a project first");
    }
    const response = await this.request("file.diff", {
      project_id: this.selectedProject.id,
      path,
    }, 10000);
    return {
      path: String(response.payload?.path || path),
      name: String(response.payload?.name || ""),
      diff: String(response.payload?.diff || ""),
      additions: this.optionalCount(response.payload?.additions)
        ?? this.diffLineCount(String(response.payload?.diff || ""), "+"),
      deletions: this.optionalCount(response.payload?.deletions)
        ?? this.diffLineCount(String(response.payload?.diff || ""), "-"),
    };
  }

  async revertFile(path: string) {
    if (!this.selectedProject) {
      throw new Error("Select a project first");
    }
    const response = await this.request("file.revert", {
      project_id: this.selectedProject.id,
      path,
    }, 12000);
    return {
      path: String(response.payload?.path || path),
      name: String(response.payload?.name || ""),
    };
  }

  async uploadFile(
    file: UploadFileSource,
    path: string,
    overwrite: boolean,
    onStarted: (uploadId: string) => void,
    onProgress: (progress: UploadProgress) => void,
    isCancelled: () => boolean,
  ) {
    if (!this.selectedProject) {
      throw new Error("Select a project first");
    }
    if (!Number.isFinite(file.size) || file.size < 0 || file.size > 20 * 1024 * 1024) {
      throw new Error("文件大小不能超过 20 MB");
    }

    const started = await this.request("file.upload.start", {
      project_id: this.selectedProject.id,
      path,
      size: file.size,
      overwrite,
    }, 10000);
    const uploadId = String(started.payload?.upload_id || "");
    if (!uploadId) {
      throw new Error("服务器未创建上传任务");
    }
    onStarted(uploadId);

    const chunkSize = Math.max(1, Number(started.payload?.chunk_size || 256 * 1024));
    let received = 0;
    let index = 0;
    try {
      while (received < file.size) {
        if (isCancelled()) throw new Error("上传已取消");
        const end = Math.min(received + chunkSize, file.size);
        const encoded = await file.readChunkBase64(received, end);
        const progress = await this.request("file.upload.chunk", {
          upload_id: uploadId,
          index,
          data: encoded,
        }, 20000);
        received = Number(progress.payload?.received_size ?? end);
        index = Number(progress.payload?.next_index ?? index + 1);
        onProgress({ uploadId, received, total: file.size });
      }
      if (isCancelled()) throw new Error("上传已取消");
      const completed = await this.request("file.upload.finish", {
        project_id: this.selectedProject.id,
        upload_id: uploadId,
      }, 12000);
      return completed.payload || {};
    } catch (error) {
      try {
        await this.request("file.upload.cancel", { upload_id: uploadId }, 4000);
      } catch {
        // The connection may have closed or the server may already have discarded it.
      }
      throw error;
    }
  }

  subscribeMetrics() {
    if (this.state === "online") {
      this.request("metrics.subscribe").catch(() => undefined);
    }
  }

  unsubscribeMetrics() {
    if (this.state === "online") {
      this.request("metrics.unsubscribe").catch(() => undefined);
    }
  }

  subscribeScreen(fps = 30, maxWidth?: number) {
    if (this.state === "online") {
      this.request("screen.subscribe", {
        fps,
        max_width: maxWidth,
      }).catch(() => undefined);
    }
  }

  async sendScreenInput(payload: {
    action:
      | "click" | "move" | "down" | "up"
      | "double_click" | "right_click" | "middle_click"
      | "scroll" | "key" | "text";
    x: number;
    y: number;
    screen_width: number;
    screen_height: number;
    origin_x?: number;
    origin_y?: number;
    real_width?: number;
    real_height?: number;
    delta?: number;
    key?: string;
    text?: string;
  }) {
    await this.request("screen.input", payload, 4000);
  }

  unsubscribeScreen() {
    if (this.state === "online") {
      this.request("screen.unsubscribe").catch(() => undefined);
    }
  }

  async startTerminal(projectId?: string, cols = 80, rows = 24) {
    const resolvedProjectId = projectId || this.selectedProject?.id;
    if (!resolvedProjectId) {
      throw new Error("请先选择项目");
    }
    if (this.supportsTerminal === false) {
      throw new Error("当前 PC Agent 不支持远程终端");
    }
    const response = await this.request("terminal.start", {
      project_id: resolvedProjectId,
      cols,
      rows,
    }, 10000);
    return response.payload || {};
  }

  async sendTerminalInput(data: string) {
    const response = await this.request("terminal.input", { data }, 8000);
    return response.payload || {};
  }

  async resizeTerminal(cols: number, rows: number) {
    const response = await this.request("terminal.resize", { cols, rows }, 5000);
    return response.payload || {};
  }

  async closeTerminal() {
    const response = await this.request("terminal.close", {}, 8000);
    return response.payload || {};
  }

  async syncProjectEvents() {
    await this.replay();
  }

  async replay() {
    const projectId = this.selectedProject?.id;
    if (!projectId) {
      return;
    }
    const scope = this.currentReplayScope();
    try {
      await this.request("event.replay", {
        project_id: projectId,
        session_id: scope.sessionId,
        thread_id: this.selectedProject?.codex_thread_id || "",
        after_seq: this.replaySeqByScope.get(scope.key) || 0,
        limit: 300,
      });
    } catch {
      this.setState("online", "Event replay failed");
    }
  }

  private resetTimeline(latestSeq = 0) {
    const scope = this.currentReplayScope();
    this.replaySeqByScope.delete(scope.key);
    this.latestSeq = Number.isFinite(latestSeq) ? Math.max(0, Math.floor(latestSeq)) : 0;
    this.timeline = [];
    this.onSequenceChange?.(this.latestSeq);
    this.notifyTimeline();
  }

  private currentReplayScope() {
    const projectId = this.selectedProject?.id || "";
    const sessionId = this.selectedProject?.current_session_id || "";
    return {
      key: `${projectId}|${sessionId}`,
      projectId,
      sessionId,
    };
  }

  private startEventSyncTimer() {
    if (this.eventSyncTimer !== null) {
      return;
    }
    this.eventSyncTimer = setInterval(() => {
      if (this.state !== "online" || !this.selectedProject || this.threadSwitching) {
        return;
      }
      if (this.eventSyncing) return;
      this.eventSyncing = true;
      this.replay()
        .catch(() => undefined)
        .finally(() => {
          this.eventSyncing = false;
        });
    }, 1200) as unknown as number;
  }

  private startProjectSyncTimer() {
    if (this.projectSyncTimer !== null) return;
    this.projectSyncTimer = setInterval(() => {
      if (this.state !== "online") return;
      this.loadProjects().catch(() => undefined);
    }, 5000) as unknown as number;
  }

  private stopEventSyncTimer() {
    if (this.eventSyncTimer === null) {
      return;
    }
    clearInterval(this.eventSyncTimer);
    this.eventSyncTimer = null;
  }

  private stopProjectSyncTimer() {
    if (this.projectSyncTimer === null) return;
    clearInterval(this.projectSyncTimer);
    this.projectSyncTimer = null;
  }

  private handleMessage(message: AgentEnvelope) {
    const requestId = message.id ? String(message.id) : "";
    if (requestId && this.requests.has(requestId)) {
      const pending = this.requests.get(requestId)!;
      clearTimeout(pending.timer);
      this.requests.delete(requestId);
      if (message.type === "error") {
        const error = new Error(message.payload?.message || "Agent request failed") as Error & { code?: string };
        error.code = String(message.payload?.code || "");
        pending.reject(error);
      } else {
        pending.resolve(message);
      }
    }

    switch (message.type) {
      case "ready":
        this.connecting = false;
        this.setState("online", "Connected");
        this.startEventSyncTimer();
        this.startProjectSyncTimer();
        this.supportsCodexProjectSync = message.payload?.capabilities?.codex_project_sync === true;
        this.supportsTerminal = message.payload?.capabilities?.terminal === true;
        this.terminalSupportsPty = message.payload?.capabilities?.terminal_pty === true;
        this.models = {
          choices: (message.payload?.models?.choices || this.models.choices) as string[],
          default: String(message.payload?.models?.default || "default"),
        };
        this.previewInfo = message.payload?.preview as { host: string; port: number } | null;
        this.loadProjects().then(() => this.replay()).catch(() => undefined);
        break;
      case "pair.approved":
        this.pairCode = "";
        this.saveSettings({ token: String(message.payload?.device_token || "") });
        this.connecting = false;
        this.setState("online", "Paired");
        this.startEventSyncTimer();
        this.startProjectSyncTimer();
        break;
      case "project.snapshot":
        if (message.payload?.projects) {
          this.projects = message.payload.projects as ProjectSummary[];
          if (message.payload.selected) {
            this.selectedProject = message.payload.selected as ProjectSummary;
            uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
          }
          const snapshotSeq = Number(message.payload.latest_seq);
          if (Number.isFinite(snapshotSeq)) {
            this.setLatestSeq(snapshotSeq);
          }
          this.syncRunningTurns(message.payload?.running_turns);
          this.notifyProjects();
        }
        break;
      case "codex.event":
      case "agent.event":
        this.syncTurnLifecycle(message);
        this.appendTimeline(message);
        break;
      case "event.synced":
        const syncedScope = String(message.payload?.session_id || "");
        if (
          message.payload?.project_id &&
          (
            message.payload.project_id !== this.selectedProject?.id ||
            syncedScope !== (this.selectedProject?.current_session_id || "")
          )
        ) {
          break;
        }
        const scope = this.currentReplayScope();
        const syncedSeq = Math.max(0, Math.floor(Number(message.payload?.latest_seq || 0)));
        this.setReplaySeq(scope.key, syncedSeq);
        this.setLatestSeq(syncedSeq);
        this.onMessage?.(message);
        break;
      case "metrics":
      case "screen.frame":
      case "terminal.ready":
      case "terminal.output":
      case "terminal.exit":
        this.onMessage?.(message);
        break;
      case "error":
        const code = String(message.payload?.code || "");
        if (code === "auth.invalid_token") {
          this.settings.token = "";
          uni.setStorageSync(SETTINGS_KEY, this.settings);
          this.disconnect();
          this.scheduleReconnect(3000);
          this.setState("offline", "Token rejected");
        } else if (code === "pair.invalid_code") {
          this.pairCode = "";
          this.disconnect();
          this.setState("offline", message.payload?.message || "Pairing failed");
        } else {
          this.onMessage?.(message);
        }
        break;
    }
  }

  private appendTimeline(message: AgentEnvelope) {
    if (this.threadSwitching) {
      this.pendingThreadEvents.push(message);
      return;
    }
    if (message.project_id && message.project_id !== this.selectedProject?.id) {
      return;
    }
    const currentSessionId = this.selectedProject?.current_session_id || "";
    const currentThreadId = this.selectedProject?.codex_thread_id || "";
    const scopeKey = `${this.selectedProject?.id || ""}|${currentSessionId}`;
    const messageSessionId = String(message.session_id || "");
    const messageThreadId = String(message.thread_id || "");
    if (messageSessionId && messageSessionId !== currentSessionId) {
      return;
    }
    if (!messageSessionId && !messageThreadId) {
      return;
    }
    if (currentThreadId && messageThreadId && messageThreadId !== currentThreadId) {
      return;
    }
    const seq = Number(message.seq || 0);
    if (seq && this.timeline.some((item) => item.seq === seq)) {
      return;
    }
    if (seq) {
      this.setReplaySeq(scopeKey, seq);
      this.setLatestSeq(seq);
    }
    const source = message.type === "codex.event" ? message.event || {} : message.payload || {};
    const type = String(source.type || source.code || message.type);
    const sourceItem = source.item || {};
    const itemType = this.normalizedItemType(sourceItem);
    const body = type === "item.completed" && itemType === "agent_message"
      ? String(sourceItem.text || "")
      : "";
    const turnId = String(source.turn_id || message.turn_id || "");
    const item: TimelineItem = {
      id: `${seq}-${type}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      seq,
      kind: message.type,
      type,
      itemType,
      itemId: String(sourceItem.id || ""),
      path: this.fileChangePaths(sourceItem)[0] || "",
      command: String(sourceItem.command || ""),
      output: String(sourceItem.aggregated_output || sourceItem.output || "").slice(0, 20000),
      exitCode: Number.isFinite(Number(sourceItem.exit_code)) ? Number(sourceItem.exit_code) : null,
      changedFiles: itemType === "file_change"
        ? Math.max(1, this.fileChangePaths(sourceItem).length)
        : 0,
      additions: this.fileChangeCount(sourceItem, "add"),
      deletions: this.fileChangeCount(sourceItem, "delete"),
      title: body ? "Codex 回复" : this.eventTitle(type, source),
      turnId,
      body,
      detail: this.eventDetail(type, source),
      status: this.eventStatus(type, source),
      ts: message.ts || new Date().toISOString(),
    };
    this.timeline = [item, ...this.timeline].slice(0, 300);
    this.notifyTimeline();
    if (
      itemType === "file_change" &&
      type === "item.completed" &&
      this.fileChangeStatsMissing(sourceItem)
    ) {
      this.hydrateFileChangeStats(item.id, this.fileChangePaths(sourceItem)[0] || "");
    }
  }

  private syncTurnLifecycle(message: AgentEnvelope) {
    if (message.history) return;
    const source = message.type === "codex.event" ? message.event || {} : message.payload || {};
    const type = String(source.type || source.code || message.type);
    const turnId = String(source.turn_id || message.turn_id || "");
    if (!turnId || !type.startsWith("turn.")) return;

    if (type === "turn.started") {
      this.runningTurns = [
        ...this.runningTurns.filter((item) => item.turn_id !== turnId),
        {
          turn_id: turnId,
          project_id: String(message.project_id || ""),
          session_id: message.session_id || null,
          thread_id: message.thread_id || null,
        },
      ].filter((item) => item.project_id);
      this.runningTurnsVersion.value += 1;
      return;
    }

    const terminal: Record<string, PendingTurnSnapshot["status"]> = {
      "turn.completed": "completed",
      "turn.failed": "failed",
      "turn.interrupted": "interrupted",
    };
    if (type === "turn.status") {
      const status = String(source.status || "");
      if (status === "completed") terminal[type] = "completed";
      else if (status === "failed") terminal[type] = "failed";
      else if (status === "interrupted") terminal[type] = "interrupted";
    }
    const nextStatus = terminal[type];
    if (!nextStatus) return;

    this.runningTurns = this.runningTurns.filter((item) => item.turn_id !== turnId);
    this.runningTurnsVersion.value += 1;
    this.pendingTurns = this.pendingTurns.map((item) => (
      item.turnId === turnId ? { ...item, status: nextStatus } : item
    ));
  }

  private flushPendingThreadEvents() {
    if (this.threadSwitching || !this.pendingThreadEvents.length) {
      return;
    }
    const pending = this.pendingThreadEvents;
    this.pendingThreadEvents = [];
    for (const message of pending) {
      this.appendTimeline(message);
    }
  }

  private setLatestSeq(seq: number) {
    const normalized = Number(seq);
    if (!Number.isFinite(normalized)) {
      return;
    }
    const next = Math.max(this.latestSeq, Math.max(0, Math.floor(normalized)));
    if (next === this.latestSeq) {
      return;
    }
    this.latestSeq = next;
    this.onSequenceChange?.(this.latestSeq);
  }

  private setReplaySeq(scopeKey: string, seq: number) {
    const normalized = Number(seq);
    if (!Number.isFinite(normalized) || normalized <= 0) return;
    this.replaySeqByScope.set(scopeKey, Math.max(
      this.replaySeqByScope.get(scopeKey) || 0,
      Math.floor(normalized),
    ));
  }

  private eventTitle(type: string, source: Record<string, any>) {
    if (source.code === "turn.status" || type.startsWith("turn.")) {
      const status = String(source.status || type.replace("turn.", "") || "changed");
      return {
        started: "任务进行中",
        running: "任务进行中",
        completed: "任务已完成",
        interrupted: "任务已中断",
        failed: "任务失败",
      }[status] || `任务状态：${status}`;
    }
    if (type === "item.started") {
      return this.itemTitle(source.item || {}, "进行中");
    }
    if (type === "item.completed") {
      return this.itemTitle(source.item || {}, "已完成");
    }
    return type.replace(/[._]/g, " ");
  }

  private itemTitle(item: Record<string, any>, suffix: string) {
    const itemType = this.normalizedItemType(item) || "item";
    const running = suffix === "进行中";
    const title = itemType === "command_execution"
      ? running ? "正在运行" : "已运行"
      : itemType === "file_change"
        ? running ? "正在编辑文件" : "已编辑文件"
        : itemType === "reasoning"
          ? running ? "正在思考" : "思考过程"
          : itemType === "agent_message"
            ? running ? "正在生成回复" : "生成回复"
            : this.humanizeItemType(itemType);
    return title;
  }

  private humanizeItemType(itemType: string) {
    const labels: Record<string, string> = {
      file_change: "文件变更",
      command_execution: "命令执行",
      reasoning: "思考过程",
      agent_message: "生成回复",
    };
    return labels[itemType] || itemType.replace(/[._]/g, " ");
  }

  private normalizedItemType(item: Record<string, any>) {
    return String(item?.type || "")
      .trim()
      .replace(/-/g, "_")
      .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
      .toLowerCase();
  }

  private fileChangePaths(item: Record<string, any>) {
    const raw = item.changes;
    const paths = new Set<string>();
    const push = (path: unknown) => {
      const value = String(path || "").trim();
      if (value) paths.add(value);
    };

    if (Array.isArray(raw)) {
      raw.forEach((change: any) => push(change?.path || change?.file));
    } else if (raw && typeof raw === "object") {
      Object.keys(raw).forEach((path) => push(path));
    }
    push(item.path || item.file);
    return [...paths];
  }

  private eventDetail(type: string, source: Record<string, any>) {
    if (source.code === "turn.status" || type.startsWith("turn.")) {
      const status = String(source.status || type.replace("turn.", ""));
      if (status !== "failed") return "";
      return this.errorMessage(source) || "Codex 任务失败";
    }
    if (type === "item.started" || type === "item.completed") {
      const item = source.item || {};
      if (this.normalizedItemType(item) === "command_execution") {
        return String(item.command || "");
      }
      if (this.normalizedItemType(item) === "file_change") {
        return this.fileChangePaths(item).join(", ");
      }
    }
    return "";
  }

  private errorMessage(source: Record<string, any>) {
    const candidates = [source.message, source.error, source.detail, source.reason, source.payload];
    for (const candidate of candidates) {
      const text = this.errorValueText(candidate);
      if (text.trim()) return text.trim();
    }
    return "";
  }

  private errorValueText(value: any): string {
    if (typeof value === "string") return value;
    if (Array.isArray(value)) {
      return value.map((item) => this.errorValueText(item)).filter((item) => item.trim()).join("\n");
    }
    if (value && typeof value === "object") {
      for (const key of ["message", "error", "detail", "reason", "text", "body", "value"]) {
        const text = this.errorValueText(value[key]);
        if (text.trim()) return text;
      }
    }
    return "";
  }

  private fileChangeCount(item: Record<string, any>, kind: "add" | "delete") {
    const direct = this.optionalCount(item[kind === "add" ? "additions" : "deletions"]);
    if (direct !== null) return direct;
    const rawChanges = item.changes;
    const changes = Array.isArray(rawChanges)
      ? rawChanges
      : Object.keys(rawChanges && typeof rawChanges === "object" ? rawChanges : {})
        .map((key) => rawChanges[key]);
    const changeCount = changes.reduce((total: number, change: any) => {
      const value = this.optionalCount(change?.[kind === "add" ? "additions" : "deletions"]
        ?? change?.[kind === "add" ? "added" : "removed"]);
      return total + (value === null ? 0 : value);
    }, 0);
    if (changeCount > 0) return changeCount;
    const marker = kind === "add" ? "+" : "-";
    const changeDiffCount = changes.reduce((total: number, change: any) => (
      total + String(change?.unified_diff || change?.diff || "")
        .split(/\r?\n/)
        .filter((line) => line.startsWith(marker) && !line.startsWith(marker.repeat(3)))
        .length
    ), 0);
    if (changeDiffCount > 0) return changeDiffCount;
    return this.diffLineCount(String(item.unified_diff || item.diff || ""), marker);
  }

  private diffLineCount(diff: string, marker: "+" | "-") {
    if (!diff) return 0;
    return diff.split(/\r?\n/).filter((line) => (
      line.startsWith(marker) && !line.startsWith(marker.repeat(3))
    )).length;
  }

  private optionalCount(value: any): number | null {
    if (value === null || value === undefined || value === "") return null;
    const count = Number(value);
    return Number.isFinite(count) ? Math.max(0, count) : null;
  }

  private fileChangeStatsMissing(item: Record<string, any>) {
    const rawChanges = item.changes;
    const changes = Array.isArray(rawChanges)
      ? rawChanges
      : Object.keys(rawChanges && typeof rawChanges === "object" ? rawChanges : {})
        .map((key) => rawChanges[key]);
    const hasInlineDiff = Boolean(item.unified_diff || item.diff)
      || changes.some((change: any) => Boolean(change?.unified_diff || change?.diff));
    if (hasInlineDiff) return false;
    const hasAdditions = this.optionalCount(item.additions) !== null
      || changes.some((change: any) => (
        this.optionalCount(change?.additions ?? change?.added) !== null
      ));
    const hasDeletions = this.optionalCount(item.deletions) !== null
      || changes.some((change: any) => (
        this.optionalCount(change?.deletions ?? change?.removed) !== null
      ));
    return !hasAdditions || !hasDeletions;
  }

  private hydrateFileChangeStats(itemId: string, path: string) {
    if (!path) return;
    const requestKey = `${itemId}:${path}`;
    if (this.pendingFileDiffs.has(requestKey)) return;
    this.pendingFileDiffs.add(requestKey);
    this.fileDiff(path)
      .then((result) => {
        this.timeline = this.timeline.map((item) => (
          item.id === itemId
            ? { ...item, additions: result.additions, deletions: result.deletions }
            : item
        ));
        this.notifyTimeline();
      })
      .catch(() => undefined)
      .finally(() => {
        this.pendingFileDiffs.delete(requestKey);
      });
  }

  private eventStatus(type: string, source: Record<string, any>): TimelineItem["status"] {
    if (source.code === "turn.status" || type.startsWith("turn.")) {
      const status = String(source.status || type.replace("turn.", ""));
      if (status === "completed") return "success";
      if (status === "failed") return "danger";
      if (status === "interrupted") return "warning";
      return "running";
    }
    if (type.includes("completed")) return "success";
    if (type.includes("failed") || type.includes("error")) return "danger";
    if (type.includes("interrupted")) return "warning";
    if (type.includes("started") || type.includes("running")) return "running";
    return "info";
  }

  private sendRaw(message: AgentEnvelope) {
    this.socket?.send({
      data: JSON.stringify(message),
      success: () => undefined,
      fail: () => undefined,
    });
  }

  private setState(state: ConnectionState, detail: string) {
    this.state = state;
    this.onStateChange?.(state, detail);
  }

  private notifyProjects() {
    this.onProjectsChange?.([...this.projects], this.selectedProject);
  }

  private applyThreadSnapshot(response: AgentEnvelope) {
    this.selectedProject = (response.payload?.selected || null) as ProjectSummary | null;
    this.projects = (response.payload?.projects || this.projects) as ProjectSummary[];
    if (this.selectedProject) {
      uni.setStorageSync(PROJECT_KEY, this.selectedProject.id);
    }
  }

  private notifyTimeline() {
    this.onTimelineChange?.([...this.timeline]);
  }

  private scheduleReconnect(delay: number) {
    this.clearReconnect();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect();
    }, delay) as unknown as number;
  }

  private clearReconnect() {
    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
  }

  private cleanupAfterClose() {
    this.connecting = false;
    this.requests.forEach((pending) => {
      clearTimeout(pending.timer);
      pending.reject(new Error("Connection closed"));
    });
    this.requests.clear();
    this.stopEventSyncTimer();
    this.stopProjectSyncTimer();
    this.socket = null;
  }

  private newId() {
    return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
  }
}

export const agent = new AgentClient();
