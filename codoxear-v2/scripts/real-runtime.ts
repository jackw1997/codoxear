import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
/** Runs the installed Pi CLI and native TypeScript broker in Docker. The model endpoint is scripted,
 * so this proves real process/tool execution, not live inference acceptance. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  symlink,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import Fastify from "fastify";
import type { Socket } from "node:net";
import { Store } from "../src/persistence/store.js";
import { createHubApp } from "../src/hub/app.js";
import { createIdentityApp } from "../src/identity/app.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { NotificationInbox } from "../src/hub/notifications.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import {
  createHub,
  createComputer,
  invite,
  acceptInvite,
  setPolicy,
  removeMember,
  passwordHash,
  secret,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "real-cli-")),
  workspace = join(home, "workspace"),
  pi = join(home, ".pi", "agent");
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
await mkdir(pi, { recursive: true });
await writeFile(
  join(pi, "models.json"),
  JSON.stringify({
    providers: {
      fixture: {
        baseUrl: "http://127.0.0.1:19820/v1",
        api: "openai-completions",
        apiKey: "fixture-only",
        models: [
          {
            id: "fixture",
            name: "Scripted verification",
            reasoning: false,
            input: ["text"],
            contextWindow: 32000,
            maxTokens: 2048,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
          },
          {
            id: "fixture-alt",
            name: "Alternate verification",
            reasoning: true,
            input: ["text"],
            contextWindow: 32000,
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
const provider = Fastify();
let requests = 0;
let finishSlowTurn: (() => void) | undefined;
let finishInterruptedTurn: (() => void) | undefined;
let interruptedProviderClosed = false;
provider.post("/v1/chat/completions", async (r, reply) => {
  requests++;
  if (requests === 3)
    await new Promise<void>((resolve) => {
      finishSlowTurn = resolve;
    });
  const b = r.body as { messages: Array<{ role: string; content?: unknown }> };
  if (
    JSON.stringify(b.messages.at(-1)?.content).includes("INTERRUPT_NATIVE_TURN")
  ) {
    await new Promise<void>((resolve) => {
      finishInterruptedTurn = resolve;
      reply.raw.once("close", () => {
        interruptedProviderClosed = true;
        resolve();
      });
    });
    return reply.code(499).send({ error: "Interrupted fixture request" });
  }
  const hasTool = b.messages.some((m) => m.role === "tool");
  const delta = hasTool
    ? { content: "Verified actual Pi tool execution across the hub outage." }
    : {
        tool_calls: [
          {
            index: 0,
            id: "call_verify",
            type: "function",
            function: {
              name: "bash",
              arguments: JSON.stringify({
                command:
                  "sleep 5; printf real-pi-tool-executed > proof.txt; printf changed-line > tracked.txt",
                timeout: 15,
              }),
            },
          },
        ],
      };
  reply.type("text/event-stream");
  const chunk = (delta: unknown, finish_reason: string | null) =>
    JSON.stringify({
      id: "fixture-" + requests,
      object: "chat.completion.chunk",
      created: Math.floor(Date.now() / 1000),
      model: "fixture",
      choices: [{ index: 0, delta, finish_reason }],
    });
  return (
    "data: " +
    chunk({ role: "assistant", ...delta }, null) +
    "\n\ndata: " +
    chunk({}, hasTool ? "stop" : "tool_calls") +
    "\n\ndata: [DONE]\n\n"
  );
});
await provider.listen({ host: "127.0.0.1", port: 19820 });
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
const ownedSessionIds = new Set<string>();
const ownedHubConnections = new Set<Socket>();
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
    "Real Pi",
    "alice",
  ),
);
const issuer = "http://127.0.0.1:19740",
  origin = "http://127.0.0.1:19744",
  accounts = new Accounts(store, secret(), { async send() {} }),
  authority = new Authority(
    store,
    accounts,
    new Tokens(issuer, await signingKey()),
  ),
  identitySession = accounts.password(
    "alice@test.invalid",
    "isolated-password",
    "test",
  ).session,
  registration = authority.registerHub(
    identitySession,
    computer.computer.hubId,
    origin,
  ),
  sessions = new HubSessions(join(home, "hub.sqlite")),
  identity = await createIdentityApp({ authority, secureCookies: false });
await identity.listen({ host: "127.0.0.1", port: 19740 });
const client = new AuthorityClient(
  issuer,
  registration.hubId,
  registration.credential,
);
const notifications = new NotificationInbox(
  join(home, "notifications.sqlite"),
  registration.hubId,
  async (sessionId, agentId, computerId, binding) => {
    authority.authorizeNotification(
      registration.hubId,
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
    authority: client,
    notifications,
    sessions,
    tunnels,
    secureCookies: false,
  });
function trackHubConnections() {
  hub.server.on("connection", (socket) => {
    ownedHubConnections.add(socket);
    socket.once("close", () => ownedHubConnections.delete(socket));
  });
}
trackHubConnections();
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
const service = api.service();
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
page.setDefaultTimeout(20000);
try {
  await until(async () => {
    try {
      await nativeRuntime.execute({ op: "discover" });
      return true;
    } catch {
      return false;
    }
  });
  await service.start();
  await until(() => tunnels.online(computer.computer.id));
  const created = (await tunnels.request(computer.computer.id, {
    op: "create",
    agentId: "real-agent",
    backend: "pi",
    name: "Real process",
  })) as { localId: string };
  assert.ok(created.localId);
  ownedSessionIds.add(created.localId);
  console.log("PASS actual Pi process discovered:", created.localId);
  await until(
    async () =>
      (await nativeRuntime.request(`/api/sessions/${created.localId}/state`))
        .readiness === "ready",
  );
  await page.goto(issuer);
  await page.getByLabel("Email", { exact: true }).fill("alice@test.invalid");
  await page.getByLabel("Password", { exact: true }).fill("isolated-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.goto(origin);
  await page.getByRole("link", { name: "Sign in to your account" }).click();
  await page.goto(origin + "/?settings=");
  await page.getByRole("button", { name: "Import local session" }).click();
  await page.getByLabel("Agent name").fill("Actual Pi session");
  await page
    .getByRole("button", { name: "Import session", exact: true })
    .click();
  await page
    .locator("[data-agent]")
    .filter({ hasText: "Actual Pi session" })
    .click();
  await page
    .getByLabel("Message", { exact: true })
    .fill("Run the verification tool and report the result.");
  const firstSend = page.waitForResponse(
    (r: any) => r.url().endsWith("/send") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const firstSendResponse = await firstSend;
  assert.equal(firstSendResponse.status(), 200, await firstSendResponse.text());
  await until(() => requests >= 1);
  console.log(
    "PASS browser imports the existing local Pi session and sends a prompt",
  );
  // Destroy and recreate the hub while the actual shell tool is sleeping.
  await hub.close();
  await until(
    async () =>
      (await readFile(join(workspace, "proof.txt"), "utf8").catch(() => "")) ===
      "real-pi-tool-executed",
  );
  console.log("PASS real Pi bash tool completed while the hub was stopped");
  tunnels = new Tunnels();
  hub = await createHubApp({
    origin,
    authority: client,
    notifications,
    sessions,
    tunnels,
    secureCookies: false,
  });
  trackHubConnections();
await hub.listen({ host: "127.0.0.1", port: 19744 });
  await until(() => tunnels.online(computer.computer.id));
  await until(async () => {
    const result = (await tunnels.request(computer.computer.id, {
      op: "messages",
      agentId: "real-agent",
      localId: created.localId,
    })) as { messages: Array<{ text: string }> };
    return result.messages.some((m) => m.text.includes("Verified actual Pi"));
  });
  await until(() => notifications.counts().events > 0);
  console.log(
    "PASS durable completion hint reaches the hub after outage recovery",
  );
  await page
    .locator(".message.assistant, .bubble.assistant")
    .filter({ hasText: "Verified actual Pi" })
    .waitFor();
  await page.screenshot({
    path: "/work/artifacts/05-real-pi-browser.png",
    fullPage: true,
  });
  const workspacePage = await context.newPage();
  const browserErrors: string[] = [];
  workspacePage.setDefaultTimeout(10000);
  workspacePage.on("response", async (r: any) => {
    if (r.status() >= 400)
      console.log("WORKSPACE HTTP", r.status(), new URL(r.url()).pathname);
  });
  workspacePage.on("pageerror", (e: any) =>
    browserErrors.push(e.stack ?? e.message),
  );
  await workspacePage.goto(
    origin + "/api/v1/computers/" + computer.computer.id + "/",
  );
  await workspacePage
    .getByText("Verified actual Pi tool execution across the hub outage.", {
      exact: true,
    })
    .waitFor();
  console.log(
    "PASS full workspace renders the real Pi transcript through the streaming relay",
  );
  await workspacePage
    .getByRole("button", { name: "View file", exact: true })
    .click();
  await workspacePage
    .locator("#fileViewer")
    .getByText("changed-line", { exact: true })
    .first()
    .waitFor();
  await workspacePage
    .locator("#fileViewer")
    .getByText("original line", { exact: true })
    .first()
    .waitFor();
  console.log("PASS browser git diff shows original and modified file content");
  await workspacePage
    .getByPlaceholder("Choose or search files")
    .fill("proof.txt");
  await workspacePage
    .getByRole("option")
    .filter({ hasText: "proof.txt" })
    .first()
    .click();
  await workspacePage
    .locator("#fileViewer")
    .getByText("real-pi-tool-executed", { exact: true })
    .waitFor();
  console.log("PASS browser reads an actual computer file through the hub");
  const downloading = workspacePage.waitForEvent("download");
  await workspacePage
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  const downloaded = await downloading;
  assert.equal(
    await readFile(await downloaded.path(), "utf8"),
    "real-pi-tool-executed",
  );
  console.log("PASS normal browser download preserves file bytes");
  await workspacePage
    .getByRole("button", { name: "Edit file", exact: true })
    .click();
  await workspacePage.keyboard.press("Control+A");
  await workspacePage.keyboard.press("Backspace");
  await workspacePage.keyboard.type("edited through the hub");
  await workspacePage
    .getByRole("button", { name: "Save file", exact: true })
    .click();
  await until(
    async () =>
      (await readFile(join(workspace, "proof.txt"), "utf8")) ===
      "edited through the hub",
  );
  console.log("PASS normal browser editor saves the actual computer file");
  await workspacePage
    .getByRole("button", { name: "Edit file", exact: true })
    .click();
  await workspacePage.keyboard.press("Control+A");
  await workspacePage.keyboard.press("Backspace");
  await workspacePage.keyboard.type("unsaved browser draft");
  await writeFile(join(workspace, "proof.txt"), "external disk update");
  const conflictedSave = workspacePage.waitForResponse(
    (r: any) =>
      r.url().endsWith("/file/write") && r.request().method() === "POST",
  );
  await workspacePage
    .getByRole("button", { name: "Save file", exact: true })
    .click();
  assert.equal((await conflictedSave).status(), 409);
  assert.equal(
    await readFile(join(workspace, "proof.txt"), "utf8"),
    "external disk update",
  );
  await workspacePage.getByText(/save conflict:/).waitFor();
  await workspacePage.screenshot({
    path: "/work/artifacts/native-file-conflict.png",
    fullPage: true,
  });
  await workspacePage
    .getByRole("button", { name: "Reload from disk", exact: true })
    .click();
  await workspacePage
    .getByRole("dialog", { name: "Reload file from disk?", exact: true })
    .getByRole("button", { name: "Reload", exact: true })
    .click();
  await workspacePage
    .locator("#fileViewer")
    .getByText("external disk update", { exact: true })
    .first()
    .waitFor();
  console.log(
    "PASS native browser CAS conflict preserves the external file and reloads authoritative disk content",
  );
  await workspacePage
    .locator("#fileViewer")
    .getByRole("button", { name: "Close", exact: true })
    .click();
  const discardChanges = workspacePage.getByRole("button", {
    name: "Discard",
    exact: true,
  });
  if (await discardChanges.isVisible()) await discardChanges.click();
  await workspacePage
    .getByRole("button", { name: "Search conversation", exact: true })
    .click();
  await workspacePage
    .getByRole("searchbox", { name: "Search conversation", exact: true })
    .fill("Verified");
  await workspacePage
    .locator("#chatSearchStatus")
    .filter({ hasText: "1" })
    .waitFor();
  console.log("PASS browser searches the relayed transcript");
  await workspacePage.screenshot({
    path: "/work/artifacts/06-workspace.png",
    fullPage: true,
  });
  assert.deepEqual(
    browserErrors,
    [],
    "Workspace must not emit uncaught errors",
  );
  assert.equal(requests, 2, "No duplicate model/tool turn after reconnect");
  console.log(
    "PASS relayed transcript reconnects to the same actual Pi session, without replay",
  );
  await workspacePage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Start a slow turn to verify the queue.");
  await workspacePage
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await until(() => !!finishSlowTurn);
  await workspacePage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Queued after the slow turn.");
  await workspacePage
    .getByRole("button", { name: "Send", exact: true })
    .click();
  const enqueued = workspacePage.waitForResponse(
    (r: any) => r.url().endsWith("/enqueue") && r.request().method() === "POST",
  );
  await workspacePage
    .getByRole("button", { name: "Send after current", exact: true })
    .click();
  assert.equal((await enqueued).status(), 200);
  await workspacePage.getByRole("button", { name: /Queued messages/ }).click();
  const queuedText = workspacePage
    .getByRole("dialog", { name: "Queued messages", exact: true })
    .getByRole("textbox");
  await queuedText.waitFor();
  assert.equal(await queuedText.inputValue(), "Queued after the slow turn.");
  await workspacePage
    .getByRole("dialog", { name: "Queued messages", exact: true })
    .getByText("Waiting for the current turn or terminal input", { exact: true })
    .waitFor();
  const updated = workspacePage.waitForResponse(
    (r: any) =>
      r.url().endsWith("/queue/update") && r.request().method() === "POST",
  );
  await queuedText.fill("Edited queued prompt.");
  assert.equal((await updated).status(), 200);
  assert.equal(
    requests,
    3,
    "Queue does not dispatch while the real CLI is busy",
  );
  finishSlowTurn!();
  await until(() => requests === 4);
  console.log(
    "PASS browser queues a prompt while Pi is busy; computer reauthorizes and dispatches it after completion",
  );
  await workspacePage
    .getByRole("dialog", { name: "Queued messages", exact: true })
    .getByRole("button", { name: "Close", exact: true })
    .click();
  await until(
    async () =>
      !(await nativeRuntime.request(`/api/sessions/${created.localId}/state`))
        .busy,
  );
  const requestsBeforeControls = requests;
  await workspacePage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("/model ");
  await workspacePage
    .getByRole("listbox", { name: "Available Pi models" })
    .getByRole("option")
    .filter({ hasText: "fixture-alt" })
    .first()
    .click();
  await until(
    async () =>
      (await nativeRuntime.request(`/api/sessions/${created.localId}/state`))
        .model === "fixture-alt",
  );
  await workspacePage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("/effort ");
  await workspacePage
    .getByRole("listbox", { name: "Available Pi thinking levels" })
    .getByRole("option")
    .filter({ hasText: /^high$/ })
    .click();
  await until(
    async () =>
      (await nativeRuntime.request(`/api/sessions/${created.localId}/state`))
        .reasoning_effort === "high",
  );
  assert.equal(
    requests,
    requestsBeforeControls,
    "Live model/effort controls must not submit inference prompts",
  );
  assert.equal(
    (await nativeRuntime.request(`/api/sessions/${created.localId}/state`))
      .busy,
    false,
  );
  console.log(
    "PASS browser Pi model and effort controls update the shared native process without inference or a busy latch",
  );
  await workspacePage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("INTERRUPT_NATIVE_TURN");
  const interruptedRequestCount = requests + 1;
  await workspacePage
    .getByRole("button", { name: "Send", exact: true })
    .click();
  await until(() => requests === interruptedRequestCount);
  await workspacePage
    .getByRole("button", { name: "Interrupt (Esc)", exact: true })
    .click();
  await until(
    async () =>
      !(await nativeRuntime.request(`/api/sessions/${created.localId}/state`))
        .busy,
  );
  await until(() => interruptedProviderClosed, 10000);
  assert.equal(
    requests,
    interruptedRequestCount,
    "Interrupt must not submit another model request",
  );
  console.log(
    "PASS browser interruption settles the real native Pi turn without redispatch",
  );
  await workspacePage
    .getByRole("link", { name: "+ New agent", exact: true })
    .click();
  const newAgentDialog = workspacePage.getByRole("dialog", {
    name: "New agent",
    exact: true,
  });
  await newAgentDialog
    .getByLabel("Agent name")
    .fill("Created from full workspace");
  await newAgentDialog
    .getByLabel("Runtime", { exact: true })
    .selectOption("pi");
  await newAgentDialog
    .getByLabel("Provider", { exact: true })
    .selectOption("fixture");
  await newAgentDialog.getByText("More", { exact: true }).click();
  await newAgentDialog
    .getByLabel("Working directory", { exact: true })
    .fill(workspace);
  const launched = workspacePage.waitForResponse(
    (r: any) => r.url().endsWith("/agents") && r.request().method() === "POST",
  );
  await newAgentDialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  assert.equal((await launched).status(), 200);
  await newAgentDialog.waitFor({ state: "hidden" });
  assert.equal(
    store.read().agents.filter((a) => a.computerId === computer.computer.id)
      .length,
    2,
  );
  console.log(
    "PASS browser New agent launches and publishes a second actual Pi process through the hub",
  );
  const launchedAgent = store
    .read()
    .agents.find((a) => a.name === "Created from full workspace")!;
  assert.ok(launchedAgent.localId);
  const launchedLocalId = launchedAgent.localId;
  ownedSessionIds.add(launchedLocalId);
  // Simulate a lost central result commit after a confirmed local launch.
  store.change((s) => {
    const a = s.agents.find((a) => a.id === launchedAgent.id)!;
    a.state = "unknown";
    a.localId = null;
  });
  await page.goto(origin + "/?settings=");
  await page.locator(`[data-agent="${launchedAgent.id}"]`).click();
  await page
    .getByRole("button", { name: "Check launch result", exact: true })
    .click();
  await page
    .getByText("Recovered the existing agent.", { exact: true })
    .waitFor();
  assert.equal(
    store.read().agents.find((a) => a.id === launchedAgent.id)!.localId,
    launchedLocalId,
  );
  assert.equal(store.read().agents.length, 2);
  const localCatalog = (await tunnels.request(computer.computer.id, {
    op: "discover",
  })) as { sessions: unknown[] };
  assert.equal(
    localCatalog.sessions.length,
    2,
    "Receipt recovery does not start another local process",
  );
  await client.agentResult(launchedAgent.id, "unknown", null);
  assert.equal(
    store.read().agents.find((a) => a.id === launchedAgent.id)!.state,
    "ready",
    "A delayed failure cannot erase a recovered receipt",
  );
  await assert.rejects(
    client.agentResult(launchedAgent.id, "ready", "different-session"),
  );
  await page.screenshot({
    path: "artifacts/09-recovered-launch.png",
    fullPage: true,
  });
  console.log(
    "PASS browser recovers a saved launch receipt without starting another Pi process",
  );
  // The uncertainty test may have removed the previous selection while the
  // workspace was polling. Select the recovered session as a user would.
  await workspacePage.goto(
    origin +
      "/api/v1/computers/" +
      computer.computer.id +
      "/#session=" +
      encodeURIComponent(launchedLocalId),
  );
  await workspacePage
    .getByRole("textbox", { name: "Message", exact: true })
    .waitFor();
  const [chooser] = await Promise.all([
    workspacePage.waitForEvent("filechooser"),
    workspacePage.getByRole("button", { name: /^Attach file/ }).click(),
  ]);
  const uploaded = workspacePage.waitForResponse(
    (r: any) =>
      r.url().endsWith("/inject_file") && r.request().method() === "POST",
  );
  await chooser.setFiles({
    name: "browser-upload.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Uploaded through the public hub.\n"),
  });
  assert.equal((await uploaded).status(), 200);
  await workspacePage
    .locator("#stagedAttachments")
    .getByText("browser-upload.txt", { exact: true })
    .waitFor();
  console.log(
    "PASS normal browser file picker stages an attachment through the computer relay",
  );
  await workspacePage.goto(
    origin +
      "/api/v1/computers/" +
      computer.computer.id +
      "/#session=" +
      encodeURIComponent(created.localId),
  );
  await workspacePage
    .getByText("Verified actual Pi tool execution across the hub outage.", {
      exact: true,
    })
    .first()
    .waitFor();
  const savedPersonalDraft = workspacePage.waitForResponse(
    (r: any) => r.url().endsWith("/draft") && r.request().method() === "POST",
  );
  await workspacePage
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Alice private unsent draft");
  assert.equal((await savedPersonalDraft).status(), 200);
  store.change((s) => {
    s.users.push({
      id: "reader",
      email: "reader@test.invalid",
      name: "Reader",
      passwordHash: passwordHash("isolated-password"),
      disabled: false,
    });
    acceptInvite(
      s,
      "reader",
      invite(
        s,
        "alice",
        "hub",
        computer.computer.hubId,
        "reader@test.invalid",
        "operator",
      ).token,
    );
    acceptInvite(
      s,
      "reader",
      invite(
        s,
        "alice",
        "computer",
        computer.computer.id,
        "reader@test.invalid",
        "operator",
      ).token,
    );
  });
  const readerContext = await browser.newContext(),
    reader = await readerContext.newPage();
  try {
    await reader.goto(issuer);
    await reader
      .getByLabel("Email", { exact: true })
      .fill("reader@test.invalid");
    await reader
      .getByLabel("Password", { exact: true })
      .fill("isolated-password");
    await reader.getByRole("button", { name: "Sign in", exact: true }).click();
    await reader.goto(origin);
    await reader.getByRole("link", { name: "Sign in to your account" }).click();
    await reader.goto(origin + "/?settings=");
    await reader.locator("[data-computer]").first().waitFor();
    await reader.goto(
      origin +
        "/api/v1/computers/" +
        computer.computer.id +
        "/#session=" +
        encodeURIComponent(created.localId),
    );
    await reader
      .getByText("Verified actual Pi tool execution across the hub outage.", {
        exact: true,
      })
      .first()
      .waitFor();
    assert.equal(
      await reader
        .getByRole("button", { name: "Send", exact: true })
        .isEnabled(),
      true,
    );
    assert.equal(
      await reader
        .getByRole("textbox", { name: "Message", exact: true })
        .inputValue(),
      "",
    );
    assert.equal(
      await workspacePage
        .getByRole("textbox", { name: "Message", exact: true })
        .inputValue(),
      "Alice private unsent draft",
    );
    console.log(
      "PASS two browser accounts keep separate unsent drafts for the same real agent",
    );
    const fileBase = `${origin}/api/v1/computers/${computer.computer.id}/api/sessions/${created.localId}/file`;
    assert.equal(
      (await reader.request.get(fileBase + "/read?path=proof.txt")).status(),
      403,
    );
    await page.goto(origin + "/?settings=");
    await page
      .getByRole("button", { name: "Manage access", exact: true })
      .click();
    const fileGrant = page.locator('.workspace-form[data-member="reader"]');
    const changeFileAccess = async (access: string) => {
      await fileGrant
        .getByLabel("Workspace access for Reader")
        .selectOption(access);
      const changed = page.waitForResponse(
        (r: any) =>
          r.url().endsWith("/workspace-access/reader") &&
          r.request().method() === "PUT",
      );
      await fileGrant
        .getByRole("button", { name: "Save file access", exact: true })
        .click();
      assert.equal((await changed).status(), 200);
    };
    await changeFileAccess("read");
    const grantedRead = await reader.request.get(
      fileBase + "/read?path=proof.txt",
    );
    assert.equal(grantedRead.status(), 200, await grantedRead.text());
    assert.equal((await grantedRead.json()).editable, false);
    assert.equal(
      (
        await reader.request.post(fileBase + "/inspect", {
          data: { path: "proof.txt" },
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await reader.request.post(fileBase + "/inspect", {
          data: { path: "proof.txt", session_id: launchedLocalId },
        })
      ).status(),
      403,
    );
    assert.equal(
      (
        await reader.request.post(fileBase + "/inspect", {
          data: { path: "proof.txt", git_path: true },
        })
      ).status(),
      403,
    );
    assert.equal(
      (
        await reader.request.post(fileBase + "/write", {
          data: { path: "proof.txt", content: "denied" },
        })
      ).status(),
      403,
    );
    await writeFile(join(home, "private.txt"), "outside workspace");
    await symlink(join(home, "private.txt"), join(workspace, "escape.txt"));
    for (const path of [
      join(home, "private.txt"),
      "../private.txt",
      "escape.txt",
    ]) {
      assert.equal(
        (
          await reader.request.post(fileBase + "/inspect", { data: { path } })
        ).status(),
        403,
      );
      for (const route of ["read", "blob", "download"]) {
        const denied = await reader.request.get(
          fileBase + "/" + route + "?path=" + encodeURIComponent(path),
        );
        assert.equal(
          denied.status(),
          403,
          `${route}: ${path}: ${await denied.text()}`,
        );
      }
    }
    console.log(
      "PASS owner grants workspace read access through the browser; writes and outside paths remain denied",
    );
    await changeFileAccess("write");
    await reader
      .getByRole("button", { name: "View file", exact: true })
      .click();
    await reader.getByPlaceholder("Choose or search files").fill("proof.txt");
    await reader
      .getByRole("option")
      .filter({ hasText: "proof.txt" })
      .first()
      .click();
    await reader
      .locator("#fileViewer")
      .getByText("external disk update", { exact: true })
      .waitFor();
    await reader
      .getByRole("button", { name: "Edit file", exact: true })
      .click();
    await reader.keyboard.press("Control+A");
    await reader.keyboard.press("Backspace");
    await reader.keyboard.type("edited by invited workspace member");
    await reader
      .getByRole("button", { name: "Save file", exact: true })
      .click();
    await until(
      async () =>
        (await readFile(join(workspace, "proof.txt"), "utf8")) ===
        "edited by invited workspace member",
    );
    await reader.screenshot({
      path: "/work/artifacts/10-workspace-grant.png",
      fullPage: true,
    });
    await reader
      .locator("#fileViewer")
      .getByRole("button", { name: "Close", exact: true })
      .click();
    await changeFileAccess("");
    assert.equal(
      (await reader.request.get(fileBase + "/read?path=proof.txt")).status(),
      403,
    );
    await changeFileAccess("read");
    console.log(
      "PASS invited member edits the real workspace in the browser; owner revocation immediately removes file access",
    );
    const deletionPath = `/api/v1/computers/${computer.computer.id}/api/sessions/${launchedLocalId}/delete`;
    assert.equal(
      (await reader.request.post(origin + deletionPath, { data: {} })).status(),
      403,
    );
    const deleted = await workspacePage.request.post(origin + deletionPath, {
      data: {},
    });
    assert.equal(deleted.status(), 200, await deleted.text());
    assert.equal(store.read().agents.length, 1);
    await until(async () => {
      const remaining = (await tunnels.request(computer.computer.id, {
        op: "discover",
      })) as { sessions: Array<{ session_id: string }> };
      return !remaining.sessions.some((s) => s.session_id === launchedLocalId);
    });
    console.log(
      "PASS owner API deletes the exact real local session and hub entry; an operator receives 403",
    );
    store.change((s) => {
      setPolicy(s, "alice", "hub", computer.computer.hubId, "read_only");
      removeMember(s, "alice", "computer", computer.computer.id, "reader");
    });
    assert.equal(
      (await reader.request.get(fileBase + "/read?path=proof.txt")).status(),
      403,
    );
    await reader
      .getByRole("button", { name: "Read-only access", exact: true })
      .waitFor();
    assert.equal(
      await reader
        .getByRole("button", { name: "Read-only access", exact: true })
        .isDisabled(),
      true,
    );
    await reader.screenshot({
      path: "/work/artifacts/08-workspace-read-only.png",
      fullPage: true,
    });
    console.log(
      "PASS full workspace keeps the transcript and disables sending after hub-first read-only retention applies",
    );
  } catch (error) {
    console.error(
      "READER STATE",
      reader.url(),
      await reader.locator("body").innerText(),
    );
    await reader.screenshot({
      path: "/work/artifacts/reader-failure.png",
      fullPage: true,
    });
    throw error;
  } finally {
    await readerContext.close();
  }
  assert.deepEqual(
    browserErrors,
    [],
    "All workspace workflows finish without uncaught errors",
  );
  await writeFile(
    "/work/artifacts/real-runtime-results.json",
    JSON.stringify(
      {
        passed: true,
        engine: "native-typescript",
        at: new Date().toISOString(),
        limitations: [
          "Embedded workspace navigation has no owner deletion button; owner deletion is verified through the public Hub API.",
        ],
        backend: "installed Pi CLI",
        provider: "scripted OpenAI-compatible fixture; not live inference",
        checks: [
          "actual process discovery",
          "browser imports existing local session and sends prompt",
          "rich workspace transcript",
          "Git diff, file read, byte-identical download, editor save and CAS conflict recovery",
          "Pi live model and effort settings without inference",
          "Pi native runtime interruption without redispatch",
          "transcript search",
          "no uncaught browser errors",
          "actual shell tool completion while hub down",
          "same-session transcript after hub restart",
          "durable completion hint reaches hub after outage recovery",
          "no replay",
          "browser queues during real CLI activity and dispatches after current authorization",
          "browser New agent launches a second actual Pi process",
          "browser recovers a saved launch result without launching another process",
          "normal browser attachment picker stages a file through the hub",
          "full workspace live read-only downgrade preserves transcript and disables sending",
          "two accounts keep separate personal drafts for the same real agent",
          "owner-only public API deletion removes the exact local session and hub entry; operator deletion denied",
          "owner browser grants read-only workspace access while directory traversal and symlink escapes are denied",
          "invited member edits a real file through the browser and loses file access immediately on revocation or membership removal",
        ],
      },
      null,
      2,
    ),
  );
} catch (error) {
  console.error(error);
  await writeFile(
    "/work/artifacts/real-runtime-results.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        passed: false,
        checks: [],
        errors: [String(error)],
      },
      null,
      2,
    ),
  );
  finishSlowTurn?.();
  finishInterruptedTurn?.();
  for (const p of context.pages()) {
    console.error(
      "BROWSER STATE",
      (await p.locator("body").innerText()).slice(-2500),
    );
    await p
      .screenshot({
        path: "/work/artifacts/debug-" + context.pages().indexOf(p) + ".png",
        fullPage: true,
      })
      .catch(() => {});
  }
  await page
    .screenshot({
      path: "/work/artifacts/real-runtime-failure.png",
      fullPage: true,
    })
    .catch(() => {});
  console.error(logs.slice(-8000));
  const paths = await readdir(join(home, "computer/native")).catch(() => []);
  console.error("Isolated runtime records", paths);
  console.error(
    "Native catalog",
    JSON.stringify(await nativeRuntime.request("/api/sessions")),
  );
  const catalog = await nativeRuntime.request("/api/sessions");
  await writeFile(
    "/work/artifacts/native-workspace-runtime-state.json",
    JSON.stringify(
      await Promise.all(
        catalog.sessions.map(async (s: any) => ({
          state: await nativeRuntime.request(
            `/api/sessions/${s.session_id}/state`,
          ),
          tail: await nativeRuntime.request(
            `/api/sessions/${s.session_id}/tail`,
          ),
        })),
      ),
      null,
      2,
    ),
  );
  throw error;
} finally {
  finishSlowTurn?.();
  finishInterruptedTurn?.();
  const cleanup = async (name: string, close: () => Promise<unknown>) => {
    console.log("CLEANUP", name, "starting");
    await close();
    console.log("CLEANUP", name, "complete");
  };
  await cleanup("browser", () => browser.close());
  // These are the two exact sessions launched by this isolated fixture.
  for (const id of ownedSessionIds) {
    await nativeRuntime.request(`/api/sessions/${id}/delete`, "POST").catch((error: any) => {
      if (error.status !== 404) throw error;
    });
  }
  provider.server.closeAllConnections();
  await cleanup("provider", () => provider.close());
  const stopped = service.stop();
  for (const socket of ownedHubConnections) socket.destroy();
  hub.server.closeAllConnections();
  await cleanup("hub", () => hub.close());
  await cleanup("Computer", () => stopped);
  identity.server.closeAllConnections();
  await cleanup("identity", () => identity.close());
  notifications.close();
  sessions.close();
  store.close();
  nativeRuntime.close();
  console.log("CLEANUP all owned fixture resources complete");
}
