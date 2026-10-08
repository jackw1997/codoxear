import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ComputerQueue, type QueueRuntime } from "../src/computer/queue.js";
import { DomainError } from "../src/contracts/model.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
test("a local turn starting during authorization keeps remote work pending", async () => {
  let busy = false,
    calls = 0;
  const sent: string[] = [];
  const q = new ComputerQueue(":memory:", "attachment", {
    idle: async () => !busy,
    authorize: async () => {
      calls++;
      if (calls === 1) busy = true;
    },
    send: async (_, text) => {
      sent.push(text);
    },
  });
  try {
    q.enqueue("local", "after local work", "alice", "permit");
    await q.drain();
    assert.deepEqual(sent, []);
    assert.equal(q.list("local")[0]!.commit_unknown, false);
    assert.match(q.list("local")[0]!.pause_reason!, /current turn/);
    busy = false;
    await q.drain();
    assert.deepEqual(sent, ["after local work"]);
    assert.equal(calls, 2);
  } finally {
    q.close();
  }
});

test("only a broker-proven rejection before dispatch permits a fresh queue retry", async () => {
  let blocked = true,
    authorizations = 0;
  const sent: string[] = [];
  const q = new ComputerQueue(":memory:", "attachment", {
    idle: async () => true,
    authorize: async () => {
      authorizations++;
    },
    send: async (_, text) => {
      if (blocked)
        throw new DomainError(
          409,
          "queue_not_dispatched",
          "Waiting for local work",
        );
      sent.push(text);
    },
  });
  try {
    q.enqueue("local", "one authorized send", "alice", "permit");
    await q.drain();
    assert.equal(q.list("local")[0]!.commit_unknown, false);
    assert.match(q.list("local")[0]!.pause_reason!, /local work/);
    blocked = false;
    await q.drain();
    assert.deepEqual(sent, ["one authorized send"]);
    assert.equal(authorizations, 2);
    assert.deepEqual(q.list("local"), []);
  } finally {
    q.close();
  }
});
test("durable queue survives restart, checks current access before dispatch and fences attachment changes", async () => {
  const dir = await mkdtemp(join(tmpdir(), "queue-test-")),
    path = join(dir, "queue.sqlite"),
    sent: string[] = [];
  let busy = true,
    allowed = false,
    checks = 0;
  const runtime: QueueRuntime = {
    idle: async () => !busy,
    authorize: async (permit, localId) => {
      checks++;
      assert.equal(permit, "narrow-permit");
      assert.equal(localId, "local");
      if (!allowed) throw Error("revoked");
    },
    send: async (_, text) => {
      sent.push(text);
    },
  };
  let q = new ComputerQueue(path, "hub1:binding1", runtime);
  try {
    q.enqueue("local", "one", "alice", "narrow-permit");
    q.close();
    q = new ComputerQueue(path, "hub1:binding1", runtime);
    assert.equal(q.list("local").length, 1);
    assert.ok(!JSON.stringify(q.list("local")).includes("narrow-permit"));
    await q.drain();
    assert.equal(checks, 0);
    assert.match(q.list("local")[0]!.pause_reason!, /current turn/);
    busy = false;
    await q.drain();
    assert.equal(checks, 1);
    assert.match(q.list("local")[0]!.pause_reason!, /hub authorization/);
    assert.deepEqual(sent, []);
    assert.equal(q.list("local").length, 1);
    q.close();
    q = new ComputerQueue(path, "hub2:binding2", runtime);
    allowed = true;
    await q.drain();
    assert.deepEqual(sent, []);
    q.close();
    q = new ComputerQueue(path, "hub1:binding1", runtime);
    await q.drain();
    assert.deepEqual(sent, ["one"]);
    assert.deepEqual(q.list("local"), []);
  } finally {
    q.close();
    await rm(dir, { recursive: true });
  }
});
test("ambiguous sends block later queue items across restart until explicitly reviewed", async () => {
  const dir = await mkdtemp(join(tmpdir(), "queue-test-")),
    path = join(dir, "queue.sqlite");
  let sends = 0;
  const runtime: QueueRuntime = {
    idle: async () => true,
    authorize: async () => {},
    send: async () => {
      sends++;
      if (sends === 1) throw Error("response lost after send");
    },
  };
  let q = new ComputerQueue(path, "attachment", runtime);
  try {
    const first = q.enqueue("local", "first", "alice", "permit");
    q.enqueue("local", "second", "alice", "permit");
    await q.drain();
    assert.equal(q.list("local")[0]!.commit_unknown, true);
    q.close();
    q = new ComputerQueue(path, "attachment", runtime);
    await q.drain();
    assert.equal(sends, 1);
    assert.throws(() => q.mutate("local", "delete", { id: first }));
    assert.throws(() => q.mutate("local", "move", { id: first, to_index: 1 }));
    q.mutate("local", "delete", { id: first, allow_commit_unknown: true });
    await q.drain();
    assert.equal(sends, 2);
  } finally {
    q.close();
    await rm(dir, { recursive: true });
  }
});
test("editing or deleting a queue item during authorization prevents stale dispatch", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    sent: string[] = [];
  const q = new ComputerQueue(":memory:", "attachment", {
    idle: async () => true,
    authorize: async () => {
      entered();
      await new Promise<void>((r) => (release = r));
    },
    send: async (_, text) => {
      sent.push(text);
    },
  });
  try {
    const id = q.enqueue("local", "before", "alice", "permit");
    const drain = q.drain();
    await started;
    q.mutate("local", "update", { id, text: "after" }, "bob", "new-permit");
    release();
    await drain;
    assert.deepEqual(sent, []);
    assert.equal(q.list("local")[0]!.text, "after");
    q.mutate("local", "delete", { id });
    assert.equal(q.list("local").length, 0);
  } finally {
    q.close();
  }
});
test("retained old brokers never receive remote migration or enqueue without the unified capability", async () => {
  let allowed = false;
  const sent: string[] = [], unsafeControlCalls: string[] = [];
  const queue = new ComputerQueue(":memory:", "binding", {
    idle: async () => true,
    authorize: async () => { if (!allowed) throw new DomainError(403, "revoked", "Access removed"); },
    send: async (_, text) => { sent.push(text); },
    unified: {
      sessions: async () => ["local"],
      control: async (_, operation) => {
        if (operation === "queue/capabilities") throw new DomainError(404, "unsupported_route", "Old broker");
        unsafeControlCalls.push(operation);
        return { ok: true };
      },
    },
  });
  try {
    queue.enqueue("local", "retained remote work", "alice", "permit");
    assert.equal((await queue.listAsync("local"))[0]!.text, "retained remote work");
    await queue.drain();
    assert.deepEqual(unsafeControlCalls, []); assert.deepEqual(sent, []);
    allowed = true; await queue.drain();
    assert.deepEqual(sent, ["retained remote work"]); assert.deepEqual(unsafeControlCalls, []);
  } finally { queue.close(); }
});
