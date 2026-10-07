import { createAllowedComputer } from "./testing/authorized-fixtures.js";
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { createServer as httpServer, request } from "node:http";
import { createServer as httpsServer } from "node:https";
import { connect } from "node:net";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { createIdentityApp } from "../src/identity/app.js";
import { createHubApp } from "../src/hub/app.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import { createComputerApi } from "../src/computer/api.js";
import { FixtureRuntime } from "./testing/fixture-runtime.js";
import {
  createHub,
  passwordHash,
  secret,
} from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const issuer = "https://identity.test:19420",
  origin = "https://hub.test:19430";
async function until(check: () => Promise<boolean>, ms = 30000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function tls(port: number, target: number) {
  const server = httpsServer(
    {
      key: await readFile("/fixture/tls/key.pem"),
      cert: await readFile("/fixture/tls/cert.pem"),
    },
    (req, res) => {
      const upstream = request(
        {
          hostname: "127.0.0.1",
          port: target,
          method: req.method,
          path: req.url,
          headers: req.headers,
        },
        (r) => {
          res.writeHead(r.statusCode!, r.headers);
          r.pipe(res);
        },
      );
      upstream.on("error", () => res.destroy());
      req.pipe(upstream);
      req.on("aborted", () => upstream.destroy());
    },
  );
  server.on("upgrade", (req, socket, head) => {
    const upstream = connect(target, "127.0.0.1", () => {
      upstream.write(
        `${req.method} ${req.url} HTTP/1.1\r\n` +
          Object.entries(req.headers)
            .map(([k, v]) => `${k}: ${v}`)
            .join("\r\n") +
          "\r\n\r\n",
      );
      if (head.length) upstream.write(head);
      socket.pipe(upstream);
      upstream.pipe(socket);
    });
    upstream.on("error", () => socket.destroy());
    socket.on("error", () => upstream.destroy());
  });
  await new Promise<void>((r) => server.listen(port, "0.0.0.0", r));
  return server;
}
if (process.argv[2] === "hub") {
  const store = new Store(":memory:");
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
    h = store.change((s) => createHub(s, "alice", "Network test")),
    registration = a.registerHub(session, h.id, origin),
    computer = store.change((s) =>
      createAllowedComputer(s, "alice", h.id, "Private computer", "alice"),
    );
  const identity = await createIdentityApp({ authority: a }),
    sessions = new HubSessions(":memory:"),
    tunnels = new Tunnels(),
    hub = await createHubApp({
      origin,
      authority: new AuthorityClient(issuer, h.id, registration.credential),
      sessions,
      tunnels,
      development: true,
    });
  await identity.listen({ host: "127.0.0.1", port: 19421 });
  await hub.listen({ host: "127.0.0.1", port: 19431 });
  await tls(19420, 19421);
  await tls(19430, 19431);
  await writeFile(
    "/fixture/computer/config.json",
    JSON.stringify({
      version: 1,
      hubUrl: origin,
      hubId: h.id,
      computerId: computer.computer.id,
      credential: computer.credential,
      runtime: "fixture",
    }),
    { mode: 0o600 },
  );
  await writeFile(
    "/fixture/client/config.json",
    JSON.stringify({
      token: (await a.hubToken(session, h.id)).accessToken,
      computerId: computer.computer.id,
      origin,
    }),
    { mode: 0o600 },
  );
  console.log("Hub ready on public and computer networks");
} else if (process.argv[2] === "computer") {
  const api = createComputerApi("/tmp/computer");
  await api.attach(
    JSON.parse(await readFile("/fixture/computer/config.json", "utf8")),
  );
  await api.service(undefined, {
    runtime: (_config, stateHome) => new FixtureRuntime(join(stateHome, "fixture.sqlite")),
  }).start();
  httpServer((_req, res) => res.end("private network probe")).listen(
    19990,
    "0.0.0.0",
  );
  console.log("Computer initiated outbound WSS");
} else {
  const config = JSON.parse(
      await readFile("/fixture/client/config.json", "utf8"),
    ),
    headers = {
      authorization: "Bearer " + config.token,
      "content-type": "application/json",
    };
  const api = async (path: string, body?: unknown) => {
    const r = await fetch(origin + path, {
      headers,
      ...(body === undefined
        ? {}
        : { method: "POST", body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(8000),
    });
    assert.ok(r.ok, `${path}: ${r.status} ${r.ok ? "" : await r.text()}`);
    return r.json();
  };
  await assert.rejects(
    fetch("http://10.233.2.20:19990", { signal: AbortSignal.timeout(1500) }),
    "Client must not reach the private computer",
  );
  console.log("PASS client cannot connect to computer private IP");
  await until(async () => {
    const computers = (await api("/api/v1/computers")) as Array<{
      online: boolean;
    }>;
    return computers[0]?.online === true;
  });
  const agent = (await api("/api/computers/" + config.computerId + "/agents", {
    name: "Network proof",
    backend: "fixture",
  })) as { id: string };
  await api("/api/agents/" + agent.id + "/send", {
    text: "Only through the hub",
  });
  const data = (await api("/api/agents/" + agent.id + "/messages")) as {
    messages: Array<{ text: string }>;
  };
  assert.ok(
    data.messages.some(
      (m) => m.text === "Fixture response: Only through the hub",
    ),
  );
  console.log("PASS client → HTTPS hub → outbound WSS computer → hub → client");
  await writeFile(
    "/work/artifacts/network-results.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: true,
        topology:
          "Separate Docker network namespaces: client on front only, computer on private only, hub on both; verified TLS",
        checks: [
          "Private computer IP unreachable from client",
          "Computer establishes outbound WSS",
          "Authorized agent conversation through public hub",
        ],
        runtime: "fixture, network proof only",
      },
      null,
      2,
    ),
  );
}
