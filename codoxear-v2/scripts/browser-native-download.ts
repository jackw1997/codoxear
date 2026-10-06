import { connect } from "node:net";
import { socketPath } from "../src/computer/native/paths.js";
import { independentAuthority } from "../src/hub/independent.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
/** Docker-only installed CLI lifecycle acceptance with controlled inference and fixture credentials. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, createReadStream } from "node:fs";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, writeFile, open, stat } from "node:fs/promises";
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
const home = await mkdtemp(join(tmpdir(), "native-download-")),
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
  createComputer(
    s,
    "alice",
    createHub(s, "alice", "Runtime test").id,
    "Native backends",
    "alice",
  ),
);
const origin = "http://127.0.0.1:19944",
  clientOrigin = "http://127.0.0.1:19945";
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
hub.addHook('onError',async (request,_reply,error)=>{if(request.url.includes('/downloads/')) console.error('HANDOFF ERROR',error);});
await hub.listen({ host: "127.0.0.1", port: 19944 });
const api = createComputerApi(join(home, "computer"));
await api.attach({
  version: 1,
  hubUrl: "http://127.0.0.1:19944",
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
  ["dist/server/client/web-server.js"],
  { env: { ...process.env, CODOXEAR_CLIENT_PORT: "19945" }, stdio: "ignore" },
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
page.on('response', async (response:any) => {
  if (response.url().includes('/downloads/') && response.status() >= 400)
    console.error('DOWNLOAD ERROR', response.status(), response.url(), await response.text().catch(()=>''));
});
const pass = (text: string) => {
  checks.push(text);
  console.log("PASS", text);
};
let passed = false;
await mkdir("artifacts", { recursive: true });
const evidence: Record<string, unknown>[] = [];
const artifact = `artifacts/browser-native-download-${Date.now()}`;
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
  // Genuine fixture-issued credentials isolate this download acceptance from login acceptance.
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
      id: "download-login",
      accountKey: "download-account",
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
  const size = 257 * 1024 * 1024 + 37;
  const file = await open(join(workspace, 'large.bin'), 'wx', 0o600);
  await file.truncate(size); await file.write(Buffer.from('large download integrity'),0,24,size-24); await file.close();
  async function hash(path: string) { const value=createHash('sha256'); for await(const chunk of createReadStream(path)) value.update(chunk); return value.digest('hex'); }
  const expected=await hash(join(workspace,'large.bin'));
  const id=await launchBrowser('pi','Large downloads'); await ready(id);
  await browserSend('First download conversation');
  await page.getByRole('button',{name:'View file',exact:true}).click();
  await page.locator('#fileStatus').filter({hasText:'large.bin'}).waitFor();
  await page.locator('#fileDownloadBtn').waitFor({state:'visible'});
  const handoffs: string[]=[]; page.on('request',(request:any)=>{if(request.url().includes('/downloads/')) handoffs.push(request.url());});
  const [downloaded]=await Promise.all([page.waitForEvent('download',{timeout:60000}),page.locator('#fileDownloadBtn').click()]);
  const result=join(home,'download-result.bin'); await downloaded.saveAs(result);
  assert.equal(await downloaded.failure(),null); assert.equal((await stat(result)).size,size); assert.equal(await hash(result),expected);
  assert.equal(new URL(page.url()).origin,clientOrigin); assert.equal(await page.locator('#threadTitle').isVisible(),true);
  assert.ok(handoffs.every(url=>!/[?&](ticket|token|access_token)=/.test(url)));
  pass('Normal browser Download streams 257 MiB intact through independent Hub without navigating or buffering the application');
  await page.locator('#fileViewer').getByRole('button',{name:'Close',exact:true}).click();
  await browserSend('After large download conversation',2);
  pass('Mounted conversation sends and receives after large browser download');
  passed=true;
} catch(error) { await page.screenshot({path:artifact+'-failure.png',fullPage:true}); console.error(error); throw error; }
 finally {
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
          "Desktop Chromium acceptance; physical Safari/mobile remains external",
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
