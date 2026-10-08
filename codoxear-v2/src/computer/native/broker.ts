import { createServer } from "node:net";
import { DomainError } from "../../contracts/model.js";
import { BrokerQueue } from "./queue.js";
import {
  mkdirSync,
  writeFileSync,
  readFileSync,
  renameSync,
  unlinkSync,
  chmodSync,
  statSync,
  openSync,
  closeSync,
  fsyncSync,
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
import { providerCatalog, configuredCatalogCredentials, resolveCatalogLaunch } from "../provider-catalog.js";
import { readLaunchDefaults } from "./launch-defaults.js";
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
const launchDefaults = readLaunchDefaults(input.home, input.cwd, command.env).backends[input.backend];
const selectedProvider = input.launch.model_provider ?? launchDefaults.model_provider;
// Resolve once while this broker owns the launch, never from a later Computer default.
const savedCatalogRequest = (() => {
  try {
    const provider = input.launch.provider_config;
    const credentials = provider?.base_url ? { base: provider.base_url, key: provider.api_key, api: provider.api }
      : selectedProvider ? configuredCatalogCredentials(input.home, { backend: input.backend, provider: selectedProvider }, command.env) : null;
    return credentials ? { backend: input.backend, base_url: credentials.base, api_key: credentials.key, api: credentials.api } : null;
  } catch { return null; }
})();
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
  lastDiscovery = 0;
let piToken: any = null;
let stopping = false;
let deleteKillTimer: ReturnType<typeof setTimeout> | undefined;
let readEventId: string | null = null;
let draft = "",
  attachments: Attachment[] = [],
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
let restoredState: any = {};
try {
  restoredState = JSON.parse(readFileSync(statePath, "utf8"));
} catch {}
draft = typeof restoredState.draft === "string" ? restoredState.draft : draft;
attachments = Array.isArray(restoredState.attachments)
  ? restoredState.attachments
  : attachments;
if (restoredState.unattended) unattended = restoredState.unattended;
lastUnattended = Number.isFinite(restoredState.last_unattended) ? restoredState.last_unattended : 0;
let unattendedAttempt: string | null = typeof restoredState.unattended_attempt === "string" ? restoredState.unattended_attempt : null;
if (unattendedAttempt) unattended.enabled = false;
readEventId = restoredState.read_event_id ?? readEventId;
const unifiedQueue = new BrokerQueue(restoredState.queue, persist);
const queue = unifiedQueue.items;
const receipts = new Map<string, unknown>();
const pendingReceipts = new Map<string, Promise<unknown>>();
let sending: Promise<unknown> = Promise.resolve();
let submissionPending = false;
let interruptEpoch = 0;
type ProducerActivity = { path: string | null; rows: number; users: number };
let terminalActivity: ProducerActivity | undefined;
let sendActivity: ProducerActivity | undefined;
let lastRemotePrompt: string | undefined;
let claudeInterrupt: { output: string; prompt: string | undefined } | undefined;
let claudeInterruptedIdle: ProducerActivity | undefined;
let clearRestoredRemotePrompt: string | undefined;
function producerActivity(): ProducerActivity {
  const transcript = readTranscript(meta.log_path, input.backend);
  return {
    path: meta.log_path,
    rows: transcript.rows,
    users: transcript.events.filter((event) => event.role === "user").length,
  };
}
function producerProvesIdle(activity: ProducerActivity): boolean {
  const transcript = readTranscript(meta.log_path, input.backend);
  const samePath = activity.path === meta.log_path;
  const newRows = readTranscript(
    meta.log_path,
    input.backend,
    samePath ? activity.rows : 0,
  );
  return (
    transcript.events.filter((event) => event.role === "user").length >
      (samePath ? activity.users : 0) &&
    !newRows.busy &&
    newRows.boundaries.some(
      (boundary) => boundary === "end" || boundary === "aborted",
    )
  );
}
const attached = new Set<import("node:net").Socket>();
const queueEditors = new Set<import("node:net").Socket>();
function persist() {
  meta.updated_ts = Date.now() / 1000;
  meta.queue_len = queue.length;
  const temp = metadataPath + ".tmp";
  writeFileSync(temp, JSON.stringify(meta), { mode: 0o600 });
  renameSync(temp, metadataPath);
  const stateTemp = statePath + ".tmp";
  writeFileSync(
    stateTemp,
    JSON.stringify({
      draft,
      attachments,
      queue,
      unattended,
      last_unattended: lastUnattended,
      unattended_attempt: unattendedAttempt,
      read_event_id: readEventId,
    }),
    { mode: 0o600 },
  );
  const stateFd = openSync(stateTemp, "r");
  try {
    fsyncSync(stateFd);
  } finally {
    closeSync(stateFd);
  }
  renameSync(stateTemp, statePath);
  const directoryFd = openSync(directory, "r");
  try {
    fsyncSync(directoryFd);
  } finally {
    closeSync(directoryFd);
  }
}
function readinessError() {
  return (
    meta.setup_message ??
    `${input.backend === "cc" ? "Claude Code" : input.backend === "codex" ? "Codex" : "Pi"} is starting: wait for the native prompt, or complete runtime setup in a local terminal. Your prompt was not sent.`
  );
}
function requireQueuedIdle(dispatchingId?: string) {
  if (
    meta.busy ||
    (queue.length > 0 && queue[0]?.id !== dispatchingId) ||
    attachments.length ||
    submissionPending ||
    queueEditors.size > 0 ||
    terminalActivity ||
    meta.readiness !== "ready"
  )
    throw new DomainError(
      409,
      "queue_not_dispatched",
      "The native session is no longer idle; the queued prompt was not sent. Local terminal input holds the queue until a new backend turn finishes.",
    );
}
function send(
  text: string,
  requireIdle = false,
  dispatchingId?: string,
  actorId?: string,
  workspace?: unknown,
): Promise<unknown> {
  const operation = sending.then(async () => {
    if (requireIdle) requireQueuedIdle(dispatchingId);
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
    const ownedAttachments = attachments.filter(
      (attachment) => attachment.actorId === actorId,
    );
    if (
      actorId &&
      ownedAttachments.some(
        (attachment) =>
          JSON.stringify(attachment.workspace) !== JSON.stringify(workspace),
      )
    )
      throw new DomainError(
        403,
        "attachment_grant_changed",
        "Attachment access changed; remove it and upload again",
      );
    const files = ownedAttachments
      .map((a) => `\n${a.kind === "image" ? "Image" : "File"}: ${a.path}`)
      .join("");
    attachments = attachments.filter(
      (attachment) => attachment.actorId !== actorId,
    );
    claudeInterruptedIdle = undefined;
    meta.busy = true;
    sendActivity = producerActivity();
    persist();
    submissionPending = true;
    const initialInterruptEpoch = interruptEpoch;
    try {
      // Claude restores the canceled remote prompt into its editor. Clear it
      // only after the producer positively echoed that same owned prompt.
      if (clearRestoredRemotePrompt && !terminalActivity)
        terminal.write(
          "\x15\x7f".repeat(
            clearRestoredRemotePrompt.split(/\r?\n/).length - 1,
          ) + "\x15",
        );
      clearRestoredRemotePrompt = undefined;
      terminal.write("\x1b[200~" + text + files + "\x1b[201~");
      await new Promise((resolve) => setTimeout(resolve, 50));
      if (
        meta.readiness !== "ready" ||
        stopping ||
        initialInterruptEpoch !== interruptEpoch ||
        (requireIdle && (terminalActivity || queueEditors.size > 0))
      )
        throw Error("The native process stopped before submission");
      sendActivity = producerActivity();
      lastRemotePrompt = text + files;
      terminal.write("\r");
      meta.busy = true;
      persist();
    } catch {
      throw Object.assign(
        Error(
          "Native send outcome unknown. Check the transcript before sending again.",
        ),
        {
          status: 504,
          code: "runtime_uncertain",
        },
      );
    } finally {
      submissionPending = false;
    }
    return { ok: true, accepted: true, commit_unknown: false };
  });
  sending = operation.catch(() => {});
  return operation;
}
terminal.onData((chunk) => {
  output = (output + chunk).slice(-65536);
  if (claudeInterrupt) {
    claudeInterrupt.output = (claudeInterrupt.output + chunk).slice(-32768);
    const observed = claudeInterrupt.output;
    const idleTitle = /\x1b\]0;✳ Claude Code(?:\x07|\x1b\\)/.test(observed);
    const compact = (text: string) => text.replace(/\s/g, "");
    const editorOutput = observed.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
    const restored =
      !claudeInterrupt.prompt ||
      [...editorOutput.matchAll(/❯/g)].some((match) =>
        compact(editorOutput.slice(match.index! + 1)).startsWith(
          compact(claudeInterrupt!.prompt!),
        ),
      );
    // Supported Claude 2.1.287 cancels inference without a log end row. Its
    // fresh foreground-idle title and restored editor are producer evidence;
    // startup output and background task state never satisfy this fence.
    if (idleTitle && restored) {
      clearRestoredRemotePrompt = claudeInterrupt.prompt;
      claudeInterrupt = undefined;
      claudeInterruptedIdle = producerActivity();
      sendActivity = undefined;
      meta.busy = false;
    }
  }
  if (
    meta.readiness === "starting" ||
    meta.readiness === "setup_required" ||
    input.backend === "codex"
  ) {
    const clear = Math.max(
      chunk.lastIndexOf("\x1b[J"),
      chunk.lastIndexOf("\x1b[2J"),
    );
    startup =
      clear < 0
        ? (startup + chunk).slice(-16384)
        : chunk.slice(clear).slice(-16384);
    const observed = startupState(input.backend, startup);
    if (observed.ready) {
      meta.readiness = "ready";
      meta.setup_message = null;
      startup = "";
    } else if (observed.message) {
      meta.readiness = "setup_required";
      meta.setup_message = observed.message;
      startup = "";
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
          queueEditors.delete(socket);
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
              ) {
                terminalActivity = producerActivity();
                lastRemotePrompt = undefined;
                clearRestoredRemotePrompt = undefined;
                if (claudeInterrupt) claudeInterrupt.prompt = undefined;
                terminal.write(message.data);
              }
              if (message.type === "queue_mode") {
                if (message.active === true) queueEditors.add(socket);
                else queueEditors.delete(socket);
              }
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
  const actorId = typeof body.actorId === "string" ? body.actorId : undefined;
  const visibleAttachments = () =>
    attachments.filter((attachment) => attachment.actorId === actorId);
  switch (request.operation) {
    case "state":
      return {
        ...meta,
        interrupted_idle: !!claudeInterruptedIdle,
        codex_live_settings: !!codexControl,
        unified_queue: true,
        actor_attachments: true,
        tail: output,
        token: piToken ?? readTranscript(meta.log_path, input.backend).token,
        attachments: visibleAttachments(),
        queue: unifiedQueue.list(
          typeof body.scope === "string" ? body.scope : undefined,
        ),
        draft,
        read_event_id: readEventId,
        unattended,
      };
    case "tail":
      return { tail: output };
    case "send": {
      const key =
        typeof body.request_id === "string"
          ? JSON.stringify([
              actorId ?? "local",
              body.workspace ?? null,
              body.request_id,
            ])
          : "";
      if (key && receipts.has(key)) return receipts.get(key);
      if (key && pendingReceipts.has(key)) return pendingReceipts.get(key);
      if (body.require_idle === true) requireQueuedIdle();
      const text = String(body.text ?? "");
      const slash = /^\/(model|effort|thinking)\s+(.+)$/.exec(text.trim());
      const operation =
        input.backend === "pi" && slash
          ? control({
              operation: "settings",
              body: {
                [slash[1] === "model" ? "model" : "reasoning_effort"]: slash[2],
              },
            })
          : send(
              text,
              body.require_idle === true,
              undefined,
              actorId,
              body.workspace,
            );
      if (key) pendingReceipts.set(key, operation);
      let result: unknown;
      try {
        result = await operation;
      } finally {
        if (key) pendingReceipts.delete(key);
      }
      if (key) {
        receipts.set(key, result);
        if (receipts.size > 1000)
          receipts.delete(receipts.keys().next().value!);
      }
      return result;
    }
    case "interrupt":
      interruptEpoch++;
      if (input.backend === "cc" && meta.busy)
        claudeInterrupt = { output: "", prompt: lastRemotePrompt };
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
        attachments: visibleAttachments(),
        staged_attachments: visibleAttachments(),
        pending_attachment: visibleAttachments().length > 0,
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
        ...(actorId ? { actorId } : {}),
        ...(actorId && body.workspace
          ? {
              workspace: body.workspace as NonNullable<Attachment["workspace"]>,
            }
          : {}),
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
        attachments: visibleAttachments(),
        staged_attachments: visibleAttachments(),
        pending_attachment: true,
      };
    }
    case "attachments/delete":
      attachments = attachments.filter(
        (a) => a.id !== body.id || a.actorId !== actorId,
      );
      persist();
      return {
        ok: true,
        attachments: visibleAttachments(),
        staged_attachments: visibleAttachments(),
        pending_attachment: visibleAttachments().length > 0,
      };
    case "attachments/clear":
    case "pending_attachment/clear":
      attachments = attachments.filter(
        (attachment) => attachment.actorId !== actorId,
      );
      persist();
      return {
        ok: true,
        attachments: visibleAttachments(),
        staged_attachments: visibleAttachments(),
        pending_attachment: false,
      };
    case "queue/capabilities":
      return { unified: true, actor_attachments: true };
    case "queue":
      return {
        items: unifiedQueue.list(
          typeof body.scope === "string" ? body.scope : undefined,
        ),
        queue_len: queue.length,
      };
    case "enqueue": {
      const id = unifiedQueue.enqueue(
        body,
        typeof body.scope === "string" ? body.scope : undefined,
      );
      return { ok: true, id, queue_len: queue.length };
    }
    case "queue/delete":
    case "queue/update":
    case "queue/move":
      unifiedQueue.mutate(
        request.operation.slice(6),
        body,
        typeof body.scope === "string" ? body.scope : undefined,
      );
      return {
        ok: true,
        items: unifiedQueue.list(
          typeof body.scope === "string" ? body.scope : undefined,
        ),
        queue_len: queue.length,
      };
    case "queue/head":
      return unifiedQueue.head(String(body.scope ?? "")) ?? null;
    case "queue/pause":
      unifiedQueue.pause(
        body.id,
        body.version,
        body.reason,
        String(body.scope ?? ""),
      );
      return { ok: true };
    case "queue/dispatch": {
      // Fresh Hub authorization was checked by the Computer. This synchronous
      // claim revalidates the head/version and native idle before any paste.
      requireQueuedIdle(String(body.id));
      const item = unifiedQueue.claim(
        body.id,
        body.version,
        String(body.scope ?? ""),
      );
      try {
        const result = await send(item.text, true, item.id);
        unifiedQueue.finish(item.id);
        return result;
      } catch (error) {
        unifiedQueue.finish(item.id, error);
        throw error;
      }
    }
    case "unattended":
      if (Object.keys(body).length) {
        if (body.review_attempt !== undefined) {
          if (!unattendedAttempt || body.review_attempt !== unattendedAttempt)
            throw new DomainError(409, "unattended_review_changed", "Reload unattended settings before reviewing this attempt");
          unattendedAttempt = null;
          persist();
        }
        if (unattendedAttempt && body.enabled === true)
          throw new DomainError(409, "unattended_commit_unknown", "Check the transcript and review the previous unattended attempt before enabling again");
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
      return { ...unattended, commit_unknown: unattendedAttempt };
    case "provider-models": {
      if (!savedCatalogRequest) throw new DomainError(409, "catalog_unavailable", "This session has no saved provider endpoint and API key for discovery");
      return providerCatalog(input.home, savedCatalogRequest);
    }
    case "settings/read": {
      const editable = input.backend === "codex" && !!codexControl && !!meta.thread_id && meta.readiness === "ready" && !meta.busy;
      const choice = launchDefaults.model_provider === selectedProvider ? launchDefaults.provider_choice ?? selectedProvider : selectedProvider;
      const ids = choice ? launchDefaults.provider_models?.[choice] ?? [] : [];
      const known = [...new Set([...ids, ...(meta.model ? [meta.model] : [])])];
      return { model: meta.model, reasoning_effort: meta.reasoning_effort, provider: selectedProvider,
        editable, reason: editable ? null : meta.busy ? "Wait until the agent is idle before changing runtime settings" : "This terminal runtime cannot confirm model and thinking effort together; use its native commands",
        catalog: { metadata_available: false, models: known.map((id) => ({ id, supports_reasoning: null, supported_reasoning_efforts: null,
          runtime_reasoning_efforts: launchDefaults.reasoning_efforts_by_model?.[`${choice}/${id}`] ?? launchDefaults.reasoning_efforts_by_model?.[id] ?? (id === launchDefaults.model ? launchDefaults.reasoning_efforts : id === meta.model && meta.reasoning_effort ? [meta.reasoning_effort] : []) })) } };
    }
    case "settings": {
      if (meta.readiness !== "ready") throw Error(readinessError());
      if (meta.busy)
        throw Error(
          "Wait until the agent is idle before changing runtime settings",
        );
      if (typeof body.model === "string" && Object.hasOwn(body, "reasoning_effort")) {
        if (input.backend !== "codex" || !codexControl || !meta.thread_id)
          throw new DomainError(409, "setting_refused", "This terminal runtime cannot confirm model and thinking effort together; use its native commands");
        if (typeof body.reasoning_effort !== "string" || !body.model.trim() || !body.reasoning_effort.trim() || body.model === "default" || /[\r\n\0]/.test(body.model + body.reasoning_effort))
          throw new DomainError(400, "invalid_setting", "Choose a valid model and reasoning effort");
        if (savedCatalogRequest) await resolveCatalogLaunch(input.home, input.backend, {
          provider_catalog: true, model: body.model, reasoning_effort: body.reasoning_effort,
          provider_config: { base_url: savedCatalogRequest.base_url, api_key: savedCatalogRequest.api_key },
        });
        const response = await codexRpc(codexSocket, "thread/settings/update", { threadId: meta.thread_id, model: body.model, effort: body.reasoning_effort });
        if (response.error) throw new DomainError(409, "setting_refused", "Codex rejected the requested runtime settings");
        meta.model = body.model;
        meta.reasoning_effort = body.reasoning_effort;
        persist();
        return { ok: true, accepted: true, model: meta.model, reasoning_effort: meta.reasoning_effort };
      }
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
      queue.splice(0);
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
          marker.pid === terminal.pid &&
          Date.parse(marker.updatedAt) >= meta.start_ts * 1000 &&
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
      if (!submissionPending) {
        if (sendActivity && producerProvesIdle(sendActivity))
          sendActivity = undefined;
        if (
          claudeInterruptedIdle &&
          transcript.events.filter((event) => event.role === "user").length >
            claudeInterruptedIdle.users
        )
          claudeInterruptedIdle = undefined;
        meta.busy =
          !!sendActivity || (!claudeInterruptedIdle && transcript.busy);
      }
      if (terminalActivity && producerProvesIdle(terminalActivity))
        terminalActivity = undefined;
    }
    if (
      !meta.busy &&
      !terminalActivity &&
      queueEditors.size === 0 &&
      meta.readiness === "ready" &&
      queue.length
    ) {
      const candidate = unifiedQueue.head();
      if (candidate) {
        requireQueuedIdle(candidate.id);
        const item = unifiedQueue.claim(candidate.id, candidate.version);
        try {
          await send(item.text, true, item.id);
          unifiedQueue.finish(item.id);
        } catch (error) {
          unifiedQueue.finish(item.id, error);
        }
      }
    }
    if (
      !meta.busy &&
      !terminalActivity &&
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
        !terminalActivity &&
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
        // Spend the budget and record uncertainty durably before touching the PTY.
        // A killed broker or partial paste must never automatically replay this turn.
        unattendedAttempt = randomUUID();
        lastUnattended = Date.now();
        unattended.remaining_injections--;
        if (!unattended.remaining_injections) unattended.enabled = false;
        persist();
        try {
          await send(prompt + (unattended.request ? "\n\n" + unattended.request : ""), true);
          unattendedAttempt = null;
        } catch (error) {
          unattended.enabled = false;
          persist();
          throw error;
        }
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
