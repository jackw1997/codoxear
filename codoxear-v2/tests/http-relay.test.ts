import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:http";
import { once } from "node:events";
import { gzipSync } from "node:zlib";
import { randomBytes, createHash } from "node:crypto";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { createIdentityApp } from "../src/identity/app.js";
import { createHubApp } from "../src/hub/app.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import { LocalHttpTarget } from "./support/http-target.js";
import { FixtureRuntime } from "../scripts/testing/fixture-runtime.js";
import { createComputerApi } from "../src/computer/api.js";
import {
  createHub,
  createComputer,
  passwordHash,
  reserveAgent,
  secret,
} from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const hash = (b: Uint8Array) => createHash("sha256").update(b).digest("hex");
async function until(fn: () => boolean, ms = 6000) {
  const until = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > until) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 30));
  }
}
test("HTTP relay preserves large binary/multipart/range/ETag/HLS and closes streams on revoked access", async () => {
  const binary = randomBytes(4 * 1024 * 1024 + 19);
  let deleteOutcome = "error",
    deletionRequests = 0;
  let upload: Buffer | undefined,
    observedHeaders: Record<string, unknown> = {},
    streamClosed = false;
  const local = createServer(async (req, res) => {
    if (req.url === "/api/login") {
      res.setHeader("set-cookie", "codoxear_auth=local-only");
      res.end("{}");
      return;
    }
    observedHeaders = req.headers;
    assert.equal(req.headers.cookie, "codoxear_auth=local-only");
    assert.equal(req.headers.authorization, undefined);
    if (
      req.url === "/api/sessions/broker-22222222222222222222222222222222/delete"
    ) {
      deletionRequests++;
      res.writeHead(deleteOutcome === "error" ? 503 : 200, {
        "content-type": "application/json",
      });
      res.end(
        deleteOutcome === "invalid"
          ? "invalid-json"
          : JSON.stringify({ ok: deleteOutcome === "confirmed" }),
      );
      return;
    }
    if (req.url?.startsWith("/api/notifications/feed")) {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({
          items: ["broker-11111111111111111111111111111111", "unpublished"].map(
            (session_id) => ({
              session_id,
              message_id: "completion-" + session_id,
              session_display_name: session_id,
              notification_text: "Finished",
              updated_ts: 1,
              private_extra: "must not leave the Computer",
            }),
          ),
        }),
      );
      return;
    }
    if (
      req.url?.startsWith(
        "/api/sessions/broker-11111111111111111111111111111111/messages/tail",
      )
    ) {
      const packed = gzipSync(
        JSON.stringify({
          events: [{ text: "Unicode compressed transcript 🐟".repeat(2000) }],
        }),
      );
      res.writeHead(200, {
        "content-type": "application/json",
        "content-encoding": "gzip",
        "content-length": packed.length,
      });
      res.end(packed);
      return;
    }
    if (req.url?.endsWith("/inject_file")) {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk);
      upload = Buffer.concat(chunks);
      res.setHeader("content-type", "application/json");
      res.end(JSON.stringify({ bytes: upload.length }));
      return;
    }
    if (req.url?.includes("video_preview")) {
      res.setHeader("content-type", "application/vnd.apple.mpegurl");
      res.end(
        '#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="/api/sessions/broker-11111111111111111111111111111111/file/blob?key=1"\n/api/sessions/broker-11111111111111111111111111111111/file/blob?segment=1\n',
      );
      return;
    }
    if (req.url?.endsWith("/live")) {
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("data: initial\n\n");
      const timer = setInterval(() => res.write("data: next\n\n"), 40);
      res.on("close", () => {
        streamClosed = true;
        clearInterval(timer);
      });
      return;
    }
    if (req.headers["if-none-match"] === '"binary-1"') {
      res.writeHead(304, { etag: '"binary-1"' });
      res.end();
      return;
    }
    if (req.headers.range === "bytes=101-1100") {
      res.writeHead(206, {
        "content-type": "application/octet-stream",
        "content-length": "1000",
        "content-range": `bytes 101-1100/${binary.length}`,
        "accept-ranges": "bytes",
        etag: '"binary-1"',
      });
      res.end(binary.subarray(101, 1101));
      return;
    }
    res.writeHead(200, {
      "content-type": "application/octet-stream",
      "content-length": binary.length,
      etag: '"binary-1"',
      "set-cookie": "secret=do-not-forward",
    });
    res.end(binary);
  });
  local.listen(0, "127.0.0.1");
  await once(local, "listening");
  const localUrl =
    "http://127.0.0.1:" + (local.address() as { port: number }).port;
  const home = mkdtempSync(join(tmpdir(), "http-relay-")),
    store = new Store(":memory:"),
    issuer = "http://127.0.0.1:19380",
    origin = "http://127.0.0.1:19381";
  store.change((s) =>
    s.users.push({
      id: "alice",
      name: "Alice",
      email: "alice@example.test",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    }),
  );
  const accounts = new Accounts(store, secret(), { async send() {} }),
    a = new Authority(store, accounts, new Tokens(issuer, await signingKey())),
    session = accounts.password(
      "alice@example.test",
      "test-password",
      "native",
    ).session,
    h = store.change((s) => createHub(s, "alice", "Streaming")),
    registration = a.registerHub(session, h.id, origin),
    computer = store.change((s) =>
      createComputer(s, "alice", h.id, "Computer", "alice"),
    );
  store.change((s) => {
    const agent = reserveAgent(s, "alice", computer.computer.id, "Agent", "pi");
    agent.localId = "broker-11111111111111111111111111111111";
    agent.state = "ready";
  });
  const identity = await createIdentityApp({
      authority: a,
      secureCookies: false,
    }),
    sessions = new HubSessions(":memory:"),
    tunnels = new Tunnels(),
    hub = await createHubApp({
      origin,
      authority: new AuthorityClient(issuer, h.id, registration.credential),
      sessions,
      tunnels,
      secureCookies: false,
    });
  const api = createComputerApi(home);
  await api.attach({
    version: 1,
    hubUrl: origin,
    hubId: h.id,
    computerId: computer.computer.id,
    credential: computer.credential,
    runtime: "native",
    workspacePath: "/workspace",
  });
  const service = api.service(undefined, {
    runtime: () => new FixtureRuntime(":memory:"),
    httpTarget: () => new LocalHttpTarget(localUrl, "local-password", "/workspace"),
  });
  try {
    await identity.listen({ host: "127.0.0.1", port: 19380 });
    await hub.listen({ host: "127.0.0.1", port: 19381 });
    await service.start();
    await until(() => tunnels.online(computer.computer.id));
    await new Promise((r) => setTimeout(r, 50));
    const token = (await a.hubToken(session, h.id)).accessToken,
      headers = { authorization: "Bearer " + token },
      prefix = origin + "/api/v1/computers/" + computer.computer.id,
      base = prefix + "/api/sessions/broker-11111111111111111111111111111111";
    const feed = await fetch(prefix + "/api/notifications/feed?since=0", {
      headers,
    });
    assert.equal(feed.status, 200);
    assert.deepEqual(await feed.json(), {
      ok: true,
      items: [
        {
          session_id: "broker-11111111111111111111111111111111",
          message_id: "completion-broker-11111111111111111111111111111111",
          session_display_name: "broker-11111111111111111111111111111111",
          notification_text: "Finished",
          updated_ts: 1,
        },
      ],
    });
    const subscription = await fetch(
      prefix + "/api/notifications/subscription",
      { headers },
    );
    assert.equal(subscription.status, 200);
    assert.equal(
      ((await subscription.json()) as { web_push_configured: boolean })
        .web_push_configured,
      false,
    );
    const disposable = store.change((s) => {
      const agent = reserveAgent(
        s,
        "alice",
        computer.computer.id,
        "Disposable",
        "pi",
      );
      agent.localId = "broker-22222222222222222222222222222222";
      agent.state = "ready";
      s.users.push({
        id: "bob",
        email: "bob@example.test",
        name: "Bob",
        passwordHash: passwordHash("test-password"),
        disabled: false,
      });
      s.memberships.push(
        { resource: "hub", resourceId: h.id, userId: "bob", role: "operator" },
        {
          resource: "computer",
          resourceId: computer.computer.id,
          userId: "bob",
          role: "operator",
        },
      );
      return agent;
    });
    a.queuePermit(
      session,
      h.id,
      computer.computer.id,
      "/api/sessions/broker-22222222222222222222222222222222/enqueue",
    );
    const bob = accounts.password(
      "bob@example.test",
      "test-password",
      "native",
    ).session;
    const bobHeaders = {
      authorization: "Bearer " + (await a.hubToken(bob, h.id)).accessToken,
    };
    const deleteUrl =
      prefix + "/api/sessions/broker-22222222222222222222222222222222/delete";
    assert.equal(
      (await fetch(deleteUrl, { method: "POST", headers: bobHeaders })).status,
      403,
    );
    assert.equal(
      deletionRequests,
      0,
      "Operator deletion is rejected before dispatch",
    );
    assert.throws(() =>
      a.forgetDeletedAgent(
        bob,
        h.id,
        computer.computer.id,
        "broker-22222222222222222222222222222222",
      ),
    );
    for (deleteOutcome of ["error", "unconfirmed", "invalid"]) {
      assert.equal(
        (await fetch(deleteUrl, { method: "POST", headers })).status,
        502,
      );
      assert.ok(
        store.read().agents.some((a) => a.id === disposable.id),
        "Unconfirmed deletion retains its catalog record",
      );
    }
    deleteOutcome = "confirmed";
    assert.equal(
      (await fetch(deleteUrl, { method: "POST", headers })).status,
      200,
    );
    assert.equal(
      store.read().agents.some((a) => a.id === disposable.id),
      false,
    );
    assert.equal(
      store
        .read()
        .identity.queuePermits.some(
          (p) => p.localId === "broker-22222222222222222222222222222222",
        ),
      false,
    );
    assert.equal(
      (
        await fetch(
          prefix +
            "/api/sessions/broker-22222222222222222222222222222222/messages/tail",
          {
            headers: bobHeaders,
          },
        )
      ).status,
      404,
    );
    const compressed = await fetch(base + "/messages/tail", { headers });
    assert.equal(
      ((await compressed.json()) as { events: Array<{ text: string }> })
        .events[0]!.text,
      "Unicode compressed transcript 🐟".repeat(2000),
    );
    const get = await fetch(base + "/file/blob", { headers });
    assert.equal(get.status, 200);
    assert.equal(get.headers.get("set-cookie"), null);
    assert.equal(hash(new Uint8Array(await get.arrayBuffer())), hash(binary));
    const range = await fetch(base + "/file/blob", {
      headers: { ...headers, range: "bytes=101-1100" },
    });
    assert.equal(range.status, 206);
    assert.equal(
      range.headers.get("content-range"),
      `bytes 101-1100/${binary.length}`,
    );
    assert.equal(
      hash(new Uint8Array(await range.arrayBuffer())),
      hash(binary.subarray(101, 1101)),
    );
    const cached = await fetch(base + "/file/blob", {
      headers: { ...headers, "if-none-match": '"binary-1"' },
    });
    assert.equal(cached.status, 304);
    assert.equal((await cached.arrayBuffer()).byteLength, 0);
    const body = Buffer.concat([
      Buffer.from(
        '--boundary\r\nContent-Disposition: form-data; name="file"; filename="data.bin"\r\nContent-Type: application/octet-stream\r\n\r\n',
      ),
      binary,
      Buffer.from("\r\n--boundary--\r\n"),
    ]);
    const sent = await fetch(base + "/inject_file", {
      method: "POST",
      headers: {
        ...headers,
        "content-type": "multipart/form-data; boundary=boundary",
      },
      body,
    });
    assert.equal(sent.status, 200);
    assert.equal(((await sent.json()) as { bytes: number }).bytes, body.length);
    assert.equal(hash(upload!), hash(body));
    assert.equal(
      observedHeaders["content-type"],
      "multipart/form-data; boundary=boundary",
    );
    const playlist = await fetch(base + "/file/video_preview", { headers });
    const text = await playlist.text();
    assert.ok(
      text.includes(
        '"/api/v1/computers/' +
          computer.computer.id +
          '/api/sessions/broker-11111111111111111111111111111111/file/blob?key=1"',
      ),
    );
    assert.ok(!text.includes("\n/api/sessions/"));
    assert.equal((await fetch(prefix + "/api/login", { headers })).status, 403);
    assert.equal(
      (
        await fetch(base + "/file/blob", {
          headers: { authorization: "Bearer invalid" },
        })
      ).status,
      401,
    );
    const live = await fetch(base + "/live", { headers }),
      reader = live.body!.getReader();
    assert.equal(live.status, 200);
    assert.ok((await reader.read()).value?.length);
    store.change((s) => {
      s.users[0]!.disabled = true;
    });
    await assert.rejects(async () => {
      while (!(await reader.read()).done) {}
      throw new Error("Stream ended after revocation");
    });
    await until(() => streamClosed);
    assert.equal((await fetch(base + "/file/blob", { headers })).status, 401);
  } finally {
    await service.stop();
    await hub.close();
    await identity.close();
    sessions.close();
    store.close();
    await new Promise<void>((r) => local.close(() => r()));
    rmSync(home, { recursive: true, force: true });
  }
});
