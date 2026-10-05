import { NativeRuntime } from "../src/computer/native/runtime.js";
import { independentAuthority } from "../src/hub/independent.js";
/** Docker-only actual Pi, independent static client and local hub voice acceptance.
 * The controlled model and tone WAV verify transport/playback, not live inference or speech quality. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import Fastify from "fastify";
import type { Socket } from "node:net";
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
const home = await mkdtemp(join(tmpdir(), "native-voice-")),
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
const origin = "http://127.0.0.1:19744",
  local = await independentAuthority({ origin, hubId: computer.computer.hubId, store, otpKey: secret(), secureCookies: false }),
  authority = local.authority,
  identity = local.identity,
  client = local.client,
  identityLogin = authority.accounts.password(
    "alice@test.invalid",
    "isolated-password",
    "test",
  ),
  identitySession = identityLogin.session,
  sessions = new HubSessions(join(home, "hub.sqlite"));
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
    clientOrigins: ["http://127.0.0.1:19745"],
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
const clientOrigin = "http://127.0.0.1:19745";
const staticClient = spawn(process.execPath, ["dist/server/client/web-server.js"], {
  env: { ...process.env, CODOXEAR_CLIENT_PORT: "19745" }, stdio: "ignore",
});
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage", "--autoplay-policy=no-user-gesture-required"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
// Declare connected loopback conditions in DevTools while Docker stays
// isolated. Some browsers still report the underlying OS network as offline.
const browserNetwork = await context.newCDPSession(page);
await browserNetwork.send("Network.enable");
await browserNetwork.send("Network.emulateNetworkConditions", {offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"ethernet"});
await browserNetwork.send("Network.overrideNetworkState", {offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"ethernet"}).catch(()=>{});
page.setDefaultTimeout(20000);
const errors: string[] = [], checks: string[] = [];
page.on("pageerror", (e: Error) => errors.push(e.message));
page.on("console", (message: any) => { if (/^(live hls|live audio|auto-start live audio)/.test(message.text())) console.log("FIXTURE AUDIO",message.text().slice(0,512)); });
page.on("requestfailed", (r: any) => console.log("FIXTURE REQUEST FAILED", new URL(r.url()).pathname, r.failure()?.errorText));
let liveFailure: string | undefined, eventSourceConnected = false;
page.on("response", async (r: any) => {
  if (r.status() === 200 && r.request().resourceType() === "eventsource" && r.url().includes("/live")) eventSourceConnected = true;
  if (r.status() >= 400) console.log("FIXTURE HTTP", r.status(), new URL(r.url()).pathname);
  if (r.status() === 503 && r.url().includes("/live") && !liveFailure) {
    liveFailure = (await r.text().catch(()=>"unreadable")).slice(0,512);
    console.log("FIXTURE LIVE FAILURE",liveFailure);
  }
});
const pass = (label: string) => { checks.push(label); console.log("PASS", label); };
const fixtureKey = "fixture-voice-private-key";
let speechCalls = 0, heldClosed = false, holdSpeech = false;
const provider = Fastify();
provider.post("/v1/chat/completions", async (r, reply) => {
  const b = r.body as { stream?: boolean; messages: unknown[] };
  if (!b.stream) return { choices: [{ message: { content: "The controlled provider completed the requested browser voice check." } }] };
  const chunk = (delta: unknown, reason: string | null) => JSON.stringify({ id: "voice-fixture", object: "chat.completion.chunk", created: Math.floor(Date.now()/1000), model: "fixture", choices: [{ index: 0, delta, finish_reason: reason }] });
  reply.type("text/event-stream");
  return "data: " + chunk({ role: "assistant", content: "Controlled provider completed the browser voice check " + Date.now() + "." }, null) + "\n\ndata: " + chunk({}, "stop") + "\n\ndata: [DONE]\n\n";
});
function wav() {
  const samples = 16000 * 8, bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF"); bytes.writeUInt32LE(bytes.length - 8, 4); bytes.write("WAVE", 8); bytes.write("fmt ", 12); bytes.writeUInt32LE(16, 16); bytes.writeUInt16LE(1, 20); bytes.writeUInt16LE(1, 22); bytes.writeUInt32LE(16000, 24); bytes.writeUInt32LE(32000, 28); bytes.writeUInt16LE(2, 32); bytes.writeUInt16LE(16, 34); bytes.write("data", 36); bytes.writeUInt32LE(samples * 2, 40);
  for (let i=0; i<samples; i++) bytes.writeInt16LE(Math.round(1000 * Math.sin(i * 2 * Math.PI * 220 / 16000)), 44+i*2);
  return bytes;
}
provider.post("/v1/audio/speech", async (r, reply) => {
  assert.ok(r.headers.authorization === "Bearer " + fixtureKey);
  speechCalls++;
  if (holdSpeech) {
    await new Promise<void>(resolve => { reply.raw.once("close", () => { heldClosed = true; resolve(); }); });
    return;
  }
  return reply.type("audio/wav").send(wav());
});
await provider.listen({ host: "127.0.0.1", port: 19820 });
async function snapshot() {
  return page.evaluate(async () => (await fetch("/api/settings/voice?__agent=" + encodeURIComponent(new URLSearchParams(location.hash.slice(1)).get("session")!))).json());
}
async function sendPrompt(text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  const sending = page.waitForResponse((r:any) => r.url().endsWith("/send") && r.request().method() === "POST");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const sendNow = page.getByRole("button", {name:"Send now",exact:true});
  if (await sendNow.isVisible()) await sendNow.click();
  const response = await sending;
  assert.equal(response.status(),200);
}
async function openSettings() {
  const loading = page.waitForResponse((r: any) => r.url().includes("unattended-prompt") && r.request().method() === "GET");
  await page.locator("#settingsBtnSide").click();
  await page.locator("#settingsViewer").waitFor({ state: "visible" });
  await loading;
}
try {
  await mkdir("artifacts", { recursive: true });
  assert.equal(await page.evaluate(() => MediaSource.isTypeSupported('audio/mp4; codecs="mp4a.40.2"')),true,"Use a real browser with AAC support for playback acceptance");
  await until(async () => { try { return (await fetch(clientOrigin + "/health")).ok; } catch { return false; } });
  await service.start();
  await until(() => tunnels.online(computer.computer.id));
  const created = await nativeRuntime.execute({ op: "create", agentId: "voice-fixture", backend: "pi", name: "Native voice process" }) as { localId: string };
  ownedSessionIds.add(created.localId);
  await until(async () => (await nativeRuntime.request(`/api/sessions/${created.localId}/state`)).readiness === "ready", 60000);
  // Seed a genuine isolated account credential before booting the client.
  await page.goto(clientOrigin + "/health");
  const accessToken = await authority.tokens.issue(identitySession, origin, "identity_access");
  await page.evaluate(async (login: any) => {
    const db = await new Promise<IDBDatabase>((resolve, reject) => { const r = indexedDB.open("codoxear-client-identities", 1); r.onupgradeneeded = () => r.result.createObjectStore("credentials"); r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error); });
    await new Promise<void>((resolve,reject) => { const tx = db.transaction("credentials", "readwrite"); tx.objectStore("credentials").put(login, login.id); tx.oncomplete = () => resolve(); tx.onerror = () => reject(tx.error); });
  }, { id: "voice-login", accountKey: "voice-account", origin, hubId: computer.computer.hubId, name: "Runtime test", accountId: "alice", accessToken, refreshToken: "fixture-refresh-unused".repeat(2), expiresAt: Date.now()+300000, identity: { name: "Alice", method: "password", key: "alice" } });
  await page.goto(clientOrigin);
  await page.getByRole("button", {name:"Hubs & computers",exact:true}).first().click();
  const connections = page.getByRole("dialog", { name: "Hubs & computers", exact: true });
  await connections.locator(".connectionHub").filter({hasText:"Runtime test"}).locator("summary").click();
  await connections.getByRole("button").filter({ has: page.getByText("Real Pi", { exact: true }) }).click();
  await page.getByRole("button", { name: "Import local session", exact: true }).click();
  const importing = page.getByRole("dialog", {name:"Import a local session",exact:true});
  await importing.getByLabel(/^Local session/).selectOption(created.localId);
  await importing.getByLabel("Agent name", {exact:true}).fill("Actual native voice");
  await importing.getByRole("button", {name:"Import session",exact:true}).click();
  await page.locator(".session").filter({has:page.getByText("Native voice process",{exact:true})}).click();
  const liveProbe = await page.evaluate(async () => {
    const id = new URLSearchParams(location.hash.slice(1)).get("session");
    try {
      const response = await fetch("/api/sessions/"+encodeURIComponent(id!)+"/live", {signal:AbortSignal.timeout(3000)});
      if (!response.ok) return {status:response.status,error:await response.text()};
      await response.body?.cancel();
      return {status:response.status,error:""};
    } catch (error) { return {status:0,error:String(error)}; }
  });
  console.log("FIXTURE LIVE PROBE",liveProbe);
  console.log("FIXTURE ONLINE",await page.evaluate(()=>navigator.onLine));
  pass("Independent browser client imports a real Pi PTY session through the authenticated hub relay");
  await until(() => eventSourceConnected,15000);
  pass("Actual EventSource transcript stream opens through the independent client without relay errors");
  await openSettings();
  assert.equal(await page.locator("#settingsViewer #appearanceSettingsSection").isVisible(),true);
  assert.equal(await page.locator("#settingsViewer #voiceSettingsSection").isVisible(),true);
  await page.keyboard.press("Escape");
  assert.equal(await page.locator("#settingsViewer").isVisible(),true);
  await page.locator("#voiceBaseUrlInput").fill("http://127.0.0.1:19820/v1");
  await page.locator("#voiceApiKeyInput").fill(fixtureKey);
  await page.locator("#voiceSettingsSection").getByText("Announce narration messages", {exact:true}).click();
  assert.equal(await page.locator("#narrationSettingToggle").isChecked(),true);
  await page.locator("#voiceSettingsCancelBtn").click();
  const cancelled = await snapshot();
  assert.equal(cancelled.has_tts_api_key,false); assert.equal(cancelled.tts_enabled_for_narration,false);
  assert.equal(cancelled.tts_base_url,"https://api.openai.com/v1");
  assert.equal(await page.locator("#voiceApiKeyInput").inputValue(), "");
  pass("Settings stays flat; Escape keeps it open; Cancel drops key, URL and narration drafts");
  await openSettings();
  await page.locator("#voiceBaseUrlInput").fill("http://127.0.0.1:19820/v1");
  await page.locator("#voiceApiKeyInput").fill(fixtureKey);
  await page.locator("#voiceSettingsSaveBtn").click();
  await page.locator("#settingsViewer").waitFor({state:"hidden"});
  const saved = await snapshot();
  assert.equal(saved.tts_base_url,"http://127.0.0.1:19820/v1"); assert.equal(saved.has_tts_api_key,true); assert.equal(saved.tts_api_key,""); assert.ok(!JSON.stringify(saved).includes(fixtureKey));
  await openSettings();
  assert.equal(await page.locator("#voiceApiKeyInput").inputValue(), "");
  assert.match(await page.locator("#voiceApiKeyInput").getAttribute("placeholder"),/Saved API key/);
  await page.locator("#voiceSettingsSaveBtn").click();
  await page.locator("#settingsViewer").waitFor({state:"hidden"});
  assert.equal((await snapshot()).has_tts_api_key,true);
  pass("Browser saves configured voice provider; public settings mask the key; blank Save preserves it");
  await page.locator("#announceBtn").click();
  await until(async () => (await snapshot()).audio.active_listener_count === 1);
  await sendPrompt("Complete the browser speech playback check.");
  await until(() => speechCalls > 0,60000);
  await until(async () => (await snapshot()).audio.segment_count > 0,30000);
  await until(() => page.evaluate(() => { const audio = document.querySelector<HTMLAudioElement>("#liveAudio"); return !!audio && !audio.paused && audio.currentTime > 0.1; }),45000);
  const playback = await page.locator("#liveAudio").evaluate((audio: HTMLAudioElement) => ({time:audio.currentTime,ready:audio.readyState,error:audio.error?.code}));
  assert.ok(playback.time > 0.1); assert.equal(playback.error,undefined);
  await page.screenshot({path:"artifacts/native-voice-playback.png"});
  pass("Actual Pi completion reaches controlled TTS; real ffmpeg HLS plays in Chrome through the streaming relay");
  holdSpeech = true;
  const count = speechCalls;
  await sendPrompt("Complete the browser speech cancellation check.");
  await until(() => speechCalls > count,60000);
  await page.locator("#announceBtn").click();
  await until(() => heldClosed);
  await until(async () => (await snapshot()).audio.active_listener_count === 0);
  assert.equal(await page.locator("#liveAudio").evaluate((audio:HTMLAudioElement)=>audio.paused),true);
  pass("Browser disables announcements, pauses playback and aborts an in-flight TTS provider request");
  await openSettings();
  await page.locator("#voiceSettingsSection").getByText("Clear saved API key", {exact:true}).click();
  assert.equal(await page.locator("#voiceClearApiKeyToggle").isChecked(),true);
  await page.locator("#voiceSettingsSaveBtn").click();
  await page.locator("#settingsViewer").waitFor({state:"hidden"});
  assert.equal((await snapshot()).has_tts_api_key,false);
  await page.locator("#announceBtn").click();
  await page.locator("#settingsViewer").waitFor({state:"visible"});
  await page.locator("#voiceSettingsStatus").getByText(/Set the OpenAI-compatible/).waitFor();
  assert.equal((await snapshot()).audio.active_listener_count,0);
  await page.screenshot({path:"artifacts/native-voice-settings.png"});
  pass("Clearing the saved key persists; announcement opt-in opens actionable settings without registering a listener");
  // Restore a real active stream before removing account access.
  await page.locator("#voiceApiKeyInput").fill(fixtureKey);
  await page.locator("#voiceSettingsSaveBtn").click();
  await page.locator("#settingsViewer").waitFor({state:"hidden"});
  holdSpeech = false;
  await page.locator("#announceBtn").click();
  await until(async () => (await snapshot()).audio.active_listener_count === 1);
  await sendPrompt("Complete the browser access loss playback check.");
  await until(async () => (await snapshot()).audio.segment_count > 0,60000);
  await until(() => page.evaluate(() => { const audio = document.querySelector<HTMLAudioElement>("#liveAudio"); return !!audio && !audio.paused && audio.currentTime > 0.1; }),45000);
  store.change(s => { s.users.find(u=>u.id==="alice")!.disabled = true; });
  const denied = await page.evaluate(async () => (await fetch("/api/settings/voice?__agent=" + encodeURIComponent(new URLSearchParams(location.hash.slice(1)).get("session")!))).status);
  assert.ok([401,403].includes(denied));
  await until(() => page.evaluate(() => {
    const audio = document.querySelector<HTMLAudioElement>("#liveAudio");
    const enabled = Object.keys(localStorage).some(key => key.endsWith("codoxear.announcementEnabled") && localStorage.getItem(key) === "1");
    return !enabled && (!audio || audio.paused);
  }),30000);
  await page.reload();
  await page.getByRole("button",{name:"Hubs & computers",exact:true}).first().click();
  await page.getByRole("dialog",{name:"Hubs & computers",exact:true}).waitFor();
  assert.equal(await page.locator("#voiceApiKeyInput").inputValue(), "");
  pass("Revoked account access rejects native voice settings, cancels the browser voice opt-in and stops playback before reload");
  assert.deepEqual(errors,[]);
  await writeFile("artifacts/native-voice-results.json",JSON.stringify({checks,errors,playback,browserVersion:browser.version(),eventSourceConnected, inference:"scripted controlled provider; no live model inference; controlled tone WAV verifies playback, not speech quality", secretMasking:true},null,2));
} catch (error) {
  await page.screenshot({path:"artifacts/native-voice-failure.png"}).catch(()=>{});
  console.error("Voice fixture page errors",errors);
  console.error("Voice fixture audio state", await page.locator("#liveAudio").evaluate((audio:HTMLAudioElement)=>({online:navigator.onLine,paused:audio.paused,time:audio.currentTime,ready:audio.readyState,network:audio.networkState,error:audio.error?.code,source:audio.currentSrc})).catch(()=>null));
  console.error("Voice fixture browser state",(await page.locator("body").innerText()).slice(-2500));
  throw error;
} finally {
  await browser.close();
  for (const id of ownedSessionIds) await nativeRuntime.request(`/api/sessions/${id}/delete`,"POST").catch(()=>{});
  staticClient.kill("SIGTERM");
  await service.stop();
  for (const socket of ownedHubConnections) socket.destroy();
  provider.server.closeAllConnections(); await provider.close();
  hub.server.closeAllConnections(); await hub.close();
  identity.server.closeAllConnections(); await identity.close();
  notifications.close(); sessions.close(); store.close(); nativeRuntime.close();
}
