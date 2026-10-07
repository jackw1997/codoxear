export interface Session {
  session_id: string;
  alias?: string;
  cwd?: string;
  agent_backend?: string;
  model?: string;
  model_provider?: string;
  reasoning_effort?: string;
  service_tier?: string;
  busy?: boolean;
  queue_len?: number;
  unread_count?: number;
  blocked?: boolean;
  snoozed?: boolean;
  owned?: boolean;
  transport?: string;
  unattended_enabled?: boolean;
  lost?: boolean;
  launch_state?: string;
  launch_error?: string;
  launch_stage?: string;
  launch_id?: string;
  broker_pid?: number;
  commit_unknown_send?: boolean;
  orphan_recovery?: boolean;
  queue_recovery?: boolean;
  staged_attachments?: Attachment[];
  pending_attachment?: boolean;
  first_user_message?: string;
  subagents_running?: number;
  subagent_details?: SubagentDetail[];
  token?: TokenUsage | null;
  thinking?: number;
  thinking_tokens?: number;
  tools?: number;
  updated_ts?: number;
  draft_updated_ts?: number;
  start_ts?: number;
  priority_offset?: number;
  snooze_until?: number | null;
  dependency_session_id?: string | null;
  git_branch?: string;
  slash_commands?: SlashCommand[];
  pi_thinking_command?: boolean;
  provider_choice?: string;
  preferred_auth_method?: string;
}
export interface Catalog {
  sessions: Session[];
  recent_cwds: string[];
  tmux_available: boolean;
  new_session_defaults?: LaunchCatalog;
}
export interface ChatEvent {
  agent_internal_delivery?: boolean;
  message_id?: string;
  event_id?: string;
  role: string;
  text: string;
  ts?: number;
  kind?: string;
  message_class?: string;
  history_cursor?: string;
}
export interface Transcript {
  events: ChatEvent[];
  live_cursor?: string;
  history_cursor?: string;
  has_older?: boolean;
  busy: boolean;
  queue_len: number;
  reset?: boolean;
  token?: TokenUsage | null;
  meta_delta?: ActivityDelta;
  turn_start?: boolean;
  turn_end?: boolean;
  turn_aborted?: boolean;
  turn_activity?: boolean;
  turn_boundaries?: string[];
  transcript_state?: string;
  thread_id?: string | null;
  log_path?: string | null;
}
export interface QueueItem {
  id: string;
  text: string;
  sending?: boolean;
  commit_unknown?: boolean;
  orphan_recovery?: boolean;
}
export interface QueueResponse { items: QueueItem[]; }
export interface DraftResponse { text: string; updated_ts?: number; }
export interface CreateSession {
  name?: string;
  cwd: string;
  agent_backend: string;
  model: string;
  model_provider: string;
  preferred_auth_method?: string;
  service_tier?: string;
  reasoning_effort: string;
  resume_session_id: string;
  worktree_branch: string;
  create_in_tmux: boolean;
}
export interface CreateResponse { session_id?: string; broker_pid?: number; launch_id?: string; pending?: boolean; }
export interface TextRequest { text: string; }
export interface SendRequest { text: string; allow_pending_attachment: boolean; }
export interface NameRequest { name: string; }
export interface QueueMutation {
  id: string;
  text?: string;
  to_index?: number;
  allow_commit_unknown?: boolean;
  allow_orphan_recovery?: boolean;
}
export interface NeighborResponse { neighbor?: SearchMatch | null; }
export interface SearchMatch {
  message_id?: string;
  text?: string;
  snippet?: string;
  role?: string;
  cursor?: string;
  load_cursor?: string;
  history_cursor?: string;
  before_byte?: string;
  ts?: number;
}
export interface SearchResponse { matches: SearchMatch[]; total?: number; match_count?: number; truncated?: boolean; }
export interface FileEntry { path: string; path_token?: string; api_path?: string; kind?: string; }
export interface FileListing { files: string[]; entries?: FileEntry[]; matches?: FileEntry[]; }
export interface FileContent {
  api_path?: string;
  path: string;
  rel: string;
  kind: string;
  text?: string;
  editable?: boolean;
  version?: string;
  path_token?: string;
  reason?: string;
  viewer_max_bytes?: number;
  image_url?: string;
  pdf_url?: string;
  video_url?: string;
  size?: number;
}
export interface FileWrite {
  path: string;
  text: string;
  version?: string;
  path_token?: string;
  create?: boolean;
}
export function sessionName(session: Session): string {
  if (session.alias?.trim()) return session.alias.trim();
  const parts = (session.cwd || '').split('/').filter((part: string) => part.length > 0);
  return parts.length ? parts[parts.length - 1] : 'Session';
}
export function eventKey(event: ChatEvent): string {
  return event.message_id || event.event_id || event.role + ':' + event.ts + ':' + event.text;
}
export interface Attachment { id: string; display_name: string; size: number; }
export interface AttachmentsResponse { attachments: Attachment[]; }
export interface UploadRequest { filename: string; data_b64: string; }
export interface UnattendedConfig { enabled: boolean; request: string; cooldown_minutes: number; remaining_injections: number; }
export interface SessionEdit { name: string; priority_offset: number; snooze_until: number | null; dependency_session_id: string | null; }
export interface ExportResponse { events: ChatEvent[]; }

export interface LaunchDefaults {
  model?: string;
  model_provider?: string;
  provider_choice?: string;
  preferred_auth_method?: string;
  reasoning_effort?: string;
  service_tier?: string;
  models?: string[];
  provider_choices?: string[];
  provider_models?: Record<string, string[]>;
  reasoning_efforts?: string[];
  reasoning_efforts_by_model?: Record<string, string[]>;
  supports_fast?: boolean;
}
export interface LaunchCatalog { default_backend: string; backends: Record<string, LaunchDefaults>; }
export interface SlashCommand { name?: string; command?: string; description?: string; }

export interface GitEntry extends FileEntry { additions?: number | null; deletions?: number | null; untracked?: boolean; state?: string; }
export interface GitChanges { entries: GitEntry[]; }
export interface GitDiff { diff: string; }

export interface TokenUsage { context_window?: number; tokens_in_context?: number; percent_remaining?: number; max_input_tokens?: number; reserved_tokens?: number; }
export interface SubagentDetail { role?: string; model?: string; tools?: number | null; tokens?: number | null; }
export interface ActivityDelta { thinking?: number; thinking_tokens?: number; tool?: number; system?: number; }
