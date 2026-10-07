// @ts-nocheck -- Docker-only cold recovery acceptance; creates no agents.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
assert.ok(existsSync("/.dockerenv"), "Cold recovery browser acceptance requires Docker");
async function privateJson(file: string) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw Error("Acceptance input is missing or invalid"); }
}
const owner = await privateJson(process.env.FRESH_OWNER_FILE ?? "/private/owner.json");
const launch = await privateJson(process.env.FRESH_PROVIDER_FILE ?? "/private/pi-litellm-launch.json");
const previous = await privateJson(process.env.FRESH_PREVIOUS_RESULTS ?? "artifacts/fresh-managed/results.json");
assert.equal(previous.passed, true, "Previous live acceptance must have passed");
assert.equal(previous.delegationRequested, true, "Previous acceptance must include its real delegated child");
const match = /^Live fresh acceptance ([a-f0-9]{12})$/.exec(previous.createdAgent);
assert.ok(match, "Previous result must identify its existing parent");
const tag = match[1], parentName = previous.createdAgent, childName = `Live child ${tag}`;
const parentToken = `FRESH_REPLY_${tag}`, childToken = `CHILD_REPLY_${tag}`;
const client = process.env.FRESH_CLIENT_URL ?? "https://codoxear.gzeek.com:8445";
const hub = process.env.FRESH_HUB_URL ?? "https://codoxear.gzeek.com:8446";
const artifacts = process.env.FRESH_RECOVERY_ARTIFACTS ?? "artifacts/fresh-recovery";
const searchOnly = process.env.FRESH_SEARCH_ONLY === "1";
function sanitize(value: unknown) {
  let text = String(value ?? "");
  for (const secret of [owner.password, launch.provider_config?.api_key, launch.provider_config?.base_url]) {
    if (typeof secret !== "string" || !secret) continue;
    for (const encoded of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)]) text = text.split(encoded).join("[redacted]");
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/g, address => {
    try { const u = new URL(address); u.username = ""; u.password = ""; u.search = ""; u.hash = ""; return u.href; }
    catch { return "[redacted URL]"; }
  });
  return text.replace(/([?&][A-Za-z0-9_-]+=)[^&#\s"'<>]+/g, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]").slice(0, 3000);
}
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(60000);
const checks: string[] = [];
const transportDiagnostics: unknown[] = [], consoleErrors: unknown[] = [];
let serviceWorker = null;
let step = "login", passed = false, failure = null, failureScreenshot = false, pageErrors = 0;
const remember = (list: unknown[], value: unknown) => { if (list.length < 100) list.push(value); };
const relevant = (address: string) => /\/(messages|live|state)(?:[/?#]|$)/.test(address);
page.on("pageerror", error => {
  pageErrors += 1;
  remember(consoleErrors, { source: "pageerror", name: sanitize(error.name), message: sanitize(error.message) });
});
context.on("console", message => {
  if (message.type() === "error") remember(consoleErrors, { source: "context-console", message: sanitize(message.text()),
    location: sanitize(message.location()?.url ?? "") });
});
page.on("requestfailed", request => {
  if (!relevant(request.url())) return;
  const value = { kind: "requestfailed", url: sanitize(request.url()), method: request.method(), error: sanitize(request.failure()?.errorText) };
  remember(transportDiagnostics, value);
  console.log("Transport", JSON.stringify(value));
});
page.on("response", async response => {
  if (!relevant(response.url())) return;
  const value: Record<string, unknown> = { kind: "response", url: sanitize(response.url()), status: response.status() };
  // Never read SSE bodies (they may never end). JSON diagnostics select only
  // status metadata; transcript text, messages and authenticated headers stay private.
  if (response.headers()["content-type"]?.includes("application/json")) {
    const body = await response.json().catch(() => null);
    if (body && typeof body === "object") {
      if (typeof body.error === "string") value.error = sanitize(body.error);
      if (typeof body.bound === "boolean") value.bound = body.bound;
      if (typeof body.cursor === "string" || typeof body.cursor === "number" || body.cursor === null) value.cursor = typeof body.cursor === "string" ? sanitize(body.cursor) : body.cursor;
    }
  }
  remember(transportDiagnostics, value);
  console.log("Transport", JSON.stringify(value));
});
async function controllerDiagnostics() {
  try {
    serviceWorker = await page.evaluate(async () => ({
      supported: "serviceWorker" in navigator,
      controller: navigator.serviceWorker?.controller ? { scriptURL: navigator.serviceWorker.controller.scriptURL, state: navigator.serviceWorker.controller.state } : null,
      registrations: "serviceWorker" in navigator ? (await navigator.serviceWorker.getRegistrations()).map(registration => ({
        scope: registration.scope, active: registration.active?.state ?? null, waiting: registration.waiting?.state ?? null,
      })) : [],
    }));
    // Service worker URLs can contain deployment query values; sanitize before saving.
    serviceWorker = JSON.parse(sanitize(JSON.stringify(serviceWorker)));
  } catch (error) { serviceWorker = { error: sanitize(error instanceof Error ? error.message : error) }; }
  console.log("Controller", JSON.stringify(serviceWorker));
  for (const error of consoleErrors) console.log("BrowserError", JSON.stringify(error));
}
const pass = (text: string) => { checks.push(text); console.log("PASS", text); };
const card = (name: string) => page.locator(".session").filter({ has: page.getByText(name, { exact: true }) });
const answers = (token: string) => page.locator(".msg.assistant:not(.typing):not(.error):not(.warning) .md").filter({ hasText: token });
async function sendAndRequireNewAnswer(text: string, token: string) {
  const before = await answers(token).count();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
  // A prior identical answer cannot satisfy this assertion. Inspect only the
  // markdown body, excluding timestamps and other surrounding message chrome.
  await page.waitForFunction(({ token, before }) => [...document.querySelectorAll(".msg.assistant:not(.typing):not(.error):not(.warning) .md")]
    .filter(node => node.innerText.trim() === token).length > before, { token, before }, { timeout: 240000 });
  assert.equal((await answers(token).last().innerText()).trim(), token);
}
try {
  await mkdir(artifacts, { recursive: true });
  await page.goto(client + "/");
  const hubs = page.getByRole("dialog", { name: "Hubs & computers", exact: true });
  await hubs.getByRole("button", { name: "Add hub", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add hub", exact: true });
  await add.getByLabel("Hub address").fill(hub);
  const popupPromise = context.waitForEvent("page");
  await add.getByRole("button", { name: "Connect hub", exact: true }).click();
  const popup = await popupPromise;
  await popup.getByLabel("Email", { exact: true }).fill(owner.email);
  await popup.getByLabel("Password", { exact: true }).fill(owner.password);
  const closed = popup.waitForEvent("close");
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await closed;
  await hubs.locator("summary").filter({ hasText: process.env.FRESH_HUB_NAME ?? "Hub 1" }).waitFor();
  await hubs.getByRole("button", { name: "Back", exact: true }).click();
  step = "saved transcripts";
  await card(parentName).waitFor();
  await card(parentName).click();
  await answers(parentToken).first().waitFor();
  assert.equal((await answers(parentToken).first().innerText()).trim(), parentToken);
  await card(childName).waitFor();
  await card(childName).click();
  await answers(childToken).first().waitFor();
  assert.equal((await answers(childToken).first().innerText()).trim(), childToken);
  pass("Both existing saved transcripts remain available after the owned service restart");
  if (searchOnly) {
    step = "managed search";
    await card(parentName).click();
    await answers(parentToken).first().waitFor();
    await page.locator("#chatSearchBtn").click();
    const searchResponse = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith("/search") && url.searchParams.get("q") === childToken.toLowerCase();
    });
    await page.locator("#chatSearchInput").fill(childToken);
    const response = await searchResponse;
    assert.equal(response.status(), 200);
    const search = await response.json();
    assert.ok(search.total >= 2);
    assert.ok(search.matches.every(match => match.text.toLowerCase().includes(childToken.toLowerCase())));
    await page.waitForFunction(() => /\d/.test(document.querySelector("#chatSearchStatus")?.textContent ?? ""));
    await page.locator("#chatSearchNextBtn").click();
    await page.locator("#chatSearchPrevBtn").click();
    pass("Real managed conversation search returns saved matches and browser match navigation works");
    await page.locator("#chatSearchCloseBtn").click();
    step = "managed neighbor";
    // Exercise the browser's authenticated Hub relay using the exact URL from
    // its successful search. Neither tokens nor full transcript bodies are logged.
    // Fetch inside the page so its service worker applies the authenticated
    // Hub mapping; APIRequestContext bypasses that client-owned transport.
    const neighbors = await page.evaluate(async address => {
      const url = new URL(address);
      url.search = new URLSearchParams({ q: "*", role: "user", limit: "200" }).toString();
      const counted = await fetch(url);
      const all = await counted.json();
      if (counted.status !== 200) return { countStatus: counted.status };
      const anchor = all.matches.slice().sort((a, b) => a.ts - b.ts)[0];
      url.pathname = url.pathname.replace(/\/search$/, "/messages/neighbor");
      url.search = new URLSearchParams({ role: "user", direction: "next", cursor: anchor.history_cursor }).toString();
      const next = await fetch(url);
      const body = await next.json();
      return { countStatus: counted.status, total: all.total, userOnly: all.matches.every(match => match.role === "user"),
        neighborStatus: next.status, sameLog: body.neighbor?.same_log, different: body.neighbor?.message_id !== anchor.message_id,
        role: body.neighbor?.role, transcriptState: body.transcript_state };
    }, response.url());
    assert.equal(neighbors.countStatus, 200);
    assert.ok(neighbors.total >= 2 && neighbors.userOnly);
    assert.equal(neighbors.neighborStatus, 200);
    assert.ok(neighbors.sameLog && neighbors.different);
    assert.equal(neighbors.transcriptState, "bound");
    assert.equal(neighbors.role, "user");
    pass("Authenticated public relay counts user turns and returns the next saved user message");
    const report = await page.request.get(client + "/oar-cutover.html");
    assert.equal(report.status(), 200);
    assert.ok((await report.text()).includes("The fresh OAR deployment is live"));
    pass("Readable public release report is available over valid HTTPS");
  } else {
  step = "parent cold context";
  await card(parentName).click();
  await sendAndRequireNewAnswer("From this conversation's history, repeat exactly the earlier reply token returned by your delegated child. No extra text, no tools, and do not create any agents.", childToken);
  pass("Cold parent resumes its prior context and recalls the child's earlier real answer");
  step = "revoke access";
  await card(parentName).hover();
  await card(parentName).getByRole("button", { name: "Edit conversation", exact: true }).click();
  await page.getByRole("button", { name: "Agent access", exact: true }).click();
  const access = page.getByRole("dialog", { name: "Agent access", exact: true });
  await access.getByRole("button", { name: "Disable access", exact: true }).click();
  await access.locator("[data-delegation-status]").filter({ hasText: "Subagent access is disabled or expired." }).waitFor();
  await access.getByRole("button", { name: "Back", exact: true }).click();
  const editCancel = page.locator("#editCancelBtn");
  if (await editCancel.isVisible()) await editCancel.click();
  pass("Parent delegation access is disabled through the real Agent access interface");
  step = "existing child remains usable";
  await card(childName).waitFor();
  await card(childName).click();
  await sendAndRequireNewAnswer("Repeat exactly your earlier reply from this conversation's history. No extra text and no tools.", childToken);
  pass("Disabling delegation preserves the existing child and direct owner conversation access");
  }
  await page.reload();
  await card(childName).waitFor();
  await card(childName).click();
  await answers(childToken).last().waitFor();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: `${artifacts}/child-recovery-mobile.png`, fullPage: true });
  assert.equal(pageErrors, 0);
  passed = true;
} catch (error) {
  failure = { name: sanitize(error instanceof Error ? error.name : "UnknownError"), message: sanitize(error instanceof Error ? error.message : error) };
  console.error(`Fresh recovery acceptance failed during ${step}: ${failure.name}: ${failure.message}`);
  await controllerDiagnostics();
  try {
    await page.screenshot({ path: `${artifacts}/failure-main.png`, fullPage: true,
      mask: [page.locator('input[type="password"], input[name="apiKey"], input[name="apiUrl"]')] });
    failureScreenshot = true;
  } catch { /* Keep the original sanitized failure. */ }
  process.exitCode = 1;
} finally {
  if (!serviceWorker) await controllerDiagnostics();
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ passed, step, checks, parentName, childName,
    pageErrorCount: pageErrors, failure, failureScreenshot, transportDiagnostics, consoleErrors, serviceWorker }, null, 2));
  await browser.close();
}
