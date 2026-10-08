import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { HttpMux } from "../src/protocol/http-mux.js";
import {
  STREAM_WINDOW,
  CHUNK_BYTES,
  type HttpRequest,
  type HttpResponse,
  type Bytes,
} from "../src/protocol/http-frames.js";
import { classifyRoute, filterHeaders } from "../src/protocol/routes.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const bytes = (data: Uint8Array): Bytes => ({
  async *[Symbol.asyncIterator]() {
    for (let i = 0; i < data.length; i += CHUNK_BYTES)
      yield data.subarray(i, i + CHUNK_BYTES);
  },
});
async function pair(
  handler: (r: HttpRequest) => Promise<HttpResponse>,
  idle = 60000,
) {
  const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
  await once(server, "listening");
  const address = server.address();
  if (typeof address === "string" || !address) throw new Error("No address");
  const connected = once(server, "connection"),
    client = new WebSocket("ws://127.0.0.1:" + address.port);
  await once(client, "open");
  const [accepted] = (await connected) as [WebSocket];
  const left = new HttpMux(client, "epoch", undefined, idle),
    right = new HttpMux(accepted, "epoch", handler, idle);
  return {
    left,
    right,
    client,
    accepted,
    async close() {
      left.close();
      right.close();
      client.terminate();
      accepted.terminate();
      await new Promise<void>((r) => server.close(() => r()));
    },
  };
}
async function collect(body: Bytes) {
  const result = [];
  for await (const chunk of body) result.push(Buffer.from(chunk));
  return Buffer.concat(result);
}
test("multiplexed uploads/downloads preserve bytes and headers with concurrent streams", async () => {
  const p = await pair(async (r) => ({
    status: 206,
    headers: {
      "content-type": r.headers["content-type"] ?? "application/octet-stream",
      "content-range": "bytes 0-1023/2048",
      etag: '"version"',
    },
    body: r.body,
  }));
  try {
    const inputs = [
      randomBytes(3 * 1024 * 1024 + 17),
      randomBytes(2 * 1024 * 1024 + 13),
    ];
    await Promise.all(
      inputs.map(async (data) => {
        const response = await p.left.request(
          {
            method: "POST",
            path: "/api/sessions/a/inject_file",
            headers: { "content-type": "multipart/form-data; boundary=EXACT" },
          },
          bytes(data),
        );
        assert.equal(response.status, 206);
        assert.equal(response.headers.etag, '"version"');
        assert.deepEqual(await collect(response.body), data);
      }),
    );
    assert.ok(p.left.metrics().highWaterBytes <= 16 * STREAM_WINDOW);
    assert.ok(p.right.metrics().highWaterBytes <= 16 * STREAM_WINDOW);
  } finally {
    await p.close();
  }
});
test("slow consumer bounds producer and does not block other streams", async () => {
  let produced = 0;
  const p = await pair(async (r) => ({
    status: 200,
    headers: {},
    body: r.path.endsWith("/slow")
      ? {
          async *[Symbol.asyncIterator]() {
            for (let n = 0; n < 128; n++) {
              produced += CHUNK_BYTES;
              yield new Uint8Array(CHUNK_BYTES);
            }
          },
        }
      : bytes(Buffer.from("fast")),
  }));
  try {
    const controller = new AbortController();
    const slow = await p.left.request(
      { method: "GET", path: "/api/sessions/a/slow", headers: {} },
      undefined,
      controller.signal,
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(produced <= STREAM_WINDOW + CHUNK_BYTES);
    const fast = await p.left.request({
      method: "GET",
      path: "/api/sessions/a/messages",
      headers: {},
    });
    assert.equal((await collect(fast.body)).toString(), "fast");
    controller.abort();
    await assert.rejects(collect(slow.body));
  } finally {
    await p.close();
  }
});
test("lost tunnel cancels local work and reports mutation uncertainty without retry", async () => {
  let calls = 0,
    aborted = false;
  const p = await pair(async (r) => {
    calls++;
    r.signal.addEventListener("abort", () => {
      aborted = true;
    });
    await new Promise<void>((resolve) =>
      r.signal.addEventListener("abort", () => resolve(), { once: true }),
    );
    throw new Error("cancelled");
  });
  try {
    const pending = p.left.request(
      { method: "POST", path: "/api/sessions/a/send", headers: {} },
      bytes(Buffer.from("x")),
    );
    await new Promise((r) => setTimeout(r, 50));
    p.client.terminate();
    await assert.rejects(
      pending,
      (e: unknown) => (e as { code: string }).code === "outcome_unknown",
    );
    await new Promise((r) => setTimeout(r, 30));
    assert.equal(calls, 1);
    assert.equal(aborted, true);
  } finally {
    await p.close();
  }
});
test("wrong epochs cannot complete streams; idle streams release capacity", async () => {
  const p = await pair(async () => new Promise(() => {}), 100);
  try {
    const pending = p.left.request({
      method: "GET",
      path: "/api/sessions/a/messages",
      headers: {},
    });
    p.accepted.send(
      JSON.stringify({
        type: "http.response",
        epoch: "old",
        id: "random",
        head: { status: 200, headers: {} },
      }),
    );
    await assert.rejects(pending);
    assert.equal(p.left.metrics().streams, 0);
  } finally {
    await p.close();
  }
});
test("local route policy blocks authentication, global file escape, traversal and unexpected methods", () => {
  assert.equal(
    classifyRoute("GET", "/api/sessions/agent/file/blob?path=a.png").action,
    "files.read",
  );
  assert.equal(
    classifyRoute("POST", "/api/sessions/agent/send").action,
    "send",
  );
  for (const path of [
    "/api/login",
    "/api/files/read",
    "http://evil/api/sessions/a/messages",
    "/api/sessions/a/../messages",
    "/api/sessions/a/%252e%252e/messages",
    "/api/sessions/a%2f..%2fb/messages",
  ])
    assert.throws(() => classifyRoute("GET", path));
  assert.throws(() => classifyRoute("DELETE", "/api/sessions/a/messages"));
  assert.deepEqual(
    filterHeaders(
      {
        authorization: "secret",
        cookie: "secret",
        host: "evil",
        range: "bytes=0-10",
        connection: "upgrade",
      },
      "request",
    ),
    { range: "bytes=0-10" },
  );
});

test("sixteen saturated streams stay bounded while heartbeat control remains responsive; capacity recovers after cancellation", async () => {
  let generated = 0;
  const p = await pair(async () => ({
    status: 200,
    headers: {},
    body: {
      async *[Symbol.asyncIterator]() {
        for (let i = 0; i < 1024; i++) {
          generated += CHUNK_BYTES;
          yield new Uint8Array(CHUNK_BYTES);
        }
      },
    },
  }));
  try {
    const controllers = Array.from({ length: 16 }, () => new AbortController());
    const responses = await Promise.all(
      controllers.map((c) =>
        p.left.request(
          { method: "GET", path: "/api/sessions/a/live", headers: {} },
          undefined,
          c.signal,
        ),
      ),
    );
    await new Promise((r) => setTimeout(r, 150));
    assert.ok(generated <= 16 * (STREAM_WINDOW + CHUNK_BYTES));
    assert.ok(p.left.metrics().highWaterBytes <= 16 * STREAM_WINDOW);
    await assert.rejects(
      p.left.request({
        method: "POST",
        path: "/api/sessions/a/send",
        headers: {},
      }),
      (e: any) => e.status === 429 && e.code === "not_dispatched",
    );
    const pong = once(p.client, "pong");
    p.client.ping();
    await Promise.race([
      pong,
      new Promise((_, reject) =>
        setTimeout(() => reject(Error("Control traffic stalled")), 2000),
      ),
    ]);
    controllers.forEach((c) => c.abort());
    await Promise.all(responses.map((r) => assert.rejects(collect(r.body))));
    const deadline = Date.now() + 2000;
    while (p.right.metrics().streams && Date.now() < deadline)
      await new Promise((r) => setTimeout(r, 10));
    assert.equal(p.left.metrics().streams, 0);
    assert.equal(p.right.metrics().streams, 0);
    assert.equal(p.left.metrics().queuedBytes, 0);
  } finally {
    await p.close();
  }
});
