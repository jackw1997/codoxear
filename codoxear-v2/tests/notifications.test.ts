import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateKeyPair, exportPKCS8, jwtVerify } from "jose";
import { WebSocket, WebSocketServer } from "ws";
import { once } from "node:events";
import { CompletionOutbox } from "../src/computer/notifications.js";
import {
  NotificationInbox,
  type Subscription,
} from "../src/hub/notifications.js";
import { HarmonyPushProvider } from "../src/hub/harmony-push.js";
import { Tunnels } from "../src/server/tunnels.js";
import { DomainError } from "../src/contracts/model.js";
import { NOTIFICATION_TTL } from "../src/protocol/notifications.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const event = (at: number, id = "a") => ({
  id: id.repeat(64),
  localId: "local",
  kind: "completion" as const,
  occurredAt: at,
});
const subscription: Subscription = {
  userId: "alice",
  sessionId: "session",
  installationId: "phone",
  computerId: "computer",
  token: "device-token",
  scope: JSON.stringify([
    "relay-v1",
    "https://identity.test",
    "alice",
    "hub",
    "computer",
  ]),
};
test("completion hints survive restart, deduplicate acknowledgements and stay within their attachment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "notices-"));
  let now = 100000000;
  let out = new CompletionOutbox(
    join(dir, "out.sqlite"),
    "hub:computer:1",
    () => now,
  );
  try {
    out.observe([event(now - 10000, "b"), event(now)]);
    assert.equal(out.pending().length, 1);
    out.close();
    out = new CompletionOutbox(
      join(dir, "out.sqlite"),
      "hub:computer:1",
      () => now,
    );
    assert.equal(out.pending()[0]?.id, "a".repeat(64));
    out.acknowledge("a".repeat(64));
    out.observe([event(now)]);
    assert.deepEqual(out.pending(), []);
    out.observe([event(now, "c")]);
    out.close();
    out = new CompletionOutbox(
      join(dir, "out.sqlite"),
      "hub:computer:2",
      () => now,
    );
    assert.deepEqual(out.pending(), []);
    out.close();
    out = new CompletionOutbox(
      join(dir, "out.sqlite"),
      "hub:computer:1",
      () => now,
    );
    assert.equal(out.pending().length, 1);
    now += NOTIFICATION_TTL + 1;
    assert.deepEqual(out.pending(), []);
    assert.throws(() =>
      out.observe([
        { ...event(now), text: "must not enter the journal" } as any,
      ]),
    );
  } finally {
    out.close();
    await rm(dir, { recursive: true });
  }
});
test("durable hub inbox deduplicates reconnects and rechecks current rights before provider dispatch", async () => {
  const dir = await mkdtemp(join(tmpdir(), "inbox-"));
  let now = 100000000,
    allowed = true,
    unavailable = true,
    calls = 0;
  const sent: unknown[] = [];
  const authorize = async () => {
    calls++;
    if (unavailable) throw Error("identity down");
    if (!allowed) throw new DomainError(403, "forbidden", "Access removed");
  };
  const provider = {
    testMessage: true,
    send: async (s: Subscription, e: unknown) => {
      sent.push({ s, e });
      return "sent" as const;
    },
  };
  let inbox = new NotificationInbox(
    join(dir, "in.sqlite"),
    "hub",
    authorize,
    provider,
    () => now,
  );
  try {
    inbox.subscribe(subscription);
    inbox.receive("computer", 1, "agent", event(now));
    inbox.receive("computer", 1, "agent", event(now));
    assert.equal(inbox.counts().events, 1);
    await inbox.deliver();
    assert.equal(sent.length, 0);
    assert.equal(inbox.counts().pending, 1);
    inbox.close();
    inbox = new NotificationInbox(
      join(dir, "in.sqlite"),
      "hub",
      authorize,
      provider,
      () => now,
    );
    now += 3000;
    unavailable = false;
    await inbox.deliver();
    assert.equal(sent.length, 1);
    assert.equal(inbox.counts().pending, 0);
    inbox.receive("computer", 1, "agent", event(now, "b"));
    allowed = false;
    await inbox.deliver();
    assert.equal(sent.length, 1);
    assert.equal(inbox.counts().pending, 0);
    allowed = true;
    inbox.receive("computer", 1, "agent", event(now, "c"));
    inbox.unsubscribe("alice", "phone", "computer");
    await inbox.deliver();
    assert.equal(sent.length, 1);
    inbox.subscribe(subscription);
    inbox.receive("computer", 1, "agent", event(now, "d"));
    now += NOTIFICATION_TTL + 1;
    await inbox.deliver();
    assert.equal(sent.length, 1);
    assert.ok(calls >= 3);
  } finally {
    inbox.close();
    await rm(dir, { recursive: true });
  }
});
test("token changes during authorization are fenced; invalid tokens do not erase a replacement", async () => {
  let release!: () => void, entered!: () => void;
  const started = new Promise<void>((r) => (entered = r)),
    sent: string[] = [];
  let hold = true;
  const inbox = new NotificationInbox(
    ":memory:",
    "hub",
    async () => {
      if (hold) {
        entered();
        await new Promise<void>((r) => (release = r));
      }
    },
    {
      testMessage: true,
      send: async (s) => {
        sent.push(s.token);
        return "invalid-token";
      },
    },
  );
  try {
    inbox.subscribe(subscription);
    inbox.receive("computer", 1, "agent", event(Date.now()));
    const delivery = inbox.deliver();
    await started;
    inbox.subscribe({ ...subscription, token: "replacement" });
    release();
    await delivery;
    assert.deepEqual(sent, []);
    hold = false;
    await inbox.deliver();
    assert.deepEqual(sent, ["replacement"]);
    assert.equal(inbox.counts().subscriptions, 0);
  } finally {
    inbox.close();
  }
});
test("Harmony provider signs its service account request and sends only scoped generic notification hints", async () => {
  const { privateKey, publicKey } = await generateKeyPair("PS256", {
    extractable: true,
  });
  let invalid = false;
  const provider = new HarmonyPushProvider(
    {
      project_id: "project",
      key_id: "key",
      private_key: await exportPKCS8(privateKey),
      sub_account: "account",
      token_uri: "https://oauth.example.test/token",
    },
    true,
    async (input, init) => {
      assert.equal(
        input,
        "https://push-api.cloud.huawei.com/v3/project/messages:send",
      );
      assert.equal(init?.redirect, "error");
      const headers = new Headers(init?.headers),
        jwt = headers.get("authorization")!.slice(7);
      const claims = await jwtVerify(jwt, publicKey, {
        issuer: "account",
        audience: "https://oauth.example.test/token",
        algorithms: ["PS256"],
      });
      assert.equal(claims.protectedHeader.kid, "key");
      const payload = JSON.parse(String(init?.body));
      assert.equal(
        payload.payload.notification.clickAction.data["codoxear.server"],
        subscription.scope,
      );
      assert.deepEqual(payload.target.token, ["device-token"]);
      assert.equal(payload.pushOptions.testMessage, true);
      assert.deepEqual(Object.keys(payload.payload.notification).sort(), [
        "appMessageId",
        "body",
        "category",
        "clickAction",
        "title",
      ]);
      return Response.json({ code: invalid ? "80300007" : "80000000" });
    },
  );
  await provider.ready();
  assert.equal(
    await provider.send(subscription, {
      ...event(Date.now()),
      hubId: "hub",
      computerId: "computer",
    }),
    "sent",
  );
  invalid = true;
  assert.equal(
    await provider.send(subscription, {
      ...event(Date.now()),
      hubId: "hub",
      computerId: "computer",
    }),
    "invalid-token",
  );
});
test("tunnel acknowledges only accepted hints and fences superseded connection epochs", async () => {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address() as { port: number };
  const tunnels = new Tunnels(),
    received: string[] = [],
    acks: unknown[] = [];
  let accept = false;
  server.on("connection", (ws) =>
    tunnels.attach("computer", ws, async (e) => {
      received.push(e.id);
      if (!accept) throw Error("storage unavailable");
    }),
  );
  let socket: WebSocket | undefined;
  const connect = async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${address.port}`);
    const [raw] = await once(ws, "message");
    ws.on("message", (r) => acks.push(JSON.parse(r.toString())));
    return { ws, welcome: JSON.parse(raw.toString()) };
  };
  const pause = () => new Promise((r) => setTimeout(r, 40));
  try {
    const first = await connect();
    socket = first.ws;
    assert.ok(first.welcome.capabilities.includes("notifications"));
    const hint = {
      type: "notification",
      epoch: first.welcome.epoch,
      event: event(Date.now()),
    };
    socket.send(JSON.stringify(hint));
    await pause();
    assert.equal(acks.length, 0);
    assert.equal(received.length, 1);
    accept = true;
    socket.send(JSON.stringify(hint));
    await pause();
    assert.equal(acks.length, 1);
    const second = await connect();
    socket = second.ws;
    socket.send(JSON.stringify(hint));
    await pause();
    assert.equal(received.length, 2);
    assert.equal(acks.length, 1);
    socket.send(JSON.stringify({ ...hint, epoch: second.welcome.epoch }));
    await pause();
    assert.equal(acks.length, 2);
  } finally {
    socket?.terminate();
    tunnels.close();
    await new Promise<void>((r) => server.close(() => r()));
  }
});
