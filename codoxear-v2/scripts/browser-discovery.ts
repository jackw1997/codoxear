// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import { workspaceAsset } from "../src/hub/workspace.ts";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const errors = [], checks = [];
let mode = "loading";
let release;
let wait = new Promise((r) => { release = r; });
const app = Fastify();
const agent = { id: "agent", localId: "local", computerId: "computer", computerName: "Test computer", name: "Kimi", state: "ready" };
app.get("/api/agent-directory", async () => ({ agents: mode === "empty" ? [] : [agent], placements: [] }));
app.get("/workspace/api/sessions", async (_r, reply) => {
  if (mode === "loading") await wait;
  if (mode === "hub") return reply.code(503).send({ error: "hidden fixture token" });
  if (mode === "signed_out") return reply.code(401).send({ error: "hidden fixture token" });
  return { sessions: mode === "empty" || mode === "computer" ? [] : [{ session_id: "agent", alias: "Kimi", agent_backend: "pi", cwd: "/workspace", updated_ts: 1000 }], catalog_errors: mode === "computer" ? [{ computerId: "computer", computerName: "Test computer" }] : [] };
});
app.get("/setup", async (_r, reply) => reply.type("text/html").send("<!doctype html><title>Setup</title>"));
app.get("/*", async (r, reply) => {
  try { const asset = await workspaceAsset("dist/client", r.params["*"], {issuer:"local-client",accountId:"test",hubId:"hub",computerId:"all"}); return reply.type(asset.type).send(asset.body); }
  catch { return reply.code(404).send({error:"Fixture route unavailable"}); }
});
const origin = await app.listen({host:"127.0.0.1",port:0});
await mkdir("artifacts",{recursive:true});
const browser = await chromium.launch({headless:true,...(process.env.CHROMIUM_PATH ? {executablePath:process.env.CHROMIUM_PATH} : {}),args:["--no-sandbox","--disable-dev-shm-usage"]});
try {
  for (const width of [390, 1440]) {
    const context = await browser.newContext({viewport:{width,height:900}});
    const page = await context.newPage();
    page.on("pageerror",err=>errors.push(err.message));
    await page.goto(origin + "/setup");
    await page.evaluate(async (origin) => {
      const db = await new Promise((resolve,reject) => { const r=indexedDB.open("codoxear-client-identities",1);r.onupgradeneeded=()=>r.result.createObjectStore("credentials");r.onsuccess=()=>resolve(r.result);r.onerror=()=>reject(r.error); });
      await new Promise((resolve,reject) => {const tx=db.transaction("credentials","readwrite");tx.objectStore("credentials").put({id:"login",accountKey:"account",hubId:"hub",origin,name:"Test hub",accountId:"test",accessToken:"fixture-token",refreshToken:"fixture-refresh",expiresAt:Date.now()+3600000,identity:{name:"Test",method:"password",key:"test"}},"login");tx.oncomplete=resolve;tx.onerror=reject;});
    },origin);
    mode = "loading";
    wait = new Promise((r) => { release = r; });
    await page.goto(origin);
    {
      await page.locator(".chatEmptyCopy").filter({hasText:"Discovering sessions"}).waitFor();
      await page.locator(".sessionDiscoveryStatus").filter({hasText:"Discovering sessions"}).waitFor({state:"attached"});
      assert.equal(await page.getByText("No sessions yet",{exact:true}).count(),0);
      mode="ready"; release();
    }
    await page.locator(".session").filter({hasText:"Kimi"}).waitFor({state:"attached"});
    mode="computer";
    await page.getByText("Computer is unreachable.",{exact:false}).waitFor({timeout:25000,state:"attached"}).catch(async e=>{await page.screenshot({animations:"disabled",path:"artifacts/discovery-failure.png"});throw e;});
    assert.ok(await page.locator(".session").filter({hasText:"Kimi"}).count(), "Authorized record remains while computer unavailable");
    if (width === 390) await page.getByRole("button",{name:"Toggle sidebar"}).click();
    await page.screenshot({animations:"disabled",path:`artifacts/discovery-unreachable-${width}.png`});
    mode="ready";
    await page.getByRole("button",{name:"Retry discovery"}).click();
    await page.waitForFunction(()=>!document.querySelector(".sessionDiscoveryStatus"));
    mode="hub";
    await page.getByText("Hub catalog unavailable.",{exact:false}).waitFor({timeout:25000,state:"attached"});
    assert.equal(await page.getByText("No sessions yet",{exact:true}).count(),0);
    assert.equal(await page.getByText("hidden fixture token",{exact:false}).count(),0);
    mode="signed_out";
    await page.getByRole("button",{name:"Retry discovery"}).click();
    await page.getByText("Sign in to this hub again.",{exact:false}).waitFor();
    mode="empty";
    await page.getByRole("button",{name:"Retry discovery"}).click();
    await page.getByText("No sessions yet",{exact:true}).waitFor();
    assert.equal(await page.locator(".sessionDiscoveryStatus").count(),0);
    await page.screenshot({animations:"disabled",path:`artifacts/discovery-${width}.png`});
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    assert.equal(overflow,false,"No horizontal overflow");
    checks.push(`${width}: loading, authorized offline retention, retry recovery, hub failure, signed out, confirmed empty, no horizontal overflow`);
    console.log("PASS",checks.at(-1));
    await context.close();
  }
  assert.deepEqual(errors,[],"No browser page errors");
  await writeFile("artifacts/browser-discovery-results.json",JSON.stringify({passed:true,checks,errors},null,2));
} finally {await browser.close();await app.close();}
