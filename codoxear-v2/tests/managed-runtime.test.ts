import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../src/computer/managed/runtime.js";
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
  observer: ((record: ManagedRecord) => void) | undefined;
  seq = 0;
  prompts: string[] = [];
  disposed = false;
  failPrompt = false;
  exitObserver: (() => void) | undefined;
  constructor(readonly id: string) {}
  rawEvents(observer: (record: ManagedRecord) => void) {
    this.observer = observer;
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
  async prompt(text: string): Promise<ManagedOutcome> {
    this.prompts.push(text);
    if (this.failPrompt) throw Error("Transport lost after submission");
    return { kind: "accepted" };
  }
  async abort(): Promise<ManagedOutcome> {
    this.emit([{ kind: "turn_ended", outcome: { kind: "aborted" } }]);
    return { kind: "accepted" };
  }
  async dispose() {
    this.disposed = true;
  }
}
class Factory implements ManagedFactory {
  opens: ManagedOpen[] = [];
  sessions: Session[] = [];
  setupError = false;
  async open(options: ManagedOpen) {
    if (this.setupError)
      throw new ManagedSetupError("Local approval setup required");
    this.opens.push(options);
    const session = new Session(
      options.resume ?? "native-" + this.opens.length,
    );
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
