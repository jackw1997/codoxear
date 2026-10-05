import { createServer } from "node:net";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import * as pty from "@lydell/node-pty";
import {
  ensureStateDirectory,
  socketPath as nativeSocketPath,
} from "./paths.js";
import {
  readUnattendedPrompt,
  unattendedIdleAllowsInjection,
} from "./workspace/unattended.js";
import { startCodexControl, codexRpc } from "./codex-control.js";
import { backendCommand, startupState } from "./backend.js";
import { readTranscript, attributedLog, scanLogs } from "./logs.js";
import type {
  Attachment,
  BrokerLaunch,
  BrokerRequest,
  Metadata,
} from "./types.js";
const input = await new Promise<BrokerLaunch>((resolve, reject) => {
  let text = "";
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    text += chunk;
    if (text.length > 1024 * 1024) reject(Error("Launch payload too large"));
  });
  process.stdin.on("end", () => {
    try {
      resolve(JSON.parse(text));
    } catch (error) {
      reject(error);
    }
  });
});
const directory = ensureStateDirectory(input.storageHome ?? input.home);
const socketPath = nativeSocketPath(
    input.storageHome ?? input.home,
    input.sessionId,
  ),
  metadataPath = join(directory, input.sessionId + ".json"),
  statePath = join(directory, input.sessionId + ".state.json");
const command = backendCommand(input, !process.argv.includes("--terminal"));
const codexSocket = nativeSocketPath(
  input.storageHome ?? input.home,
  input.sessionId,
  ".codex",
);
const codexControl =
  input.backend === "codex" &&
  !input.launch.resume_session_id &&
  process.env.CODOXEAR_NATIVE_CODEX_LIVE_CONTROL !== "0"
    ? await startCodexControl(
        command.command,
        command.args,
        command.env,
        input.cwd,
        codexSocket,
      )
    : undefined;
if (codexControl) command.args.unshift("--remote", `unix://${codexSocket}`);
const terminal = pty.spawn(command.command, command.args, {
  name: "xterm-256color",
  cols: 120,
  rows: 40,
  cwd: input.cwd,
  env: command.env,
});
const meta: Metadata = {
  version: 1,
  session_id: input.sessionId,
  thread_id:
    input.launch.resume_session_id ??
    (input.backend === "cc"
      ? (command.args[command.args.indexOf("--session-id") + 1] ?? null)
      : null),
  agent_backend: input.backend,
  broker_pid: process.pid,
  pid: terminal.pid,
  cwd: input.cwd,
  start_ts: Date.now() / 1000,
  updated_ts: Date.now() / 1000,
  log_path: input.resumePath ?? null,
  alias: input.name,
  model: input.launch.model ?? null,
  model_provider: input.launch.model_provider ?? null,
  reasoning_effort: input.launch.reasoning_effort ?? null,
  service_tier: input.launch.service_tier ?? null,
  launch_requires_reentry: !!(
    input.launch.provider_config ||
    input.launch.env_vars ||
    input.launch.command
  ),
  busy: false,
  readiness: "starting",
  setup_message: null,
  queue_len: 0,
  exit_code: null,
};
let output = "",
  startup = "",
  sentAt = 0,
  lastDiscovery = 0;
let piToken: any = null;
let stopping = false;
let deleteKillTimer: ReturnType<typeof setTimeout> | undefined;
let readEventId: string | null = null;
let draft = "",
  attachments: Attachment[] = [],
  queue: Array<{ id: string; text: string; at: number }> = [],
  unattended: {
    enabled: boolean;
    request: string;
    cooldown_minutes: number;
    remaining_injections: number;
  } = {
    enabled: false,
    request: "",
    cooldown_minutes: 5,
    remaining_injections: 10,
  },
  lastUnattended = 0;
const receipts = new Map<string, unknown>();
const attached = new Set<import("node:net").Socket>();
function persist() {
  meta.updated_ts = Date.now() / 1000;
  meta.queue_len = queue.length;
  const temp = metadataPath + ".tmp";
  writeFileSync(temp, JSON.stringify(meta), { mode: 0o600 });
  renameSync(temp, metadataPath);
  writeFileSync(
    statePath,
    JSON.stringify({
      draft,
      attachments,
      queue,
      unattended,
      read_event_id: readEventId,
    }),
    { mode: 0o600 },
  );
}
function readinessError() {
  return (
    meta.setup_message ??
    `${input.backend === "cc" ? "Claude Code" : input.backend === "codex" ? "Codex" : "Pi"} is starting: wait for the native prompt, or complete runtime setup in a local terminal. Your prompt was not sent.`
  );
}
function send(text: string) {
  if (meta.readiness !== "ready")
    throw Object.assign(Error(readinessError()), {
      status: 409,
      code: "setup_required",
    });
  if (!text.trim())
    throw Object.assign(Error("Enter a message"), {
      status: 400,
      code: "invalid_message",
    });
  const files = attachments
    .map((a) => `\n${a.kind === "image" ? "Image" : "File"}: ${a.path}`)
    .join("");
  terminal.write("\x1b[200~" + text + files + "\x1b[201~");
  setTimeout(() => terminal.write("\r"), 50);
  attachments = [];
  meta.busy = true;
  sentAt = Date.now();
  persist();
  return { ok: true, accepted: true, commit_unknown: false };
}
terminal.onData((chunk) => {
  output = (output + chunk).slice(-65536);
  if (meta.readiness === "starting" || meta.readiness === "setup_required") {
    startup = (startup + chunk).slice(-16384);
    const observed = startupState(input.backend, startup);
    if (observed.ready) {
      meta.readiness = "ready";
      meta.setup_message = null;
      startup = "";
    } else if (observed.message) {
      meta.readiness = "setup_required";
      meta.setup_message = observed.message;
    }
  }
  // Answer native terminal queries without user input or answering runtime setup prompts.
  if (chunk.includes("\x1b[6n")) terminal.write("\x1b[1;1R");
  if (chunk.includes("\x1b[c")) terminal.write("\x1b[?1;2c");
  if (chunk.includes("\x1b[18t")) terminal.write("\x1b[8;40;120t");
  if (chunk.includes("\x1b]10;?"))
    terminal.write("\x1b]10;rgb:ffff/ffff/ffff\x1b\\");
  if (chunk.includes("\x1b]11;?"))
    terminal.write("\x1b]11;rgb:0000/0000/0000\x1b\\");
  if (chunk.includes("\x1b[?u")) terminal.write("\x1b[?0u");
  persist();
});
const server = createServer((socket) => {
  let buffer = "";
  socket.setEncoding("utf8");
  socket.on("data", async (data) => {
    buffer += data;
    if (buffer.length > 1024 * 1024) {
      socket.destroy();
      return;
    }
    const newline = buffer.indexOf("\n");
    if (newline < 0) return;
    socket.pause();
    try {
      const request = JSON.parse(buffer.slice(0, newline)) as BrokerRequest;
      if (request.operation === "attach") {
        attached.add(socket);
        socket.removeAllListeners("data");
        let messages = buffer.slice(newline + 1);
        const subscription = terminal.onData((data) => {
          if (!socket.destroyed)
            socket.write(JSON.stringify({ type: "output", data }) + "\n");
        });
        socket.on("close", () => {
          attached.delete(socket);
          subscription.dispose();
        });
        socket.on("data", (chunk) => {
          messages += chunk;
          let end;
          while ((end = messages.indexOf("\n")) >= 0) {
            const line = messages.slice(0, end);
            messages = messages.slice(end + 1);
            try {
              const message = JSON.parse(line);
              if (
                message.type === "input" &&
                typeof message.data === "string" &&
                message.data.length < 200000
              )
                terminal.write(message.data);
              if (message.type === "resize") {
                const cols = Math.max(
                    20,
                    Math.min(1000, Number(message.cols) || 120),
                  ),
                  rows = Math.max(
                    10,
                    Math.min(500, Number(message.rows) || 40),
                  );
                terminal.resize(cols, rows);
              }
            } catch {}
          }
        });
        socket.write(JSON.stringify({ type: "output", data: output }) + "\n");
        socket.resume();
        if (messages.length) socket.emit("data", "");
        return;
      }
      const result = await control(request);
      socket.end(JSON.stringify({ ok: true, value: result }) + "\n");
    } catch (error) {
      const e = error as Error & { status?: number; code?: string };
      socket.end(
        JSON.stringify({
          ok: false,
          error: e.message,
          status: e.status ?? 400,
          code: e.code ?? "runtime_error",
        }) + "\n",
      );
    }
  });
});
async function control(request: BrokerRequest): Promise<unknown> {
  const body = request.body ?? {};
  switch (request.operation) {
    case "state":
      return {
        ...meta,
        codex_live_settings: !!codexControl,
        tail: output,
        token: piToken ?? readTranscript(meta.log_path, input.backend).token,
        attachments,
        queue,
        draft,
        read_event_id: readEventId,
        unattended,
      };
    case "tail":
      return { tail: output };
    case "send": {
      const key = typeof body.request_id === "string" ? body.request_id : "";
      if (key && receipts.has(key)) return receipts.get(key);
      const text = String(body.text ?? "");
      const slash = /^\/(model|effort|thinking)\s+(.+)$/.exec(text.trim());
      const result =
        input.backend === "pi" && slash
          ? await control({
              operation: "settings",
              body: {
                [slash[1] === "model" ? "model" : "reasoning_effort"]: slash[2],
              },
            })
          : send(text);
      if (key) {
        receipts.set(key, result);
        if (receipts.size > 1000)
          receipts.delete(receipts.keys().next().value!);
      }
      return result;
    }
    case "interrupt":
      // Native Codex, Pi and Claude all use Escape to interrupt a turn.
      // Keep busy until their transcript records the actual aborted/end turn.
      terminal.write("\x1b");
      return { ok: true, interrupted: true, interrupt_requested: true };
    case "rename":
      meta.alias = String(body.name ?? "").slice(0, 120);
      persist();
      return { ok: true };
    case "draft":
      if (body.text !== undefined) {
        draft = String(body.text);
        persist();
      }
      return { text: draft, updated_ts: meta.updated_ts };
    case "attachments":
      return {
        attachments,
        staged_attachments: attachments,
        pending_attachment: attachments.length > 0,
      };
    case "inject_file":
    case "inject_image": {
      const path = String(body.path ?? "");
      if (!path.startsWith("/"))
        throw Error("Attachment requires an absolute uploaded file path");
      readFileSync(path);
      const filename = String(
        body.filename ?? body.name ?? path.split("/").pop() ?? "file",
      );
      const attachment: Attachment = {
        id: randomUUID(),
        path,
        name: filename,
        filename,
        display_name: String(body.display_name ?? filename),
        size: statSync(path).size,
        content_type: String(body.content_type ?? "application/octet-stream"),
        created_ts: Date.now() / 1000,
        kind: request.operation === "inject_image" ? "image" : "file",
      };
      attachments.push(attachment);
      persist();
      return {
        ok: true,
        attachment,
        attachments,
        staged_attachments: attachments,
        pending_attachment: true,
      };
    }
    case "attachments/delete":
      attachments = attachments.filter((a) => a.id !== body.id);
      persist();
      return {
        ok: true,
        attachments,
        staged_attachments: attachments,
        pending_attachment: attachments.length > 0,
      };
    case "attachments/clear":
    case "pending_attachment/clear":
      attachments = [];
      persist();
      return {
        ok: true,
        attachments,
        staged_attachments: attachments,
        pending_attachment: false,
      };
    case "queue":
      return { items: queue, queue, queue_len: queue.length };
    case "enqueue": {
      const item = {
        id: randomUUID(),
        text: String(body.text ?? ""),
        at: Date.now(),
      };
      if (!item.text.trim()) throw Error("Enter a queued message");
      queue.push(item);
      persist();
      return { ok: true, item, queue_len: queue.length };
    }
    case "queue/delete":
      queue = queue.filter((q) => q.id !== body.id);
      persist();
      return { ok: true };
    case "queue/update": {
      const q = queue.find((q) => q.id === body.id);
      if (!q) throw Error("Unknown queued message");
      q.text = String(body.text ?? q.text);
      persist();
      return { ok: true };
    }
    case "queue/move": {
      const index = queue.findIndex((q) => q.id === body.id);
      if (index < 0) throw Error("Unknown queued message");
      const [item] = queue.splice(index, 1);
      queue.splice(
        Math.max(
          0,
          Math.min(queue.length, Number(body.index ?? body.to_index ?? 0)),
        ),
        0,
        item!,
      );
      persist();
      return { ok: true };
    }
    case "unattended":
      if (Object.keys(body).length) {
        const next = {
          enabled:
            body.enabled === undefined
              ? unattended.enabled
              : body.enabled === true,
          request: String(body.request ?? unattended.request),
          cooldown_minutes: Math.max(
            1,
            Math.trunc(
              Number(body.cooldown_minutes ?? unattended.cooldown_minutes),
            ),
          ),
          remaining_injections: Math.max(
            0,
            Math.trunc(
              Number(
                body.remaining_injections ?? unattended.remaining_injections,
              ),
            ),
          ),
        };
        if (
          !Number.isFinite(next.cooldown_minutes) ||
          !Number.isFinite(next.remaining_injections)
        )
          throw Error("Unattended counts must be finite integers");
        unattended = next;
        if (!unattended.remaining_injections) unattended.enabled = false;
        persist();
      }
      return unattended;
    case "settings": {
      if (meta.readiness !== "ready") throw Error(readinessError());
      if (meta.busy)
        throw Error(
          "Wait until the agent is idle before changing runtime settings",
        );
      const field =
        typeof body.model === "string"
          ? "model"
          : typeof body.reasoning_effort === "string"
            ? "reasoning_effort"
            : null;
      if (!field) throw Error("Choose a model or reasoning effort");
      const value = String(body[field]);
      if (/[\r\n\0]/.test(value)) throw Error("Invalid runtime setting");
      if (input.backend === "codex" && codexControl && meta.thread_id) {
        const response = await codexRpc(codexSocket, "thread/settings/update", {
          threadId: meta.thread_id,
          [field === "model" ? "model" : "effort"]: value,
        });
        if (response.error)
          throw Error("Codex rejected the requested runtime setting");
        meta[field] = value;
        persist();
        return { ok: true, accepted: true };
      }
      let previousCaps = "";
      if (input.backend === "pi")
        try {
          previousCaps = readFileSync(
            join(directory, input.sessionId + ".pi.caps"),
            "utf8",
          );
        } catch {}
      terminal.write(
        "\x1b[200~" +
          `/${field === "model" ? "model" : "effort"} ${value}` +
          "\x1b[201~",
      );
      setTimeout(() => terminal.write("\r"), 50);
      if (input.backend === "pi") {
        const deadline = Date.now() + 2000;
        while (Date.now() < deadline) {
          await new Promise((resolve) => setTimeout(resolve, 50));
          try {
            const currentCaps = readFileSync(
              join(directory, input.sessionId + ".pi.caps"),
              "utf8",
            );
            const caps = JSON.parse(currentCaps);
            const effective =
              field === "model"
                ? value.includes("/")
                  ? `${caps.model_provider}/${caps.model}`
                  : caps.model
                : caps.reasoning_effort;
            if (currentCaps !== previousCaps && effective === value) {
              meta[field] = field === "model" ? caps.model : effective;
              if (caps.model_provider)
                meta.model_provider = caps.model_provider;
              persist();
              return {
                ok: true,
                accepted: true,
                commit_unknown: false,
                effective,
              };
            }
          } catch {}
        }
        throw Error("Pi has not confirmed the requested runtime setting");
      }
      meta[field] = value;
      persist();
      return { ok: true, accepted: true };
    }
    case "delete":
      stopping = true;
      queue = [];
      unattended.enabled = false;
      terminal.kill("SIGTERM");
      deleteKillTimer = setTimeout(() => {
        try {
          terminal.kill("SIGKILL");
        } catch {}
      }, 1500).unref();
      return { ok: true, deleted: true };
    case "read":
      readEventId = typeof body.event_id === "string" ? body.event_id : null;
      persist();
      return { ok: true, event_id: readEventId };
    case "commit_unknown_send/clear":
      return { ok: true };
    default:
      throw Object.assign(
        Error(`Unsupported native session operation: ${request.operation}`),
        { status: 404, code: "unsupported_route" },
      );
  }
}
server.listen(socketPath, () => {
  chmodSync(socketPath, 0o600);
  persist();
  process.stdout.write(
    JSON.stringify({
      ready: true,
      localId: input.sessionId,
      brokerPid: process.pid,
    }) + "\n",
  );
});
let polling = false;
const poll = setInterval(async () => {
  if (polling) return;
  polling = true;
  try {
    if (!meta.log_path && Date.now() - lastDiscovery > 1000) {
      lastDiscovery = Date.now();
      const found =
        (input.backend === "cc" && meta.thread_id
          ? scanLogs(input.home, "cc").find(
              (log) => log.id === meta.thread_id && log.cwd === input.cwd,
            )
          : undefined) ??
        attributedLog(
          input.home,
          input.backend,
          terminal.pid,
          codexControl?.pid,
        );
      if (found) {
        meta.log_path = found.path;
        meta.thread_id = found.id;
      }
      if (!meta.log_path && input.backend === "codex" && codexControl) {
        try {
          // This server belongs solely to this PTY. Its in-memory loaded IDs
          // are producer evidence; persisted global newest logs are not.
          const loaded = await codexRpc(codexSocket, "thread/loaded/list", {
            limit: 100,
          });
          const ids = loaded.result?.data;
          if (Array.isArray(ids)) {
            const logs = scanLogs(input.home, "codex").filter(
              (log) => ids.includes(log.id) && log.cwd === input.cwd,
            );
            if (logs.length === 1) {
              meta.log_path = logs[0]!.path;
              meta.thread_id = logs[0]!.id;
            }
          }
        } catch {}
      }
    }
    if (input.backend === "pi") {
      try {
        const marker = JSON.parse(
          readFileSync(join(directory, input.sessionId + ".pi"), "utf8"),
        );
        if (
          marker.cwd === input.cwd &&
          typeof marker.sessionFile === "string"
        ) {
          meta.log_path = marker.sessionFile;
          meta.thread_id = marker.sessionId;
          meta.readiness = "ready";
          meta.setup_message = null;
        }
      } catch {}
      try {
        const caps = JSON.parse(
          readFileSync(join(directory, input.sessionId + ".pi.caps"), "utf8"),
        );
        if (caps.token) piToken = caps.token;
        if (caps.model) meta.model = caps.model;
        if (caps.model_provider) meta.model_provider = caps.model_provider;
        if (caps.reasoning_effort)
          meta.reasoning_effort = caps.reasoning_effort;
        (meta as any).slash_commands = caps.commands ?? [];
        (meta as any).pi_thinking_command = true;
      } catch {}
    }
    if (meta.log_path) {
      const transcript = readTranscript(meta.log_path, input.backend);
      meta.thread_id = transcript.threadId ?? meta.thread_id;
      const last = transcript.events.at(-1);
      if (
        transcript.completedAt >= sentAt - 200 ||
        (last?.role === "assistant" &&
          last.message_class === "final_response" &&
          last.ts * 1000 >= sentAt - 200)
      )
        meta.busy = transcript.busy;
    }
    if (
      meta.readiness === "starting" &&
      input.backend === "pi" &&
      Date.now() - meta.start_ts * 1000 > 1500 &&
      output.length > 0
    ) {
      meta.readiness = "ready";
    }
    if (!meta.busy && meta.readiness === "ready" && queue.length) {
      const item = queue.shift()!;
      send(item.text);
    }
    if (
      !meta.busy &&
      !queue.length &&
      !attachments.length &&
      meta.readiness === "ready" &&
      unattended.enabled &&
      unattended.remaining_injections > 0 &&
      unattendedIdleAllowsInjection(
        readTranscript(meta.log_path, input.backend).events,
        unattended.cooldown_minutes,
        lastUnattended,
      )
    ) {
      const prompt = await readUnattendedPrompt(
        input.storageHome ?? input.home,
      );
      // Reading the prompt yields to user controls; recheck readiness and the
      // current config before committing an automatic send.
      if (
        !meta.busy &&
        !queue.length &&
        !attachments.length &&
        meta.readiness === "ready" &&
        unattended.enabled &&
        unattended.remaining_injections > 0 &&
        unattendedIdleAllowsInjection(
          readTranscript(meta.log_path, input.backend).events,
          unattended.cooldown_minutes,
          lastUnattended,
        )
      ) {
        send(prompt + (unattended.request ? "\n\n" + unattended.request : ""));
        lastUnattended = Date.now();
        unattended.remaining_injections--;
        if (!unattended.remaining_injections) unattended.enabled = false;
      }
    }
    persist();
  } catch {
  } finally {
    polling = false;
  }
}, 500);
terminal.onExit((event) => {
  if (deleteKillTimer) clearTimeout(deleteKillTimer);
  for (const socket of attached) socket.end();
  if (codexControl) {
    codexControl.kill("SIGTERM");
    try {
      unlinkSync(codexSocket);
    } catch {}
  }
  meta.exit_code = event.exitCode;
  meta.busy = false;
  meta.readiness = "exited";
  persist();
  clearInterval(poll);
  server.close();
  try {
    unlinkSync(socketPath);
  } catch {}
  if (stopping) {
    try {
      unlinkSync(metadataPath);
      unlinkSync(statePath);
    } catch {}
  }
  setTimeout(() => process.exit(0), 100).unref();
});
// Brokers deliberately survive Computer shutdown. Only an explicit session delete stops this PTY.
