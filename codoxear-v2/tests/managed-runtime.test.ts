import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { ManagedRuntime } from "../src/computer/managed/runtime.js";
import { NativeHttpTarget } from "../src/computer/native/http.js";
import { emptyBody } from "../src/protocol/http-frames.js";
import { ComputerQueue } from "../src/computer/queue.js";
import {
  ManagedSetupError,
  type ManagedFactory,
  type ManagedOpen,
  type ManagedSession,
  type ManagedRecord,
  type ManagedOutcome,
} from "../src/computer/managed/driver.js";

assert.ok(
  existsSync("/.dockerenv"),
  "Managed runtime behavioral verification runs only in Docker",
);
class Session implements ManagedSession {
  capabilities = { images: true, steer: true };
  observer: ((record: ManagedRecord) => void) | undefined;
  seq = 0;
  prompts: string[] = [];
  promptOptions: { inputId: string; images?: readonly { path: string; mediaType?: string }[] }[] = [];
  disposed = false;
  failPrompt = false;
  completeBeforeFail = false;
  requestOnSubscribe = false;
  disposeWait: Promise<void> | undefined;
  exitObserver: (() => void) | undefined;
  constructor(readonly id: string) {}
  rawEvents(observer: (record: ManagedRecord) => void) {
    this.observer = observer;
    if (this.requestOnSubscribe) observer({
      kind: "request", direction: "toApp", seq: this.seq++, sessionId: this.id,
      receivedAt: Date.now(), agentPath: [], body: { kind: "approval" },
    });
    return () => {
      this.observer = undefined;
    };
  }
  onExit(observer: () => void) {
    this.exitObserver = observer;
    return () => {
      this.exitObserver = undefined;
    };
  }
  emit(events: Record<string, unknown>[]) {
    this.observer?.({
      kind: "frame",
      seq: this.seq++,
      sessionId: this.id,
      receivedAt: Date.now(),
      agentPath: [],
      body: { events },
    });
  }
  async prompt(text: string, options: { inputId: string; images?: readonly { path: string; mediaType?: string }[] }): Promise<ManagedOutcome> {
    this.prompts.push(text);
    this.promptOptions.push(options);
    if (this.failPrompt) {
      if (this.completeBeforeFail) this.emit([{ kind: "text_delta", text: "Delivered" }, { kind: "turn_ended", outcome: { kind: "completed" } }]);
      throw Error("Transport lost after submission");
    }
    return { kind: "accepted" };
  }
  async abort(): Promise<ManagedOutcome> {
    this.emit([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
    return { kind: "accepted" };
  }
  async dispose() {
    await this.disposeWait;
    this.disposed = true;
  }
}
class Factory implements ManagedFactory {
  opens: ManagedOpen[] = [];
  sessions: Session[] = [];
  setupError = false;
  nextApproval = false;
  async open(options: ManagedOpen) {
    if (this.setupError)
      throw new ManagedSetupError("Local approval setup required");
    this.opens.push(options);
    const session = new Session(
      options.resume ?? "native-" + this.opens.length,
    );
    session.requestOnSubscribe = this.nextApproval;
    this.sessions.push(session);
    return session;
  }
}
function fixture(
  options: {
    maxResident?: number;
    maxEvents?: number;
    idleMs?: number;
    now?: () => number;
  } = {},
) {
  const path = mkdtempSync(join(tmpdir(), "managed-runtime-"));
  const factory = new Factory();
  const config = {
    databasePath: join(path, "managed.sqlite"),
    home: path,
    stateHome: path,
    workspace: path,
    factory,
    ...options,
  };
  const runtime = new ManagedRuntime(config);
  return { runtime, factory, config, path };
}
const create = (agentId = "agent-a") => ({
  op: "create" as const,
  agentId,
  backend: "pi" as const,
  name: "Managed Pi",
});
async function tick() {
  await new Promise<void>((resolve) => setImmediate(resolve));
}

test("managed unattended mode persists settings, respects cooldown and queue, spends a bounded budget and stops after interruption", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock });
  try {
    const { localId } = await f.runtime.execute(create()) as { localId: string };
    const endpoint = `/api/sessions/${localId}/unattended`;
    assert.equal((await f.runtime.request(endpoint)).enabled, false);
    await f.runtime.request(endpoint, "POST", { enabled: true, cooldown_minutes: 1, remaining_injections: 1, request: "Continue bounded work" });
    await f.runtime.sendQueued(localId, "Original objective");
    f.factory.sessions[0]!.emit([{ kind: "text_delta", text: "Completed initial turn" }, { kind: "turn_ended", outcome: { kind: "completed" } }]);
    await f.runtime.runUnattended();
    assert.equal(f.factory.sessions[0]!.prompts.length, 1);
    clock += 60_000;
    f.runtime.setUnattendedBlocker(() => true);
    await f.runtime.runUnattended();
    assert.equal(f.factory.sessions[0]!.prompts.length, 1);
    assert.equal((await f.runtime.request(endpoint)).remaining_injections, 1);
    f.runtime.setUnattendedBlocker(() => false);
    await f.runtime.runUnattended();
    assert.equal(f.factory.sessions[0]!.prompts.length, 2);
    assert.ok(f.factory.sessions[0]!.prompts[1]!.endsWith("Continue bounded work"));
    const exhausted = await f.runtime.request(endpoint);
    assert.equal(exhausted.remaining_injections, 0);
    assert.equal(exhausted.enabled, false);
    assert.equal(exhausted.commit_unknown, null);
    await f.runtime.request(endpoint, "POST", { enabled: true, remaining_injections: 2 });
    await f.runtime.request(`/api/sessions/${localId}/interrupt`, "POST");
    clock += 60_000;
    await f.runtime.runUnattended();
    assert.equal((await f.runtime.request(endpoint)).enabled, false);
    assert.equal(f.factory.sessions[0]!.prompts.length, 2);
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("uncertain unattended dispatch remains disabled and review fenced after restart without replay", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock });
  let reopened: ManagedRuntime | undefined;
  try {
    const { localId } = await f.runtime.execute(create()) as { localId: string };
    const endpoint = `/api/sessions/${localId}/unattended`;
    await f.runtime.sendQueued(localId, "Original objective");
    f.factory.sessions[0]!.emit([{ kind: "text_delta", text: "Completed initial turn" }, { kind: "turn_ended", outcome: { kind: "completed" } }]);
    await f.runtime.request(endpoint, "POST", { enabled: true, cooldown_minutes: 1, remaining_injections: 2 });
    clock += 60_000;
    f.factory.sessions[0]!.failPrompt = true;
    await f.runtime.runUnattended();
    const failed = await f.runtime.request(endpoint);
    assert.equal(failed.enabled, false);
    assert.equal(failed.remaining_injections, 1);
    assert.ok(failed.commit_unknown);
    await f.runtime.close();
    reopened = new ManagedRuntime(f.config);
    assert.deepEqual(await reopened.request(endpoint), failed);
    await assert.rejects(reopened.request(endpoint, "POST", { enabled: true }), /review the previous unattended attempt/);
    await assert.rejects(reopened.request(endpoint, "POST", { review_attempt: "stale" }), /Reload unattended settings/);
    await reopened.request(endpoint, "POST", { review_attempt: failed.commit_unknown, enabled: true });
    clock += 60_000;
    await reopened.runUnattended();
    assert.equal(f.factory.opens.length, 1, "Uncertain runtime outcome blocks automatic replay even after settings review");
    assert.equal(f.factory.sessions[0]!.prompts.length, 2);
  } finally {
    await reopened?.close();
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("managed state home cannot depend on the invoking working directory", () => {
  assert.throws(() => new ManagedRuntime({
    home: "/tmp",
    workspace: "/tmp",
    databasePath: "/tmp/not-created-managed-state.sqlite",
    stateHome: "relative-state",
    factory: new Factory(),
  }), /paths must be absolute/);
});

for (const backend of ["pi", "codex", "cc"] as const) {
  test(`${backend} idle settings reopen the same native conversation, reject busy changes and retain prior configuration on refusal`, async () => {
    const f = fixture();
    try {
      const { localId } = await f.runtime.execute({ ...create(), backend, launch: { model: "first-model", reasoning_effort: "low" } }) as { localId: string };
      await f.runtime.sendQueued(localId, "Original task");
      f.factory.sessions[0]!.emit([{ kind: "text_delta", text: "Completed initial work" }, { kind: "turn_ended", outcome: { kind: "completed" } }]);
      const native = (await f.runtime.request(`/api/sessions/${localId}/state`)).thread_id;
      await assert.rejects(f.runtime.request(`/api/sessions/${localId}/settings`, "POST", { model: "default" }), /valid model or reasoning effort/);
      assert.equal(f.factory.opens.length, 1, "Hidden default selections never replace the owned runtime");
      const changed = await f.runtime.request(`/api/sessions/${localId}/settings`, "POST", { model: "second-model" });
      assert.equal(changed.accepted, true);
      assert.equal(f.factory.opens.at(-1)!.model, "second-model");
      assert.equal(f.factory.opens.at(-1)!.resume, native);
      assert.equal(f.factory.sessions[0]!.disposed, true);
      await f.runtime.sendQueued(localId, "Continue same conversation");
      await assert.rejects(f.runtime.request(`/api/sessions/${localId}/settings`, "POST", { reasoning_effort: "high" }), /Wait until the agent is idle/);
      assert.equal(f.factory.opens.length, 2);
      assert.equal(f.factory.sessions[1]!.disposed, false);
      f.factory.sessions[1]!.emit([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
      f.factory.setupError = true;
      await assert.rejects(f.runtime.request(`/api/sessions/${localId}/settings`, "POST", { model: "refused-model" }), /previous model and reasoning effort/);
      const restored = await f.runtime.request(`/api/sessions/${localId}/state`);
      assert.equal(restored.model, "second-model");
      assert.equal(restored.reasoning_effort, "low");
      assert.equal(restored.thread_id, native);
      assert.equal(restored.resident, false);
      f.factory.setupError = false;
      await f.runtime.request(`/api/sessions/${localId}/send`, "POST", { text: "/effort off" });
      assert.equal(f.factory.opens.at(-1)!.effort, "off");
      assert.equal(f.factory.opens.at(-1)!.resume, native);
      assert.deepEqual(f.factory.sessions.at(-1)!.prompts, [], "Setting commands must never become model prompts");
    } finally {
      await f.runtime.close();
      rmSync(f.path, { recursive: true, force: true });
    }
  });
}

test("managed HTTP attachments are actor scoped and delivered once as native images and accessible file references", async () => {
  const f = fixture();
  const http = new NativeHttpTarget(f.runtime, f.path);
  try {
    const { localId } = await f.runtime.execute(create()) as { localId: string };
    const call = async (action: string, method: "GET" | "POST" = "GET", body?: unknown, actorId = "alice") => {
      const response = await http.execute({
        method, path: `/api/sessions/${localId}/${action}`, headers: { "content-type": "application/json" }, actorId,
        body: body === undefined ? emptyBody : (async function* () { yield Buffer.from(JSON.stringify(body)); })(),
        signal: new AbortController().signal,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
      return { status: response.status, value: JSON.parse(Buffer.concat(chunks).toString()) };
    };
    const file = await call("inject_file", "POST", { filename: "guide.txt", data_b64: Buffer.from("Real attached file contents").toString("base64"), content_type: "text/plain" });
    assert.equal(file.status, 200);
    assert.equal(readFileSync(file.value.attachment.path, "utf8"), "Real attached file contents");
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
    const image = await call("inject_image", "POST", { filename: "pixel.png", data_b64: png, content_type: "image/png" });
    assert.equal(image.status, 200);
    assert.equal((await call("attachments", "GET", undefined, "bob")).value.attachments.length, 0);
    await call("attachments/delete", "POST", { id: file.value.attachment.id }, "bob");
    assert.equal((await call("attachments")).value.attachments.length, 2);
    const peer = await call("inject_file", "POST", { filename: "peer.txt", data_b64: Buffer.from("Private peer attachment").toString("base64") }, "bob");
    assert.equal(peer.status, 200);
    f.factory.sessions[0]!.capabilities.images = false;
    const unsupported = await call("send", "POST", { text: "Read these attachments", request_id: "image-refused" });
    assert.equal(unsupported.status, 409);
    assert.equal(f.factory.sessions[0]!.prompts.length, 0);
    assert.equal((await call("attachments")).value.attachments.length, 2);
    f.factory.sessions[0]!.capabilities.images = true;
    const sent = await call("send", "POST", { text: "Read these attachments", request_id: "native-image-input" });
    assert.equal(sent.status, 200);
    assert.ok(f.factory.sessions[0]!.prompts[0]!.includes(file.value.attachment.path));
    assert.ok(!f.factory.sessions[0]!.prompts[0]!.includes(peer.value.attachment.path));
    assert.deepEqual(f.factory.sessions[0]!.promptOptions[0]!.images, [{ path: image.value.attachment.path, mediaType: "image/png" }]);
    assert.equal((await call("attachments")).value.attachments.length, 0);
    assert.equal((await call("attachments", "GET", undefined, "bob")).value.attachments.length, 1);
    await call("send", "POST", { text: "Read these attachments", request_id: "native-image-input" });
    assert.equal(f.factory.sessions[0]!.prompts.length, 1, "A confirmed-send retry must never redeliver images or files");
    f.factory.sessions[0]!.emit([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    f.factory.sessions[0]!.failPrompt = true;
    f.factory.sessions[0]!.completeBeforeFail = true;
    assert.equal((await call("send", "POST", { text: "Peer input", request_id: "completed-before-transport-loss" }, "bob")).status, 200);
    assert.equal((await call("attachments", "GET", undefined, "bob")).value.attachments.length, 0, "Native completed delivery consumes attachments even if its transport subsequently throws");
    assert.equal(existsSync(file.value.attachment.path), true, "Delivered uploads remain readable by later tools");
    const temporary = await call("inject_file", "POST", { filename: "temporary.txt", data_b64: Buffer.from("Temporary staging").toString("base64") });
    assert.equal(temporary.status, 200);
    await call("attachments/delete", "POST", { id: temporary.value.attachment.id });
    assert.equal(existsSync(temporary.value.attachment.path), false, "Removing staged runtime-owned uploads frees their bytes");
    const userFile = join(f.path, "preserved-user-file.txt");
    writeFileSync(userFile, "User workspace contents");
    assert.equal((await call("inject_file", "POST", { path: userFile, name: "preserved-user-file.txt" })).status, 200);
    await call("attachments/clear", "POST", {});
    assert.equal(readFileSync(userFile, "utf8"), "User workspace contents", "Clearing path references never deletes user files");
    for (let index = 0; index < 20; index++) {
      assert.equal((await call("inject_file", "POST", { filename: `limit-${index}.txt`, data_b64: Buffer.from("Staged").toString("base64") })).status, 200);
    }
    const stagingDirectory = dirname(file.value.attachment.path);
    const beforeRefusal = readdirSync(stagingDirectory).sort();
    assert.equal((await call("inject_file", "POST", { filename: "refused.txt", data_b64: Buffer.from("Refused").toString("base64") })).status, 413);
    assert.deepEqual(readdirSync(stagingDirectory).sort(), beforeRefusal, "Refused uploads leave no orphan bytes");
    const staged = (await call("attachments")).value.attachments;
    await call("attachments/clear", "POST", {});
    for (const attachment of staged) assert.equal(existsSync(attachment.path), false);
    assert.equal((await call("delete", "POST", {})).status, 200);
    for (const attachment of [file.value.attachment, image.value.attachment, peer.value.attachment]) assert.equal(existsSync(attachment.path), false, "Explicit conversation deletion removes its delivered owned uploads");
    assert.equal(readFileSync(userFile, "utf8"), "User workspace contents");
  } finally {
    http.close();
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("another actor's staged files cannot block authorized queued or unattended work and own staging stays protected", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock });
  const queue = new ComputerQueue(":memory:", "managed-actors", {
    idle: async (localId, actorId) => {
      const catalog = await f.runtime.execute({ op: "discover", ...(actorId ? { actorId } : {}) }) as { sessions: { session_id: string; busy: boolean; pending_attachment: boolean }[] };
      const row = catalog.sessions.find((session) => session.session_id === localId);
      return !!row && !row.busy && !row.pending_attachment;
    },
    authorize: async () => {},
    send: async (localId, text, actorId) => { await f.runtime.sendQueued(localId, text, actorId); },
  });
  try {
    const { localId } = await f.runtime.execute(create()) as { localId: string };
    const aFile = join(f.path, "actor-a.txt"), bFile = join(f.path, "actor-b.txt");
    writeFileSync(aFile, "Actor A staged work");
    writeFileSync(bFile, "Actor B staged work");
    await f.runtime.request(`/api/sessions/${localId}/inject_file`, "POST", { path: aFile, actorId: "actor-a" });
    queue.enqueue(localId, "Actor B queued work", "actor-b", "authorized-actor-b");
    await queue.drain();
    assert.equal(queue.list(localId).length, 0);
    assert.deepEqual(f.factory.sessions[0]!.prompts, ["Actor B queued work"]);
    assert.equal((await f.runtime.request(`/api/sessions/${localId}/attachments`, "GET", { actorId: "actor-a" })).attachments.length, 1);
    f.factory.sessions[0]!.emit([{ kind: "text_delta", text: "Completed B work" }, { kind: "turn_ended", outcome: { kind: "completed" } }]);
    await f.runtime.request(`/api/sessions/${localId}/unattended`, "POST", { enabled: true, cooldown_minutes: 1, remaining_injections: 2, actorId: "actor-b" });
    clock += 60_000;
    await f.runtime.runUnattended();
    assert.equal(f.factory.sessions[0]!.prompts.length, 2, "Another actor's stale/revoked staging does not pause this actor's unattended work");
    f.factory.sessions[0]!.emit([{ kind: "text_delta", text: "Completed automatic work" }, { kind: "turn_ended", outcome: { kind: "completed" } }]);
    await f.runtime.request(`/api/sessions/${localId}/inject_file`, "POST", { path: bFile, actorId: "actor-b" });
    clock += 60_000;
    await f.runtime.runUnattended();
    assert.equal(f.factory.sessions[0]!.prompts.length, 2, "Own staged attachments pause unattended sends");
    queue.enqueue(localId, "B waits for own staging", "actor-b", "authorized-actor-b");
    await queue.drain();
    assert.equal(queue.list(localId).length, 1);
    await assert.rejects(f.runtime.sendQueued(localId, "Atomic queued staging fence", "actor-b"), (error: unknown) => (error as { code?: string }).code === "queue_not_dispatched");
    assert.equal(f.factory.sessions[0]!.prompts.length, 2);
    await f.runtime.request(`/api/sessions/${localId}/attachments/clear`, "POST", { actorId: "actor-b" });
    await queue.drain();
    assert.equal(queue.list(localId).length, 0);
    assert.equal(f.factory.sessions[0]!.prompts.length, 3);
    assert.equal(existsSync(aFile), true);
    assert.equal(existsSync(bFile), true);
  } finally {
    queue.close();
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("settings refusal preserves runtime review state raised during cold initialization", async () => {
  const f = fixture();
  try {
    const { localId } = await f.runtime.execute(create()) as { localId: string };
    await f.runtime.sendQueued(localId, "Original task");
    f.factory.sessions[0]!.emit([{ kind: "turn_ended", outcome: { kind: "completed" } }]);
    f.factory.nextApproval = true;
    await assert.rejects(f.runtime.request(`/api/sessions/${localId}/settings`, "POST", { model: "review-required" }), /previous model and reasoning effort/);
    const state = await f.runtime.request(`/api/sessions/${localId}/state`);
    assert.equal(state.runtime_state, "attention");
    assert.equal(state.commit_unknown_send, true);
    assert.equal(state.resident, false);
    await assert.rejects(f.runtime.sendQueued(localId, "Do not replay"), /automatic replay is blocked/);
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("managed sidebar edits survive restart and deleting one conversation disposes only its owned worker", async () => {
  const f = fixture();
  let reopened: ManagedRuntime | undefined;
  try {
    const { localId: first } = await f.runtime.execute(create("first")) as { localId: string };
    const { localId: second } = await f.runtime.execute(create("second")) as { localId: string };
    await assert.rejects(f.runtime.request(`/api/sessions/${first}/edit`, "POST", {
      name: "Self dependent", dependency_session_id: first,
    }), /cannot depend on itself/);
    await f.runtime.request(`/api/sessions/${first}/edit`, "POST", {
      name: "  Reviewed   task ", priority_offset: 0.25,
      snooze_until: Date.now() / 1000 + 3600, dependency_session_id: second,
    });
    const edited = await f.runtime.request(`/api/sessions/${first}/diagnostics`);
    assert.equal(edited.alias, "Reviewed task");
    assert.equal(edited.priority_offset, 0.25);
    assert.equal(edited.dependency_session_id, second);
    assert.equal(edited.blocked, true);
    assert.equal(edited.snoozed, true);
    await f.runtime.request(`/api/sessions/${first}/rename`, "POST", { name: "Renamed task" });
    assert.equal((await f.runtime.request(`/api/sessions/${first}/state`)).priority_offset, 0.25);
    await f.runtime.sendQueued(second, "Owned work");
    await f.runtime.request(`/api/sessions/${second}/unattended`, "POST", { enabled: true });
    let finishDisposal!: () => void;
    f.factory.sessions[1]!.disposeWait = new Promise<void>((done) => { finishDisposal = done; });
    f.factory.sessions[1]!.exitObserver?.();
    let deleteConfirmed = false;
    const deleting = f.runtime.request(`/api/sessions/${second}/delete`, "POST").then((result) => { deleteConfirmed = true; return result; });
    await tick();
    assert.equal(deleteConfirmed, false, "Deletion waits for in-progress owned disposal before confirmation");
    finishDisposal();
    assert.deepEqual(await deleting, { ok: true, deleted: true });
    assert.equal(f.factory.sessions[1]!.disposed, true);
    assert.equal(f.factory.sessions[0]!.disposed, false, "Deletion preserves other owned Computers and sessions");
    await assert.rejects(f.runtime.request(`/api/sessions/${second}/state`), /Unknown managed session/);
    assert.equal((await f.runtime.request(`/api/sessions/${first}/state`)).dependency_session_id, null);
    await f.runtime.close();
    reopened = new ManagedRuntime(f.config);
    const catalog = await reopened.request("/api/sessions");
    assert.deepEqual(catalog.sessions.map((session: { session_id: string }) => session.session_id), [first]);
    assert.equal(catalog.sessions[0].alias, "Renamed task");
    assert.equal(catalog.sessions[0].priority_offset, 0.25);
    assert.equal(f.factory.opens.length, 2, "Metadata and deletion do not launch replacement workers");
  } finally {
    await reopened?.close();
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("archived saved transcripts retain one binding across catalogue, state and tail after restart", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, idleMs: 10 });
  let reopened: ManagedRuntime | undefined;
  try {
    const { localId } = await f.runtime.execute(create()) as { localId: string };
    await f.runtime.sendQueued(localId, "saved user");
    f.factory.sessions[0]!.emit([
      { kind: "text_delta", text: "saved assistant" },
      { kind: "turn_ended", outcome: { kind: "completed" } },
    ]);
    const original = await f.runtime.request(`/api/sessions/${localId}/messages/tail`);
    await f.runtime.request(`/api/sessions/${localId}/read`, "POST", { actorId: "first-reader", event_id: original.events[0].message_id });
    clock += 20;
    await f.runtime.quiesceIdle();
    await f.runtime.close();
    reopened = new ManagedRuntime(f.config);
    const tail = await reopened.request(`/api/sessions/${localId}/messages/tail`);
    const state = await reopened.request(`/api/sessions/${localId}/state`);
    const catalogue = await reopened.request("/api/sessions");
    const listed = catalogue.sessions.find((item: { session_id: string }) => item.session_id === localId);
    assert.equal((await reopened.request(`/api/sessions/${localId}/unread`, "GET", { actorId: "first-reader" })).count, 1);
    assert.equal((await reopened.request(`/api/sessions/${localId}/unread`, "GET", { actorId: "second-reader" })).count, 0);
    assert.equal((await reopened.request(`/api/sessions/${localId}/unread`, "GET", { actorId: "first-reader" })).count, 1, "Another reader cannot consume this actor's unread state");
    await assert.rejects(reopened.request(`/api/sessions/${localId}/read`, "POST", { event_id: "not-a-message" }), /Unknown transcript event/);
    const diagnostics = await reopened.request(`/api/sessions/${localId}/diagnostics`);
    assert.equal(diagnostics.runtime, "oar");
    assert.equal(diagnostics.session_id, localId);
    assert.equal(diagnostics.agent_backend, "pi");
    assert.equal(diagnostics.cwd, f.path);
    assert.equal(diagnostics.resident, false);
    assert.equal(diagnostics.runtime_state, "archived");
    assert.ok(diagnostics.retained_records > 0);
    assert.ok(diagnostics.retained_record_bytes > 0);
    assert.equal(f.factory.opens.length, 1, "Inspecting diagnostics must not resume the archived agent");
    writeFileSync(join(f.path, "review.txt"), "saved workspace file");
    execFileSync("git", ["init", "--quiet", f.path]);
    const http = new NativeHttpTarget(reopened, f.path);
    try {
      const inspect = async (action: string) => {
        const response = await http.execute({
          method: "GET", path: `/api/sessions/${localId}/${action}`,
          headers: {}, body: emptyBody, signal: new AbortController().signal,
        });
        assert.equal(response.status, 200);
        const chunks: Buffer[] = [];
        for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
        return JSON.parse(Buffer.concat(chunks).toString());
      };
      assert.equal((await inspect("diagnostics")).session_id, localId);
      assert.ok((await inspect("file/list")).files.includes("review.txt"));
      assert.equal((await inspect("file/read?path=review.txt")).text, "saved workspace file");
      assert.ok(JSON.stringify(await inspect("git/changed_files")).includes("review.txt"));
      assert.equal(f.factory.opens.length, 1, "Files and Git inspect an archived workspace without starting OAR");
    } finally { http.close(); }
    assert.deepEqual(tail.events.map((event: { text: string }) => event.text), ["saved user", "saved assistant"]);
    for (const snapshot of [original, tail, state, listed]) {
      assert.equal(snapshot.transcript_state, "bound");
      assert.equal(snapshot.thread_id, "native-1");
      assert.equal(snapshot.log_path, `managed:${localId}`);
    }
    assert.equal(state.resident, false);
    assert.equal(state.runtime_state, "archived");
    assert.equal(f.factory.opens.length, 1, "Transcript reads never reactivate native execution");
  } finally {
    await reopened?.close();
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("managed conversation survives quiescence/restart with native identity and a fresh stream", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, idleMs: 10 });
  try {
    const { localId } = (await f.runtime.executeWithReceipt(
      create(),
      "launch-a",
    )) as { localId: string };
    await f.runtime.executeWithReceipt(
      { op: "send", agentId: "agent-a", localId, text: "hello" },
      "input-a",
    );
    f.factory.sessions[0]!.emit([
      { kind: "text_delta", text: "world" },
      { kind: "turn_ended", outcome: { kind: "completed" } },
    ]);
    const firstState = await f.runtime.queueControl(localId, "state");
    clock += 20;
    await f.runtime.quiesceIdle();
    assert.equal(f.factory.sessions[0]!.disposed, true);
    assert.equal(
      (await f.runtime.queueControl(localId, "state")).resident,
      false,
    );
    await f.runtime.close();
    const reopened = new ManagedRuntime(f.config);
    try {
      const history = (await reopened.execute({
        op: "messages",
        agentId: "agent-a",
        localId,
      })) as { messages: Array<{ text: string }> };
      assert.deepEqual(
        history.messages.map((m) => m.text),
        ["hello", "world"],
      );
      await reopened.executeWithReceipt(
        { op: "send", agentId: "agent-a", localId, text: "continue" },
        "input-b",
      );
      assert.equal(f.factory.opens.at(-1)!.resume, "native-1");
      assert.notEqual(
        (await reopened.queueControl(localId, "state")).stream_id,
        firstState.stream_id,
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("uncertain submission is durable and duplicate request or new input never replays it", async () => {
  const f = fixture();
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    f.factory.sessions[0]!.failPrompt = true;
    const send = {
      op: "send" as const,
      agentId: "agent-a",
      localId,
      text: "write a file",
    };
    await assert.rejects(
      f.runtime.executeWithReceipt(send, "uncertain-input"),
      /unknown/,
    );
    await assert.rejects(
      f.runtime.executeWithReceipt(send, "uncertain-input"),
      /unknown/,
    );
    assert.equal(f.factory.sessions[0]!.prompts.length, 1);
    await f.runtime.close();
    const restarted = new ManagedRuntime(f.config);
    try {
      await assert.rejects(
        restarted.executeWithReceipt(send, "new-input"),
        /unknown/,
      );
      assert.equal(f.factory.opens.length, 1);
    } finally {
      await restarted.close();
    }
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("durable request receipt deduplicates accepted input while native completion stays distinct", async () => {
  const f = fixture();
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    const send = {
      op: "send" as const,
      agentId: "agent-a",
      localId,
      text: "hello",
    };
    await f.runtime.executeWithReceipt(send, "same-input");
    await f.runtime.executeWithReceipt(send, "same-input");
    assert.equal(f.factory.sessions[0]!.prompts.length, 1);
    assert.equal((await f.runtime.queueControl(localId, "state")).busy, true);
    f.factory.sessions[0]!.emit([
      { kind: "turn_ended", outcome: { kind: "completed" } },
    ]);
    assert.equal((await f.runtime.queueControl(localId, "state")).busy, false);
    assert.equal((await f.runtime.completions(0))[0]!.kind, "completion");
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("admission refuses a third running worker and releases an idle worker for later creation", async () => {
  const f = fixture({ maxResident: 1 });
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    await f.runtime.sendQueued(localId, "work");
    await assert.rejects(f.runtime.execute(create("agent-b")), /capacity/);
    assert.equal(f.factory.opens.length, 1);
    f.factory.sessions[0]!.emit([
      { kind: "turn_ended", outcome: { kind: "completed" } },
    ]);
    await f.runtime.execute(create("agent-b"));
    assert.equal(f.factory.sessions[0]!.disposed, true);
    assert.equal(f.factory.opens.length, 2);
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("runtime approval requests stop execution with attention instead of automatic approval", async () => {
  const f = fixture();
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    const session = f.factory.sessions[0]!;
    session.observer?.({
      kind: "request",
      direction: "toApp",
      id: "approval",
      seq: session.seq++,
      sessionId: session.id,
      agentPath: [],
      receivedAt: Date.now(),
      body: { method: "approval" },
    });
    await tick();
    assert.equal(session.disposed, true);
    await assert.rejects(f.runtime.sendQueued(localId, "retry"), /unknown/);
    assert.equal((await f.runtime.completions(0))[0]!.kind, "attention");
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("event quota stops the owned worker and retains an explicit evidence gap", async () => {
  const f = fixture({ maxEvents: 1 });
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    const session = f.factory.sessions[0]!;
    session.emit([{ kind: "text_delta", text: "first" }]);
    session.emit([{ kind: "text_delta", text: "over limit" }]);
    await tick();
    assert.equal(session.disposed, true);
    const receipts = await f.runtime.request(`/api/sessions/${localId}/state`);
    assert.equal(receipts.runtime_state, "attention");
    await assert.rejects(f.runtime.sendQueued(localId, "again"), /unknown/);
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("launch secrets are passed to the driver but never stored in managed SQLite metadata", async () => {
  const f = fixture();
  try {
    await f.runtime.execute({
      ...create(),
      launch: {
        provider_config: {
          base_url: "https://private.example/v1",
          api_key: "super-private-test-key",
        },
        model: "kimi",
        model_provider: "custom",
      },
    });
    assert.equal(
      f.factory.opens[0]!.launch!.provider_config!.api_key,
      "super-private-test-key",
    );
    await f.runtime.close();
    assert.equal(
      readFileSync(f.config.databasePath).includes(
        Buffer.from("super-private-test-key"),
      ),
      false,
    );
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("live transcript cursor changes for deltas updating an existing assistant message", async () => {
  const f = fixture();
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    await f.runtime.sendQueued(localId, "hello");
    f.factory.sessions[0]!.emit([{ kind: "text_delta", text: "a" }]);
    const first = await f.runtime.request(
      `/api/sessions/${localId}/messages/live`,
    );
    f.factory.sessions[0]!.emit([{ kind: "text_delta", text: "b" }]);
    const second = await f.runtime.request(
      `/api/sessions/${localId}/messages/live?after=${first.live_cursor}`,
    );
    assert.notEqual(second.live_cursor, first.live_cursor);
    assert.equal(
      second.events.find(
        (event: { role: string }) => event.role === "assistant",
      ).text,
      "ab",
    );
    assert.deepEqual(
      (
        await f.runtime.request(
          `/api/sessions/${localId}/messages/live?after=${second.live_cursor}`,
        )
      ).events,
      [],
    );
    await assert.rejects(
      f.runtime.request(
        `/api/sessions/${localId}/messages/live?after=managed-other:0`,
      ),
      /another session/,
    );
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});

test("managed saved transcript search is literal, case insensitive, paginated and opens matching windows without a worker", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, idleMs: 10 });
  let reopened: ManagedRuntime | undefined;
  try {
    const { localId } = await f.runtime.execute(create()) as { localId: string };
    for (const text of ["First ПрИвЕт %_needle", "Second привет %_needle"]) {
      await f.runtime.sendQueued(localId, "unmatched prompt");
      f.factory.sessions[0]!.emit([{ kind: "text_delta", text }, { kind: "turn_ended", outcome: { kind: "completed" } }]);
      clock++;
    }
    clock += 20;
    await f.runtime.quiesceIdle();
    await f.runtime.close();
    reopened = new ManagedRuntime(f.config);
    const query = encodeURIComponent("ПРИВЕТ %_needle");
    const latest = await reopened.request(`/api/sessions/${localId}/search?q=${query}&limit=1`);
    assert.equal(latest.total, 2);
    assert.equal(latest.match_count, 2);
    assert.equal(latest.matches.length, 1);
    assert.equal(latest.matches[0].text, "Second привет %_needle");
    assert.equal(latest.matches[0].before_byte, latest.matches[0].history_cursor);
    assert.equal(latest.has_older, true);
    const older = await reopened.request(`/api/sessions/${localId}/search?q=${query}&limit=1&before=${encodeURIComponent(latest.matches[0].before_byte)}`);
    assert.equal(older.total, 2);
    assert.equal(older.matches[0].text, "First ПрИвЕт %_needle");
    assert.equal(older.has_older, false);
    const window = await reopened.request(`/api/sessions/${localId}/messages/window?cursor=${encodeURIComponent(older.matches[0].history_cursor)}&before=0&after=0`);
    assert.deepEqual(window.events.map((event: { text: string }) => event.text), [older.matches[0].text]);
    for (const result of [latest, older, window]) {
      assert.equal(result.transcript_state, "bound");
      assert.equal(result.thread_id, "native-1");
    }
    const users = await reopened.request(`/api/sessions/${localId}/search?q=*&role=user&limit=1`);
    assert.equal(users.total, 2, "User turn count excludes assistant messages");
    assert.equal(users.matches.length, 1);
    assert.equal(users.matches[0].role, "user");
    const assistants = await reopened.request(`/api/sessions/${localId}/search?q=*&role=assistant&limit=1`);
    assert.equal(assistants.total, 2);
    assert.equal(assistants.matches[0].role, "assistant");
    assert.equal((await reopened.request(`/api/sessions/${localId}/search?q=*&limit=1`)).total, 4);
    const previous = await reopened.request(`/api/sessions/${localId}/messages/neighbor?role=user&direction=previous&cursor=${encodeURIComponent(users.matches[0].history_cursor)}`);
    assert.equal(previous.neighbor.role, "user");
    assert.equal(previous.neighbor.same_log, true);
    assert.notEqual(previous.neighbor.message_id, users.matches[0].message_id);
    const next = await reopened.request(`/api/sessions/${localId}/messages/neighbor?role=user&direction=next&cursor=${encodeURIComponent(previous.neighbor.history_cursor)}`);
    assert.equal(next.neighbor.message_id, users.matches[0].message_id);
    const userWindow = await reopened.request(`/api/sessions/${localId}/messages/window?cursor=${encodeURIComponent(previous.neighbor.history_cursor)}&before=0&after=0`);
    assert.equal(userWindow.events[0].message_id, previous.neighbor.message_id);
    assert.equal((await reopened.request(`/api/sessions/${localId}/messages/neighbor?role=user&direction=previous&cursor=${encodeURIComponent(previous.neighbor.history_cursor)}`)).neighbor, null);
    assert.equal((await reopened.request(`/api/sessions/${localId}/messages/neighbor?role=user&direction=next&cursor=${encodeURIComponent(next.neighbor.history_cursor)}`)).neighbor, null);
    assert.equal((await reopened.request(`/api/sessions/${localId}/state`)).resident, false);
    assert.equal(f.factory.opens.length, 1);
    await assert.rejects(reopened.request(`/api/sessions/${localId}/search?q=x&limit=Infinity`), /limit must/);
    await assert.rejects(reopened.request(`/api/sessions/${localId}/search?q=${"x".repeat(2001)}`), /query must/);
    await assert.rejects(reopened.request(`/api/sessions/${localId}/search?q=x&before=managed-other:2`), /another session/);
    await assert.rejects(reopened.request(`/api/sessions/${localId}/search?q=*&role=system`), /role must/);
    await assert.rejects(reopened.request(`/api/sessions/${localId}/messages/neighbor?role=user&direction=previous&cursor=managed-other:2`), /another session/);
  } finally {
    await reopened?.close();
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("an empty evicted Pi conversation opens fresh rather than resuming an unwritten native file", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, idleMs: 10 });
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    clock += 20;
    await f.runtime.quiesceIdle();
    await f.runtime.sendQueued(localId, "first real input");
    assert.equal(f.factory.opens.length, 2);
    assert.equal(f.factory.opens[1]!.resume, undefined);
    assert.equal(f.factory.sessions[1]!.prompts[0], "first real input");
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("owned worker death after acceptance marks an unknown outcome and blocks fresh input", async () => {
  const f = fixture();
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    await f.runtime.sendQueued(localId, "effectful operation");
    f.factory.sessions[0]!.exitObserver?.();
    await tick();
    assert.equal(
      (await f.runtime.queueControl(localId, "state")).runtime_state,
      "unknown",
    );
    await assert.rejects(f.runtime.sendQueued(localId, "retry"), /unknown/);
    assert.equal((await f.runtime.completions(0))[0]!.kind, "attention");
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
test("idle cleanup rechecks lifecycle after queued prompt admission and preserves active work", async () => {
  let clock = 1000;
  const f = fixture({ now: () => clock, idleMs: 10 });
  try {
    const { localId } = (await f.runtime.execute(create())) as {
      localId: string;
    };
    clock += 20;
    const sending = f.runtime.sendQueued(localId, "begin work");
    const cleanup = f.runtime.quiesceIdle();
    await Promise.all([sending, cleanup]);
    assert.equal(f.factory.sessions[0]!.disposed, false);
    assert.equal((await f.runtime.queueControl(localId, "state")).busy, true);
  } finally {
    await f.runtime.close();
    rmSync(f.path, { recursive: true, force: true });
  }
});
