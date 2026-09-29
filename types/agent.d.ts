export type ConnectionState = "offline" | "connecting" | "online" | "pairing";

export type SandboxMode = "read_only" | "workspace_write";

export interface ProjectSummary {
  id: string;
  name: string;
  normalized_path: string;
  codex_thread_id?: string | null;
  current_session_id?: string | null;
  session_status?: string | null;
  session_title?: string | null;
  session_updated_at?: string | null;
  model?: string | null;
  reasoning_effort?: string | null;
  goal?: string | null;
  default_sandbox?: SandboxMode;
  is_temporary?: number | boolean;
  authorized_at?: string | null;
}

export interface DirectoryAuthorizationRequest {
  request_id: string;
  project_id: string;
  project_name: string;
  reason: string;
  status: "pending" | "approved" | "rejected" | "expired";
  created_at: string;
  expires_at: string;
}

export interface RunningTurnSummary {
  turn_id: string;
  project_id: string;
  session_id?: string | null;
  thread_id?: string | null;
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

export interface CodexThreadStatus {
  available: boolean;
  thread_id?: string | null;
  model?: string;
  reasoning_effort?: string;
  context_window?: number | null;
  used_tokens?: number | null;
  context_percent?: number | null;
  rate_limits?: Record<string, any>;
  updated_at?: string;
  title?: string;
  source?: string;
}

export interface CodexThreadSummary {
  session_id: string;
  thread_id?: string | null;
  current: boolean;
  title: string;
  model: string;
  reasoning_effort: string;
  updated_at: string;
  status?: "active" | "archived";
  running?: boolean;
  running_turn_id?: string | null;
  archived_at?: string | null;
  context_percent?: number | null;
}

export interface CodexProjectSyncResult {
  projects: CodexProjectCandidate[];
  registered_projects: ProjectSummary[];
  source?: string;
  scanned_sessions?: number;
  synced_projects?: number;
  synced_sessions?: number;
}

export interface CodexThreadSnapshot {
  project_id: string;
  current_session_id?: string | null;
  current_thread_id?: string | null;
  is_new_thread?: boolean;
  sessions: CodexThreadSummary[];
  archived_sessions?: CodexThreadSummary[];
}

export interface McpServer {
  name: string;
  detail: string;
  enabled: boolean;
}

export interface CodexProjectCandidate {
  name: string;
  path: string;
  last_used_at: string;
  session_count: number;
  imported: boolean;
  importable: boolean;
  project_id?: string | null;
}

export interface TimelineItem {
  id: string;
  seq: number;
  kind: string;
  type: string;
  itemType?: string;
  itemId?: string;
  path?: string;
  command?: string;
  output?: string;
  exitCode?: number | null;
  changedFiles?: number;
  additions?: number;
  deletions?: number;
  title: string;
  turnId?: string;
  body?: string;
  detail: string;
  status: "info" | "success" | "warning" | "danger" | "running";
  ts: string;
}

export interface AgentMetrics {
  cpu_percent: number | null;
  memory_percent: number | null;
  memory_used_bytes: number | null;
  disk_percent: number | null;
  net_sent_bytes_per_sec: number | null;
  net_recv_bytes_per_sec: number | null;
  process_count: number | null;
}

export interface TerminalSessionInfo {
  session_id: string;
  cwd: string;
  shell: string;
  mode: "pty" | "pipe";
  cols: number;
  rows: number;
  line_ending: string;
  pty: boolean;
}

export interface AgentEnvelope {
  v: 1;
  id?: string;
  type: string;
  payload?: Record<string, any>;
  seq?: number;
  project_id?: string;
  session_id?: string | null;
  thread_id?: string | null;
  turn_id?: string | null;
  ts?: string;
  history?: boolean;
  event?: Record<string, any>;
}
