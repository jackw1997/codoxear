import "./testing/frontend-artifact.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { independentAuthority } from "../src/hub/independent.js";
/** Docker-only actual Pi, independent static client and local hub voice acceptance.
 * The controlled model and tone WAV verify transport/playback, not live inference or speech quality. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
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
  invite,
  acceptInvite,
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
let delayCandidateRefresh = 0;
hub.addHook("onRequest", async request => {
  if (delayCandidateRefresh && request.url.includes("/git/changed_files")) {
    const delay = delayCandidateRefresh; delayCandidateRefresh = 0;
    await new Promise(resolve => setTimeout(resolve, delay));
  }
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
const service = api.service();
const clientOrigin = "http://127.0.0.1:19745";
const staticClient = spawn(process.execPath, ["frontend/serve.mjs"], {
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
page.on("pageerror",(error:Error)=>errors.push(error.message));
const pass=(label:string)=>{checks.push(label);console.log("PASS",label);};
let latestMessages="";
const provider=Fastify();
provider.post("/v1/chat/completions", async(r,reply)=>{
 latestMessages=JSON.stringify(r.body);
 const chunk=(delta:unknown,reason:string|null)=>JSON.stringify({id:"delegated",object:"chat.completion.chunk",created:Math.floor(Date.now()/1000),model:"fixture",choices:[{index:0,delta,finish_reason:reason}]});
 return reply.type("text/event-stream").send("data: "+chunk({role:"assistant",content:"Delegated attachment completed."},null)+"\n\ndata: "+chunk({},"stop")+"\n\ndata: [DONE]\n\n");
});
await provider.listen({host:"127.0.0.1",port:19820});
store.change(s=>{
 s.users.push({id:"member",email:"member@test.invalid",name:"Member",passwordHash:passwordHash("isolated-password"),disabled:false});
 for(const [kind,id] of [["hub",computer.computer.hubId],["computer",computer.computer.id]] as const) acceptInvite(s,"member",invite(s,"alice",kind,id,"member@test.invalid","operator").token);
});
const memberLogin=authority.accounts.password("member@test.invalid","isolated-password","member-browser");
const memberContext=await browser.newContext({viewport:{width:390,height:844}}),member=await memberContext.newPage();
member.setDefaultTimeout(20000);member.on("pageerror",(error:Error)=>errors.push(error.message));
const memberNetwork=await memberContext.newCDPSession(member);await memberNetwork.send("Network.enable");await memberNetwork.send("Network.emulateNetworkConditions",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"ethernet"});
await memberNetwork.send("Network.overrideNetworkState",{offline:false,latency:0,downloadThroughput:-1,uploadThroughput:-1,connectionType:"ethernet"}).catch(()=>{});
async function seed(target:any, login:any,id:string,name:string){
 await target.goto(clientOrigin+"/health");const token=await authority.tokens.issue(login.session,origin,"identity_access");
 await target.evaluate(async(value:any)=>{
 const db=await new Promise<IDBDatabase>((yes,no)=>{const request=indexedDB.open("codoxear-client-identities",1);request.onupgradeneeded=()=>request.result.createObjectStore("credentials");request.onsuccess=()=>yes(request.result);request.onerror=()=>no(request.error);});
 await new Promise<void>((yes,no)=>{const tx=db.transaction("credentials","readwrite");tx.objectStore("credentials").put(value,value.id);tx.oncomplete=()=>yes();tx.onerror=()=>no(tx.error);});
 },{id,accountKey:id,origin,hubId:computer.computer.hubId,name:"Runtime test",accountId:login.session.userId,accessToken:token,refreshToken:authority.accounts.issueRefresh(login.session.id),expiresAt:Date.now()+300000,identity:{name,method:"password",key:login.session.userId}});
 await target.goto(clientOrigin);
 await target.getByRole("button", {name:"Hubs & computers",exact:true}).first().waitFor();
 await target.waitForFunction(()=>!!navigator.serviceWorker.controller);
}
async function manage(){
 await page.getByRole("button",{name:"Hubs & computers",exact:true}).first().click();
 const dialog=page.getByRole("dialog",{name:"Hubs & computers",exact:true});await dialog.locator(".connectionHub summary").click();
 await dialog.locator("[data-computer]").first().click();await page.getByRole("button",{name:"Manage access",exact:true}).click();
 await page.locator('.workspace-form[data-member="member"]').waitFor();
}
async function grant(options:{id?:string;paths?:string;access?:string;git?:boolean;uploads?:boolean;transcode?:boolean}={}){
 const form=page.locator('.workspace-form[data-member="member"]');await form.getByLabel("Approved workspace",{exact:true}).selectOption(options.id??"default");
 await form.getByLabel("Workspace access for Member",{exact:true}).selectOption(options.access??"write");
 await form.locator('[name="paths"]').fill(options.paths??".");
 for(const name of ["git","uploads","transcode"] as const){const checkbox=form.locator(`[name="${name}"]`);const checked=options[name]??false;if(await checkbox.isChecked()!==checked)await checkbox.locator("..").click();assert.equal(await checkbox.isChecked(),checked);}
 const saved=page.waitForResponse((r:any)=>r.url().includes("workspace-access/member")&&r.request().method()==="PUT");await form.getByRole("button",{name:"Save file access",exact:true}).click();const response=await saved;assert.equal(response.status(),200,await response.text());
}
async function memberFetch(path:string,body?:unknown,headers?:Record<string,string>){return member.evaluate(async({path,body,headers}:any)=>{const r=await fetch(path,{method:body===undefined?"GET":"POST",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});const text=await r.text();return {status:r.status,headers:Object.fromEntries(r.headers),text};},{path,body,headers});}
let globalId="";
try{
 await mkdir("artifacts",{recursive:true});await until(async()=>{try{return(await fetch(clientOrigin+"/health")).ok;}catch{return false;}});
 await service.start();await until(()=>tunnels.online(computer.computer.id));
 const created=await nativeRuntime.execute({op:"create",agentId:"delegated-fixture",backend:"pi",name:"Delegated native process"}) as {localId:string};ownedSessionIds.add(created.localId);
 await until(async()=>(await nativeRuntime.request(`/api/sessions/${created.localId}/state`)).readiness==="ready",60000);
 await seed(page,identityLogin,"owner-login","Alice");
 const imported=await page.evaluate(async({computerId,localId}:any)=>{const r=await fetch(`/api/client/hubs/owner-login/api/computers/${computerId}/import`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({localId,name:"Delegated native process"})});return{status:r.status,value:await r.json()};},{computerId:computer.computer.id,localId:created.localId});assert.equal(imported.status,200,JSON.stringify(imported.value));
 await page.reload();await page.locator(".session").filter({has:page.getByText("Delegated native process",{exact:true})}).click();
 await seed(member,memberLogin,"member-login","Member");await member.getByRole("textbox",{name:"Message",exact:true}).waitFor();
 globalId="member-login~"+store.read().agents.find(a=>a.localId===created.localId)!.id;
 const base=`/api/sessions/${globalId}`;
 await writeFile(join(workspace,"allowed.txt"),"allowed member text");await writeFile(join(workspace,"private.txt"),"unapproved private text");
 assert.equal((await memberFetch(base+"/file/read?path=allowed.txt")).status,403);
 await manage();await grant({paths:"allowed.txt"});
 delayCandidateRefresh=900;const delayedRefresh=member.waitForResponse((r:any)=>r.url().includes("/git/changed_files"));
 await member.getByRole("button",{name:"View file",exact:true}).click();await member.getByPlaceholder("Choose or search files").fill("allowed.txt");await(await delayedRefresh).finished();assert.equal(await member.getByPlaceholder("Choose or search files").inputValue(),"allowed.txt");await member.locator('.fileMenuItem:not(.fileMenuCreate)').filter({hasText:"allowed.txt"}).first().click();await member.locator("#fileViewer").getByText("allowed member text",{exact:true}).waitFor();
 assert.equal((await memberFetch(base+"/file/read?path=private.txt")).status,403);
 await member.getByRole("button",{name:"Edit file",exact:true}).click();await member.keyboard.press("Control+A");await member.keyboard.press("Backspace");await member.keyboard.type("member browser edit");await member.getByRole("button",{name:"Save file",exact:true}).click();await until(async()=>(await readFile(join(workspace,"allowed.txt"),"utf8"))==="member browser edit");
 await member.locator("#fileViewer").getByRole("button",{name:"Close",exact:true}).click();pass("Invited account reads and edits only owner-approved paths through the independent browser");
 await grant({paths:"allowed.txt",git:true});const history=await memberFetch(base+"/git/file_versions?path=tracked.txt");assert.equal(history.status,200,history.text);assert.equal(JSON.parse(history.text).base_text,"original line\n");
 await grant({paths:"allowed.txt"});assert.equal((await memberFetch(base+"/git/file_versions?path=tracked.txt")).status,403);pass("Full-repository history and diff capability is separate from working-file grants and revokes immediately");
 await grant({paths:"allowed.txt",uploads:true});
 const [picker]=await Promise.all([member.waitForEvent("filechooser"),member.getByRole("button",{name:/^Attach file/}).click()]);const uploading=member.waitForResponse((r:any)=>r.url().includes("inject_file")&&r.request().method()==="POST");await picker.setFiles({name:"member-upload.txt",mimeType:"text/plain",buffer:Buffer.from("member scoped attachment")});assert.equal((await uploading).status(),200);
 await member.locator("#stagedAttachments").getByText("member-upload.txt",{exact:true}).waitFor();
 const actorStage=await memberFetch(base+"/attachments"),stage=JSON.parse(actorStage.text).attachments[0];assert.equal(await readFile(stage.path,"utf8"),"member scoped attachment");
 const ownerStage=await page.evaluate(async (id:string)=>(await(await fetch(`/api/sessions/${id}/attachments`)).json()).attachments,globalId.replace("member-login~","owner-login~"));assert.deepEqual(ownerStage,[]);
 await grant({paths:"allowed.txt"});const deniedSend=await memberFetch(base+"/send",{text:"must remain unsent",request_id:"revoked-upload"});assert.equal(deniedSend.status,403,deniedSend.text);
 await grant({paths:"allowed.txt",uploads:true});
 assert.equal((await memberFetch(base+"/send",{text:"regrant cannot revive an old attachment",request_id:"regrant-upload"})).status,403);
 assert.equal((await memberFetch(base+"/attachments/clear",{})).status,200);
 const [freshPicker]=await Promise.all([member.waitForEvent("filechooser"),member.getByRole("button",{name:/^Attach file/}).click()]);
 const freshUpload=member.waitForResponse((r:any)=>r.url().includes("inject_file")&&r.request().method()==="POST");
 await freshPicker.setFiles({name:"member-upload.txt",mimeType:"text/plain",buffer:Buffer.from("member scoped attachment")});assert.equal((await freshUpload).status(),200);
 await member.getByRole("textbox",{name:"Message",exact:true}).fill("DELEGATED_UPLOAD_SENT");const sending=member.waitForResponse((r:any)=>r.url().includes("/send")&&r.request().method()==="POST");await member.getByRole("button",{name:"Send",exact:true}).click();const confirm=member.getByRole("button",{name:"Send now",exact:true});if(await confirm.isVisible())await confirm.click();assert.equal((await sending).status(),200);await until(()=>latestMessages.includes("member-upload.txt"));assert.ok(latestMessages.includes("DELEGATED_UPLOAD_SENT"));
 pass("Normal member file picker stages actor-private bytes; changed upload grant blocks injection/send and the current grant sends to installed Pi");
 const video=join(workspace,"clip.webm");execFileSync(process.env.FFMPEG_BIN??"ffmpeg",["-nostdin","-v","error","-f","lavfi","-i","color=c=blue:s=64x64:d=0.4","-c:v","libvpx","-y",video]);
 await member.evaluate(()=>{
   const input=document.querySelector<HTMLInputElement>('#filePickerInput')??document.querySelector<HTMLInputElement>('[placeholder="Choose or search files"]')!;
   const descriptor=Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value')!;
   const trace:unknown[]=[];(window as any).pickerTrace=trace;
   Object.defineProperty(input,'value',{get(){return descriptor.get!.call(this);},set(value){trace.push({value,stack:new Error().stack,active:document.activeElement?.id});descriptor.set!.call(this,value);}});
   for(const name of ['focus','blur','input'])input.addEventListener(name,()=>trace.push({event:name,value:input.value,active:document.activeElement?.id}));
 });
 await grant({paths:"allowed.txt\nclip.webm",transcode:true});const preview=await memberFetch(base+"/file/video_preview?path=clip.webm",undefined,{range:"bytes=0-31"});assert.equal(preview.status,206,preview.text);assert.equal(preview.headers["content-range"].startsWith("bytes 0-31/"),true);
 delayCandidateRefresh=900;const delayedVideoRefresh=member.waitForResponse((r:any)=>r.url().includes("/git/changed_files"));
 await member.getByRole("button",{name:"View file",exact:true}).click();
 const searching=member.waitForResponse((r:any)=>r.url().includes("/file/search?")&&r.url().includes("clip.webm"));
 await member.getByPlaceholder("Choose or search files").fill("clip.webm");const search=await searching;assert.equal(search.status(),200);assert.ok((await search.json()).matches.some((f:any)=>f.path==="clip.webm"));
 await(await delayedVideoRefresh).finished();assert.equal(await member.getByPlaceholder("Choose or search files").inputValue(),"clip.webm");
 await member.locator('.fileMenuItem:not(.fileMenuCreate)').filter({hasText:"clip.webm"}).first().click();await member.locator("#fileViewer video").waitFor();await member.locator("#fileViewer").getByRole("button",{name:"Close",exact:true}).click();
 await grant({paths:"allowed.txt\nclip.webm"});assert.equal((await memberFetch(base+"/file/video_preview?path=clip.webm")).status,403);pass("Member video preview uses approved source, scoped processing/cache and byte ranges; revocation blocks cached previews");
 const second=join(home,"second-workspace");await mkdir(second);await writeFile(join(second,"second.txt"),"second root bytes");
 const rootForm=page.locator(".workspace-root-form");await rootForm.getByLabel("Workspace name",{exact:true}).fill("Second approved workspace");await rootForm.getByLabel("Absolute directory on this Computer",{exact:true}).fill(second);const approving=page.waitForResponse((r:any)=>r.url().endsWith(`/computers/${computer.computer.id}/workspace`)&&r.request().method()==="PUT");await rootForm.getByRole("button",{name:"Approve workspace",exact:true}).click();const roots=(await(await approving).json()).roots;const secondId=roots.find((root:any)=>root.path===second).id;
 await page.locator('.workspace-form[data-member="member"]').waitFor();await grant({id:secondId,paths:"second.txt"});
 const secondProcess=await nativeRuntime.execute({op:"create",agentId:"second-fixture",backend:"pi",name:"Second delegated process",launch:{cwd:second}}) as {localId:string};ownedSessionIds.add(secondProcess.localId);
 const importedSecond=await page.evaluate(async({computerId,localId}:any)=>{const r=await fetch(`/api/client/hubs/owner-login/api/computers/${computerId}/import`,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({localId,name:"Second delegated process"})});return{status:r.status,value:await r.json()};},{computerId:computer.computer.id,localId:secondProcess.localId});assert.equal(importedSecond.status,200);
 const secondGlobal="member-login~"+store.read().agents.find(a=>a.localId===secondProcess.localId)!.id;
 const secondRead=await memberFetch(`/api/sessions/${secondGlobal}/file/read?workspace_id=${secondId}&path=second.txt`);assert.equal(secondRead.status,200,secondRead.text);assert.equal(JSON.parse(secondRead.text).text,"second root bytes");
 assert.equal((await memberFetch(`/api/sessions/${secondGlobal}/file/read?path=second.txt`)).status,403);
 const removal=page.waitForResponse((r:any)=>r.url().endsWith(`/computers/${computer.computer.id}/workspace`)&&r.request().method()==="PUT");await page.locator(`[data-remove-workspace="${secondId}"]`).click();assert.equal((await removal).status(),200);assert.equal((await memberFetch(`/api/sessions/${secondGlobal}/file/read?workspace_id=${secondId}&path=second.txt`)).status,403);
 pass("Owner browser approves a second stable root and independent path grant; root removal revokes actual member access without changing the default grant");
 await grant({access:""});assert.equal((await memberFetch(base+"/file/read?path=allowed.txt")).status,403);
 assert.deepEqual(errors,[]);await member.screenshot({path:"artifacts/delegated-workspaces-member.png",fullPage:true});
 await writeFile("artifacts/delegated-workspaces-browser-results.json",JSON.stringify({passed:true,checks,errors,browserVersion:browser.version(),runtime:"installed Pi, independent Hub and static client",provider:"controlled stream; no live inference"},null,2));
}catch(error){await page.screenshot({path:"artifacts/delegated-workspaces-owner-failure.png"}).catch(()=>{});await member.screenshot({path:"artifacts/delegated-workspaces-member-failure.png"}).catch(()=>{});console.error("PICKER",await member.evaluate(()=>(window as any).pickerTrace));console.error("OWNER",(await page.locator("body").innerText()).slice(-3000));console.error("MEMBER",(await member.locator("body").innerText()).slice(-3000));await writeFile("artifacts/delegated-workspaces-browser-results.json",JSON.stringify({passed:false,checks,errors:[...errors,String(error)]},null,2));throw error;
}finally{
 await browser.close();for(const id of ownedSessionIds)await nativeRuntime.request(`/api/sessions/${id}/delete`,"POST").catch(()=>{});staticClient.kill("SIGTERM");await service.stop();for(const socket of ownedHubConnections)socket.destroy();provider.server.closeAllConnections();await provider.close();hub.server.closeAllConnections();await hub.close();identity.server.closeAllConnections();await identity.close();notifications.close();sessions.close();store.close();nativeRuntime.close();
}
