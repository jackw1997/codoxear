import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, chmod, mkdir } from "node:fs/promises";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const phase = process.env.CODOXEAR_CATALOG_RECOVERY_PHASE ?? "after";
const origin = "https://codoxear.gzeek.com:8445";
const password = JSON.parse(await readFile("/demo-data/demo.json", "utf8")).password;
const playwright = await import(process.env.PLAYWRIGHT_MODULE ?? "@playwright/test");
const browser = await playwright.chromium.launch({ executablePath: process.env.CHROMIUM_PATH, headless: true, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const statePath = "/demo-data/catalog-recovery-browser-state.json";
const context = await browser.newContext({ viewport: { width: 390, height: 844 }, ignoreHTTPSErrors: false, ...(phase === "after" ? { storageState: statePath } : {}) });
const page = await context.newPage();
const errors: string[] = [];
const checks: string[] = [];
page.on("pageerror", (error: Error) => errors.push(error.message));
page.setDefaultTimeout(30000);
async function online(target: any) {
  const cdp = await context.newCDPSession(target);
  await cdp.send("Network.enable");
  await cdp.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "ethernet" });
}
async function addHub(port: number) {
  let connections = page.getByRole("dialog", { name: "Hubs & computers", exact: true });
  if (!(await connections.isVisible())) await page.getByRole("button", { name: "Hubs & computers", exact: true }).click();
  await connections.getByRole("button", { name: "Add hub", exact: true }).click();
  const panel = page.getByRole("dialog", { name: "Add hub", exact: true });
  await panel.getByLabel("Hub address").fill(`https://codoxear.gzeek.com:${port}`);
  const promise = context.waitForEvent("page");
  await panel.getByRole("button", { name: "Connect hub", exact: true }).click();
  const popup = await promise;
  popup.on("pageerror", (error: Error) => errors.push(error.message));
  await online(popup);
  await popup.getByLabel("Email", { exact: true }).fill("alice@example.test");
  await popup.getByLabel("Password", { exact: true }).fill(password);
  const closed = popup.waitForEvent("close");
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await closed;
  await page.waitForFunction(async () => {
    const request = indexedDB.open("codoxear-client-identities", 1);
    const db = await new Promise<IDBDatabase>((ok, bad) => { request.onsuccess = () => ok(request.result); request.onerror = () => bad(request.error); });
    const count = await new Promise<number>((ok, bad) => { const r = db.transaction("credentials").objectStore("credentials").count(); r.onsuccess = () => ok(r.result); r.onerror = () => bad(r.error); });
    db.close(); return count > 0;
  });
}
async function directory() {
  return await page.evaluate(async () => { const r = await fetch("/api/client/directory"); if (!r.ok) throw Error("Directory failed"); return await r.json(); });
}
function pass(label: string) { checks.push(label); console.log("PASS " + label); }
try {
  await online(page);
  await page.goto(origin, { waitUntil: "domcontentloaded" });
  if (phase === "before") {
    await page.getByRole("dialog", { name: "Hubs & computers", exact: true }).waitFor();
    await addHub(8446); await addHub(8447);
    const d = await directory(); assert.deepEqual(d.errors, []);
    await writeFile("/demo-data/catalog-recovery-baseline.json", JSON.stringify({ agents: d.agents.map((a: any) => ({ agentId: a.agentId, hubId: a.hubId })), count: d.agents.length }));
    await context.storageState({ path: statePath, indexedDB: true }); await chmod(statePath, 0o600);
    pass("Captured existing native-catalog browser logins before restoring the original Hub defaults");
  } else {
    const baseline = JSON.parse(await readFile("/demo-data/catalog-recovery-baseline.json", "utf8"));
    const expected = JSON.parse(await readFile("/demo-data/catalog-recovery-legacy.json", "utf8"));
    await page.waitForFunction(async () => (await (await fetch("/api/client/directory")).json()).errors.length === 0);
    let d = await directory();
    for (const a of baseline.agents) assert.ok(d.agents.some((v: any) => v.agentId === a.agentId));
    pass("Existing native-catalog agents remain accessible after restoring original defaults");
    await addHub(8446); await addHub(8447);
    await page.waitForFunction(async (ids: string[]) => { const d = await (await fetch("/api/client/directory")).json(); return ids.every(id => d.agents.some((a: any) => a.agentId === id)); }, expected.flatMap((h: any) => h.agents.map((a: any) => a.id)));
    d = await directory(); assert.deepEqual(d.errors, []);
    const old = expected.flatMap((h: any) => h.agents);
    for (const a of old) assert.ok(d.agents.some((v: any) => v.agentId === a.id));
    pass("Real browser sign-in restores all 19 original agents across the two existing Hubs");
    for (const a of baseline.agents) assert.ok(d.agents.some((v: any) => v.agentId === a.agentId));
    pass("Original and newly created agents coexist in the same authenticated browser directory");
    await page.evaluate(async () => {
      const request = indexedDB.open("codoxear-client-identities", 1);
      const db = await new Promise<IDBDatabase>((ok, bad) => { request.onsuccess = () => ok(request.result); request.onerror = () => bad(request.error); });
      await new Promise<void>((ok, bad) => { const tx = db.transaction("credentials", "readwrite"), store = tx.objectStore("credentials"), r = store.getAll(); r.onsuccess = () => { for (const login of r.result) store.put({ ...login, expiresAt: 0 }, login.id); }; tx.oncomplete = () => ok(); tx.onerror = () => bad(tx.error); }); db.close();
    });
    d = await directory(); assert.deepEqual(d.errors, []);
    for (const a of [...old.map((a: any) => ({ agentId: a.id })), ...baseline.agents]) assert.ok(d.agents.some((v: any) => v.agentId === a.agentId));
    pass("Actual OAuth refresh preserves logins and catalog visibility in both original and native realms");
    const connections = page.getByRole("dialog", { name: "Hubs & computers", exact: true });
    if (await connections.isVisible()) await connections.getByRole("button", { name: "Back", exact: true }).click();
    const catalog = await page.evaluate(async () => {
      const r = await fetch("/api/sessions");
      if (!r.ok) throw Error("Session catalog failed");
      return await r.json();
    });
    const originalIds = new Set(d.agents.filter((a: any) => old.some((v: any) => v.id === a.agentId)).map((a: any) => a.id));
    const candidate = catalog.sessions.find((s: any) => originalIds.has(s.session_id));
    assert.ok(candidate, "An original running session must appear in the browser session catalog");
    const target = page.locator(".session[data-session-id=" + JSON.stringify(candidate.session_id) + "]");
    await target.waitFor();
    const bounds = await target.boundingBox();
    if (!bounds || bounds.x < 0 || bounds.x >= 390) await page.getByRole("button", { name: "Toggle sidebar", exact: true }).click();
    await target.click();
    await page.waitForFunction(() => document.querySelector("#chatInner")?.textContent?.trim());
    pass("Original agent opens in the updated conversation interface");
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    pass("Recovered session UI fits the phone viewport without page errors");
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({ path: "artifacts/browser-catalog-recovery.png" });
    await writeFile("artifacts/browser-catalog-recovery-results.json", JSON.stringify({ checks, errors, restoredOriginalAgents: old.length, preservedNativeAgents: baseline.count, certificateExceptions: false }, null, 2));
  }
} finally { await browser.close(); }
