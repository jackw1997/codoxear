/** Docker-only independent-Hub transfer through the public Computer CLI,
 * owner-issued destination admission and an actual installed Pi PTY. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { execFile } from "node:child_process";
import Fastify from "fastify";
import { Store } from "../src/persistence/store.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import {
  createHub,
  createComputer,
  passwordHash,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
import { readAttachment } from "../src/computer/config.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
assert.ok(
  existsSync("/.dockerenv"),
  "Native transfer acceptance runs in Docker",
);
process.env.PI_BIN = "/opt/codoxear-tools/node/bin/pi";
const home = await mkdtemp(join(tmpdir(), "native-transfer-")),
  workspace = join(home, "workspace"),
  nativeHome = join(home, "native"),
  computerHome = join(home, "computer");
await mkdir(workspace);
await mkdir(nativeHome);
await mkdir("artifacts", { recursive: true });
const checks: string[] = [],
  observations: Record<string, unknown> = {};
const pass = (message: string) => {
  checks.push(message);
  console.log("PASS", message);
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(fn: () => Promise<boolean> | boolean, label: string) {
  const end = Date.now() + 45000;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("Timed out: " + label);
    await wait(75);
  }
}
const provider = Fastify(),
  turns = new Map<string, number>();
let releaseHold: (() => void) | undefined,
  holding = false;
provider.post("/v1/chat/completions", async (request, reply) => {
  const messages = (request.body as any).messages as Array<{
    role: string;
    content?: unknown;
  }>;
  let index = messages.length - 1;
  while (index >= 0 && messages[index]?.role !== "user") index--;
  const text = JSON.stringify(messages[index]?.content);
  const marker = ["TRANSFER_INITIAL", "TRANSFER_HOLD", "TRANSFER_AFTER"].find(
    (value) => text.includes(value),
  );
  assert.ok(
    marker,
    "Only explicitly submitted transfer prompts may reach inference",
  );
  const toolDone = messages
    .slice(index + 1)
    .some((message) => message.role === "tool");
  turns.set(marker, (turns.get(marker) ?? 0) + 1);
  if (marker === "TRANSFER_HOLD" && !toolDone) {
    holding = true;
    await new Promise<void>((resolve) => (releaseHold = resolve));
  }
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
                command: "printf '" + marker + "\\n' >> transfer-commits.txt",
                timeout: 5,
              }),
            },
          },
        ],
      };
  const chunk = (delta: unknown, finish_reason: string | null) =>
    JSON.stringify({
      id: "fixture-" + marker,
      object: "chat.completion.chunk",
      created: 1,
      model: "TransferFixture",
      choices: [{ index: 0, delta, finish_reason }],
    });
  return reply
    .type("text/event-stream")
    .send(
      "data: " +
        chunk(delta, null) +
        "\n\ndata: " +
        chunk({}, toolDone ? "stop" : "tool_calls") +
        "\n\ndata: [DONE]\n\n",
    );
});
await provider.listen({ host: "127.0.0.1", port: 19841 });
async function hubFixture(port: number, userId: string) {
  const origin = "http://127.0.0.1:" + port,
    store = new Store(join(home, userId + ".sqlite"));
  const created = store.change((state) => {
    state.users.push({
      id: userId,
      email: userId + "@test.invalid",
      name: userId,
      passwordHash: passwordHash("fixture-password"),
      disabled: false,
    });
    return createComputer(
      state,
      userId,
      createHub(state, userId, userId + " independent Hub").id,
      "Retained Computer",
      userId,
    );
  });
  const local = await independentAuthority({
    origin,
    hubId: created.computer.hubId,
    store,
    otpKey: "independent-transfer-fixture-otp".repeat(3),
    secureCookies: false,
  });
  const session = local.authority.accounts.password(
    userId + "@test.invalid",
    "fixture-password",
    "transfer-cli",
  ).session;
  const token = await local.authority.tokens.issue(
    session,
    origin,
    "identity_access",
  );
  const sessions = new HubSessions(join(home, userId + "-sessions.sqlite")),
    tunnels = new Tunnels();
  const app = await createHubApp({
    origin,
    authority: local.client,
    localIdentity: local.identity,
    sessions,
    tunnels,
    webRoot: "/no-assets",
    secureCookies: false,
  });
  await app.listen({ host: "127.0.0.1", port });
  return {
    origin,
    store,
    created,
    local,
    session,
    token,
    tunnels,
    app,
    sessions,
  };
}
const source = await hubFixture(19764, "alice"),
  target = await hubFixture(19765, "bob"),
  runtime = new NativeRuntime(nativeHome, workspace, computerHome),
  api = createComputerApi(computerHome);
await api.attach({
  version: 1,
  hubUrl: source.origin,
  hubId: source.created.computer.hubId,
  computerId: source.created.computer.id,
  credential: source.created.credential,
  binding: 1,
  runtime: "native",
  workspacePath: workspace,
  nativeHome,
  nativeStateHome: computerHome,
});
let service = api.service(),
  id: string | undefined,
  passed = false;
const previousTargetHome = join(home, "previous-target"),
  previousTargetWorkspace = join(previousTargetHome, "workspace"),
  otherTargetHome = join(home, "unrelated-target"),
  otherTargetWorkspace = join(otherTargetHome, "workspace");
await mkdir(previousTargetWorkspace, { recursive: true });
await mkdir(otherTargetWorkspace, { recursive: true });
const previousTargetRuntime = new NativeRuntime(
    previousTargetHome,
    previousTargetWorkspace,
  ),
  previousTargetApi = createComputerApi(previousTargetHome),
  otherTargetApi = createComputerApi(otherTargetHome),
  unrelatedComputer = target.store.change((state) =>
    createComputer(
      state,
      "bob",
      target.created.computer.hubId,
      "Unrelated destination Computer",
      "bob",
    ),
  );
await previousTargetApi.attach({
  version: 1,
  hubUrl: target.origin,
  hubId: target.created.computer.hubId,
  computerId: target.created.computer.id,
  credential: target.created.credential,
  binding: 1,
  runtime: "native",
  nativeHome: previousTargetHome,
  workspacePath: previousTargetWorkspace,
});
await otherTargetApi.attach({
  version: 1,
  hubUrl: target.origin,
  hubId: target.created.computer.hubId,
  computerId: unrelatedComputer.computer.id,
  credential: unrelatedComputer.credential,
  binding: 1,
  runtime: "native",
  nativeHome: otherTargetHome,
  workspacePath: otherTargetWorkspace,
});
const previousTargetService = previousTargetApi.service(),
  otherTargetService = otherTargetApi.service();
let previousTargetId: string | undefined;
const json = async (hub: typeof source, path: string, body?: unknown) => {
  const response = await fetch(hub.origin + path, {
    headers: {
      Authorization: "Bearer " + hub.token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const value = await response.json();
  assert.equal(response.status, 200, JSON.stringify(value));
  return value as any;
};
const localPath = (hub: typeof source, operation: string) =>
  `/api/v1/computers/${hub.created.computer.id}/api/sessions/${id}/${operation}`;
const commits = async () =>
  (
    await readFile(join(workspace, "transfer-commits.txt"), "utf8").catch(
      () => "",
    )
  )
    .trim()
    .split("\n")
    .filter(Boolean);
try {
  previousTargetId = (
    await previousTargetRuntime.createTerminal(
      "pi",
      "Existing destination Pi",
      {
        cwd: previousTargetWorkspace,
        model: "TransferFixture",
        provider_config: {
          base_url: "http://127.0.0.1:19841/v1",
          api_key: "fixture-private-key",
        },
      },
    )
  ).localId;
  await until(
    async () =>
      (
        await previousTargetRuntime.request(
          `/api/sessions/${previousTargetId}/state`,
        )
      ).readiness === "ready",
    "existing destination Pi editor",
  );
  const previousTargetIdentity = await previousTargetRuntime.request(
    `/api/sessions/${previousTargetId}/state`,
  );
  await previousTargetRuntime.queueControl(previousTargetId, "enqueue", {
    text: "Existing destination work requires local review",
    commit_unknown: true,
  });
  await previousTargetService.start();
  await otherTargetService.start();
  await until(
    () =>
      target.tunnels.supports(target.created.computer.id, "provider-launch") &&
      target.tunnels.supports(unrelatedComputer.computer.id, "provider-launch"),
    "existing destination Computer connections",
  );
  const created = await runtime.createTerminal("pi", "Retained native Pi", {
    cwd: workspace,
    model: "TransferFixture",
    provider_config: {
      base_url: "http://127.0.0.1:19841/v1",
      api_key: "fixture-private-key",
    },
  });
  id = created.localId;
  await until(
    async () =>
      (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
      "ready",
    "actual Pi editor",
  );
  await service.start();
  await until(
    () =>
      source.tunnels.supports(source.created.computer.id, "provider-launch"),
    "source Computer connection",
  );
  await json(source, `/api/computers/${source.created.computer.id}/import`, {
    localId: id,
    name: "Source native Pi",
  });
  await json(source, localPath(source, "send"), { text: "TRANSFER_INITIAL" });
  await until(
    async () => (await commits()).includes("TRANSFER_INITIAL"),
    "source real shell tool commit",
  );
  await until(
    async () => !(await runtime.request(`/api/sessions/${id}/state`)).busy,
    "source producer idle",
  );
  const before = await runtime.request(`/api/sessions/${id}/state`);
  observations.before = {
    localId: id,
    brokerPid: before.broker_pid,
    cliPid: before.pid,
    threadId: before.thread_id,
  };
  pass(
    "Source independent Hub imports an actual installed Pi PTY and executes a real shell tool once",
  );
  await json(source, localPath(source, "send"), { text: "TRANSFER_HOLD" });
  await until(() => holding, "controlled live provider hold");
  const queued = await json(source, localPath(source, "enqueue"), {
    text: "Source pending prompt must require local review",
  });
  const sourceQueuedId = queued.items[0].id;
  await runtime.queueControl(id, "enqueue", {
    text: "Unknown retained local prompt",
    commit_unknown: true,
  });
  await service.stop();
  const pairing = target.local.authority.pairing(
    target.session,
    target.created.computer.id,
  );
  const command = await promisify(execFile)(
    process.execPath,
    [
      "--import",
      import.meta.resolve("tsx"),
      resolve("src/computer/main.ts"),
      "transfer",
      "--hub",
      target.origin,
      "--code",
      pairing.code,
    ],
    {
      env: { ...process.env, CODOXEAR_COMPUTER_HOME: computerHome },
      timeout: 30000,
    },
  );
  const receipt = JSON.parse(command.stdout);
  assert.equal(receipt.transferred, true);
  assert.equal(
    target.tunnels.online(target.created.computer.id),
    false,
    "destination admission disconnects its prior transport before new connection",
  );
  assert.equal(
    target.tunnels.online(unrelatedComputer.computer.id),
    true,
    "unrelated destination Computer remains connected",
  );
  assert.throws(() =>
    target.local.authority.device(
      target.created.computer.hubId,
      target.created.computer.id,
      target.created.credential,
    ),
  );
  const preservedTarget = await previousTargetRuntime.request(
    `/api/sessions/${previousTargetId}/state`,
  );
  assert.equal(preservedTarget.pid, previousTargetIdentity.pid);
  assert.equal(preservedTarget.broker_pid, previousTargetIdentity.broker_pid);
  assert.equal(preservedTarget.thread_id, previousTargetIdentity.thread_id);
  assert.equal(
    (await previousTargetRuntime.queueControl(previousTargetId, "queue"))
      .items[0].commit_unknown,
    true,
  );
  observations.previousDestination = {
    brokerPid: preservedTarget.broker_pid,
    cliPid: preservedTarget.pid,
    retainedUnknownQueue: true,
    unrelatedComputerOnline: true,
  };
  assert.ok(!command.stdout.includes(source.created.credential));
  const attached = await readAttachment(computerHome);
  assert.equal(attached!.hubId, target.created.computer.hubId);
  assert.equal(attached!.nativeHome, nativeHome);
  assert.equal(attached!.nativeStateHome, computerHome);
  assert.ok(!command.stdout.includes(attached!.credential));
  assert.throws(() =>
    source.local.authority.device(
      source.created.computer.hubId,
      source.created.computer.id,
      source.created.credential,
    ),
  );
  const after = await runtime.request(`/api/sessions/${id}/state`);
  assert.equal(after.pid, before.pid);
  assert.equal(after.broker_pid, before.broker_pid);
  assert.equal(after.thread_id, before.thread_id);
  pass(
    "Public transfer CLI revokes source and prior destination transports, preserves both actual Pi incarnations and leaves unrelated destination Computers online",
  );
  service = api.service();
  await service.start();
  await until(
    () =>
      target.tunnels.supports(target.created.computer.id, "provider-launch"),
    "destination Computer connection",
  );
  assert.equal(source.tunnels.online(source.created.computer.id), false);
  await json(target, `/api/computers/${target.created.computer.id}/import`, {
    localId: id,
    name: "Destination retained Pi",
  });
  const retained = await json(target, localPath(target, "queue"));
  assert.equal(retained.items.length, 2);
  assert.ok(
    !JSON.stringify(retained).includes(
      "Source pending prompt must require local review",
    ),
  );
  assert.equal(retained.items[1].commit_unknown, true);
  const deniedDelete = await fetch(
    target.origin + localPath(target, "queue/delete"),
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + target.token,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ id: sourceQueuedId }),
    },
  );
  assert.equal(deniedDelete.status, 403);
  await deniedDelete.body?.cancel();
  await runtime.request(`/api/sessions/${id}/interrupt`, "POST", {});
  await until(
    async () => !(await runtime.request(`/api/sessions/${id}/state`)).busy,
    "retained Pi cancellation idle",
  );
  releaseHold?.();
  await wait(1800);
  assert.deepEqual(await commits(), ["TRANSFER_INITIAL"]);
  assert.equal((await runtime.queueControl(id, "queue")).items.length, 2);
  pass(
    "Destination explicitly imports the same native incarnation; old-binding queue contents are redacted and uncertain work stays blocked",
  );
  await json(target, localPath(target, "send"), { text: "TRANSFER_AFTER" });
  await until(
    async () => (await commits()).includes("TRANSFER_AFTER"),
    "destination real shell tool commit",
  );
  await until(
    async () => !(await runtime.request(`/api/sessions/${id}/state`)).busy,
    "destination producer idle",
  );
  const finalState = await runtime.request(`/api/sessions/${id}/state`);
  assert.equal(finalState.pid, before.pid);
  assert.equal(finalState.broker_pid, before.broker_pid);
  assert.equal(finalState.thread_id, before.thread_id);
  assert.equal(finalState.log_path, before.log_path);
  assert.deepEqual(await commits(), ["TRANSFER_INITIAL", "TRANSFER_AFTER"]);
  const users = (
    await runtime.request(`/api/sessions/${id}/messages/tail`)
  ).events
    .filter((event: any) => event.role === "user")
    .map((event: any) => event.text);
  assert.deepEqual(users, [
    "TRANSFER_INITIAL",
    "TRANSFER_HOLD",
    "TRANSFER_AFTER",
  ]);
  assert.equal(turns.get("TRANSFER_INITIAL"), 2);
  assert.equal(turns.get("TRANSFER_AFTER"), 2);
  observations.after = {
    localId: id,
    brokerPid: finalState.broker_pid,
    cliPid: finalState.pid,
    threadId: finalState.thread_id,
    toolCommits: await commits(),
    users,
    sourceBinding: source.store.read().computers[0]!.binding,
  };
  pass(
    "Destination continues the original producer transcript and shell tools without replay; direct steering survives retained queue review barriers",
  );
  const obsolete = await fetch(
    source.origin +
      `/connect/v1/computers/${source.created.computer.id}/authorize-queue`,
    {
      method: "POST",
      headers: {
        Authorization: "Bearer " + source.created.credential,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ permit: "stale-source-permit", localId: id }),
    },
  );
  assert.equal(obsolete.status, 401);
  await obsolete.body?.cancel();
  await service.stop();
  const stableAudits = [
    source.store.read().audit.length,
    target.store.read().audit.length,
  ];
  const repeated = await api.transfer({
    hub: target.origin,
    code: pairing.code,
  });
  assert.deepEqual(repeated, receipt);
  assert.deepEqual(
    [source.store.read().audit.length, target.store.read().audit.length],
    stableAudits,
  );
  pass(
    "Stale source authorization is rejected; a completed transfer retry returns its credential-free receipt without another admission",
  );
  passed = true;
} catch (error) {
  console.error(error);
  observations.error = error instanceof Error ? error.message : String(error);
} finally {
  await writeFile(
    "artifacts/native-independent-transfer-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        observations,
        limitations: [
          "Linux installed Pi with controlled local provider and fixture Hub credentials",
          "Protocol is deliberate detach/admit; destination imports retained native sessions explicitly",
          "Owner-issued external Hub admission and real device acceptance remain separate",
        ],
      },
      null,
      2,
    ),
  );
  releaseHold?.();
  await service.stop().catch(() => {});
  await previousTargetService.stop().catch(() => {});
  await otherTargetService.stop().catch(() => {});
  if (previousTargetId)
    await previousTargetRuntime
      .request(`/api/sessions/${previousTargetId}/delete`, "POST", {})
      .catch(() => {});
  if (id)
    await runtime
      .request(`/api/sessions/${id}/delete`, "POST", {})
      .catch(() => {});
  for (const hub of [source, target]) {
    hub.tunnels.close();
    await Promise.race([
      hub.app.close().then(() => hub.local.identity.close()),
      wait(3000),
    ]);
    hub.sessions.close();
    hub.store.close();
  }
  await provider.close();
  process.exit(passed ? 0 : 1);
}
