/** Public current-native producer contracts. These describe wire values, not
 * authorization: canonical paths, byte limits, grant revisions and readiness
 * are checked on the Computer. Upstream usage/telemetry extensions stay open. */
import { z } from "zod";
import { Id, Action } from "../contracts/model.js";
import { WorkspaceContext } from "../contracts/workspaces.js";

const count = z.number().int().nonnegative(),
  text = z.string(),
  nullableText = text.nullable(),
  ok = z.literal(true);
export const NativeBackend = z.enum(["codex", "pi", "cc"]);
export const NativeMetadata = z.object({
  version: z.literal(1),
  session_id: text,
  thread_id: nullableText,
  agent_backend: NativeBackend,
  broker_pid: z.number().int().positive(),
  pid: z.number().int().positive(),
  cwd: text,
  start_ts: z.number(),
  updated_ts: z.number(),
  log_path: nullableText,
  alias: text,
  model: nullableText,
  model_provider: nullableText,
  reasoning_effort: nullableText,
  service_tier: nullableText,
  launch_requires_reentry: z.boolean(),
  busy: z.boolean(),
  readiness: z.enum(["starting", "ready", "setup_required", "exited"]),
  setup_message: nullableText,
  queue_len: count,
  exit_code: z.number().int().nullable(),
  slash_commands: z
    .array(z.object({ name: text, description: text }))
    .optional(),
  pi_thinking_command: z.boolean().optional(),
});
export const AccessDecision = z.object({
  actions: z.array(Action),
  mode: z.enum(["member", "shared", "retained", "read_only", "denied"]),
  source: z.enum(["hub", "computer", "default", "membership", "agent"]),
  reason: text,
});
export const Usage = z
  .object({
    used: z.number().optional(),
    limit: z.number().optional(),
    context_window: z.number().optional(),
    tokens_in_context: z.number().optional(),
    percent_remaining: z.number().nullable().optional(),
    max_input_tokens: z.number().optional(),
    reserved_tokens: z.number().optional(),
  })
  .catchall(z.unknown())
  .describe(
    "Optional normalized context counters; backend-native token/cost fields may also appear and are not exhaustively enumerated.",
  );
export const ChatEvent = z.object({
  role: z.enum(["user", "assistant", "system"]),
  text,
  ts: z.number(),
  message_id: text,
  message_class: text.optional(),
  history_cursor: text.optional(),
  before_byte: text.optional(),
});
export const Transcript = z.object({
  events: z.array(ChatEvent),
  matches: z.array(ChatEvent).optional(),
  total: count.optional(),
  match_count: count.optional(),
  truncated: z.literal(false),
  event_count: count,
  transcript_state: z.enum(["bound", "failed", "pending_bind"]),
  log_path: nullableText,
  meta_delta: z.object({
    thinking: count,
    thinking_tokens: count,
    tool: count,
    system: count,
  }),
  turn_start: z.boolean(),
  turn_end: z.boolean(),
  turn_aborted: z.boolean(),
  turn_boundaries: z.array(z.enum(["start", "end", "aborted"])),
  live_cursor: text,
  history_cursor: nullableText,
  has_older: z.boolean(),
  has_newer: z.boolean(),
  jumped_window: z.boolean(),
  busy: z.boolean(),
  queue_len: count,
  token: Usage.nullable(),
  transcript_id: text,
  transcript_revision: text,
  thread_id: text,
});
export const Attachment = z.object({
  actorId: text.optional(),
  workspace: WorkspaceContext.optional(),
  id: text,
  path: text,
  name: text,
  filename: text,
  display_name: text,
  size: count,
  content_type: text,
  created_ts: z.number(),
  kind: z.enum(["file", "image"]),
});
export const Attachments = z.object({
  attachments: z.array(Attachment),
  staged_attachments: z.array(Attachment),
  pending_attachment: z.boolean(),
});
export const QueueItem = z.object({
  id: text,
  text,
  actorId: text.optional(),
  created_ts: z.number(),
  sending: z.boolean(),
  commit_unknown: z.boolean(),
  pause_reason: text.optional(),
  version: count.optional(),
  origin: z.enum(["local", "remote"]).optional(),
});
export const QueueSnapshot = z.object({
  ok,
  queued: z.literal(true),
  items: z.array(QueueItem),
  queue: z.array(text),
  queue_len: count,
});
export const Unattended = z.object({
  enabled: z.boolean(),
  request: text,
  cooldown_minutes: z.number().int().positive(),
  remaining_injections: count,
  commit_unknown: nullableText,
});
const defaults = z.object({
  model: nullableText,
  model_provider: nullableText.optional(),
  provider_choice: nullableText.optional(),
  preferred_auth_method: nullableText.optional(),
  reasoning_effort: nullableText.optional(),
  provider_choices: z.array(text),
  models: z.array(text),
  reasoning_efforts: z.array(text),
  supports_fast: z.boolean(),
  provider_models: z.record(text, z.array(text)).optional(),
  reasoning_efforts_by_model: z.record(text, z.array(text)).optional(),
  reasoning_efforts_for_custom_model: z.array(text).optional().describe("Runtime request vocabulary for a user-supplied model; the provider may reject these levels."),
});
export const LaunchDefaults = z.object({
  default_backend: NativeBackend.optional(),
  provider_launch: z.literal(true),
  backends: z.object({ pi: defaults, codex: defaults, cc: defaults }),
});
const subagent = z
  .object({
    id: text.optional(),
    status: text.optional(),
    name: text.optional(),
    model: text.optional(),
    role: text.optional(),
    tool: text.optional(),
    tokens: z.number().optional(),
  })
  .catchall(z.unknown())
  .describe(
    "Backend-owned optional child telemetry, with additional producer fields permitted.",
  );
export const Session = NativeMetadata.extend({
  thread_id: text,
  interrupted_idle: z.boolean().optional(),
  codex_live_settings: z.boolean().optional(),
  unified_queue: z.literal(true).optional(),
  actor_attachments: z.literal(true).optional(),
  attachments: z.array(Attachment).optional(),
  queue: z.array(QueueItem).optional(),
  draft: text.optional(),
  read_event_id: nullableText.optional(),
  unattended: Unattended.omit({ commit_unknown: true }).optional(),
  owned: z.literal(true),
  transport: z.literal("native"),
  priority_offset: z.number(),
  snooze_until: z.number().nullable(),
  dependency_session_id: nullableText,
  blocked: z.boolean(),
  snoozed: z.boolean(),
  time_priority: z.number(),
  base_priority: z.number(),
  final_priority: z.number(),
  token: Usage.nullable(),
  log_exists: z.boolean(),
  lost: z.boolean(),
  pending_attachment: z.boolean(),
  staged_attachments: z.array(Attachment),
  files: z.array(text),
  draft_updated_ts: z.number(),
  thinking: count,
  thinking_tokens: count,
  tools: count,
  system: count,
  subagents_running: count,
  subagent_details: z.array(subagent),
  unattended_enabled: z.boolean(),
  unattended_request: text,
  slash_commands: z.array(z.object({ name: text, description: text })),
  pi_thinking_command: z.boolean(),
  remote_queue_len: count.optional(),
  remote_access: AccessDecision.optional(),
});
export const Catalog = z.object({
  sessions: z.array(Session),
  new_session_defaults: z.union([LaunchDefaults, z.object({}).strict()]),
  recent_cwds: z.array(text),
  tmux_available: z.literal(false),
});
export const BrowserCatalog = z.object({
  sessions: z.array(
    Session.extend({
      codoxear_launch_defaults: z.union([
        LaunchDefaults,
        z.object({}).strict(),
      ]),
      codoxear_computer_id: Id,
    }),
  ),
  catalog_errors: z.array(
    z.object({ computerId: Id, computerName: text, message: text }),
  ),
  catalog_authorized_agents: z.array(
    z.object({ session_id: Id, computer_id: Id }),
  ),
  recent_cwds: z.array(text),
  new_session_defaults: z.object({}).strict(),
  tmux_available: z.literal(false),
});
export const WorkspaceSnapshot = z.object({
  id: z.literal("default"),
  path: nullableText,
  roots: z.array(
    z.object({ id: Id, name: text, path: text, device: text, inode: text }),
  ),
});
export const ResumeCandidates = z.object({
  sessions: z.array(
    z.object({
      session_id: text,
      alias: text.optional(),
      first_user_message: text.optional(),
    }),
  ),
});
export const NativeResumeCandidates = ResumeCandidates.extend({
  ok,
  cwd: text,
  exists: z.boolean(),
  sessions: z.array(
    z.object({
      session_id: text,
      cwd: text,
      updated_ts: z.number(),
      agent_backend: NativeBackend,
      alias: text,
      first_user_message: text,
    }),
  ),
});
export const PathFields = z.object({
  path: text,
  api_path: text.optional(),
  non_utf8_path: z.boolean().optional(),
});
const viewFields = { size: count };
export const FileView = z.union([
  z.object({
    kind: z.literal("directory"),
    size: z.literal(0),
    content_type: z.null(),
  }),
  z.object({
    kind: z.enum(["image", "pdf", "video"]),
    ...viewFields,
    content_type: text,
  }),
  z.object({
    kind: z.enum(["text", "markdown"]),
    ...viewFields,
    content_type: z.null(),
    text,
    editable: z.boolean(),
    version: text,
  }),
  z.object({
    kind: z.literal("download_only"),
    ...viewFields,
    reason: z.enum(["too_large", "binary"]),
    viewer_max_bytes: count.optional(),
  }),
]);
const fileReadFields = {
  ...PathFields.shape,
  ok,
  rel: text,
  image_url: text.optional(),
  pdf_url: text.optional(),
  video_url: text.optional(),
  video_preview_url: text.optional(),
  preview_content_type: text.optional(),
};
export const FileRead = z.union(
  FileView.options.map((view) => view.extend(fileReadFields)),
);
export const FileInspect = z.union(
  FileView.options.map((view) => view.extend({ ok, path: text })),
);
export const FileList = z.object({
  ok,
  cwd: text,
  files: z.array(text),
  entries: z.array(PathFields),
});
export const FileSearch = z.object({
  ok,
  cwd: text,
  query: text,
  mode: z.enum(["native", "workspace"]),
  matches: z.array(PathFields),
  scanned: count,
  truncated: z.boolean(),
});
export const FileInspectBatch = z.object({
  results: z.array(
    z.union([
      ...FileView.options.map((view) =>
        view.extend({
          ok,
          path: text,
          exists: z.literal(true),
          resolved_path: text,
        }),
      ),
      z.object({
        path: text,
        exists: z.literal(false),
        error: text.optional(),
      }),
    ]),
  ),
});
export const FileWrite = z.object({
  ok,
  path: text,
  size: count,
  version: text,
  editable: z.literal(true),
  rel: text,
});
export const GitChanged = z.object({
  ok,
  cwd: text,
  repository_root: text,
  files: z.array(text),
  unstaged: z.array(text),
  staged: z.array(text),
  untracked: z.array(text),
  entries: z.array(
    PathFields.extend({
      abs_path: text,
      abs_api_path: text.optional(),
      additions: count.nullable(),
      deletions: count.nullable(),
      changed: z.boolean(),
      untracked: z.boolean(),
      state: z.enum(["changed", "untracked"]),
    }),
  ),
});
export const GitDiff = PathFields.extend({
  ok,
  cwd: text,
  staged: z.boolean(),
  diff: text,
});
export const GitVersions = PathFields.extend({
  ok,
  cwd: text,
  abs_path: text,
  current_exists: z.boolean(),
  current_size: count,
  current_text: text,
  base_exists: z.boolean(),
  base_text: text,
});
export const Voice = z.object({
  ok,
  tts_enabled_for_narration: z.boolean(),
  tts_enabled_for_final_response: z.boolean(),
  tts_base_url: text,
  tts_api_key: z.literal(""),
  summarization_model: text,
  tts_model: text,
  has_tts_api_key: z.boolean(),
  audio: z.object({
    queue_depth: count,
    active_listener_count: count,
    stream_url: text,
    segment_count: count,
    last_error: nullableText,
  }),
  notifications: z.object({
    enabled: z.literal(false),
    supported: z.literal(false),
  }),
});
export const Notification = z.object({
  message_id: text,
  source_message_id: text.optional(),
  session_id: text,
  session_display_name: text,
  updated_ts: z.number(),
  message_class: text,
  summary_status: z.literal("ready"),
  push_status: z.literal("not_requested"),
  notification_text: text,
});
export const NotificationFeed = z.object({ ok, items: z.array(Notification) });
export const HubNotificationFeed = z.object({
  ok,
  items: z.array(
    Notification.pick({
      message_id: true,
      session_id: true,
      notification_text: true,
      updated_ts: true,
    }).extend({ session_display_name: text }),
  ),
});
export const SendAck = z.object({
  ok,
  accepted: z.literal(true),
  commit_unknown: z.literal(false).optional(),
  effective: text.optional(),
});
export const InterruptAck = z.object({
  ok,
  interrupted: z.literal(true),
  interrupt_requested: z.literal(true),
});
export const Messages = z.object({
  messages: z.array(
    z.object({
      id: text,
      role: z.enum(["user", "assistant", "system"]),
      text,
      at: z.number(),
    }),
  ),
  state: z.enum(["starting", "ready", "unknown", "failed"]).optional(),
});
const pathQuery = z
  .object({
    path: text.optional(),
    path_token: text.optional(),
    session_id: text.optional(),
    git_path: text.optional(),
  })
  .describe(
    "Supply path or opaque path_token. Tokens preserve non-UTF-8 filenames; canonical path and granted-root checks run on the Computer.",
  );
const pathBody = pathQuery;
const finiteQuery = text.describe("Finite number encoded as a query string.");
const empty = z.object({});
export const MessageNeighborQuery = z.object({
  role: z.enum(["user", "assistant"]).optional(),
  direction: z.enum(["previous", "next"]),
  cursor: text.min(1).describe("Session-prefixed numeric history cursor; the Computer rejects another session's identity."),
});
export const MessageNeighbor = z.object({
  neighbor: z.object({ role: z.enum(["user", "assistant"]), text,
    ts: z.number(), message_id: text, history_cursor: text, before_byte: text,
    same_log: z.literal(true),
  }).nullable(),
  transcript_state: z.literal("bound"), thread_id: text, log_path: text,
});
export type NativeDetail = {
  body?: z.ZodType;
  query?: z.ZodType;
  response?: z.ZodType;
  events?: Record<string, z.ZodType>;
  contentType?: string;
  requestContents?: Record<string, z.ZodType>;
  statuses?: number[];
  responseHeaders?: Record<
    string,
    { schema: Record<string, unknown>; description: string }
  >;
};
export function nativeDetail(method: string, path: string): NativeDetail {
  const action = path.replace(/^\/api\/sessions\/\{localId\}\//, "");
  const post = method === "POST";
  if (action === "messages/neighbor") return { query: MessageNeighborQuery, response: MessageNeighbor,
    statuses: [200, 400, 401, 403, 404, 409, 413, 500, 503] };
  if (["live", "messages/live"].includes(action))
    return {
      contentType: "text/event-stream",
      events: { message: Transcript },
      query: z.object({
        after: text.optional(),
        cursor: text.optional(),
        limit: finiteQuery.optional(),
      }),
      statuses: [200, 400, 401, 403, 404, 409, 500, 503],
    };
  if (
    [
      "messages/tail",
      "messages/history",
      "messages/window",
      "messages/export",
      "search",
    ].includes(action)
  )
    return {
      response: Transcript,
      query: z.object({
        cursor: text.optional(),
        before: text.optional(),
        after: text.optional(),
        limit: finiteQuery.optional(),
        q: text.optional(),
        query: text.optional(),
        ...(action === "search" ? { role: z.enum(["user", "assistant"]).optional() } : {}),
      }),
    };
  if (action === "tail") return { response: z.object({ tail: text }) };
  if (action === "diagnostics")
    return {
      response: z.object({
        runtime: z.literal("native"),
        session: NativeMetadata,
      }),
    };
  if (action === "unread")
    return {
      response: z.object({
        count,
        unread: count,
        first_unread_event_id: nullableText,
        last_unread_event_id: nullableText,
      }),
    };
  if (action === "read")
    return {
      body: z.object({ event_id: nullableText.optional() }),
      response: z.object({ ok, event_id: nullableText }),
    };
  if (action === "draft")
    return post
      ? {
          body: z.object({ text: text.max(200000) }),
          response: z.object({ ok, updated_ts: z.number() }),
        }
      : { response: z.object({ ok, text, updated_ts: z.number() }) };
  if (action === "send")
    return {
      body: z.object({
        text: text.trim().min(1),
        request_id: text.optional(),
      }),
      response: SendAck,
    };
  if (action === "interrupt") return { body: empty, response: InterruptAck };
  if (action === "settings")
    return {
      body: z.union([
        z.object({ model: text }),
        z.object({ reasoning_effort: text }),
      ]),
      response: SendAck,
    };
  if (action === "edit")
    return {
      body: z.object({
        name: text,
        priority_offset: z.union([z.number(), text]).optional(),
        snooze_until: z.union([z.number(), text, z.null()]).optional(),
        dependency_session_id: nullableText.optional(),
      }),
      response: z.object({
        ok,
        alias: text,
        priority_offset: z.number(),
        snooze_until: z.number().nullable(),
        dependency_session_id: nullableText,
      }),
    };
  if (action === "rename")
    return {
      body: z.object({ name: text }),
      response: z.object({ ok, alias: text }),
    };
  if (action === "unattended")
    return {
      response: Unattended,
      ...(post
        ? {
            body: z.object({
              enabled: z.boolean().optional(),
              request: text.optional(),
              cooldown_minutes: z.union([z.number(), text]).optional(),
              remaining_injections: z.union([z.number(), text]).optional(),
              review_attempt: text.optional(),
            }),
          }
        : {}),
    };
  if (action === "attachments") return { response: Attachments };
  if (
    [
      "attachments/delete",
      "attachments/clear",
      "pending_attachment/clear",
    ].includes(action)
  )
    return {
      body: action.endsWith("delete") ? z.object({ id: text }) : empty,
      response: Attachments.extend({ ok }),
    };
  if (["commit_unknown_send/clear", "delete"].includes(action))
    return { body: empty, response: z.object({ ok }) };
  if (["inject_file", "inject_image"].includes(action))
    return {
      requestContents: {
        "application/json": z.union([
          z.object({
            filename: text,
            data_b64: text
              .min(1)
              .regex(/^[A-Za-z0-9+/]*={0,2}$/)
              .describe(
                "Nonempty base64 file bytes; decoded size must be at most 64 MiB.",
              ),
            content_type: text.optional(),
          }),
          z
            .object({
              path: text,
              name: text.optional(),
              filename: text.optional(),
              display_name: text.optional(),
              content_type: text.optional(),
            })
            .describe(
              "Owner-only reference to an already stored Computer-local file; delegated uploads must supply file bytes.",
            ),
        ]),
        "multipart/form-data": z.union([
          z.object({ file: z.string().meta({ format: "binary" }) }),
          z.object({ image: z.string().meta({ format: "binary" }) }),
        ]),
      },
      response: Attachments.extend({
        ok,
        attachment: Attachment,
        pending_attachment: z.literal(true),
      }),
    };
  if (action.startsWith("git/"))
    return {
      query: pathQuery.extend({
        staged: text.optional(),
        head: text.optional(),
      }),
      response: action.endsWith("changed_files")
        ? GitChanged
        : action.endsWith("diff")
          ? GitDiff
          : GitVersions,
    };
  if (action.startsWith("file/") || /^\/api\/files?\//.test(path)) {
    const op = action.startsWith("file/")
      ? action.slice(5)
      : path.split("/").at(-1);
    if (op === "list") return { query: pathQuery, response: FileList };
    if (op === "search")
      return {
        query: pathQuery.extend({
          q: text.min(1),
          limit: finiteQuery.optional(),
        }),
        response: FileSearch,
      };
    if (op === "inspect-batch")
      return {
        body: pathBody.extend({ paths: z.array(text).max(50) }),
        response: FileInspectBatch,
      };
    if (op === "inspect") return { body: pathBody, response: FileInspect };
    if (op === "write")
      return {
        body: pathBody
          .extend({
            text,
            create: z.boolean().optional(),
            version: text.optional(),
          })
          .describe(
            "Updates require the last file version (CAS); create:true requires a new path. Text is limited to 2 MiB UTF-8 bytes.",
          ),
        response: FileWrite,
      };
    if (op === "image-dimensions")
      return {
        query: pathQuery,
        response: z.object({
          ok,
          width: z.number().int().positive(),
          height: z.number().int().positive(),
        }),
      };
    if (["blob", "download", "video_preview"].includes(op!))
      return {
        query: pathQuery,
        contentType: "*/*",
        statuses: [
          200, 206, 304, 400, 401, 403, 404, 409, 413, 416, 500, 501, 503,
        ],
        responseHeaders: FILE_HEADERS,
      };
    if (op === "read")
      return {
        ...(post ? { body: pathBody } : { query: pathQuery }),
        response: FileRead,
      };
  }
  if (path === "/api/cwd-suggest")
    return {
      query: z.object({ path: text.optional(), prefix: text.optional() }),
      response: z.object({
        directories: z.array(z.object({ name: text, path: text })),
      }),
    };
  if (path === "/api/session_resume_candidates")
    return {
      query: z.object({ agent_backend: NativeBackend, cwd: text }),
      response: NativeResumeCandidates,
    };
  if (path === "/api/settings/voice")
    return {
      response: Voice,
      ...(post
        ? {
            body: Voice.pick({
              tts_enabled_for_narration: true,
              tts_enabled_for_final_response: true,
              tts_base_url: true,
              summarization_model: true,
              tts_model: true,
            })
              .partial()
              .extend({
                tts_api_key: text.meta({ writeOnly: true }).optional(),
                tts_api_key_clear: z.boolean().optional(),
              }),
          }
        : {}),
    };
  if (path === "/api/settings/unattended-prompt")
    return {
      response: z.object({ ok, prompt: text, default_prompt: text }),
      ...(post ? { body: z.object({ prompt: text }) } : {}),
    };
  if (path === "/api/audio/listener")
    return {
      body: z.object({
        client_id: text.trim().min(1).max(200),
        enabled: z.boolean().optional(),
      }),
      response: z.object({ ok, active_listener_count: count }),
    };
  if (path === "/api/audio/live.m3u8")
    return {
      contentType: "application/vnd.apple.mpegurl",
      response: text,
      statuses: [200, 400, 401, 403, 404, 500, 503],
    };
  if (path.startsWith("/api/audio/segments/"))
    return {
      contentType: "video/mp2t",
      statuses: [200, 206, 304, 400, 401, 403, 404, 416, 500, 503],
      responseHeaders: FILE_HEADERS,
    };
  if (path === "/api/notifications/feed")
    return {
      query: z.object({ since: finiteQuery.optional() }),
      response: NotificationFeed,
    };
  if (["/api/notifications/text", "/api/notifications/state"].includes(path))
    return {
      query: z.object({ message_id: text.min(1) }),
      response: Notification.extend({ ok, text }),
    };
  return {};
}
export const FILE_HEADERS = {
  "Content-Type": {
    schema: { type: "string" },
    description: "Actual detected file MIME type; download accepts any type.",
  },
  "Content-Length": {
    schema: { type: "string", pattern: "^[0-9]+$" },
    description: "Bytes in the full or partial body; retained for HEAD.",
  },
  "Accept-Ranges": {
    schema: { type: "string", const: "bytes" },
    description: "Single byte ranges supported.",
  },
  "Content-Range": {
    schema: { type: "string" },
    description:
      "Present for 206 and unsatisfiable 416: bytes start-end/total or bytes */total.",
  },
  ETag: {
    schema: { type: "string" },
    description: "Quoted size/mtime validator for the open file.",
  },
  "Last-Modified": { schema: { type: "string" }, description: "HTTP date." },
  "Content-Disposition": {
    schema: { type: "string" },
    description: "Attachment filename on downloads.",
  },
  "Cache-Control": {
    schema: { type: "string" },
    description: "Private file caching policy.",
  },
};
export const nativeSchemas = {
  NativeMetadata,
  AccessDecision,
  Usage,
  ChatEvent,
  Transcript,
  Attachment,
  Attachments,
  QueueItem,
  QueueSnapshot,
  Unattended,
  LaunchDefaults,
  Session,
  Catalog,
  BrowserCatalog,
  WorkspaceSnapshot,
  ResumeCandidates,
  NativeResumeCandidates,
  PathFields,
  FileView,
  FileRead,
  FileInspect,
  FileList,
  FileSearch,
  FileInspectBatch,
  FileWrite,
  GitChanged,
  GitDiff,
  GitVersions,
  Voice,
  Notification,
  NotificationFeed,
  HubNotificationFeed,
  SendAck,
  InterruptAck,
  Messages,
  MessageNeighborQuery,
  MessageNeighbor,
};
