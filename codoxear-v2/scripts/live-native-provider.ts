/** Docker-only live inference acceptance. Private configuration stays external;
 * artifacts contain fixed fixture markers and native identities only. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  copyFile,
  chmod,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, execFile } from "node:child_process";
import { promisify } from "node:util";
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
assert.ok(existsSync("/.dockerenv"), "Live acceptance runs in Docker");
const privateProvider = JSON.parse(
  await readFile("/live-provider/provider.json", "utf8"),
);
assert.ok(
  typeof privateProvider.apiKey === "string" &&
    privateProvider.apiKey.length > 10,
  "Static provider resource is usable",
);
assert.equal(
  new URL(privateProvider.url).protocol,
  "https:",
  "Provider transport uses normal HTTPS",
);
const redact = (value: unknown) =>
  String(value)
    .split(privateProvider.apiKey)
    .join("[private credential]")
    .split(privateProvider.url)
    .join("[private provider]")
    .split(new URL(privateProvider.url).hostname)
    .join("[private provider]")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[endpoint]");
const proxy = spawn(
  process.execPath,
  [
    resolve("scripts/demo-provider-network.mjs"),
    "container",
    "/egress/provider-egress.sock",
  ],
  { stdio: "ignore" },
);
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
await wait(250);
assert.equal(proxy.exitCode, null, "Owned egress forwarder is live");
process.env.PI_BIN = "/opt/codoxear-tools/node/bin/pi";
process.env.TAR_OPTIONS = "--no-same-owner";
process.env.NODE_OPTIONS =
  "--import=" + resolve("scripts/live-provider-proxy.mjs");
const home = await mkdtemp(join(tmpdir(), "live-provider-")),
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
let stage = "native launch";
async function until(
  fn: () => Promise<boolean> | boolean,
  label: string,
  timeout = 90000,
) {
  const end = Date.now() + timeout;
  while (!(await fn())) {
    if (Date.now() > end) throw Error("Timed out: " + label);
    await wait(100);
  }
}
async function hubFixture(port: number, userId: string) {
  const origin = "http://127.0.0.1:" + port,
    store = new Store(join(home, userId + ".sqlite"));
  const created = store.change((s) => {
    s.users.push({
      id: userId,
      email: userId + "@test.invalid",
      name: userId,
      passwordHash: passwordHash("fixture-password"),
      disabled: false,
    });
    return createComputer(
      s,
      userId,
      createHub(s, userId, userId + " independent Hub").id,
      "Live native Computer",
      userId,
    );
  });
  const local = await independentAuthority({
    origin,
    hubId: created.computer.hubId,
    store,
    otpKey: "live-fixture-otp".repeat(4),
    secureCookies: false,
  });
  const login = local.authority.accounts.password(
    userId + "@test.invalid",
    "fixture-password",
    "owner-browser",
  );
  const token = await local.authority.tokens.issue(
    login.session,
    origin,
    "identity_access",
  );
  const sessions = new HubSessions(join(home, userId + "-sessions.sqlite"));
  let tunnels = new Tunnels();
  const build = () =>
    createHubApp({
      origin,
      authority: local.client,
      localIdentity: local.identity,
      sessions,
      tunnels,
      webRoot: "/no-assets",
      secureCookies: false,
    });
  let app = await build();
  await app.listen({ host: "127.0.0.1", port });
  return {
    origin,
    store,
    created,
    local,
    token,
    sessions,
    get tunnels() {
      return tunnels;
    },
    get app() {
      return app;
    },
    async outage() {
      tunnels.close();
      await app.close();
    },
    async restart() {
      tunnels = new Tunnels();
      app = await build();
      await app.listen({ host: "127.0.0.1", port });
    },
  };
}
const source = await hubFixture(19774, "alice"),
  target = await hubFixture(19775, "bob"),
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
const request = async (
  hub: typeof source,
  path: string,
  body?: unknown,
  token = hub.token,
) => {
  const r = await fetch(hub.origin + path, {
    headers: {
      Authorization: "Bearer " + token,
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    ...(body === undefined
      ? {}
      : { method: "POST", body: JSON.stringify(body) }),
    signal: AbortSignal.timeout(30000),
  });
  const data = await r.json();
  assert.equal(r.status, 200, redact(JSON.stringify(data)));
  return data as any;
};
const path = (hub: typeof source, op: string) =>
  `/api/v1/computers/${hub.created.computer.id}/api/sessions/${id}/${op}`;
const state = () => runtime.request(`/api/sessions/${id}/state`);
const commits = async () =>
  (await readFile(join(workspace, "live-commits.txt"), "utf8").catch(() => ""))
    .trim()
    .split("\n")
    .filter(Boolean);
const prompt = (marker: string) =>
  `Use the bash tool exactly once to run this exact command: printf '${marker}\\n' >> live-commits.txt . Do not run any other commands. After the tool returns, reply with only ${marker}.`;
const markers = [
  "LIVE_INITIAL",
  "LIVE_NEXT",
  "LIVE_AUTHORIZED",
  "LIVE_DESTINATION",
];
try {
  stage = "managed tool preparation";
  await promisify(execFile)(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      'import {ensureTool} from "/opt/codoxear-tools/node/lib/node_modules/@earendil-works/pi-coding-agent/dist/utils/tools-manager.js"; for(const tool of ["fd","rg"]) if(!await ensureTool(tool)) process.exitCode=1;',
    ],
    {
      env: {
        ...process.env,
        HOME: nativeHome,
        PI_CODING_AGENT_DIR: join(nativeHome, ".pi", "agent"),
      },
      timeout: 120000,
    },
  );
  if (existsSync("/live-tools"))
    for (const tool of ["fd", "rg"]) {
      await copyFile(
        join(nativeHome, ".pi", "agent", "bin", tool),
        join("/live-tools", tool),
      );
      await chmod(join("/live-tools", tool), 0o755);
    }
  stage = "native launch";
  const launch = await runtime.createTerminal("pi", "Isolated live native Pi", {
    cwd: workspace,
    model: privateProvider.model,
    reasoning_effort: privateProvider.reasoning,
    provider_config: {
      base_url: privateProvider.url,
      api_key: privateProvider.apiKey,
      api: privateProvider.api,
      image_support:
        privateProvider.images === "1" || privateProvider.images === true,
    },
  });
  id = launch.localId;
  await until(
    async () => (await state()).readiness === "ready",
    "installed Pi editor",
    30000,
  );
  await service.start();
  await until(
    () =>
      source.tunnels.supports(source.created.computer.id, "provider-launch"),
    "source connection",
    30000,
  );
  await request(source, `/api/computers/${source.created.computer.id}/import`, {
    localId: id,
    name: "Live Pi",
  });
  stage = "authenticated live shell tool";
  await request(source, path(source, "send"), { text: prompt(markers[0]!) });
  await until(
    async () => (await commits()).includes(markers[0]!),
    "initial live shell tool",
  );
  await until(async () => !(await state()).busy, "initial live producer idle");
  const before = await state();
  observations.identity = {
    localId: id,
    brokerPid: before.broker_pid,
    cliPid: before.pid,
    threadId: before.thread_id,
  };
  pass(
    "Private static resource authenticates through isolated egress; actual installed Pi executes a live-provider bash tool",
  );
  stage = "live interrupt and next turn";
  const slowPrompt =
    "Use bash exactly once to run: printf 'LIVE_INTERRUPT_STARTED\\n' >> live-commits.txt; sleep 120; printf 'LIVE_INTERRUPT_FINISHED\\n' >> live-commits.txt . Do not run other commands.";
  await request(source, path(source, "send"), { text: slowPrompt });
  await until(
    async () => (await commits()).includes("LIVE_INTERRUPT_STARTED"),
    "live interrupt tool started",
  );
  await request(source, path(source, "interrupt"), {});
  await until(
    async () => !(await state()).busy,
    "live interrupt producer idle",
    30000,
  );
  assert.ok(!(await commits()).includes("LIVE_INTERRUPT_FINISHED"));
  await request(source, path(source, "send"), { text: prompt(markers[1]!) });
  await until(
    async () => (await commits()).includes(markers[1]!),
    "next live shell tool",
  );
  await until(async () => !(await state()).busy, "next turn idle");
  pass(
    "A running real bash tool is interrupted through the independent Hub; the next live turn completes on the same producer",
  );
  stage = "outage queue authorization";
  const ephemeral = source.local.authority.accounts.password(
    "alice@test.invalid",
    "fixture-password",
    "revoked-browser",
  );
  const ephemeralToken = await source.local.authority.tokens.issue(
    ephemeral.session,
    source.origin,
    "identity_access",
  );
  // A trusted local unknown head holds pending remote items until outage is established.
  const barrier = await runtime.queueControl(id, "enqueue", {
    text: "Local acceptance barrier",
    commit_unknown: true,
  });
  const revoked = await request(
    source,
    path(source, "enqueue"),
    { text: prompt("LIVE_REVOKED_MUST_NOT_EXECUTE") },
    ephemeralToken,
  );
  const revokedId = revoked.items.find((i: any) => i.origin === "remote").id;
  await request(source, path(source, "enqueue"), { text: prompt(markers[2]!) });
  await source.outage();
  source.local.authority.accounts.revoke(ephemeral.credential);
  await runtime.queueControl(id, "queue/delete", {
    id: barrier.id,
    allow_commit_unknown: true,
  });
  await until(
    async () =>
      (await runtime.queueControl(id!, "queue")).items.some(
        (i: any) =>
          i.id === revokedId && /authoriz/i.test(i.pause_reason ?? ""),
      ),
    "durable queue authorization unavailable",
    15000,
  );
  await wait(1600);
  assert.deepEqual(await commits(), [
    markers[0],
    "LIVE_INTERRUPT_STARTED",
    markers[1],
  ]);
  const held = await state();
  assert.equal(held.pid, before.pid);
  assert.equal(held.thread_id, before.thread_id);
  await source.restart();
  await until(
    () =>
      source.tunnels.supports(source.created.computer.id, "provider-launch"),
    "Hub automatic reconnect",
    30000,
  );
  await wait(2200);
  assert.equal((await runtime.queueControl(id!, "queue")).items.length, 2);
  assert.ok(!(await commits()).includes("LIVE_REVOKED_MUST_NOT_EXECUTE"));
  await request(source, path(source, "queue/delete"), { id: revokedId });
  await until(
    async () => (await commits()).includes(markers[2]!),
    "freshly authorized queue live tool",
  );
  await until(
    async () =>
      !(await state()).busy &&
      (await runtime.queueControl(id!, "queue")).items.length === 0,
    "authorized queue complete",
  );
  pass(
    "Hub outage preserves pending work and producer identity; reconnect rejects a revoked actor before allowing the remaining freshly authorized live turn",
  );
  stage = "Computer service reconnect";
  await service.stop();
  service = api.service();
  await service.start();
  await until(
    () =>
      source.tunnels.supports(source.created.computer.id, "provider-launch"),
    "Computer restart connection",
    30000,
  );
  const reconnected = await state();
  assert.equal(reconnected.pid, before.pid);
  assert.equal(reconnected.broker_pid, before.broker_pid);
  assert.equal(reconnected.thread_id, before.thread_id);
  assert.equal(reconnected.log_path, before.log_path);
  pass(
    "Computer service restart reconnects the same actual native CLI, broker and transcript without replay",
  );
  stage = "live independent Hub transfer";
  await service.stop();
  const pairing = target.local.authority.pairing(
    target.local.authority.accounts.password(
      "bob@test.invalid",
      "fixture-password",
      "destination-owner",
    ).session,
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
  assert.equal(JSON.parse(command.stdout).transferred, true);
  const attached = await readAttachment(computerHome);
  assert.equal(attached!.hubId, target.created.computer.hubId);
  service = api.service();
  await service.start();
  await until(
    () =>
      target.tunnels.supports(target.created.computer.id, "provider-launch"),
    "independent destination connection",
    30000,
  );
  await request(target, `/api/computers/${target.created.computer.id}/import`, {
    localId: id,
    name: "Retained live Pi",
  });
  await request(target, path(target, "send"), { text: prompt(markers[3]!) });
  await until(
    async () => (await commits()).includes(markers[3]!),
    "destination live shell tool",
  );
  await until(async () => !(await state()).busy, "destination idle");
  const final = await state();
  assert.equal(final.pid, before.pid);
  assert.equal(final.broker_pid, before.broker_pid);
  assert.equal(final.thread_id, before.thread_id);
  assert.equal(final.log_path, before.log_path);
  assert.deepEqual(await commits(), [
    markers[0],
    "LIVE_INTERRUPT_STARTED",
    markers[1],
    markers[2],
    markers[3],
  ]);
  const transcript = await runtime.request(`/api/sessions/${id}/messages/tail`);
  const userTexts = transcript.events
    .filter((e: any) => e.role === "user")
    .map((e: any) => e.text);
  for (const marker of markers)
    assert.equal(
      userTexts.filter((s: string) => s.includes(marker)).length,
      1,
      "Native user prompts execute once",
    );
  assert.ok(
    !userTexts.some((s: string) => s.includes("LIVE_REVOKED_MUST_NOT_EXECUTE")),
  );
  observations.after = {
    localId: id,
    brokerPid: final.broker_pid,
    cliPid: final.pid,
    threadId: final.thread_id,
    toolCommits: await commits(),
    userTurnCount: userTexts.length,
  };
  pass(
    "Public detach/admit CLI transfers between independent Hubs; live destination tools continue the original native transcript exactly once",
  );
  passed = true;
} catch (error) {
  if (id) {
    const tail = await runtime
      .queueControl(id, "tail")
      .catch(() => ({ tail: "unavailable" }));
    observations.nativeTail = redact(tail.tail)
      .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
      .slice(-6000);
    console.log("DIAGNOSTIC", observations.nativeTail);
  }
  observations.error = redact(error instanceof Error ? error.message : error);
  console.error("FAIL", stage, observations.error);
} finally {
  await writeFile(
    "artifacts/live-native-provider-results.json",
    JSON.stringify(
      {
        passed,
        stage,
        checks,
        observations,
        limitations: [
          "Linux installed Pi and actual external provider; disposable independent-Hub owners and authenticated HTTP interfaces",
          "Real handset/mobile-platform acceptance is separate",
        ],
      },
      null,
      2,
    ),
  );
  await service.stop().catch(() => {});
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
  if (proxy.exitCode === null) proxy.kill("SIGTERM");
  process.exit(passed ? 0 : 1);
}
