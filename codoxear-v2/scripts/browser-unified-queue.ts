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
  createComputer,
  passwordHash,
  secret,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "unified-queue-")),
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
const gateway = await backendGateway(19831);
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
  createComputer(
    s,
    "alice",
    createHub(s, "alice", "Queue test").id,
    "Native backends",
    "alice",
  ),
);
const origin = "http://127.0.0.1:19754",
  clientOrigin = "http://127.0.0.1:19755";
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
await hub.listen({ host: "127.0.0.1", port: 19754 });
const api = createComputerApi(join(home, "computer"));
await api.attach({
  version: 1,
  hubUrl: "http://127.0.0.1:19754",
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
  { env: { ...process.env, CODOXEAR_CLIENT_PORT: "19755" }, stdio: "ignore" },
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
const artifact = `artifacts/browser-unified-queue-${Date.now()}`;
async function nativeState(id: string) {
  return nativeRuntime.request(`/api/sessions/${id}/state`);
}
async function ready(id: string) {
  await until(async () => (await nativeState(id)).readiness === "ready", 60000);
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
      name: "Queue test",
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
  const created = await nativeRuntime.createTerminal("pi", "Unified queue Pi", {
    cwd: workspace,
    model: "PrivateModel",
    provider_config: {
      base_url: gateway.origin + "/v1",
      api_key: "fixture-private-key",
    },
  });
  await ready(created.localId);
  const original = await nativeState(created.localId);
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
    .filter({ hasText: "Queue test" })
    .locator("summary")
    .click();
  await connections
    .getByRole("button")
    .filter({ has: page.getByText("Native backends", { exact: true }) })
    .click();
  await page
    .getByRole("button", { name: "Import local session", exact: true })
    .click();
  const importing = page.getByRole("dialog", {
    name: "Import a local session",
    exact: true,
  });
  await importing.getByLabel(/^Local session/).selectOption(created.localId);
  await importing
    .getByLabel("Agent name", { exact: true })
    .fill("Unified queue Pi");
  await importing
    .getByRole("button", { name: "Import session", exact: true })
    .click();
  await importing.waitFor({ state: "hidden" });
  await selectBrowserSession("Unified queue Pi");
  pass(
    "Browser imports the installed Pi terminal PTY without replacing its native identity",
  );
  gateway.holdNext("/chat/completions", "Hold the real Pi turn");
  await page
    .getByLabel("Message", { exact: true })
    .fill("Hold the real Pi turn");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await until(() => gateway.requests.some((request) => request.held === true));
  await nativeRuntime.queueControl(created.localId, "enqueue", {
    text: "Local second prompt",
  });
  await page.getByLabel("Message", { exact: true }).fill("Remote prompt");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const enqueued = page.waitForResponse(
    (response: any) =>
      response.url().endsWith("/enqueue") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Send after current", exact: true })
    .click();
  assert.equal((await enqueued).status(), 200);
  await page.getByRole("button", { name: /Queued messages/ }).click();
  const queueDialog = page.getByRole("dialog", {
    name: "Queued messages",
    exact: true,
  });
  const queueTexts = queueDialog.getByRole("textbox");
  await until(async () => (await queueTexts.count()) === 2);
  assert.deepEqual(
    await queueTexts.evaluateAll((nodes: HTMLTextAreaElement[]) =>
      nodes.map((node) => node.value),
    ),
    ["Local second prompt", "Remote prompt"],
  );
  pass(
    "Genuine browser queue lists local and remote items in one broker-owned order",
  );
  const moved = page.waitForResponse(
    (response: any) =>
      response.url().endsWith("/queue/move") &&
      response.request().method() === "POST",
  );
  await queueDialog
    .getByRole("button", { name: "Move up", exact: true })
    .nth(1)
    .click();
  assert.equal((await moved).status(), 200);
  await until(
    async () => (await queueTexts.nth(0).inputValue()) === "Remote prompt",
  );
  const updated = page.waitForResponse(
    (response: any) =>
      response.url().endsWith("/queue/update") &&
      response.request().method() === "POST",
  );
  await queueTexts.nth(0).fill("Browser edited remote prompt");
  assert.equal((await updated).status(), 200);
  const remoteHead = (
    await nativeRuntime.queueControl(created.localId, "queue")
  ).items[0];
  await nativeRuntime.queueControl(created.localId, "queue/update", {
    id: remoteHead.id,
    version: remoteHead.version,
    text: "Terminal edited remote prompt",
  });
  await queueDialog.getByRole("button", { name: "Close", exact: true }).click();
  await page.getByRole("button", { name: /Queued messages/ }).click();
  await until(
    async () =>
      (await queueTexts.nth(0).inputValue()) ===
      "Terminal edited remote prompt",
  );
  pass(
    "Browser move/edit and local terminal edit reconcile through the same ordered versioned queue",
  );
  await queueDialog.getByRole("button", { name: "Close", exact: true }).click();
  await service.stop();
  service = api.service();
  await service.start();
  await until(() => tunnels.supports(computer.computer.id, "provider-launch"));
  assert.equal((await nativeState(created.localId)).pid, original.pid);
  assert.equal(
    (await nativeRuntime.queueControl(created.localId, "queue")).items.length,
    2,
  );
  pass(
    "Computer service restart preserves both queue origins and the actual installed Pi process",
  );
  await page
    .getByRole("button", { name: "Interrupt (Esc)", exact: true })
    .click();
  await until(async () => {
    const events = (
      await nativeRuntime.request(
        `/api/sessions/${created.localId}/messages/tail`,
      )
    ).events;
    return events.filter((event: any) => event.role === "user").length === 3;
  }, 60000);
  const finalState = await nativeState(created.localId);
  const users = (
    await nativeRuntime.request(
      `/api/sessions/${created.localId}/messages/tail`,
    )
  ).events
    .filter((event: any) => event.role === "user")
    .map((event: any) => event.text);
  assert.deepEqual(users, [
    "Hold the real Pi turn",
    "Terminal edited remote prompt",
    "Local second prompt",
  ]);
  assert.equal(finalState.pid, original.pid);
  await until(
    async () =>
      (await nativeRuntime.queueControl(created.localId, "queue")).items
        .length === 0,
  );
  pass(
    "After real provider cancellation the current authorized remote head and local successor dispatch once in the chosen order",
  );
  await page.screenshot({ path: artifact + ".png", fullPage: true });
  passed = true;
} catch (error) {
  console.error(error);
  console.error((await page.locator("body").innerText()).slice(-8000));
  await page.screenshot({ path: artifact + "-failure.png", fullPage: true });
} finally {
  await writeFile(
    "artifacts/browser-unified-queue-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        browserErrors,
        gateway: gateway.requests,
        limitations: [
          "Installed Pi with controlled provider responses and fixture-issued browser credentials",
          "Real-device and live private provider acceptance remain separate",
        ],
      },
      null,
      2,
    ),
  );
  for (const row of (await nativeRuntime.request("/api/sessions")).sessions)
    await nativeRuntime
      .request(`/api/sessions/${row.session_id}/delete`, "POST", {})
      .catch(() => {});
  staticClient.kill("SIGTERM");
  await browser.close();
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
