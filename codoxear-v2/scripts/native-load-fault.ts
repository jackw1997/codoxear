import { createAllowedComputer } from "./testing/authorized-fixtures.js";
/** Bounded native Linux acceptance, Docker only. Installed Pi uses a controlled
 * OpenAI-compatible provider. Measurements are observations, not production SLOs. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  appendFile,
  mkdir,
  mkdtemp,
  open,
  readFile,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance, monitorEventLoopDelay } from "node:perf_hooks";
import { randomUUID } from "node:crypto";
import type { Socket } from "node:net";
import Fastify from "fastify";
import { Store } from "../src/persistence/store.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import { HttpMux } from "../src/protocol/http-mux.js";
import {
  COMPUTER_WINDOW,
  STREAM_WINDOW,
  CHUNK_BYTES,
} from "../src/protocol/http-frames.js";
import { createComputerApi } from "../src/computer/api.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { NativeHttpTarget } from "../src/computer/native/http.js";
import {
  createHub,
  reserveAgent,
  passwordHash,
} from "../src/domain/commands.js";

assert.ok(existsSync("/.dockerenv"), "Run native acceptance in Docker");
const bounded = (name: string, fallback: number, max: number) => {
  const value = Number(process.env[name] ?? fallback);
  assert.ok(
    Number.isInteger(value) && value > 0 && value <= max,
    name + " outside bounded fixture range",
  );
  return value;
};
const parameters = {
  sessions: 2,
  historyRowsPerSession: bounded("LOAD_HISTORY_ROWS", 512, 2048),
  historyTextBytes: 4096,
  mixedRounds: bounded("LOAD_MIXED_ROUNDS", 3, 10),
  slowConsumers: 3,
  downloadBytes: 24 * 1024 * 1024,
  observationPauseMs: 250,
  outageObservationMs: 2500,
  pollMs: 150,
  timeoutMs: 45000,
};
const started = performance.now(),
  home = await mkdtemp(join(tmpdir(), "native-load-fault-"));
const workspace = join(home, "workspace"),
  computerHome = join(home, "computer");
await mkdir(workspace, { recursive: true });
await mkdir("artifacts", { recursive: true });
const artifact = "artifacts/native-load-fault-results.json";
const checks: string[] = [],
  observations: Record<string, unknown> = {},
  samples: number[] = [];
const latencyPhases: Record<string, number[]> = {};
let latencyPhase = "setup";
function distribution(values: number[]) {
  const sorted = [...values].sort((a, b) => a - b);
  return {
    samples: sorted.length,
    min: sorted[0] ?? null,
    p50: sorted[Math.floor(sorted.length * 0.5)] ?? null,
    p95:
      sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * 0.95))] ??
      null,
    max: sorted.at(-1) ?? null,
  };
}
const passed = (message: string) => {
  checks.push(message);
  console.log("PASS", message);
};
const pause = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(fn: () => Promise<boolean> | boolean, label: string) {
  const deadline = performance.now() + parameters.timeoutMs;
  while (!(await fn())) {
    if (performance.now() > deadline) throw Error("Timed out: " + label);
    await pause(parameters.pollMs);
  }
}
const provider = Fastify();
const providerTurns = new Map<string, number>();
let releaseHold: (() => void) | undefined,
  releaseCommit: (() => void) | undefined;
let holdReached = false,
  faultAfterCommit = false;
provider.post("/v1/chat/completions", async (request, reply) => {
  const messages = (
    request.body as { messages: Array<{ role: string; content?: unknown }> }
  ).messages;
  let userIndex = messages.length - 1;
  while (userIndex >= 0 && messages[userIndex]?.role !== "user") userIndex--;
  const content = JSON.stringify(messages[userIndex]?.content);
  const marker = [
    "INITIAL_A",
    "INITIAL_B",
    "HOLD",
    "QUEUED_EDITED",
    "COMMIT_ONCE",
  ].find((s) => content.includes(s));
  assert.ok(marker, "Expected a controlled prompt marker");
  const toolDone = messages.slice(userIndex + 1).some((m) => m.role === "tool");
  providerTurns.set(marker, (providerTurns.get(marker) ?? 0) + 1);
  if (marker === "HOLD" && !toolDone) {
    holdReached = true;
    await new Promise<void>((resolve) => {
      releaseHold = resolve;
    });
  }
  if (marker === "COMMIT_ONCE" && !toolDone)
    await new Promise<void>((resolve) => {
      releaseCommit = resolve;
    });
  const delta = toolDone
    ? { content: "Completed " + marker }
    : {
        tool_calls: [
          {
            index: 0,
            id: "call_" + marker,
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command: "printf '" + marker + "\\n' >> commits.txt",
                timeout: 5,
              }),
            },
          },
        ],
      };
  const chunk = (delta: unknown, finish_reason: string | null) =>
    JSON.stringify({
      id: "fixture_" + marker,
      object: "chat.completion.chunk",
      created: 1,
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    });
  return reply
    .type("text/event-stream")
    .send(
      "data: " +
        chunk({ role: "assistant", ...delta }, null) +
        "\n\ndata: " +
        chunk({}, toolDone ? "stop" : "tool_calls") +
        "\n\ndata: [DONE]\n\n",
    );
});
await provider.listen({ host: "127.0.0.1", port: 19832 });
const pi = join(home, ".pi", "agent");
await mkdir(pi, { recursive: true });
await writeFile(
  join(pi, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:19832/v1",
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          {
            id: "fixture",
            name: "Controlled load fixture",
            reasoning: false,
            input: ["text"],
            contextWindow: 10000000,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
        ],
      },
    },
  }),
);
await writeFile(
  join(pi, "settings.json"),
  JSON.stringify({
    defaultProvider: "fixture",
    defaultModel: "fixture",
    defaultThinkingLevel: "off",
    defaultProjectTrust: "always",
    quietStartup: true,
  }),
);
process.env.PI_BIN = "/opt/codoxear-tools/node/bin/pi";
const runtime = new NativeRuntime(home, workspace, computerHome);
const store = new Store(join(home, "hub.sqlite"));
store.change((state) =>
  state.users.push({
    id: "alice",
    email: "alice@test.invalid",
    name: "Alice",
    passwordHash: passwordHash("fixture-only-password"),
    disabled: false,
  }),
);
const h = store.change((state) => createHub(state, "alice", "Load acceptance"));
const c = store.change((state) =>
  createAllowedComputer(state, "alice", h.id, "Native fixture", "alice"),
);
const origin = "http://127.0.0.1:19831";
const local = await independentAuthority({
  origin,
  hubId: h.id,
  store,
  otpKey: "fixture-only".repeat(4),
  secureCookies: false,
});
const signed = local.authority.accounts.password(
  "alice@test.invalid",
  "fixture-only-password",
  "fixture",
);
const token = await local.authority.tokens.issue(
  signed.session,
  origin,
  "identity_access",
);
const headers = { authorization: "Bearer " + token };
const hubSessions = new HubSessions(join(home, "hub-sessions.sqlite"));
let tunnels = new Tunnels();
let hub = await makeHub();
const hubSockets = new Set<Socket>();
async function makeHub() {
  const app = await createHubApp({
    origin,
    authority: local.client,
    localIdentity: local.identity,
    sessions: hubSessions,
    tunnels,
    secureCookies: false,
    webRoot: "/no-assets",
  });
  return app;
}
function trackHub() {
  hub.server.on("connection", (socket) => {
    hubSockets.add(socket);
    socket.once("close", () => hubSockets.delete(socket));
  });
}
trackHub();
await hub.listen({ host: "127.0.0.1", port: 19831 });
const api = createComputerApi(computerHome);
await api.attach({
  version: 1,
  hubUrl: origin,
  hubId: h.id,
  computerId: c.computer.id,
  credential: c.credential,
  runtime: "native",
  nativeHome: home,
  workspacePath: workspace,
});
// Inject only the deliberate post-commit connection-loss boundary. All work
// executes through the real native target, actual sockets and installed CLI.
let service = api.service(undefined, {
  httpTarget: () => {
    const target = new NativeHttpTarget(runtime, workspace);
    return {
      close: () => target.close(),
      execute: async (request) => {
        const result = await target.execute(request);
        if (faultAfterCommit && request.path.endsWith("/send")) {
          faultAfterCommit = false;
          tunnels.close();
          await pause(100);
        }
        return result;
      },
    };
  },
});
const ids: string[] = [],
  controllerSet = new Set<AbortController>();
const loop = monitorEventLoopDelay({ resolution: 10 });
let rssPeak = process.memoryUsage().rss;
const memoryTimer = setInterval(() => {
  rssPeak = Math.max(rssPeak, process.memoryUsage().rss);
}, 50);
const prefix = origin + "/api/v1/computers/" + c.computer.id;
async function json(path: string, payload?: unknown) {
  const begin = performance.now();
  const response = await fetch(prefix + path, {
    headers: {
      ...headers,
      ...(payload === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(payload === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(payload) }),
    signal: AbortSignal.timeout(parameters.timeoutMs),
  });
  const body = await response.json();
  assert.equal(response.status, 200, JSON.stringify(body));
  const elapsed = performance.now() - begin;
  samples.push(elapsed);
  (latencyPhases[latencyPhase] ??= []).push(elapsed);
  return body as any;
}
const metricSnapshots: unknown[] = [];
function metrics(label: string) {
  // Existing mux diagnostic API; private fields are inspected only by this fixture.
  const computerMux = (service as unknown as { http?: HttpMux }).http;
  const hubMux = (
    tunnels as unknown as { links: Map<string, { http?: HttpMux }> }
  ).links.get(c.computer.id)?.http;
  const snapshot = {
    label,
    computer: computerMux?.metrics(),
    hub: hubMux?.metrics(),
  };
  metricSnapshots.push(snapshot);
  for (const value of [snapshot.computer, snapshot.hub])
    if (value)
      assert.ok(
        value.highWaterBytes <= COMPUTER_WINDOW,
        "Mux exceeds its protocol memory budget",
      );
  return snapshot;
}
async function closeHub() {
  tunnels.close();
  for (const socket of hubSockets) socket.destroy();
  hub.server.closeAllConnections();
  await hub.close();
}
const commits = async () =>
  (await readFile(join(workspace, "commits.txt"), "utf8").catch(() => ""))
    .trim()
    .split("\n");
async function writeReport(ok: boolean, error?: unknown) {
  observations.latencyMs = distribution(samples);
  observations.latencyByPhaseMs = Object.fromEntries(
    Object.entries(latencyPhases).map(([phase, values]) => [
      phase,
      distribution(values),
    ]),
  );
  observations.elapsedMs = performance.now() - started;
  observations.rss = {
    peakHarnessHubComputerBytes: rssPeak,
    currentBytes: process.memoryUsage().rss,
    scope:
      "Hub and Computer share this harness process; detached brokers/CLIs sampled separately",
  };
  observations.eventLoopDelayMs = {
    mean: Number.isFinite(loop.mean) ? loop.mean / 1e6 : null,
    p99: loop.percentile(99) / 1e6,
    max: loop.max / 1e6,
  };
  await writeFile(
    artifact,
    JSON.stringify(
      {
        passed: ok,
        at: new Date().toISOString(),
        engine: "native-typescript",
        topology:
          "one independent Hub, one native Computer, two installed Pi PTYs, authenticated HTTP clients",
        provider:
          "controlled local OpenAI-compatible fixture; no live inference or private credentials",
        parameters,
        limits: {
          streamWindowBytes: STREAM_WINDOW,
          computerWindowBytes: COMPUTER_WINDOW,
          chunkBytes: CHUNK_BYTES,
        },
        observations,
        metrics: metricSnapshots,
        checks,
        providerRequests: Object.fromEntries(providerTurns),
        commitBoundary:
          "Native send is acknowledged by the broker before deliberately dropping its relay response; local tools finish after loss. A restarted Computer must not resend it.",
        remaining: [
          "Production concurrency/history sizes and separated-process resource accounting",
          "Hard process termination at every broker/queue/Hub database commit boundary",
          "All CLI/provider combinations, long outage/backoff, permission churn, high RTT/loss and soak tests",
          "Browser/Safari/mobile download lifecycle",
        ],
        ...(error ? { error: String(error) } : {}),
      },
      null,
      2,
    ),
  );
}
try {
  await service.start();
  await until(
    () => tunnels.supports(c.computer.id, "http-streams"),
    "Computer online",
  );
  for (let i = 0; i < parameters.sessions; i++) {
    const agent = store.change((state) =>
      reserveAgent(state, "alice", c.computer.id, "Load " + i, "pi"),
    );
    const created = (await tunnels.request(c.computer.id, {
      op: "create",
      agentId: agent.id,
      backend: "pi",
      name: "Load " + i,
    })) as { localId: string };
    ids.push(created.localId);
    store.change((state) => {
      const row = state.agents.find((a) => a.id === agent.id)!;
      row.localId = created.localId;
      row.state = "ready";
    });
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${created.localId}/state`))
          .readiness === "ready",
      "Pi readiness",
    );
  }
  passed("Two installed Pi native PTYs are admitted by an independent Hub");
  await Promise.all(
    ids.map((id, i) =>
      json(`/api/sessions/${id}/send`, { text: i ? "INITIAL_B" : "INITIAL_A" }),
    ),
  );
  await until(
    async () =>
      (await commits()).includes("INITIAL_A") &&
      (await commits()).includes("INITIAL_B"),
    "initial actual tool commits",
  );
  await until(
    async () =>
      (
        await Promise.all(
          ids.map((id) => runtime.request(`/api/sessions/${id}/state`)),
        )
      ).every((s) => !s.busy),
    "initial idle",
  );
  passed("Concurrent native turns execute real shell tools");
  latencyPhase = "smallHistoryBaseline";
  for (let round = 0; round < parameters.mixedRounds; round++)
    await Promise.all(
      ids.map((id) => json(`/api/sessions/${id}/messages/tail?limit=8`)),
    );
  const historyBytes: number[] = [];
  const brokerPids: number[] = [];
  for (const id of ids) {
    const meta = JSON.parse(
      await readFile(join(runtime.directory, id + ".json"), "utf8"),
    );
    assert.ok(meta.log_path, "Actual native log attribution");
    brokerPids.push(meta.broker_pid, meta.pid);
    // Deliberately extend the owned backend log after a completed turn, keeping
    // legitimate Pi entry shape and parent chain. No application/parser stubs.
    const previous = (await readFile(meta.log_path, "utf8"))
      .trim()
      .split("\n")
      .at(-1)!;
    let parentId = JSON.parse(previous).id;
    const records = [];
    for (let i = 0; i < parameters.historyRowsPerSession; i++) {
      const entryId = randomUUID().slice(0, 8);
      records.push(
        JSON.stringify({
          type: "message",
          id: entryId,
          parentId,
          timestamp: new Date(1700000000000 + i).toISOString(),
          message: {
            role: "assistant",
            content: [
              {
                type: "text",
                text:
                  "History " +
                  i +
                  " " +
                  "h".repeat(parameters.historyTextBytes),
              },
            ],
            api: "openai-completions",
            provider: "fixture",
            model: "fixture",
            stopReason: "stop",
            timestamp: 1700000000000 + i,
          },
        }),
      );
      parentId = entryId;
    }
    await appendFile(meta.log_path, records.join("\n") + "\n");
    historyBytes.push((await stat(meta.log_path)).size);
  }
  observations.historyBytes = historyBytes;
  observations.historySource =
    "Synthetic valid Pi entries appended to each owned native log after a completed turn. This measures native history parsing, not a large model context or CLI-generated conversation.";
  const brokerRss = await Promise.all(
    [...new Set(brokerPids.filter(Number.isInteger))].map(async (pid) => {
      const status = await readFile(`/proc/${pid}/status`, "utf8").catch(
        () => "",
      );
      return {
        pid,
        rssBytes: Number(/VmRSS:\s+(\d+)/.exec(status)?.[1] ?? 0) * 1024,
      };
    }),
  );
  observations.detachedProcessRss = brokerRss;
  const file = await open(join(workspace, "load.bin"), "wx");
  await file.truncate(parameters.downloadBytes);
  await file.close();
  loop.enable();
  latencyPhase = "representativeHistoryWithSlowDownloads";
  const muxSlow = [];
  for (let i = 0; i < parameters.slowConsumers; i++) {
    const controller = new AbortController();
    controllerSet.add(controller);
    muxSlow.push(
      await tunnels.http(
        c.computer.id,
        {
          method: "GET",
          path: `/api/sessions/${ids[0]}/file/download?path=load.bin`,
          headers: {},
          actorId: "alice",
        },
        undefined,
        controller.signal,
      ),
    );
  }
  await pause(parameters.observationPauseMs);
  const blocked = metrics("unconsumed native downloads");
  assert.ok(
    blocked.hub &&
      blocked.hub.queuedBytes <= parameters.slowConsumers * STREAM_WINDOW,
  );
  assert.ok(blocked.hub && blocked.hub.streams === parameters.slowConsumers);
  for (let round = 0; round < parameters.mixedRounds; round++) {
    await Promise.all(
      ids.map((id) => json(`/api/sessions/${id}/messages/tail?limit=8`)),
    );
    await json(`/api/sessions/${ids[1]}/queue`);
  }
  passed(
    "Bounded slow consumers coexist with authenticated transcript and queue reads over representative histories",
  );
  // Drain one complete actual native file through the public Hub HTTP route.
  const download = await fetch(
    prefix + `/api/sessions/${ids[1]}/file/download?path=load.bin`,
    { headers },
  );
  assert.equal(download.status, 200);
  let downloadBytes = 0;
  const downloadReader = download.body!.getReader();
  while (true) {
    const next = await downloadReader.read();
    if (next.done) break;
    downloadBytes += next.value.byteLength;
  }
  assert.equal(downloadBytes, parameters.downloadBytes);
  observations.streamedDownloadBytes = downloadBytes;
  metrics("mixed HTTP download complete");
  for (const controller of controllerSet) controller.abort();
  controllerSet.clear();
  await Promise.all(
    muxSlow.map(async (response) => {
      await assert.rejects(async () => {
        for await (const _ of response.body) {
          /* cancelled */
        }
      });
    }),
  );
  await until(
    () => metrics("cancel cleanup").hub?.streams === 0,
    "slow stream cleanup",
  );
  passed("Native downloads cancel and release all mux capacity");
  latencyPhase = "outageAndRecovery";
  await json(`/api/sessions/${ids[0]}/send`, { text: "HOLD" });
  await until(() => holdReached, "held provider turn");
  const queued = await json(`/api/sessions/${ids[0]}/enqueue`, {
    text: "QUEUED_ORIGINAL",
  });
  assert.equal(queued.items.length, 1);
  await json(`/api/sessions/${ids[0]}/queue/update`, {
    id: queued.items[0].id,
    text: "QUEUED_EDITED",
  });
  const outageStarted = performance.now();
  await closeHub();
  releaseHold!();
  releaseHold = undefined;
  await until(
    async () => (await commits()).includes("HOLD"),
    "tool completion during Hub outage",
  );
  await pause(parameters.outageObservationMs);
  assert.ok(
    !(await commits()).includes("QUEUED_EDITED"),
    "Queue cannot dispatch without current Hub authorization",
  );
  await assert.rejects(
    fetch(prefix + `/api/sessions/${ids[0]}/queue`, {
      headers,
      signal: AbortSignal.timeout(2000),
    }),
  );
  const offlineTail = await runtime.request(
    `/api/sessions/${ids[0]}/messages/tail?limit=8`,
  );
  assert.ok(
    JSON.stringify(offlineTail).includes("Completed HOLD"),
    "Computer-owned transcript remains readable locally",
  );
  passed(
    "Hub outage permits local tool/transcript progress and leaves the edited remote queue pending",
  );
  tunnels = new Tunnels();
  hub = await makeHub();
  trackHub();
  await hub.listen({ host: "127.0.0.1", port: 19831 });
  await until(
    () => tunnels.supports(c.computer.id, "http-streams"),
    "Hub reconnect",
  );
  observations.hubRecoveryMs = performance.now() - outageStarted;
  await until(
    async () => (await commits()).includes("QUEUED_EDITED"),
    "edited queued dispatch after reauthorization",
  );
  await until(
    async () =>
      (await json(`/api/sessions/${ids[0]}/queue`)).items.length === 0,
    "queue removal after broker acknowledgement",
  );
  assert.equal((await commits()).filter((x) => x === "HOLD").length, 1);
  assert.equal(
    (await commits()).filter((x) => x === "QUEUED_EDITED").length,
    1,
  );
  passed(
    "Reconnected Hub reauthorizes the edited queue and commits each native tool exactly once",
  );
  await until(
    async () => !(await runtime.request(`/api/sessions/${ids[1]}/state`)).busy,
    "second session idle",
  );
  faultAfterCommit = true;
  const lost = await fetch(prefix + `/api/sessions/${ids[1]}/send`, {
    method: "POST",
    headers: { ...headers, "content-type": "application/json" },
    body: JSON.stringify({ text: "COMMIT_ONCE" }),
  });
  assert.equal(lost.status, 503, await lost.clone().text());
  assert.equal(
    ((await lost.json()) as { code: string }).code,
    "outcome_unknown",
  );
  await until(
    () => !!releaseCommit,
    "native turn accepted before relay result loss",
  );
  releaseCommit!();
  releaseCommit = undefined;
  await until(
    async () => (await commits()).includes("COMMIT_ONCE"),
    "uncertain turn actual tool completion",
  );
  await service.stop();
  service = api.service();
  await service.start();
  await until(
    () => tunnels.supports(c.computer.id, "http-streams"),
    "Computer restart",
  );
  await pause(parameters.outageObservationMs);
  await json(`/api/sessions/${ids[1]}/messages/tail?limit=8`);
  assert.equal((await commits()).filter((x) => x === "COMMIT_ONCE").length, 1);
  assert.equal(
    providerTurns.get("COMMIT_ONCE"),
    2,
    "Exactly one tool call and one completion; no automatic replay",
  );
  passed(
    "Native broker acknowledgement followed by relay loss reports uncertainty; Computer restart preserves the PTY without replay",
  );
  metrics("after Computer restart");
  await writeReport(true);
  console.log("ARTIFACT", artifact);
} catch (error) {
  await writeReport(false, error);
  console.error(error);
  process.exitCode = 1;
} finally {
  loop.disable();
  clearInterval(memoryTimer);
  releaseHold?.();
  releaseCommit?.();
  for (const controller of controllerSet) controller.abort();
  await service.stop();
  await closeHub();
  for (const id of ids)
    await runtime.request(`/api/sessions/${id}/delete`, "POST").catch(() => {});
  provider.server.closeAllConnections();
  await provider.close();
  await local.identity.close();
  hubSessions.close();
  store.close();
  runtime.close();
}
