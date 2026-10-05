import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { once } from "node:events";
import { WebSocket } from "ws";
import { Store } from "../src/persistence/store.js";
import { Tunnels } from "../src/server/tunnels.js";
import { createApp } from "../src/server/app.js";
import {
  createHub,
  createComputer,
  passwordHash,
  digest,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
async function until(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 8000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}
async function fixture() {
  const store = new Store(":memory:"),
    tunnels = new Tunnels();
  const value = store.change((s) => {
    s.users.push({
      id: "alice",
      email: "alice@example.test",
      name: "Alice",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    });
    const h = createHub(s, "alice", "Hub");
    return createComputer(s, "alice", h.id, "Machine", "alice");
  });
  const app = await createApp({ store, tunnels, secureCookies: false });
  const url = await app.listen({ host: "127.0.0.1", port: 0 });
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/login",
    payload: { email: "alice@example.test", password: "test-password" },
  });
  const cookie = login.cookies[0]!.value;
  return {
    app,
    store,
    tunnels,
    url,
    ...value,
    cookies: { codoxear_v2: cookie },
    async close() {
      tunnels.close();
      await app.close();
      store.close();
    },
  };
}
test("Computer reconnect retains runtime; revoked credential blocks reconnection", async () => {
  const f = await fixture(),
    home = mkdtempSync(join(tmpdir(), "transport-")),
    api = createComputerApi(home);
  await api.attach({
    version: 1,
    hubUrl: f.url,
    hubId: f.computer.hubId,
    computerId: f.computer.id,
    credential: f.credential,
    runtime: "fixture",
  });
  const service = api.service();
  try {
    await service.start();
    await until(() => f.tunnels.online(f.computer.id));
    const created = (await f.tunnels.request(f.computer.id, {
      op: "create",
      agentId: "agent",
      backend: "fixture",
      name: "Example",
    })) as { localId: string };
    await f.tunnels.request(f.computer.id, {
      op: "send",
      agentId: "agent",
      localId: created.localId,
      text: "Survive reconnect",
    });
    f.tunnels.disconnect(f.computer.id);
    await until(() => !f.tunnels.online(f.computer.id));
    await until(() => f.tunnels.online(f.computer.id));
    const read = (await f.tunnels.request(f.computer.id, {
      op: "messages",
      agentId: "agent",
      localId: created.localId,
    })) as { messages: unknown[] };
    assert.equal(read.messages.length, 2);
    assert.deepEqual(
      await f.tunnels.request(f.computer.id, {
        op: "launch-status",
        agentId: "agent",
      }),
      { state: "ready", result: { localId: created.localId } },
    );
    await assert.rejects(
      f.tunnels.request(f.computer.id, {
        op: "create",
        agentId: "agent",
        backend: "fixture",
        name: "Must not duplicate",
      }),
    );
    f.store.change((s) => {
      s.computers[0]!.credentialHash = digest("rotated");
    });
    f.tunnels.disconnect(f.computer.id);
    await until(
      async () => (await api.status()).lastObserved?.state === "blocked",
    );
    assert.equal(f.tunnels.online(f.computer.id), false);
  } finally {
    await service.stop();
    await f.close();
    rmSync(home, { recursive: true });
  }
});
test("lost mutation acknowledgement is unknown and is never replayed onto a new connection", async () => {
  const f = await fixture();
  const connect = () =>
    new WebSocket(
      f.url.replace("http:", "ws:") + "/connect/v1/computers/" + f.computer.id,
      {
        headers: {
          Authorization: "Bearer " + f.credential,
          "X-Codoxear-Hub": f.computer.hubId,
        },
      },
    );
  let first: WebSocket | undefined, second: WebSocket | undefined;
  try {
    first = connect();
    await once(first, "message");
    const incoming = once(first, "message");
    const result = f.tunnels
      .request(f.computer.id, {
        op: "send",
        agentId: "a",
        localId: "a",
        text: "Only once",
      })
      .catch((e) => e);
    await incoming;
    first.terminate();
    const error = await result;
    assert.equal((error as { code: string }).code, "outcome_unknown");
    second = connect();
    let requests = 0;
    second.on("message", (raw) => {
      if (JSON.parse(raw.toString()).type === "request") requests++;
    });
    await once(second, "message");
    await new Promise((r) => setTimeout(r, 100));
    assert.equal(requests, 0);
  } finally {
    first?.terminate();
    second?.terminate();
    await f.close();
  }
});

test("explicit pre-dispatch refusal stays definite; unclassified launch failures stay unknown", async () => {
  const f = await fixture();
  let socket: WebSocket | undefined;
  try {
    socket = new WebSocket(
      f.url.replace("http:", "ws:") + "/connect/v1/computers/" + f.computer.id,
      { headers: { Authorization: "Bearer " + f.credential, "X-Codoxear-Hub": f.computer.hubId } },
    );
    const [raw] = await once(socket, "message");
    const welcome = JSON.parse(raw.toString());
    let errorCode: string | undefined = "not_dispatched";
    socket.on("message", (raw) => {
      const request = JSON.parse(raw.toString());
      if (request.type !== "request") return;
      socket!.send(JSON.stringify({ type: "result", id: request.id, epoch: welcome.epoch,
        ok: false, error: "Claude Code setup required: complete local setup.",
        ...(errorCode ? { errorCode } : {}),
      }));
    });
    const operation = { op: "create", agentId: "agent", backend: "cc", name: "Example" } as const;
    await assert.rejects(f.tunnels.request(f.computer.id, operation),
      (error: any) => error.code === "not_dispatched" && error.status === 400);
    errorCode = "setup_required";
    await assert.rejects(f.tunnels.request(f.computer.id, { op: "send", agentId: "agent", localId: "local", text: "Retain this prompt" }),
      (error: any) => error.code === "setup_required" && error.status === 409);
    errorCode = undefined;
    await assert.rejects(f.tunnels.request(f.computer.id, operation),
      (error: any) => error.code === "outcome_unknown" && error.status === 502);
  } finally {
    socket?.terminate();
    await f.close();
  }
});
test("API rejects cross-origin writes and authentication cannot use a computer token", async () => {
  const f = await fixture();
  try {
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/hubs",
          cookies: f.cookies,
          headers: { origin: "https://attacker.test" },
          payload: { name: "bad" },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/hubs",
          headers: { authorization: "Bearer " + f.credential },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/computers/" + f.computer.id + "/agents",
          cookies: f.cookies,
          payload: { name: "offline", backend: "fixture" },
        })
      ).json().code,
      "not_dispatched",
    );
    assert.equal(f.store.read().agents.length, 0);
  } finally {
    await f.close();
  }
});
