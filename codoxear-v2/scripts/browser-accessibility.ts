import "./testing/frontend-artifact.js";
import { connect } from "node:net";
import { socketPath } from "../src/computer/native/paths.js";
import { independentAuthority } from "../src/hub/independent.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
import { recoveredUnattended } from "./accessibility-unattended.js";
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
  invite, acceptInvite,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "accessibility-")),
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
store.change(s=>s.users.push({id:"member",email:"member@test.invalid",name:"Member",passwordHash:passwordHash("isolated-password"),disabled:false}));
const computer = store.change((s) =>
  createComputer(
    s,
    "alice",
    createHub(s, "alice", "Accessibility Hub").id,
    "Accessibility Computer",
    "alice",
  ),
);
store.change(s=>{ for(const [kind,id] of [["hub",computer.computer.hubId],["computer",computer.computer.id]] as const) acceptInvite(s,"member",invite(s,"alice",kind,id,"member@test.invalid","operator").token); });
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
const context = await browser.newContext({viewport: {width:1440,height:1000}});
let page = await context.newPage();
// Keep loopback connectivity visible to Chromium's online-aware UI inside the
// network-isolated container. This changes browser network state, not responses.
let network = await context.newCDPSession(page);
await network.send("Network.enable");
await network.send("Network.emulateNetworkConditions", {
  offline: false,
  latency: 0,
  downloadThroughput: -1,
  uploadThroughput: -1,
  connectionType: "ethernet",
});
await network.send("Network.overrideNetworkState", {offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"ethernet"}).catch(()=>{});
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
let recovery: Awaited<ReturnType<typeof recoveredUnattended>> | undefined;
await mkdir("artifacts", { recursive: true });
const evidence: Record<string, unknown>[] = [];
const artifact = `artifacts/browser-accessibility-${Date.now()}`;
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
async function openSidebar() {
  const sidebar=page.locator(".sidebar");
  const open=await page.evaluate(()=>document.body.classList.contains("sidebar-open"));
  if(!open)await page.getByRole("button",{name:"Toggle sidebar",exact:true}).click();
  await until(async()=>sidebar.evaluate((node:Element)=>node.getBoundingClientRect().left>=-1));
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
      name: "Accessibility Hub",
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
  const created = await nativeRuntime.createTerminal("pi", "Accessibility Pi", {
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
    .filter({ hasText: "Accessibility Hub" })
    .locator("summary")
    .click();
  await connections
    .getByRole("button")
    .filter({ has: page.getByText("Accessibility Computer", { exact: true }) })
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
    .fill("Accessibility Pi");
  await importing
    .getByRole("button", { name: "Import session", exact: true })
    .click();
  await importing.waitFor({ state: "hidden" });
  await selectBrowserSession("Accessibility Pi");
  pass("Keyboard import opens the installed Pi session through independent Hub pages");
  const gaps: string[] = [];
  async function activate(locator: any) { await locator.focus(); await page.keyboard.press("Enter"); }
  async function dialogKeyboard(dialog: any, label: string, modal = true) {
    await dialog.waitFor();
    if (modal) {
    const boundary=await dialog.evaluate((node:HTMLElement)=>{
      const controls=[...node.querySelectorAll<HTMLElement>("button,input,textarea,select,a[href],summary,[contenteditable=true],[tabindex]")].filter(n=>n.tabIndex>=0&&!n.matches(":disabled")&&!n.closest("[inert]")&&n.getClientRects().length&&getComputedStyle(n).visibility!=="hidden");
      controls[0]?.focus();return {first:controls[0]?.outerHTML,last:controls.at(-1)?.outerHTML};
    });
    await page.keyboard.press("Shift+Tab");
    assert.equal(await dialog.evaluate(()=>document.activeElement?.outerHTML),boundary.last,label+" wraps backwards to its final visible control");
    await page.keyboard.press("Tab");
    assert.equal(await dialog.evaluate(()=>document.activeElement?.outerHTML),boundary.first,label+" wraps forwards to its first visible control");
    for (let i = 0; i < 24; i++) {
      await page.keyboard.press(i < 12 ? "Tab" : "Shift+Tab");
      assert.ok(await dialog.evaluate((node: HTMLElement) => node.contains(document.activeElement)), label + " contains keyboard focus");
    }
    } else {
      await dialog.locator('input:not(:disabled)').first().focus();
      const reached: string[] = [];
      for(let i=0;i<8;i++){
        reached.push(await page.evaluate(()=>document.activeElement?.id||""));
        await page.keyboard.press("Tab");
      }
      assert.ok(reached.includes("unattendedReviewBtn"),"Review control is reachable through natural Tab order");
    }
    await page.keyboard.press("Escape");
    await page.keyboard.press("Escape");
    assert.ok(await dialog.isVisible(), label + " stays open on Escape");
    const ax = await network.send("Accessibility.getFullAXTree");
    const unnamed = ax.nodes.filter((node: any) => !node.ignored && ["button","textbox","combobox","checkbox","radio"].includes(node.role?.value) && !node.name?.value).map((node:any)=>node.role.value);
    if (unnamed.length) gaps.push(label + " unnamed controls: " + unnamed.join(", "));
    evidence.push({dialog: label, modal, focusContained: modal, escapePreservesDialog: true, unnamed});
  }
  async function targets(label: string, scope: any) {
    assert.ok(await scope.count(),label+" scope exists");
    const small = await scope.locator('button:not(:disabled),[role=button],[role=link][tabindex],summary,input:not(:disabled),select:not(:disabled)').evaluateAll((nodes: Element[]) => nodes.flatMap(node => {
      if (!node.getClientRects().length || getComputedStyle(node).visibility === "hidden") return [];
      const target = node.matches("input,select") ? node.closest("label") || node : node;
      const r = target.getBoundingClientRect();
      if(r.right<=0||r.bottom<=0||r.left>=innerWidth||r.top>=innerHeight)return [];
      const hit=document.elementFromPoint(Math.max(0,Math.min(innerWidth-1,r.left+r.width/2)),Math.max(0,Math.min(innerHeight-1,r.top+r.height/2)));
      if(hit&&!target.contains(hit)&&!hit.contains(target))return [];
      let width=r.width,height=r.height;
      for(const pseudo of ["::before","::after"]){
        const style=getComputedStyle(target,pseudo);
        if(style.content==="none"||style.content==="normal"||style.position!=="absolute"||style.pointerEvents==="none")continue;
        const pseudoWidth=parseFloat(style.width),pseudoHeight=parseFloat(style.height);
        if(Number.isFinite(pseudoWidth))width=Math.max(width,pseudoWidth);
        if(Number.isFinite(pseudoHeight))height=Math.max(height,pseudoHeight);
        const inset=[style.left,style.right,style.top,style.bottom].map(v=>parseFloat(v));
        if(inset.every(Number.isFinite)){width=Math.max(width,r.width-inset[0]!-inset[1]!);height=Math.max(height,r.height-inset[2]!-inset[3]!);}
      }
      return width < 43.9 || height < 43.9 ? [{id:node.id,name:node.getAttribute("aria-label")||node.textContent?.trim().slice(0,60),width,height}] : [];
    }));
    evidence.push({mobileTargets:label,small});
    if(small.length) gaps.push(label + " targets below 44px: " + JSON.stringify(small));
  }
  await activate(page.getByRole("button",{name:"Hubs & computers",exact:true}).first());
  let connection = page.locator("dialog.connectionPage");
  await dialogKeyboard(connection,"Hubs & computers");
  await activate(connection.locator(".connectionHub summary").first());
  await activate(connection.locator("[data-computer]").first());
  await dialogKeyboard(connection,"Computer page");
  await activate(connection.getByRole("button",{name:"Manage access",exact:true}));
  await connection.locator('.workspace-form[data-member="member"]').waitFor();
  await dialogKeyboard(connection,"Manage access");
  await activate(connection.getByRole("button",{name:"Back",exact:true}));
  await connection.getByRole("heading",{name:"Accessibility Computer",exact:true}).waitFor();
  await activate(connection.getByRole("button",{name:"Back",exact:true}));
  await connection.getByRole("heading",{name:"Hubs & computers",exact:true}).waitFor();
  await activate(connection.getByRole("button",{name:"Back",exact:true}));
  assert.equal(await page.getByRole("button",{name:"Hubs & computers",exact:true}).first().evaluate((node:Element)=>node===document.activeElement),true);
  pass("Hubs, Computer and Manage access contain Tab focus, preserve Escape and restore the opener");
  await activate(page.getByRole("button",{name:"View file",exact:true}));
  await page.getByPlaceholder("Choose or search files").fill("tracked.txt");
  await page.getByRole("option").filter({hasText:"tracked.txt"}).first().waitFor();
  await page.getByPlaceholder("Choose or search files").focus();
  await page.keyboard.press("ArrowDown");
  assert.ok(await page.getByPlaceholder("Choose or search files").getAttribute("aria-activedescendant"));
  await page.keyboard.press("Enter");
  let file = page.locator("#fileViewer");
  await file.getByText("original line",{exact:true}).first().waitFor();
  await dialogKeyboard(file,"File viewer");
  await activate(file.getByRole("button",{name:"Edit file",exact:true}));
  await file.locator('.monaco-editor [role="textbox"]').focus();
  await page.keyboard.press("Control+m");
  await dialogKeyboard(file,"File editor");
  await activate(file.getByRole("button",{name:"Close",exact:true}));
  await until(async()=>page.getByRole("button",{name:"View file",exact:true}).evaluate((node:Element)=>node===document.activeElement));
  pass("Actual workspace file viewer and editor retain keyboard focus and restore View file");
  for(const [opener,dialogName] of [["Help","Help"],["Details","Details"]] as const){
    await activate(page.getByRole("button",{name:opener,exact:true}));
    const dialog=page.getByRole("dialog",{name:dialogName,exact:true});
    if(dialogName==="Details")await until(async()=>!await dialog.locator("#diagCopyBtn").isDisabled());
    await dialogKeyboard(dialog,dialogName);
    await activate(dialog.getByRole("button",{name:"Close",exact:true}));
  }
  await activate(page.locator(".session.active").getByRole("button",{name:"Edit conversation",exact:true}));
  const edit=page.getByRole("dialog",{name:"Edit conversation",exact:true});
  await dialogKeyboard(edit,"Edit conversation");
  await activate(edit.getByRole("button",{name:"Close",exact:true}));
  pass("Help, Details and Edit conversation support forward/backward focus boundaries and repeated Escape");
  gateway.holdNext("/chat/completions", "Accessibility held turn");
  await page.getByLabel("Message",{exact:true}).fill("Accessibility held turn");
  await activate(page.getByRole("button",{name:"Send",exact:true}));
  await until(()=>gateway.requests.some(request=>request.held===true));
  await nativeRuntime.queueControl(created.localId,"enqueue",{text:"First real queue item"});
  await nativeRuntime.queueControl(created.localId,"enqueue",{text:"Second real queue item"});
  await activate(page.getByRole("button",{name:/Queued messages/}));
  let queue = page.getByRole("dialog",{name:"Queued messages",exact:true});
  await until(async()=>await queue.getByRole("textbox").count()===2);
  await dialogKeyboard(queue,"Queued messages");
  await activate(queue.getByRole("button",{name:"Close",exact:true}));
  await until(async()=>page.getByRole("button",{name:/Queued messages/}).evaluate((node:Element)=>node===document.activeElement));
  pass("Real broker queue controls expose labels, contain focus and restore the opener");
  await activate(page.getByRole("button",{name:"New session",exact:true}).first());
  const newSession = page.getByRole("dialog",{name:"New agent",exact:true});
  await until(async()=>!await newSession.getByRole("button",{name:"Create agent",exact:true}).isDisabled());
  await dialogKeyboard(newSession,"New agent");
  const model = newSession.getByRole("combobox",{name:"Model",exact:true});
  await newSession.evaluate((dialog:HTMLDialogElement)=>{
    (window as any).agentDialogEvents=[];
    dialog.addEventListener("cancel",event=>queueMicrotask(()=>(window as any).agentDialogEvents.push({event:"cancel",prevented:event.defaultPrevented})));
    dialog.addEventListener("close",()=>(window as any).agentDialogEvents.push({event:"close"}));
  });
  await until(async()=>await model.locator("option").count()>1);
  evidence.push({producerModelOptions:await model.locator("option").allTextContents()});
  await model.focus(); await page.keyboard.press("ArrowDown");
  await newSession.getByLabel("Custom model",{exact:true}).waitFor();
  evidence.push({beforeModelEscape:await newSession.evaluate((dialog:HTMLDialogElement)=>({open:dialog.open,active:document.activeElement?.outerHTML}))});
  await page.keyboard.press("Escape");
  evidence.push({afterModelEscape:await page.evaluate(()=>({events:(window as any).agentDialogEvents,dialog:[...document.querySelectorAll("dialog")].map(d=>({name:d.getAttribute("aria-label"),open:d.open})),active:document.activeElement?.outerHTML}))});
  assert.ok(await newSession.isVisible());
  await activate(newSession.getByRole("button",{name:"Close",exact:true}));
  pass("File picker announces its keyboard option and current model selection supports native keyboard navigation without Escape closing the dialog");
  const mobileLogin = await page.evaluate(async()=> {
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open("codoxear-client-identities",1);request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    const value=await new Promise((resolve,reject)=>{const request=db.transaction("credentials").objectStore("credentials").get("lifecycle-login");request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    db.close();return value;
  });
  const mobileContext = await browser.newContext({viewport:{width:390,height:844},hasTouch:true,isMobile:true});
  page = await mobileContext.newPage(); page.setDefaultTimeout(20000);
  page.on("pageerror",(error:Error)=>browserErrors.push(error.message));
  page.on("console",(entry:any)=>{if(entry.type()==="error")browserErrors.push(entry.text());});
  network = await mobileContext.newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"ethernet"});
  await network.send("Network.overrideNetworkState",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"ethernet"}).catch(()=>{});
  await page.goto(clientOrigin+"/health");
  await page.evaluate(async(login:any)=>{
    const db=await new Promise<IDBDatabase>((resolve,reject)=>{const request=indexedDB.open("codoxear-client-identities",1);request.onupgradeneeded=()=>request.result.createObjectStore("credentials");request.onsuccess=()=>resolve(request.result);request.onerror=()=>reject(request.error);});
    await new Promise<void>((resolve,reject)=>{const tx=db.transaction("credentials","readwrite");tx.objectStore("credentials").put(login,login.id);tx.oncomplete=()=>resolve();tx.onerror=()=>reject(tx.error);});db.close();
  },mobileLogin);
  await page.goto(clientOrigin+"#session="+encodeURIComponent("lifecycle-account~"+store.read().agents.find(agent=>agent.localId===created.localId)!.id));
  await page.getByRole("button",{name:"Toggle sidebar",exact:true}).waitFor();
  await until(async()=>(await page.locator("#threadTitle").innerText()).includes("Accessibility Pi"));
  connection=page.locator("dialog.connectionPage");
  file=page.locator("#fileViewer");
  queue=page.getByRole("dialog",{name:"Queued messages",exact:true});
  assert.ok(await page.evaluate(()=>matchMedia("(pointer: coarse)").matches),"Mobile acceptance uses Chrome touch emulation");
  await page.getByRole("button",{name:"Toggle sidebar",exact:true}).click();
  await activate(page.getByRole("button",{name:"Settings",exact:true}));
  const settings = page.getByRole("dialog",{name:"Settings",exact:true});
  await dialogKeyboard(settings,"Settings");
  const themeGroup = settings.getByRole("radiogroup",{name:"Theme",exact:true});
  const activeTheme = themeGroup.locator('[aria-checked="true"]');
  const priorTheme = await activeTheme.getAttribute("data-theme-family");
  await activeTheme.focus(); await page.keyboard.press("ArrowRight");
  if(await themeGroup.locator('[aria-checked="true"]').getAttribute("data-theme-family")===priorTheme) gaps.push("Theme radiogroup does not respond to ArrowRight");
  assert.ok(await themeGroup.locator('[aria-checked="true"]').evaluate((node:Element)=>node.matches(":focus-visible")&&getComputedStyle(node).outlineStyle!=="none"),"Keyboard radio selection has a visible focus indicator");
  assert.equal(await themeGroup.locator('[tabindex="0"]').count(),1);
  const modeGroup=settings.getByRole("radiogroup",{name:"Mode",exact:true});
  await modeGroup.locator('[aria-checked="true"]').focus();
  await page.keyboard.press("End");
  assert.equal(await settings.locator('[data-theme-mode="dark"]').getAttribute("aria-checked"),"true");
  await page.keyboard.press("Home");
  assert.equal(await settings.locator('[data-theme-mode="system"]').getAttribute("aria-checked"),"true");
  assert.equal(await modeGroup.locator('[tabindex="0"]').count(),1);
  const fontSnapshots: Record<string,unknown> = {};
  for(const family of ["paper","clay","slate"]){
    await activate(settings.locator(`[data-theme-family="${family}"]`));
    assert.equal(await settings.locator(`[data-theme-family="${family}"]`).getAttribute("aria-checked"),"true");
    await until(()=>page.evaluate((family:string)=>!!document.querySelector<HTMLLinkElement>(`link[data-theme-family="${family}"]`)?.sheet,family));
    for(const appearance of [
      {mode:"system",media:"light",resolved:"light",suffix:""},
      {mode:"dark",media:"light",resolved:"dark",suffix:"-dark"},
      {mode:"system",media:"dark",resolved:"dark",suffix:"-system-dark"},
    ] as const){
    await page.emulateMedia({colorScheme:appearance.media});
    await activate(settings.locator(`[data-theme-mode="${appearance.mode}"]`));
    await until(()=>page.evaluate((resolved:string)=>document.documentElement.dataset.mode===resolved,appearance.resolved));
    assert.equal(await settings.locator(`[data-theme-mode="${appearance.mode}"]`).getAttribute("aria-checked"),"true");
    assert.equal(await page.evaluate(()=>matchMedia("(prefers-color-scheme: dark)").matches),appearance.media==="dark");
    const sampleKey=family+appearance.suffix;
    const fonts=await settings.locator("button,textarea").evaluateAll((nodes:Element[])=>nodes.map(n=>getComputedStyle(n).fontFamily));
    assert.equal(fonts.length,13,"Settings retains its thirteen font samples");
    fontSnapshots[sampleKey]=fonts;
    if(sampleKey!=="paper")assert.deepEqual(fontSnapshots.paper,fonts,"Fonts remain invariant across theme families and modes");
    const contrast = await settings.locator(".settingsSectionTitle,.fieldHint,.choiceChip,.themeSwatchName").evaluateAll((nodes:Element[])=>{
      const canvas=document.createElement("canvas");canvas.width=canvas.height=1;const ctx=canvas.getContext("2d",{willReadFrequently:true})!;
      const colors={
        read(css:string){ctx.clearRect(0,0,1,1);ctx.fillStyle=css;ctx.fillRect(0,0,1,1);return [...ctx.getImageData(0,0,1,1).data];},
        luminance(rgb:number[]){return rgb.slice(0,3).map(v=>{const c=v/255;return c<=0.04045?c/12.92:((c+0.055)/1.055)**2.4;}).reduce((sum,v,i)=>sum+v*[0.2126,0.7152,0.0722][i]!,0);},
      };
      return nodes.filter(n=>n.getClientRects().length).map(node=>{
        const style=getComputedStyle(node),fg=colors.read(style.color);let bg=[255,255,255,255];
        const ancestors:Element[]=[];for(let p:Element|null=node;p;p=p.parentElement)ancestors.unshift(p);
        for(const p of ancestors){const c=colors.read(getComputedStyle(p).backgroundColor),alpha=c[3]!/255;bg=bg.map((v,i)=>i===3?255:c[i]!*alpha+v*(1-alpha));}
        const effective=fg.map((v,i)=>i===3?255:v*(fg[3]!/255)+bg[i]!*(1-fg[3]!/255));
        const a=colors.luminance(effective),b=colors.luminance(bg),ratio=(Math.max(a,b)+0.05)/(Math.min(a,b)+0.05);
        const large=parseFloat(style.fontSize)>=24||parseFloat(style.fontSize)>=18.667&&Number(style.fontWeight)>=700;
        return {label:node.textContent?.trim().slice(0,80),ratio,required:large?3:4.5,color:style.color,background:bg};
      });
    });
    evidence.push({themeContrast:family,mode:appearance.mode,media:appearance.media,resolvedMode:appearance.resolved,contrast});
    for(const item of contrast)if(item.ratio+0.01<item.required)gaps.push(sampleKey+" text contrast: "+JSON.stringify(item));
    await targets(sampleKey+" Settings",settings);
    await page.screenshot({path:`artifacts/accessibility-${sampleKey}-mobile.png`,fullPage:true});
    }
  }
  assert.deepEqual(fontSnapshots.paper,fontSnapshots.clay);
  assert.deepEqual(fontSnapshots.paper,fontSnapshots.slate);
  await page.emulateMedia({colorScheme:"light"});
  await until(()=>page.evaluate(()=>document.documentElement.dataset.mode==="light"));
  await activate(settings.getByRole("button",{name:"Close",exact:true}));
  await until(async()=>page.getByRole("button",{name:"Settings",exact:true}).evaluate((node:Element)=>node===document.activeElement));
  await page.getByRole("button",{name:"Toggle sidebar",exact:true}).click();
  await targets("Mobile sidebar",page.locator(".sidebar"));
  await page.getByRole("button",{name:"Toggle sidebar",exact:true}).click();
  await targets("Mobile conversation",page.locator("#root"));
  await activate(page.getByRole("button",{name:/Queued messages/}));
  await targets("Mobile real queue",queue);
  await activate(queue.getByRole("button",{name:"Close",exact:true}));
  await page.getByRole("button",{name:"Toggle sidebar",exact:true}).click();
  await activate(page.getByRole("button",{name:"Hubs & computers",exact:true}).first());
  await targets("Mobile Hubs",connection);
  await activate(connection.locator(".connectionHub summary").first());
  await activate(connection.locator("[data-computer]").first());
  await targets("Mobile Computer",connection);
  await activate(connection.getByRole("button",{name:"Manage access",exact:true}));
  await connection.locator('.workspace-form[data-member="member"]').waitFor();
  await targets("Mobile Manage access",connection);
  await activate(connection.getByRole("button",{name:"Back",exact:true}));
  await connection.getByRole("heading",{name:"Accessibility Computer",exact:true}).waitFor();
  await activate(connection.getByRole("button",{name:"Back",exact:true}));
  await connection.getByRole("heading",{name:"Hubs & computers",exact:true}).waitFor();
  await activate(connection.getByRole("button",{name:"Back",exact:true}));
  await activate(page.getByRole("button",{name:"View file",exact:true}));
  await page.getByPlaceholder("Choose or search files").fill("tracked.txt");
  await activate(page.getByRole("option").filter({hasText:"tracked.txt"}).first());
  await targets("Mobile File viewer",file);
  await activate(file.getByRole("button",{name:"Close",exact:true}));
  recovery = await recoveredUnattended(nativeRuntime,home,workspace);
  const importedRecovery = await page.evaluate(async ({path,localId}:any)=> {
    const response=await fetch(path,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({localId,name:"Recovered unattended review"})});
    return {status:response.status,text:await response.text()};
  },{path:`/api/client/hubs/lifecycle-login/api/computers/${computer.computer.id}/import`,localId:recovery.localId});
  assert.equal(importedRecovery.status,200,importedRecovery.text);
  await page.reload();
  const recoveredCard=page.locator(".session").filter({has:page.getByText("Recovered unattended review",{exact:true})});
  await recoveredCard.waitFor({state:"attached"});
  await until(async()=>(await page.locator("#threadTitle").innerText()).includes("Accessibility Pi"));
  await openSidebar();
  await activate(recoveredCard);
  await until(async()=>(await page.locator("#threadTitle").innerText()).includes("Recovered unattended review"));
  await activate(page.locator("#unattendedBtn"));
  const unattended=page.getByRole("dialog",{name:"Unattended mode settings",exact:true});
  await unattended.locator("#unattendedReviewStatus").waitFor();
  assert.equal(await unattended.locator("#unattendedEnabled").isDisabled(),true);
  await dialogKeyboard(unattended,"Recovered unattended review",false);
  await targets("Mobile unattended review",unattended);
  const reviewed=page.waitForResponse((response:any)=>response.url().endsWith("/unattended")&&response.request().method()==="POST");
  await activate(unattended.getByRole("button",{name:"I checked the previous attempt",exact:true}));
  assert.equal((await reviewed).status(),200);
  await until(async()=>!await unattended.locator("#unattendedEnabled").isDisabled());
  const reviewedConfig=await nativeRuntime.request(`/api/sessions/${recovery.localId}/unattended`);
  assert.equal(reviewedConfig.enabled,false);
  assert.equal(reviewedConfig.remaining_injections,recovery.remaining);
  assert.ok(!reviewedConfig.commit_unknown);
  await targets("Mobile reviewed unattended",unattended);
  pass("Real broker recovery exposes a labelled keyboard review control that clears uncertainty without enabling or refunding unattended sends");
  evidence.push({fontSnapshots,gaps});
  assert.deepEqual(gaps,[],"Accessibility gaps found through actual browser interfaces");
  pass("Three themes pass System light, explicit Dark and System dark contrast, invariant fonts, keyboard radios and mobile 44px targets");
  await page.screenshot({path:"artifacts/accessibility-conversation-mobile.png",fullPage:true});
  passed = true;
} catch (error) {
  console.error(error);
  console.error((await page.locator("body").innerText()).slice(-8000));
  await page.screenshot({ path: artifact + "-failure.png", fullPage: true });
} finally {
  await writeFile(
    "artifacts/browser-accessibility-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        browserErrors,
        gateway: gateway.requests,
        browserVersion:browser.version(), evidence,
        limitations: [
          "Installed Pi with controlled provider responses and fixture-issued browser credentials",
          "Unattended crash recovery uses a controlled terminal producer with the real PTY, broker, Hub and client",
          "Chrome touch emulation and AX tree checks do not establish physical mobile or assistive-technology device acceptance",
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
  recovery?.close();
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
