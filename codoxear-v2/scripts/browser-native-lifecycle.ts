import { createAllowedComputer } from "./testing/authorized-fixtures.js";
import "./testing/frontend-artifact.js";
import { connect } from "node:net";
import { socketPath } from "../src/computer/native/paths.js";
import { independentAuthority } from "../src/hub/independent.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
/** Docker-only installed CLI lifecycle acceptance with controlled inference and fixture credentials. */
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { Store } from "../src/persistence/store.js";
import { createHubApp } from "../src/hub/app.js";
import { NotificationInbox } from "../src/hub/notifications.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import {
  createHub,
  passwordHash,
  secret,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "native-lifecycle-")),
  workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "tracked.txt"), "original line\n");
for (const args of [
  ["init"],
  ["config", "user.email", "test@example.invalid"],
  ["config", "user.name", "Verification"],
  ["add", "tracked.txt"],
  ["commit", "-m", "fixture"],
])
  execFileSync("/usr/bin/git", args, { cwd: workspace, stdio: "ignore" });
await mkdir(join(home, ".codex"), { recursive: true });
await writeFile(
  join(home, ".codex", "config.toml"),
  `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
);
await mkdir(join(home, ".claude"), { recursive: true });
await writeFile(
  join(home, ".claude", "settings.json"),
  JSON.stringify({ skipDangerousModePermissionPrompt: true }),
);
await writeFile(
  join(home, ".claude", ".claude.json"),
  JSON.stringify({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: ["fixture-private-key"], rejected: [] },
    bypassPermissionsModeAccepted: true,
    projects: { [workspace]: { hasTrustDialogAccepted: true } },
  }),
);
Object.assign(process.env, {
  PI_BIN: "/opt/codoxear-tools/node/bin/pi",
  CODEX_BIN: "/opt/codoxear-tools/node/bin/codex",
  CLAUDE_BIN: "/tools/claude",
  IS_SANDBOX: "1",
});
const nativeRuntime = new NativeRuntime(
  home,
  workspace,
  join(home, "computer"),
);
const gateway = await backendGateway();
let logs = "";
async function until(check: () => Promise<boolean> | boolean, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timeout\n" + logs.slice(-5000));
    await new Promise((r) => setTimeout(r, 100));
  }
}
const store = new Store(":memory:");
store.change((s) =>
  s.users.push({
    id: "alice",
    email: "alice@test.invalid",
    name: "Alice",
    passwordHash: passwordHash("isolated-password"),
    disabled: false,
  }),
);
const computer = store.change((s) =>
  createAllowedComputer(
    s,
    "alice",
    createHub(s, "alice", "Runtime test").id,
    "Native backends",
    "alice",
  ),
);
const origin = "http://127.0.0.1:19744",
  clientOrigin = "http://127.0.0.1:19745";
const local = await independentAuthority({
  origin,
  hubId: computer.computer.hubId,
  store,
  otpKey: secret(),
  secureCookies: false,
});
const { authority, identity, client } = local;
const identitySession = authority.accounts.password(
  "alice@test.invalid",
  "isolated-password",
  "test",
).session;
const sessions = new HubSessions(join(home, "hub.sqlite"));
const notifications = new NotificationInbox(
  join(home, "notifications.sqlite"),
  computer.computer.hubId,
  async (sessionId, agentId, computerId, binding) => {
    authority.authorizeNotification(
      computer.computer.hubId,
      sessionId,
      agentId,
      computerId,
      binding,
    );
  },
);
let tunnels = new Tunnels(),
  hub = await createHubApp({
    origin,
    localIdentity: identity,
    clientOrigins: [clientOrigin],
    authority: client,
    notifications,
    sessions,
    tunnels,
    secureCookies: false,
  });
await hub.listen({ host: "127.0.0.1", port: 19744 });
const api = createComputerApi(join(home, "computer"));
await api.attach({
  version: 1,
  hubUrl: "http://127.0.0.1:19744",
  hubId: computer.computer.hubId,
  computerId: computer.computer.id,
  credential: computer.credential,
  runtime: "native",
  nativeHome: home,
  workspacePath: workspace,
});
let service = api.service();
const staticClient = spawn(
  process.execPath,
  ["frontend/serve.mjs"],
  { env: { ...process.env, CODOXEAR_CLIENT_PORT: "19745" }, stdio: "ignore" },
);
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
// Keep loopback connectivity visible to Chromium's online-aware UI inside the
// network-isolated container. This changes browser network state, not responses.
const network = await context.newCDPSession(page);
await network.send("Network.enable");
await network.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
  connectionType: "ethernet",
});
page.setDefaultTimeout(20000);
const browserErrors: string[] = [];
page.on("pageerror", (error: Error) => browserErrors.push(error.message));
page.on("console", (entry: any) => {
  if (entry.type() === "error") browserErrors.push(entry.text());
});
const checks: string[] = [];
const pass = (text: string) => {
  checks.push(text);
  console.log("PASS", text);
};
let passed = false;
await mkdir("artifacts", { recursive: true });
const evidence: Record<string, unknown>[] = [];
const artifact = `artifacts/browser-native-lifecycle-${Date.now()}`;
async function nativeState(id: string) {
  return nativeRuntime.request(`/api/sessions/${id}/state`);
}
async function ready(id: string) {
  await until(async () => (await nativeState(id)).readiness === "ready", 60000);
}
async function browserSend(text: string, expectedCount = 1) {
  await page.getByLabel("Message", { exact: true }).fill(text);
  await clickBrowserSend();
  await until(
    async () =>
      (await page.getByText("PRIVATE_PROVIDER_OK", { exact: true }).count()) >=
      expectedCount,
    60000,
  );
}
async function clickBrowserSend() {
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const confirm = page.getByRole("button", { name: "Send now", exact: true });
  // The producer can be idle before the browser receives that state. Exercise
  // the ordinary explicit send confirmation if the UI still shows a turn.
  try {
    await confirm.waitFor({ state: "visible", timeout: 1200 });
  } catch {
    return;
  }
  await confirm.click();
}
async function selectBrowserSession(name: string) {
  const card = page
    .locator(".session")
    .filter({ has: page.getByText(name, { exact: true }) });
  await card.waitFor({ timeout: 30000 });
  await card.click();
  await until(
    async () =>
      (await card.getAttribute("class"))!.split(" ").includes("active") &&
      (await page.locator("#threadTitle").innerText()).includes(name),
  );
}
async function newDialog(backend: string, name: string, resumeId?: string) {
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  const dialog = page.locator("dialog.agent-creation");
  await dialog.getByLabel("Agent name").fill(name);
  await dialog.getByLabel("Runtime", { exact: true }).selectOption(backend);
  if (resumeId) {
    await dialog.getByLabel("Start", { exact: true }).selectOption("resume");
    await dialog
      .getByLabel("Session working directory", { exact: true })
      .fill(workspace);
    await dialog
      .getByRole("button", { name: "Find saved sessions", exact: true })
      .click();
    await until(
      async () =>
        (await dialog
          .getByLabel("Saved sessions", { exact: true })
          .locator("option")
          .count()) > 1,
    );
    await dialog
      .getByLabel("Saved sessions", { exact: true })
      .selectOption(resumeId);
    assert.equal(
      await dialog.getByLabel("Session ID", { exact: true }).inputValue(),
      resumeId,
    );
  }
  await dialog
    .getByLabel("Provider", { exact: true })
    .selectOption({ label: "Custom API" });
  await dialog
    .getByLabel("API URL", { exact: true })
    .fill(gateway.origin + (backend === "cc" ? "" : "/v1"));
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("fixture-private-key");
  await dialog.getByLabel("Custom model", { exact: true }).fill("PrivateModel");
  if (!resumeId) {
    await dialog.getByText("More", { exact: true }).click();
    await dialog
      .getByLabel("Working directory", { exact: true })
      .fill(workspace);
  }
  return dialog;
}
async function launchBrowser(backend: string, name: string, resumeId?: string) {
  const dialog = await newDialog(backend, name, resumeId);
  await dialog
    .getByRole("button", {
      name: resumeId ? "Resume agent" : "Create agent",
      exact: true,
    })
    .click();
  await dialog.waitFor({ state: "hidden", timeout: 60000 });
  const catalog = await nativeRuntime.request("/api/sessions");
  const native = catalog.sessions.find((row: any) => row.alias === name);
  assert.ok(native, "Browser launch registered the named native broker");
  await selectBrowserSession(name);
  return native.session_id as string;
}
async function terminalTurn(id: string, text: string) {
  const socket = connect(socketPath(nativeRuntime.stateHome, id));
  await new Promise<void>((resolve, reject) => {
    socket.once("connect", resolve);
    socket.once("error", reject);
  });
  socket.resume();
  socket.write(JSON.stringify({ operation: "attach" }) + "\n");
  socket.write(
    JSON.stringify({ type: "input", data: "\x1b[200~" + text + "\x1b[201~" }) +
      "\n",
  );
  await new Promise((resolve) => setTimeout(resolve, 100));
  socket.write(JSON.stringify({ type: "input", data: "\r" }) + "\n");
  await until(
    async () =>
      (
        await nativeRuntime.request(`/api/sessions/${id}/messages/tail`)
      ).events.some((e: any) => e.text === "PRIVATE_PROVIDER_OK"),
    60000,
  );
  socket.end();
  await new Promise<void>((resolve) => socket.once("close", resolve));
}
try {
  await service.start();
  await until(() => tunnels.supports(computer.computer.id, "provider-launch"));
  await until(async () => {
    try {
      return (await fetch(clientOrigin + "/health")).ok;
    } catch {
      return false;
    }
  });
  await page.goto(clientOrigin + "/health");
  const accessToken = await authority.tokens.issue(
    identitySession,
    origin,
    "identity_access",
  );
  // Genuine fixture-issued credentials isolate this lifecycle acceptance from login acceptance.
  await page.evaluate(
    async (login: any) => {
      const db = await new Promise<IDBDatabase>((resolve, reject) => {
        const request = indexedDB.open("codoxear-client-identities", 1);
        request.onupgradeneeded = () =>
          request.result.createObjectStore("credentials");
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      await new Promise<void>((resolve, reject) => {
        const tx = db.transaction("credentials", "readwrite");
        tx.objectStore("credentials").put(login, login.id);
        tx.oncomplete = () => resolve();
        tx.onerror = () => reject(tx.error);
      });
      db.close();
    },
    {
      id: "lifecycle-login",
      accountKey: "lifecycle-account",
      origin,
      hubId: computer.computer.hubId,
      name: "Runtime test",
      accountId: "alice",
      accessToken,
      refreshToken: "fixture-refresh-unused".repeat(2),
      expiresAt: Date.now() + 600000,
      identity: { name: "Alice", method: "password", key: "alice" },
    },
  );
  await page.goto(clientOrigin);
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  for (const backend of ["pi", "cc"]) {
    const id = await launchBrowser(backend, "Saved " + backend);
    await ready(id);
    await browserSend("First lifecycle turn " + backend);
    const original = await nativeState(id);
    assert.ok(original.thread_id);
    assert.ok(original.log_path);
    await nativeRuntime.request(`/api/sessions/${id}/delete`, "POST");
    await until(
      async () =>
        !(await nativeRuntime.request("/api/sessions")).sessions.some(
          (r: any) => r.session_id === id,
        ),
    );
    const resumedId = await launchBrowser(
      backend,
      "Resumed " + backend,
      original.thread_id,
    );
    await ready(resumedId);
    await page
      .getByText("PRIVATE_PROVIDER_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    await browserSend("Resumed lifecycle turn " + backend, 2);
    const resumed = await nativeState(resumedId);
    assert.equal(resumed.thread_id, original.thread_id);
    assert.equal(resumed.log_path, original.log_path);
    evidence.push({
      scenario: "saved-resume",
      backend,
      id: resumedId,
      thread: resumed.thread_id,
      log: resumed.log_path,
    });
    pass(
      backend +
        ": browser saved-session picker resumes real CLI history and accepts another turn",
    );
  }
  for (const backend of ["codex", "cc"] as const) {
    const created = await nativeRuntime.createTerminal(
      backend,
      "Terminal " + backend,
      {
        cwd: workspace,
        model: "PrivateModel",
        provider_config: {
          base_url: gateway.origin + (backend === "cc" ? "" : "/v1"),
          api_key: "fixture-private-key",
        },
      },
    );
    await ready(created.localId);
    await terminalTurn(created.localId, "Terminal lifecycle turn " + backend);
    const original = await nativeState(created.localId);
    await page.goto(clientOrigin);
    await page
      .getByRole("button", { name: "Hubs & computers", exact: true })
      .first()
      .click();
    const connections = page.getByRole("dialog", {
      name: "Hubs & computers",
      exact: true,
    });
    await connections
      .locator(".connectionHub")
      .filter({ hasText: "Runtime test" })
      .locator("summary")
      .click();
    await connections
      .getByRole("button")
      .filter({ has: page.getByText("Native backends", { exact: true }) })
      .click();
    await page
      .getByRole("button", { name: "Import local session", exact: true })
      .click();
    const dialog = page.getByRole("dialog", {
      name: "Import a local session",
      exact: true,
    });
    await dialog.getByLabel(/^Local session/).selectOption(created.localId);
    await dialog
      .getByLabel("Agent name", { exact: true })
      .fill("Imported " + backend);
    await dialog
      .getByRole("button", { name: "Import session", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden" });
    await selectBrowserSession("Terminal " + backend);
    await page
      .getByText("PRIVATE_PROVIDER_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    await page
      .getByText("Terminal lifecycle turn " + backend, { exact: true })
      .waitFor();
    assert.equal((await nativeState(created.localId)).pid, original.pid);
    pass(
      backend +
        ": actual terminal PTY turn imported through browser without replacing native session",
    );
    const heldPrompt =
      "Held browser turn " +
      backend +
      (backend === "cc" ? "\nSecond line of owned prompt" : "");
    const beforeHeldTail = (await nativeState(created.localId)).tail as string;
    gateway.holdNext(
      backend === "codex" ? "/responses" : "/messages",
      backend === "cc" ? heldPrompt : undefined,
    );
    await page.getByLabel("Message", { exact: true }).fill(heldPrompt);
    await clickBrowserSend();
    await until(() => gateway.requests.some((r) => r.held && !r.aborted));
    await until(async () => (await nativeState(created.localId)).busy === true);
    if (backend === "cc") {
      await new Promise((resolve) => setTimeout(resolve, 700));
      const busyTail = (await nativeState(created.localId)).tail as string;
      const suffix = beforeHeldTail.slice(-1000);
      const offset = busyTail.indexOf(suffix);
      assert.ok(offset >= 0, "busy terminal trace retains its starting suffix");
      const busyTitles = [
        ...busyTail
          .slice(offset + suffix.length)
          .matchAll(/\x1b\]0;([^\x07]*)\x07/g),
      ].map((match) => match[1]!);
      assert.ok(busyTitles.length > 0);
      assert.ok(
        busyTitles.every((title) => /^[◐◑]/.test(title)),
        "foreground busy title animation never uses idle star",
      );
      evidence.push({ scenario: "claude-held-title-proof", busyTitles });
    }
    const heldRequests = gateway.requests.length;
    await assert.rejects(
      nativeRuntime.sendQueued(created.localId, "QUEUED_WHILE_NATIVE_BUSY"),
      (error: any) =>
        error.status === 409 && error.code === "queue_not_dispatched",
    );
    assert.equal(gateway.requests.length, heldRequests);
    assert.equal(
      (
        await nativeRuntime.request(
          `/api/sessions/${created.localId}/messages/tail`,
        )
      ).events.some((e: any) => e.text === "QUEUED_WHILE_NATIVE_BUSY"),
      false,
    );
    await page
      .getByRole("button", { name: "Interrupt (Esc)", exact: true })
      .click();
    await until(
      () => gateway.requests.filter((r) => r.held).every((r) => r.aborted),
      15000,
    );
    await until(
      async () => (await nativeState(created.localId)).busy === false,
      15000,
    );
    const interrupted = await nativeRuntime.request(
      `/api/sessions/${created.localId}/messages/tail`,
    );
    assert.equal(interrupted.turn_aborted, true);
    evidence.push({
      scenario: "terminal-import-interrupt",
      backend,
      id: created.localId,
      thread: original.thread_id,
      events: interrupted.events,
      boundaries: interrupted.turn_boundaries,
    });
    await browserSend("After interrupt " + backend, 2);
    const afterInterrupt = await nativeRuntime.request(
      `/api/sessions/${created.localId}/messages/tail`,
    );
    assert.equal(
      afterInterrupt.events.filter((event: any) => event.role === "user").at(-1)
        .text,
      "After interrupt " + backend,
      "the canceled owned prompt is not concatenated with the next message",
    );
    pass(
      backend +
        ": browser interrupt cancels held real provider request, reaches idle and accepts next turn",
    );
  }
  const before = (await nativeRuntime.request("/api/sessions")).sessions.map(
    (r: any) => ({
      id: r.session_id,
      pid: r.pid,
      broker: r.broker_pid,
      thread: r.thread_id,
    }),
  );
  await service.stop();
  await until(() => !tunnels.online(computer.computer.id));
  for (const row of before)
    assert.equal((await nativeState(row.id)).pid, row.pid);
  service = api.service();
  await service.start();
  await until(() => tunnels.supports(computer.computer.id, "provider-launch"));
  for (const row of before) {
    const current = await nativeState(row.id);
    assert.equal(current.pid, row.pid);
    assert.equal(current.broker_pid, row.broker);
    assert.equal(current.thread_id, row.thread);
  }
  await page.reload();
  await page
    .getByText("PRIVATE_PROVIDER_OK", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await browserSend("After Computer service restart", 3);
  evidence.push({ scenario: "computer-restart", sessions: before });
  pass(
    "Computer service restart retains broker/CLI PIDs, native identities and browser transcript; another turn succeeds",
  );
  tunnels.disconnect(computer.computer.id, "Controlled acceptance disconnect");
  await until(
    () => tunnels.supports(computer.computer.id, "provider-launch"),
    15000,
  );
  await page.reload();
  await page
    .getByText("PRIVATE_PROVIDER_OK", { exact: true })
    .first()
    .waitFor({ timeout: 30000 });
  await browserSend("After tunnel reconnect", 4);
  for (const row of before)
    assert.equal((await nativeState(row.id)).pid, row.pid);
  pass(
    "Computer tunnel reconnect preserves actual CLI sessions and browser can continue",
  );
  // An untrusted resume uses a genuine saved Codex log and actual installed Codex.
  const codex = (await nativeRuntime.request("/api/sessions")).sessions.find(
    (r: any) => r.agent_backend === "codex",
  );
  assert.ok(codex);
  const codexThread = codex.thread_id;
  await nativeRuntime.request(
    `/api/sessions/${codex.session_id}/delete`,
    "POST",
  );
  await until(
    async () =>
      !(await nativeRuntime.request("/api/sessions")).sessions.some(
        (r: any) => r.session_id === codex.session_id,
      ),
  );
  await writeFile(
    join(home, ".codex", "config.toml"),
    "# Fixture intentionally has no workspace trust.\n",
  );
  const untrustedId = await launchBrowser(
    "codex",
    "Untrusted resumed Codex",
    codexThread,
  );
  await until(
    async () => (await nativeState(untrustedId)).readiness === "setup_required",
    60000,
  );
  const untrusted = await nativeState(untrustedId);
  const configBeforeFirstPrompt = readFileSync(
    join(home, ".codex", "config.toml"),
    "utf8",
  );
  assert.doesNotMatch(
    configBeforeFirstPrompt,
    /trust_level\s*=\s*["']trusted["']/,
  );
  const requestsBefore = gateway.requests.length;
  await page
    .getByLabel("Message", { exact: true })
    .fill("UNTRUSTED_RESUME_FIRST_PROMPT");
  await clickBrowserSend();
  await page.getByText(/Codex setup required:/).waitFor();
  assert.equal(
    await page.getByLabel("Message", { exact: true }).inputValue(),
    "UNTRUSTED_RESUME_FIRST_PROMPT",
  );
  assert.equal(gateway.requests.length, requestsBefore);
  assert.equal(
    readFileSync(join(home, ".codex", "config.toml"), "utf8"),
    configBeforeFirstPrompt,
  );
  assert.match(untrusted.setup_message, /local terminal/);
  assert.equal(
    (
      await nativeRuntime.request(`/api/sessions/${untrustedId}/messages/tail`)
    ).events.some((e: any) => e.text === "UNTRUSTED_RESUME_FIRST_PROMPT"),
    false,
  );
  evidence.push({
    scenario: "untrusted-resume",
    readiness: untrusted.readiness,
    setupMessage: untrusted.setup_message,
    configBeforeFirstPrompt,
    tail: untrusted.tail,
  });
  pass(
    "Untrusted Codex resume rejects first browser prompt with actionable local trust setup; preserves text, sends no inference and never autoaccepts trust",
  );
  passed = true;
} catch (error) {
  console.error(error);
  console.error("BROWSER ERRORS", browserErrors);
  console.error(
    "BROWSER STATE",
    (await page.locator("body").innerText()).slice(-8000),
  );
  const debug = [];
  for (const row of (await nativeRuntime.request("/api/sessions")).sessions) {
    const state = await nativeState(row.session_id);
    debug.push({
      state,
      log: row.log_path
        ? readFileSync(row.log_path, "utf8").slice(-16000)
        : null,
    });
    console.error(
      "NATIVE STATE",
      row.alias,
      row.agent_backend,
      state.readiness,
      "busy:",
      state.busy,
    );
  }
  await writeFile(artifact + "-debug.json", JSON.stringify(debug, null, 2));
  await page.screenshot({ path: artifact + "-failure.png", fullPage: true });
  throw error;
} finally {
  await writeFile(
    artifact + "-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        evidence,
        browserErrors,
        gateway: gateway.requests,
        limitations: [
          "Controlled inference responses and fixture credentials only; no hosted provider or private user keys",
          "Workspace trust and Claude onboarding remain deliberate local CLI setup; this app never accepts those decisions",
        ],
      },
      null,
      2,
    ),
  );
  staticClient.kill("SIGTERM");
  await browser.close();
  nativeRuntime.close();
  await gateway.close();
  tunnels.close();
  await Promise.race([
    service
      .stop()
      .then(() => hub.close())
      .then(() => identity.close()),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  notifications.close();
  sessions.close();
  store.close();
  process.exit(passed ? 0 : 1);
}
