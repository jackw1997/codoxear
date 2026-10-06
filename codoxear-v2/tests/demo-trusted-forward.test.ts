import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer, request } from "node:http";
import { once } from "node:events";
import { WebSocket, WebSocketServer } from "ws";
import {
  createTrustedForwarder,
  forwardPorts,
  type TrustedForwardConfig,
} from "../scripts/demo-trusted-forward.js";
assert.ok(existsSync("/.dockerenv"), "Gateway acceptance runs only in Docker");

async function fixture(options: Partial<TrustedForwardConfig> = {}) {
  const root = await mkdtemp(join(tmpdir(), "cdfwd-")),
    fresh = join(root, "new"),
    legacy = join(root, "old");
  await mkdir(fresh);
  await mkdir(legacy);
  const upstreams: Array<ReturnType<typeof createServer>> = [],
    websockets: WebSocketServer[] = [];
  const events: Array<{
    label: string;
    path: string;
    host: string | undefined;
    origin: string | undefined;
    authorization: string | undefined;
    chunks: number;
  }> = [];
  let cancelledResolve!: () => void;
  const cancelled = new Promise<void>((done) => (cancelledResolve = done));
  for (const [label, path] of [
    ...forwardPorts.map((port) => ["new-" + port, join(fresh, port + ".sock")]),
    ["old-19530", join(legacy, "independent-hub-0.sock")],
    ["old-19531", join(legacy, "independent-hub-1.sock")],
  ] as Array<[string, string]>) {
    const server = createServer((req, res) => {
      const event = {
        label,
        path: req.url!,
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        chunks: 0,
      };
      events.push(event);
      if (req.url === "/stream") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Access-Control-Allow-Origin": req.headers.origin ?? "",
        });
        res.write("data: first\n\n");
        res.once("close", cancelledResolve);
        return;
      }
      req.on("data", () => {
        event.chunks++;
        if (req.url === "/upload") res.write("chunk\n");
      });
      req.on("end", () => {
        if (req.url === "/unauthorized") {
          res.writeHead(403);
          res.end("backend-denied");
        } else res.end(label);
      });
    });
    const wss = new WebSocketServer({ noServer: true });
    websockets.push(wss);
    server.on("upgrade", (req, socket, head) => {
      events.push({
        label,
        path: req.url!,
        host: req.headers.host,
        origin: req.headers.origin,
        authorization: req.headers.authorization,
        chunks: 0,
      });
      wss.handleUpgrade(req, socket, head, (ws) => {
        ws.send(label);
        ws.on("message", (data) => ws.send(data));
      });
    });
    await new Promise<void>((done, reject) => {
      server.once("error", reject);
      server.listen(path, done);
    });
    upstreams.push(server);
  }
  const gateway = createTrustedForwarder({
    newDir: fresh,
    legacyDir: legacy,
    legacyComputers: [
      { id: "old-home", hubPort: 19530 },
      { id: "old-work", hubPort: 19531 },
    ],
    ports: { 19500: 0, 19520: 0, 19530: 0, 19531: 0 },
    legacyJwtKids: [{ kid: "old-public-key", hubPort: 19530 }],
    ...options,
  });
  const addresses = await gateway.listen();
  return {
    events,
    cancelled,
    gateway,
    url: (port: (typeof forwardPorts)[number]) =>
      "http://127.0.0.1:" + addresses.get(port)!.port,
    async close() {
      await gateway.close();
      for (const wss of websockets) {
        for (const ws of wss.clients) ws.terminate();
        wss.close();
      }
      await Promise.all(
        upstreams.map(
          (s) =>
            new Promise<void>((done) => {
              s.closeAllConnections();
              s.close(() => done());
            }),
        ),
      );
      await rm(root, { recursive: true, force: true });
    },
  };
}
test("new frontend/default Hub and exact legacy Computer paths route transparently", async () => {
  const f = await fixture();
  try {
    for (const port of forwardPorts)
      assert.equal(
        await (await fetch(f.url(port) + "/")).text(),
        "new-" + port,
      );
    for (const [port, id, label] of [
      [19530, "old-home", "old-19530"],
      [19531, "old-work", "old-19531"],
    ] as const)
      assert.equal(
        await new Promise<string>((done, reject) => {
          const req = request(
            f.url(port) + `/api/computers/${id}/settings`,
            {
              headers: {
                Host: "public.example:8446",
                Origin: "https://client.example",
                Authorization: "Bearer fixture-secret",
              },
            },
            (response) => {
              let body = "";
              response.setEncoding("utf8");
              response.on("data", (chunk) => {
                body += chunk;
              });
              response.once("end", () => done(body));
              response.once("error", reject);
            },
          );
          req.once("error", reject);
          req.end();
        }),
        label,
      );
    const last = f.events.at(-1)!;
    assert.equal(last.host, "public.example:8446");
    assert.equal(last.origin, "https://client.example");
    assert.equal(last.authorization, "Bearer fixture-secret");
    for (const path of [
      "/api/computers/unknown/settings",
      "/api/computers/old-home-suffix/settings",
      "/?computer=old-home",
    ])
      assert.equal(
        await (await fetch(f.url(19530) + path)).text(),
        "new-19530",
      );
    assert.equal(
      await (
        await fetch(f.url(19531) + "/api/computers/old-home/settings")
      ).text(),
      "new-19531",
    );
  } finally {
    await f.close();
  }
});
test("legacy default preserves new explicit Computer and key routes with backend authorization", async () => {
  const f = await fixture({
    defaultHubTarget: "legacy",
    newComputers: [{ id: "new-home", hubPort: 19530 }],
    newJwtKids: [{ kid: "new-public-key", hubPort: 19530 }],
  });
  const bearer = (kid: string) =>
    "Bearer " +
    Buffer.from(JSON.stringify({ kid })).toString("base64url") +
    ".fake.fake";
  try {
    for (const port of forwardPorts)
      assert.equal(
        await (await fetch(f.url(port) + "/")).text(),
        (port === 19530 || port === 19531 ? "old-" : "new-") + port,
      );
    for (const [path, kid, expected] of [
      ["/api/computers/new-home/settings", "old-public-key", "new-19530"],
      ["/api/computers/old-home/settings", "new-public-key", "old-19530"],
      ["/api/computers/unknown/settings", "new-public-key", "new-19530"],
      ["/api/agents", "old-public-key", "old-19530"],
      ["/api/agents", "unknown", "old-19530"],
      ["/api/computers/new-home-suffix/settings", "unknown", "old-19530"],
    ]) {
      assert.equal(
        await (
          await fetch(f.url(19530) + path, {
            headers: { Authorization: bearer(kid!) },
          })
        ).text(),
        expected,
      );
    }
    const denied = await fetch(f.url(19531) + "/unauthorized", {
      headers: { Authorization: bearer("new-public-key") },
    });
    assert.equal(denied.status, 403);
    assert.equal(await denied.text(), "backend-denied");
    assert.equal(f.events.at(-1)!.label, "old-19531");
    assert.equal(
      await (
        await fetch(f.url(19531) + "/api/computers/new-home/settings")
      ).text(),
      "old-19531",
    );
  } finally {
    await f.close();
  }
  const base = {
    newDir: "/new",
    legacyDir: "/old",
    legacyComputers: [{ id: "same", hubPort: 19530 as const }],
  };
  assert.throws(() =>
    createTrustedForwarder({
      ...base,
      newComputers: [{ id: "same", hubPort: 19531 }],
    }),
  );
  assert.throws(() =>
    createTrustedForwarder({
      ...base,
      legacyJwtKids: [{ kid: "same", hubPort: 19530 }],
      newJwtKids: [{ kid: "same", hubPort: 19531 }],
    }),
  );
});
test("explicit public signing-key hint routes old bearer APIs while backend denial remains authoritative", async () => {
  const f = await fixture();
  try {
    const bearer =
      "Bearer " +
      Buffer.from(JSON.stringify({ kid: "old-public-key" })).toString(
        "base64url",
      ) +
      ".fake.fake";
    const response = await fetch(f.url(19530) + "/unauthorized", {
      headers: { Authorization: bearer },
    });
    assert.equal(response.status, 403);
    assert.equal(await response.text(), "backend-denied");
    assert.equal(f.events.at(-1)!.label, "old-19530");
    assert.equal(
      await (
        await fetch(f.url(19530) + "/api/agents", {
          headers: { Authorization: "Bearer malformed" },
        })
      ).text(),
      "new-19530",
    );
    const unknown =
      "Bearer " +
      Buffer.from(JSON.stringify({ kid: "unknown-public-key" })).toString(
        "base64url",
      ) +
      ".fake.fake";
    assert.equal(
      await (
        await fetch(f.url(19530) + "/api/agents", {
          headers: { Authorization: unknown },
        })
      ).text(),
      "new-19530",
    );
  } finally {
    await f.close();
  }
});
test("real Computer WebSocket upgrades preserve headers, survive listener drain and reconnect to the old Hub", async () => {
  const f = await fixture();
  let ws: WebSocket | undefined;
  try {
    ws = new WebSocket(
      f.url(19530).replace("http:", "ws:") + "/connect/v1/computers/old-home",
      {
        headers: {
          Host: "public.example:8446",
          Origin: "https://client.example",
          Authorization: "Bearer computer-fixture",
        },
      },
    );
    const [message] = await once(ws, "message");
    assert.equal(message.toString(), "old-19530");
    assert.equal(f.events.at(-1)!.host, "public.example:8446");
    assert.equal(f.events.at(-1)!.authorization, "Bearer computer-fixture");
    f.gateway.stopAccepting();
    const reply = once(ws, "message");
    ws.send("still-connected");
    assert.equal((await reply)[0].toString(), "still-connected");
  } finally {
    ws?.terminate();
    await f.close();
  }
  const second = await fixture();
  let reconnect: WebSocket | undefined;
  try {
    reconnect = new WebSocket(
      second.url(19530).replace("http:", "ws:") +
        "/connect/v1/computers/old-home",
    );
    assert.equal((await once(reconnect, "message"))[0].toString(), "old-19530");
  } finally {
    reconnect?.terminate();
    await second.close();
  }
});
test("SSE first bytes and CORS stream immediately; downstream cancellation reaches the Unix backend", async () => {
  const f = await fixture();
  try {
    const response = await fetch(f.url(19530) + "/stream", {
      headers: { Origin: "https://client.example" },
    });
    assert.equal(
      response.headers.get("access-control-allow-origin"),
      "https://client.example",
    );
    const reader = response.body!.getReader();
    assert.equal(
      Buffer.from((await reader.read()).value!).toString(),
      "data: first\n\n",
    );
    await reader.cancel();
    await Promise.race([
      f.cancelled,
      new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error("Cancellation did not reach upstream")),
          1500,
        ),
      ),
    ]);
  } finally {
    await f.close();
  }
});
test("upload chunks reach the Unix backend before the request body ends", async () => {
  const f = await fixture();
  try {
    await new Promise<void>((done, reject) => {
      const req = request(
        f.url(19530) + "/upload",
        { method: "POST" },
        (res) => {
          res.once("data", () => {
            assert.equal(f.events.at(-1)!.chunks, 1);
            req.end("second");
          });
          res.on("data", () => {});
          res.once("end", done);
        },
      );
      req.once("error", reject);
      req.write("first");
    });
    assert.equal(f.events.at(-1)!.chunks, 2);
  } finally {
    await f.close();
  }
});
