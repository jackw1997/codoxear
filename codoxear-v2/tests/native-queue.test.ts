import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { connect } from "node:net";
import * as pty from "@lydell/node-pty";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { socketPath } from "../src/computer/native/paths.js";
import { ComputerQueue } from "../src/computer/queue.js";
import { BrokerQueue } from "../src/computer/native/queue.js";
import { DomainError } from "../src/contracts/model.js";
assert.ok(
  existsSync("/.dockerenv"),
  "Native queue behavior runs in Docker only",
);
process.env.CODOXEAR_NATIVE_CODEX_LIVE_CONTROL = "0";
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => Promise<boolean> | boolean) {
  const end = Date.now() + 15000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("Native queue condition timed out");
    await wait(30);
  }
}
async function fixture(delay = 150) {
  const home = await mkdtemp(join(tmpdir(), "native-queue-")),
    workspace = join(home, "workspace"),
    command = join(home, "codex-fixture");
  await mkdir(workspace);
  await writeFile(
    command,
    `#!${process.execPath}
const fs=require('fs'),path=require('path'),id='queue-'+process.pid,cwd=process.cwd();
const directory=path.join(process.env.HOME,'.codex','sessions');fs.mkdirSync(directory,{recursive:true});
const log=path.join(directory,id+'.jsonl'),fd=fs.openSync(log,'a');
function row(type,payload){fs.writeSync(fd,JSON.stringify({type,payload,timestamp:new Date().toISOString()})+'\\n');}
row('session_meta',{id,cwd});process.stdout.write('100% context left ? for shortcuts\\n');process.stdin.setRawMode(true);
let buffer='';process.stdin.on('data',data=>{if(data.toString().includes('\\x1b[200~'))process.stdout.write('PASTE_BOUNDARY\\n');buffer+=data.toString().replace(/\\x1b\\[(?:200|201)~/g,'');if(!buffer.includes('\\r'))return;let text=buffer.split('\\r')[0];buffer='';row('event_msg',{type:'user_message',message:text});setTimeout(()=>{row('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'reply:'+text}]});row('event_msg',{type:'task_complete'});},${delay});});
`,
    { mode: 0o755 },
  );
  const prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = command;
  const runtime = new NativeRuntime(home, workspace);
  const { localId: id } = await runtime.createTerminal(
    "codex",
    "Unified queue",
  );
  await until(
    async () =>
      (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
      "ready",
  );
  let allowed = true,
    authorize: (permit: string) => Promise<void> = async () => {
      if (!allowed) throw new DomainError(403, "revoked", "Access removed");
    };
  const queuePath = join(home, "remote.sqlite");
  const makeQueue = () =>
    new ComputerQueue(queuePath, "hub:computer:1", {
      idle: async () => {
        const state = await runtime.request(`/api/sessions/${id}/state`);
        return !state.busy;
      },
      authorize: async (permit) => authorize(permit),
      send: async () => {
        throw Error("Split send path must not run");
      },
      unified: {
        sessions: async () => [id],
        control: (localId, operation, body) =>
          runtime.queueControl(localId, operation, body),
      },
    });
  let queue = makeQueue();
  const remote = async (text: string, extra: Record<string, unknown> = {}) => {
    const response = await queue.handle({
      method: "POST",
      path: `/api/sessions/${id}/enqueue`,
      headers: {},
      signal: new AbortController().signal,
      actorId: "alice",
      queuePermit: "permit",
      body: {
        async *[Symbol.asyncIterator]() {
          yield Buffer.from(JSON.stringify({ ...extra, text }));
        },
      },
    });
    assert.equal(response!.status, 200);
    return (await queue.listAsync(id)).find((item) => item.text === text)
      .id as string;
  };
  const local = (operation: string, body?: Record<string, unknown>) =>
    runtime.queueControl(id, operation, body);
  const messages = async () =>
    (await runtime.request(`/api/sessions/${id}/messages/tail`)).events
      .filter((event: any) => event.role === "user")
      .map((event: any) => event.text);
  return {
    home,
    workspace,
    id,
    runtime,
    local,
    remote,
    messages,
    get queue() {
      return queue;
    },
    setAllowed(value: boolean) {
      allowed = value;
    },
    setAuthorize(fn: typeof authorize) {
      authorize = fn;
    },
    restartQueue() {
      queue.close();
      queue = makeQueue();
    },
    async close() {
      queue.close();
      await runtime
        .request(`/api/sessions/${id}/delete`, "POST", {})
        .catch(() => {});
      if (prior === undefined) delete process.env.CODEX_BIN;
      else process.env.CODEX_BIN = prior;
    },
  };
}
test("native unified queue preserves one local/remote order through authorization outage and restart", async () => {
  const f = await fixture();
  try {
    f.setAllowed(false);
    const remoteId = await f.remote("remote first");
    await f.local("enqueue", { text: "local second" });
    await f.queue.drain();
    await wait(1100);
    assert.deepEqual(await f.messages(), []);
    assert.match(
      (await f.queue.listAsync(f.id))[0].pause_reason,
      /access removed/,
    );
    f.restartQueue();
    assert.deepEqual(
      (await f.queue.listAsync(f.id)).map((item) => item.text),
      ["remote first", "local second"],
    );
    f.setAllowed(true);
    await f.queue.drain();
    await until(async () => (await f.messages()).length === 2);
    assert.deepEqual(await f.messages(), ["remote first", "local second"]);
    assert.ok(
      !(await f.local("queue")).items.some((item: any) => item.id === remoteId),
    );
    assert.ok(!JSON.stringify(await f.local("queue")).includes("permit"));
  } finally {
    await f.close();
  }
});
test("terminal edit during remote authorization rejects the stale dispatch and stale browser version", async () => {
  const f = await fixture();
  try {
    const id = await f.remote("original", { id: "forged-id", commit_unknown: true, scope: "evil-binding", actorId: "mallory", permit: "forged-permit" });
    const first = (await f.queue.listAsync(f.id))[0];
    assert.notEqual(id, "forged-id"); assert.equal(first.actorId, "alice"); assert.equal(first.commit_unknown, false);
    let entered!: () => void, release!: () => void;
    const started = new Promise<void>((r) => (entered = r)),
      held = new Promise<void>((r) => (release = r));
    f.setAuthorize(async () => {
      entered();
      await held;
    });
    const draining = f.queue.drain();
    await started;
    await f.local("queue/update", { id, version: 0, text: "terminal edited" });
    release();
    await draining;
    assert.deepEqual(await f.messages(), []);
    await assert.rejects(
      f.local("queue/update", {
        id,
        version: 0,
        text: "stale browser",
        scope: "hub:computer:1",
        actorId: "alice",
        permit: "permit",
      }),
      (error: any) => error.code === "queue_changed",
    );
    f.setAuthorize(async () => {});
    await f.queue.drain();
    await until(async () => (await f.messages()).length === 1);
    assert.deepEqual(await f.messages(), ["terminal edited"]);
  } finally {
    await f.close();
  }
});
test("historical pending and uncertain queues migrate by stable ID and retain old-binding barriers", async () => {
  const f = await fixture();
  try {
    const legacy = new ComputerQueue(
      join(f.home, "legacy.sqlite"),
      "hub:computer:1",
      {
        idle: async () => true,
        authorize: async () => {},
        send: async () => {
          throw Error("lost reply");
        },
      },
    );
    const unknownId = legacy.enqueue(
      f.id,
      "uncertain prior prompt",
      "alice",
      "permit",
    );
    legacy.enqueue(f.id, "pending prior prompt", "alice", "permit");
    await legacy.drain();
    legacy.close();
    const migrated = new ComputerQueue(
      join(f.home, "legacy.sqlite"),
      "hub:computer:1",
      {
        idle: async () => true,
        authorize: async () => {},
        send: async () => {},
        unified: {
          sessions: async () => [f.id],
          control: (id, op, body) => f.runtime.queueControl(id, op, body),
        },
      },
    );
    try {
      const items = await migrated.listAsync(f.id);
      assert.equal(items[0].id, unknownId);
      assert.equal(items[0].commit_unknown, true);
      await migrated.listAsync(f.id);
      await migrated.drain();
      assert.equal((await f.local("queue")).items.length, 2);
      assert.deepEqual(await f.messages(), []);
      const rebound = await f.local("queue", { scope: "new-hub:binding:2" });
      assert.ok(!JSON.stringify(rebound).includes("uncertain prior prompt"));
      await assert.rejects(
        f.local("queue/delete", {
          id: unknownId,
          scope: "new-hub:binding:2",
          allow_commit_unknown: true,
        }),
        (error: any) => error.code === "queue_binding_changed",
      );
      await assert.rejects(
        f.local("queue/delete", { id: unknownId }),
        (error: any) => error.code === "commit_unknown",
      );
    } finally {
      migrated.close();
    }
  } finally {
    await f.close();
  }
});
test("real foreground PTY exposes local and remote queue list/edit/move/delete and detaches without terminating the broker", async () => {
  const f = await fixture(1800);
  let presenter: pty.IPty | undefined;
  try {
    await f.remote("remote visible");
    presenter = pty.spawn(
      process.execPath,
      [
        "--import",
        import.meta.resolve("tsx"),
        resolve("src/computer/main.ts"),
        "terminal",
        f.id,
      ],
      {
        name: "xterm-256color",
        cols: 120,
        rows: 40,
        cwd: process.cwd(),
        env: {
          ...process.env,
          HOME: f.home,
          CODOXEAR_COMPUTER_HOME: f.home,
        } as Record<string, string>,
      },
    );
    let output = "";
    presenter.onData((data) => (output += data));
    await until(() => output.includes("Ctrl-] opens queue controls"));
    presenter.write("\x1d");
    await until(() => output.includes("(queue)>"));
    presenter.write("list\r");
    await until(() => output.includes("remote visible"));
    presenter.write("edit 1 terminal changed remote\r");
    await until(
      async () =>
        (await f.local("queue")).items[0].text === "terminal changed remote",
    );
    presenter.write("add local visible\r");
    await until(async () => (await f.local("queue")).items.length === 2);
    presenter.write("move 2 1\r");
    await until(
      async () => (await f.local("queue")).items[0].text === "local visible",
    );
    presenter.write("delete 1\r");
    await until(async () => (await f.local("queue")).items.length === 1);
    presenter.write("back\r");
    await until(() => output.includes("Returning to native terminal"));
    presenter.write("direct steering\r");
    await until(async () => (await f.messages()).includes("direct steering"));
    presenter.write("\x1d");
    await wait(50);
    let exited = false;
    presenter.onExit(() => (exited = true));
    presenter.write("detach\r");
    await until(() => exited);
    const state = await f.runtime.request(`/api/sessions/${f.id}/state`);
    assert.equal(state.readiness, "ready");
    assert.ok(state.pid > 0);
    assert.deepEqual(await f.messages(), ["direct steering"]);
  } finally {
    presenter?.kill();
    await f.close();
  }
});
test("hard broker death after paste persists a non-replayable queue barrier", async () => {
  const f = await fixture();
  const attached = connect(socketPath(f.home, f.id));
  try {
    await f.remote("one paste only");
    await f.local("enqueue", { text: "must stay blocked" });
    const state = await f.runtime.request(`/api/sessions/${f.id}/state`);
    let killed = false;
    attached.setEncoding("utf8");
    attached.on("data", (chunk) => {
      if (!killed && String(chunk).includes("PASTE_BOUNDARY")) {
        killed = true;
        process.kill(state.broker_pid, "SIGKILL");
      }
    });
    attached.write(JSON.stringify({ operation: "attach" }) + "\n");
    await f.queue.drain();
    await until(() => killed);
    const saved = JSON.parse(
      readFileSync(join(f.runtime.directory, f.id + ".state.json"), "utf8"),
    );
    assert.equal(saved.queue[0].state, "dispatching");
    const recovered = new BrokerQueue(saved.queue, () => {});
    assert.equal(recovered.list()[0]!.commit_unknown, true);
    assert.equal(recovered.head("hub:computer:1"), undefined);
    assert.equal(recovered.head(), undefined);
    assert.equal(recovered.items.length, 2);
  } finally {
    attached.destroy();
    await f.close();
  }
});
test("broker attachment ownership, changed grants and send receipts remain isolated across actors", async () => {
  const f = await fixture();
  const workspace = {
    id: "default",
    access: "write",
    uploads: true,
    binding: 1,
    ownerRevision: 1,
  };
  const request = (operation: string, body: Record<string, unknown>) =>
    f.runtime.request(`/api/sessions/${f.id}/${operation}`, "POST", body);
  try {
    const aliceFile = join(f.workspace, "alice.txt"),
      localFile = join(f.workspace, "local.txt");
    await writeFile(aliceFile, "alice bytes");
    await writeFile(localFile, "local bytes");
    await request("inject_file", {
      path: aliceFile,
      actorId: "alice",
      workspace,
    });
    await request("inject_file", { path: localFile });
    const alice = await request("attachments", { actorId: "alice" });
    assert.equal(alice.attachments.length, 1);
    assert.equal(alice.attachments[0].path, aliceFile);
    const local = await request("attachments", {});
    assert.equal(local.attachments.length, 1);
    assert.equal(local.attachments[0].path, localFile);
    await request("attachments/clear", { actorId: "bob" });
    await assert.rejects(
      request("send", {
        text: "stale grant",
        actorId: "alice",
        workspace: { ...workspace, ownerRevision: 2 },
      }),
      (error: any) => error.code === "attachment_grant_changed",
    );
    assert.deepEqual(await f.messages(), []);
    await request("send", {
      text: "alice prompt",
      actorId: "alice",
      workspace,
      request_id: "shared-id",
    });
    await request("send", {
      text: "bob prompt",
      actorId: "bob",
      workspace,
      request_id: "shared-id",
    });
    await request("send", { text: "local prompt" });
    await until(async () => (await f.messages()).length === 3);
    const texts = await f.messages();
    assert.ok(texts[0].includes(aliceFile));
    assert.ok(!texts[0].includes(localFile));
    assert.equal(texts[1], "bob prompt");
    assert.ok(texts[2].includes(localFile));
    assert.ok(!texts[2].includes(aliceFile));
  } finally {
    await f.close();
  }
});
test("failed durable queue writes roll back edits and keep post-dispatch uncertainty blocking", () => {
  let fail = false,
    saved: unknown;
  let queue: BrokerQueue;
  queue = new BrokerQueue([], () => {
    if (fail) throw Error("disk failed");
    saved = structuredClone(queue.items);
  });
  const id = queue.enqueue({ text: "first" });
  queue.enqueue({ text: "second" });
  const initial = queue.head()!;
  fail = true;
  assert.throws(() => queue.mutate("update", { id, text: "uncommitted edit" }));
  assert.equal(queue.items[0]!.text, "first");
  assert.throws(() => queue.claim(id, initial.version));
  assert.equal(queue.items[0]!.state, "pending");
  fail = false;
  queue.claim(id, initial.version);
  fail = true;
  assert.throws(() => queue.finish(id));
  assert.equal(queue.items[0]!.state, "unknown");
  assert.equal(queue.head(), undefined);
  const restored = new BrokerQueue(saved, () => {});
  assert.equal(restored.items[0]!.state, "unknown");
  assert.equal(restored.head(), undefined);
});
