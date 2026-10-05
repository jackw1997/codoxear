import { readdirSync, readFileSync, readlinkSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { backendHomes } from "./homes.js";
import type { Backend, ChatEvent } from "./types.js";
export type NativeLog = {
  path: string;
  id: string;
  cwd: string;
  updated: number;
  backend: Backend;
};
const directories = (home: string, backend: Backend) => {
  const homes = backendHomes(home);
  return backend === "codex"
    ? [join(homes.codex, "sessions")]
    : backend === "pi"
      ? [join(homes.pi, "sessions")]
      : [join(homes.claude, "projects")];
};
export function scanLogs(home: string, backend: Backend): NativeLog[] {
  const result: NativeLog[] = [];
  function walk(directory: string, depth = 0) {
    if (depth > 8) return;
    let entries;
    try {
      entries = readdirSync(directory, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path, depth + 1);
      else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          const buffer = readFileSync(path);
          if (buffer.length > 64 * 1024 * 1024) continue;
          const rows = buffer.toString("utf8").split("\n");
          let id = "",
            cwd = "",
            subagent = false;
          for (const line of rows.slice(0, 100)) {
            let row: any;
            try {
              row = JSON.parse(line);
            } catch {
              continue;
            }
            if (backend === "codex" && row.type === "session_meta") {
              id = row.payload?.id ?? "";
              cwd = row.payload?.cwd ?? "";
              subagent = !!row.payload?.source?.subagent;
              break;
            }
            if (backend === "pi" && row.type === "session") {
              id = row.id ?? "";
              cwd = row.cwd ?? "";
              break;
            }
            if (backend === "cc") {
              id = row.sessionId ?? id;
              cwd = row.cwd ?? cwd;
              if (row.isSidechain === true) subagent = true;
              if (id && cwd) break;
            }
          }
          if (id && cwd && !subagent && !path.includes("/subagents/"))
            result.push({
              path,
              id,
              cwd: resolve(cwd),
              updated: statSync(path).mtimeMs,
              backend,
            });
        } catch {}
      }
    }
  }
  for (const dir of directories(home, backend)) walk(dir);
  return result.sort((a, b) => b.updated - a.updated);
}
const contentText = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content
          .filter(
            (p: any) =>
              p &&
              ["text", "input_text", "output_text"].includes(p.type) &&
              typeof p.text === "string",
          )
          .map((p: any) => p.text)
          .join("\n")
      : "";
export function readTranscript(
  path: string | null,
  backend: Backend,
  afterRows = 0,
): {
  events: ChatEvent[];
  busy: boolean;
  token: any;
  threadId: string | null;
  revision: string;
  rows: number;
  delta: any;
  boundaries: string[];
  thinking: number;
  thinkingTokens: number;
  tools: number;
  system: number;
  subagents: any[];
  completedAt: number;
} {
  if (!path)
    return {
      events: [],
      busy: false,
      token: null,
      threadId: null,
      revision: "empty",
      rows: 0,
      delta: { thinking: 0, thinking_tokens: 0, tool: 0, system: 0 },
      boundaries: [],
      thinking: 0,
      thinkingTokens: 0,
      tools: 0,
      system: 0,
      subagents: [],
      completedAt: 0,
    };
  let source = "";
  try {
    source = readFileSync(path, "utf8");
    if (Buffer.byteLength(source) > 64 * 1024 * 1024)
      throw Error("Session log is too large to load");
  } catch {
    return {
      events: [],
      busy: false,
      token: null,
      threadId: null,
      revision: "unavailable",
      rows: 0,
      delta: { thinking: 0, thinking_tokens: 0, tool: 0, system: 0 },
      boundaries: [],
      thinking: 0,
      thinkingTokens: 0,
      tools: 0,
      system: 0,
      subagents: [],
      completedAt: 0,
    };
  }
  const events: ChatEvent[] = [];
  let busy = false,
    token: any = null,
    threadId: string | null = null;
  const seen = new Set<string>();
  let thinking = 0,
    thinkingTokens = 0,
    tools = 0,
    system = 0,
    completedAt = 0,
    assistantFinalInTurn = false;
  const subagents = new Map<string, any>();
  let rows = 0;
  const delta = { thinking: 0, thinking_tokens: 0, tool: 0, system: 0 };
  const boundaries: string[] = [];
  const add = (
    role: ChatEvent["role"],
    text: string,
    at: number,
    cls?: string,
  ) => {
    if (!text.trim()) return;
    const id = createHash("sha256")
      .update(JSON.stringify([role, text, at, cls ?? ""]))
      .digest("hex");
    if (seen.has(id)) return;
    seen.add(id);
    events.push({
      role,
      text,
      ts: at / 1000,
      message_id: id,
      ...(cls ? { message_class: cls } : {}),
    });
  };
  for (const line of source.split("\n")) {
    let row: any;
    try {
      row = JSON.parse(line);
    } catch {
      continue;
    }
    const old = { thinking, thinkingTokens, tools, system, busy, completedAt };
    const rowIndex = rows++;
    const at =
      typeof row.timestamp === "number"
        ? row.timestamp
        : Date.parse(row.timestamp ?? "") || 0;
    if (backend === "codex") {
      const p = row.payload ?? {};
      if (row.type === "session_meta") threadId = p.id ?? null;
      if (row.type === "event_msg") {
        if (p.type === "user_message") {
          assistantFinalInTurn = false;
          add("user", p.message ?? "", at);
          busy = true;
        }
        if (p.type === "task_started") busy = true;
        if (p.type === "error") {
          add("assistant", String(p.message ?? "Backend error"), at, "error");
          busy = false;
          completedAt = at;
        }

        if (p.type === "context_compacted") system++;
        if (
          ["task_complete", "turn_complete", "turn_aborted"].includes(p.type)
        ) {
          busy = false;
          completedAt = at;
          if (p.last_agent_message && !assistantFinalInTurn)
            add("assistant", p.last_agent_message, at, "final_response");
          if (p.type === "turn_aborted")
            add(
              "assistant",
              "The backend turn was interrupted before completion.",
              at,
              "error",
            );
        }
        if (p.type === "token_count") {
          const used = p.info?.last_token_usage ?? p.info?.total_token_usage;
          token = used
            ? {
                ...used,
                used: used.input_tokens ?? used.total_tokens ?? 0,
                limit: p.info?.model_context_window ?? 0,
              }
            : token;
        }
      }
      if (
        row.type === "response_item" &&
        p.type === "message" &&
        p.role === "assistant"
      ) {
        const text = contentText(p.content);
        const final = p.phase === "final_answer" || p.end_turn === true;
        add("assistant", text, at, final ? "final_response" : "narration");
        if (final) {
          busy = false;
          completedAt = at;
          assistantFinalInTurn = true;
        }
      }
      if (row.type === "response_item" && p.type === "reasoning") {
        thinking++;
        thinkingTokens += Number(p.token_count ?? 0);
      }
      if (
        row.type === "response_item" &&
        ["function_call", "custom_tool_call"].includes(p.type)
      ) {
        tools++;
        if (["spawn_agent", "agent"].includes(p.name)) {
          let args: any = {};
          try {
            args = JSON.parse(p.arguments ?? "{}");
          } catch {}
          subagents.set(p.call_id, {
            id: p.call_id,
            name: args.name ?? args.agent_type ?? "Agent",
            status: "running",
            task: args.message ?? args.task ?? "",
          });
        }
      }
      if (row.type === "event_msg" && p.type === "collab_agent_spawn_end") {
        const agent = subagents.get(p.call_id);
        if (agent) {
          agent.id = p.new_agent_id ?? agent.id;
          agent.status = "running";
        }
      }
      if (
        row.type === "event_msg" &&
        ["collab_waiting_end", "collab_close_end"].includes(p.type)
      ) {
        for (const agent of subagents.values()) {
          const status = p.agent_statuses?.[agent.id];
          if (
            status &&
            ["completed", "errored", "shutdown"].some((value) =>
              JSON.stringify(status).includes(value),
            )
          )
            agent.status = "completed";
        }
      }
    } else if (backend === "pi") {
      if (row.type === "session") threadId = row.id ?? null;
      if (row.type === "message") {
        const m = row.message ?? {};
        const text = contentText(m.content);
        if (m.role === "user") {
          add("user", text, at);
          busy = true;
        }
        if (m.role === "assistant") {
          for (const part of Array.isArray(m.content) ? m.content : []) {
            if (part.type === "thinking") thinking++;
            if (part.type === "toolCall") {
              tools++;
              if (["subagent", "spawn_agent", "agent"].includes(part.name))
                subagents.set(part.id, {
                  id: part.id,
                  name: part.name,
                  status: "running",
                  task: part.arguments?.task ?? part.arguments?.message ?? "",
                });
            }
          }
          const final = m.stopReason && m.stopReason !== "toolUse";
          add("assistant", text, at, final ? "final_response" : "narration");
          if (m.errorMessage) add("assistant", m.errorMessage, at, "error");
          if (final) {
            busy = false;
            completedAt = at;
          }
          if (m.usage) {
            let window = 0;
            try {
              const marker = path.split("/sessions/")[0]!;
              const config = JSON.parse(
                readFileSync(join(marker, "models.json"), "utf8"),
              );
              window =
                config.providers?.[m.provider]?.models?.find(
                  (model: any) => model.id === m.model,
                )?.contextWindow ?? 0;
            } catch {}
            token = {
              ...m.usage,
              used: m.usage.totalTokens ?? 0,
              limit: window,
            };
          }
        }
      }
    } else {
      threadId = row.sessionId ?? threadId;
      const m = row.message ?? {};
      if (row.type === "user" && !row.isMeta) {
        const text = contentText(m.content);
        if (text) {
          add("user", text, at);
          busy = true;
        }
      }
      if (row.type === "assistant") {
        for (const part of Array.isArray(m.content) ? m.content : []) {
          if (part.type === "thinking") thinking++;
          if (part.type === "tool_use") {
            tools++;
            if (["Agent", "Task"].includes(part.name))
              subagents.set(part.id, {
                id: part.id,
                name: part.input?.description ?? part.name,
                status: "running",
                task: part.input?.prompt ?? "",
                background: part.input?.run_in_background === true,
              });
          }
        }
        const final =
          m.stop_reason === "end_turn" || m.stop_reason === "stop_sequence";
        add(
          "assistant",
          contentText(m.content),
          at,
          final ? "final_response" : "narration",
        );
        if (final) {
          busy = false;
          completedAt = at;
        }
        if (m.usage)
          token = {
            ...m.usage,
            used:
              (m.usage.input_tokens ?? 0) +
              (m.usage.cache_read_input_tokens ?? 0) +
              (m.usage.cache_creation_input_tokens ?? 0),
            limit: m.context_window ?? row.context_window ?? 200000,
          };
      }
      if (row.type === "user")
        for (const part of Array.isArray(m.content) ? m.content : []) {
          if (part.type === "tool_result") {
            const agent = subagents.get(part.tool_use_id);
            if (agent) {
              const text =
                typeof part.content === "string"
                  ? part.content
                  : contentText(part.content);
              const nativeId = /agentId:\s*([A-Za-z0-9_-]+)/.exec(text)?.[1];
              if (nativeId) agent.native_id = nativeId;
              if (!agent.background) agent.status = "completed";
            }
          }
        }
      const notification = contentText(m.content);
      if (notification.includes("<task-notification>")) {
        const taskId = /<task-id>([^<]+)<\/task-id>/.exec(notification)?.[1];
        const status = /<status>(completed|failed|stopped)<\/status>/.exec(
          notification,
        )?.[1];
        if (taskId && status)
          for (const agent of subagents.values())
            if (agent.native_id === taskId || agent.id === taskId)
              agent.status = status;
      }
      if (row.type === "system") {
        system++;
        if (["turn_end", "stop_hook_summary"].includes(row.subtype)) {
          busy = false;
          completedAt = at;
        }
      }
    }
    thinkingTokens =
      token?.reasoning_output_tokens ??
      token?.output_tokens_details?.reasoning_tokens ??
      thinkingTokens;
    if (rowIndex >= afterRows) {
      delta.thinking += thinking - old.thinking;
      delta.thinking_tokens += Math.max(0, thinkingTokens - old.thinkingTokens);
      delta.tool += tools - old.tools;
      delta.system += system - old.system;
      if (busy && !old.busy) boundaries.push("start");
      if (!busy && old.busy)
        boundaries.push(
          row.payload?.type === "turn_aborted" ||
            row.message?.stopReason === "aborted"
            ? "aborted"
            : "end",
        );
    }
  }

  const normalized = events;
  if (token) {
    const used = token.used ?? 0,
      limit = token.limit ?? 0;
    token = {
      ...token,
      context_window: limit,
      tokens_in_context: used,
      percent_remaining: limit ? Math.max(0, 100 * (1 - used / limit)) : null,
      max_input_tokens: limit,
      reserved_tokens: 0,
    };
    thinkingTokens =
      token.reasoning_output_tokens ??
      token.output_tokens_details?.reasoning_tokens ??
      thinkingTokens;
  }
  return {
    events: normalized,
    busy,
    token,
    threadId,
    rows,
    delta,
    boundaries,
    thinking,
    thinkingTokens,
    tools,
    system,
    subagents: [...subagents.values()],
    completedAt,
    revision: createHash("sha256").update(source).digest("hex").slice(0, 24),
  };
}

/** A descriptor must belong to the exact PTY process tree; cwd/time are never identities. */
export function attributedLog(
  home: string,
  backend: Backend,
  pid: number,
  additionalPid?: number,
): NativeLog | undefined {
  const open = new Set<string>(),
    visited = new Set<number>();
  function walk(processId: number) {
    if (visited.has(processId) || visited.size >= 256) return;
    visited.add(processId);
    try {
      for (const fd of readdirSync(`/proc/${processId}/fd`)) {
        try {
          const target = readlinkSync(`/proc/${processId}/fd/${fd}`);
          if (target.endsWith(".jsonl")) open.add(target);
        } catch {}
      }
    } catch {}
    try {
      for (const child of readFileSync(
        `/proc/${processId}/task/${processId}/children`,
        "utf8",
      )
        .trim()
        .split(/\s+/)
        .map(Number)
        .filter(Boolean))
        walk(child);
    } catch {}
  }
  if (process.platform === "darwin") {
    try {
      const table = execFileSync("/bin/ps", ["-axo", "pid=,ppid="], {
        encoding: "utf8",
        timeout: 3000,
      })
        .trim()
        .split("\n")
        .map((row) => row.trim().split(/\s+/).map(Number));
      const ids = new Set<number>([
        pid,
        ...(additionalPid ? [additionalPid] : []),
      ]);
      let changed = true;
      while (changed && ids.size < 256) {
        changed = false;
        for (const [child, parent] of table)
          if (child && parent && ids.has(parent) && !ids.has(child)) {
            ids.add(child);
            changed = true;
          }
      }
      const descriptors = execFileSync(
        "/usr/sbin/lsof",
        ["-a", "-p", [...ids].join(","), "-F0n"],
        { encoding: "utf8", timeout: 3000, maxBuffer: 8 * 1024 * 1024 },
      );
      for (const field of descriptors.split(/\0|\n/))
        if (field.startsWith("n") && field.endsWith(".jsonl"))
          open.add(field.slice(1));
    } catch {}
  } else {
    walk(pid);
    if (additionalPid) walk(additionalPid);
  }
  return scanLogs(home, backend).find((log) => open.has(log.path));
}
