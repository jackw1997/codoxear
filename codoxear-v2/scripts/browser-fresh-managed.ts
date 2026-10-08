// @ts-nocheck -- Playwright acceptance fixture; run only in an owned Docker container.
import "./testing/frontend-artifact.js";
// Never save browser storage, request bodies, traces, credentials or raw errors.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
assert.ok(existsSync("/.dockerenv"), "Fresh live browser acceptance requires Docker");
async function privateJson(file: string) {
  try { return JSON.parse(await readFile(file, "utf8")); }
  catch { throw Error("Private live acceptance input is missing or invalid"); }
}
const owner = await privateJson(process.env.FRESH_OWNER_FILE ?? "/private/owner.json");
const launch = await privateJson(process.env.FRESH_PROVIDER_FILE ?? "/private/pi-litellm-launch.json");
assert.equal(launch.model, process.env.FRESH_EXPECTED_MODEL ?? "kimi-k3", "Preserved live model differs from acceptance target");
assert.ok(owner.email && owner.password && launch.provider_config?.api_key, "Private acceptance configuration is incomplete");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
const browser = await chromium.launch({ headless: true,
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage();
page.setDefaultTimeout(45000);
const checks: string[] = [];
let pageErrors = 0, passed = false, step = "connect", failure = null, failureScreenshot = false;
page.on("pageerror", () => { pageErrors += 1; });
const artifacts = process.env.FRESH_ARTIFACTS ?? "artifacts/fresh-managed";
const client = process.env.FRESH_CLIENT_URL ?? "https://codoxear.gzeek.com:8445";
const hub = process.env.FRESH_HUB_URL ?? "https://codoxear.gzeek.com:8446";
const sourceName = process.env.FRESH_SOURCE_COMPUTER ?? "Computer A";
const targetName = process.env.FRESH_TARGET_COMPUTER ?? "Computer B";
function sanitize(value: unknown) {
  let text = String(value ?? "");
  for (const secret of [owner.password, launch.provider_config?.api_key, launch.provider_config?.base_url]) {
    if (typeof secret !== "string" || !secret) continue;
    for (const encoded of [secret, encodeURIComponent(secret), JSON.stringify(secret).slice(1, -1)])
      text = text.split(encoded).join("[redacted]");
  }
  text = text.replace(/https?:\/\/[^\s"'<>]+/g, address => {
    try { const url = new URL(address); url.username = ""; url.password = ""; url.search = ""; url.hash = ""; return url.href; }
    catch { return "[redacted URL]"; }
  });
  text = text.replace(/([?&][A-Za-z0-9_-]+=)[^&#\s"'<>]+/g, "$1[redacted]")
    .replace(/\bBearer\s+[A-Za-z0-9._~+\/-]+/gi, "Bearer [redacted]");
  return text.slice(0, 3000);
}
const tag = randomBytes(6).toString("hex");
const name = `Live fresh acceptance ${tag}`;
const token = `FRESH_REPLY_${tag}`;
const pass = (check: string) => { checks.push(check); console.log("PASS", check); };
const card = (title: string) => page.locator(".session").filter({ has: page.getByText(title, { exact: true }) });
const assistant = (text: string) => page.locator(".msg.assistant:not(.typing):not(.error):not(.warning)").filter({ hasText: text });
async function send(text: string) {
  await page.getByRole("textbox", { name: "Message", exact: true }).fill(text);
  await page.getByRole("button", { name: "Send", exact: true }).click();
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
  const summary = hubs.locator("summary").filter({ hasText: process.env.FRESH_HUB_NAME ?? "Hub 1" });
  await summary.waitFor();
  if (!(await summary.evaluate(el => el.parentElement.open))) await summary.click();
  await hubs.getByRole("button", { name: sourceName, exact: false }).waitFor();
  await hubs.getByRole("button", { name: targetName, exact: false }).waitFor();
  await hubs.getByRole("button", { name: "Back", exact: true }).click();
  pass("Fresh owner connects to the public independent Hub and both Computers appear");

  step = "provider forms";
  await page.locator("#newBtn").click();
  const dialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await dialog.getByLabel("Computer & hub", { exact: true }).selectOption({ label: `${sourceName} · ${process.env.FRESH_HUB_NAME ?? "Hub 1"}` });
  await dialog.getByLabel("Runtime", { exact: true }).selectOption("pi");
  const submit = dialog.getByRole("button", { name: "Create agent", exact: true });
  await page.waitForFunction(() => {
    const button = document.querySelector('dialog[aria-label="New agent"] button[type="submit"]');
    return button && !button.disabled;
  });
  const initialProvider = await dialog.getByLabel("Provider", { exact: true }).inputValue();
  const initialModel = await dialog.getByLabel("Model", { exact: true }).inputValue();
  assert.equal(initialModel, launch.model, "Creation must select the actual configured model");
  assert.equal(initialProvider, "litellm", "Creation must select the actual configured provider");
  assert.equal(await dialog.getByLabel("Provider", { exact: true }).locator('option[value="litellm"]').count(), 1);
  assert.equal(await dialog.getByLabel("Model", { exact: true }).locator('option:checked').innerText(), launch.model);
  assert.equal(await dialog.getByLabel("Reasoning", { exact: true }).inputValue(), "off");
  pass("Creation shows the saved litellm provider, kimi-k3 model and off reasoning as explicit selections");
  for (const backend of ["pi", "codex", "cc"]) {
    await dialog.getByLabel("Runtime", { exact: true }).selectOption(backend);
    await dialog.getByLabel("Provider", { exact: true }).selectOption({ label: "Custom API" });
    for (const field of ["API URL", "API key", "Custom model"])
      assert.ok(await dialog.getByLabel(field, { exact: true }).isVisible());
    assert.equal(await dialog.getByLabel("API key", { exact: true }).getAttribute("type"), "password");
    pass(`${backend}: custom provider fields are available without creating an agent`);
  }
  await dialog.getByLabel("Runtime", { exact: true }).selectOption("pi");
  await dialog.getByLabel("Provider", { exact: true }).selectOption(initialProvider);
  await dialog.getByLabel("Model", { exact: true }).selectOption(initialModel);
  await dialog.getByLabel("Agent name", { exact: true }).fill(name);
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await submit.isVisible());
  pass("Fresh Pi creation remains usable at phone width");
  await page.setViewportSize({ width: 1440, height: 1000 });
  step = "live Pi turn";
  await submit.click();
  await dialog.waitFor({ state: "hidden", timeout: 90000 });
  await card(name).waitFor({ timeout: 90000 });
  await card(name).click();
  await send(`Reply with exactly ${token} and no other text. Do not use tools.`);
  await assistant(token).first().waitFor({ timeout: 180000 });
  assert.equal((await assistant(token).first().locator(".md").innerText()).trim(), token);
  pass("A newly created managed Pi returns the requested real LiteLLM response");
  step = "reload history";
  await page.reload();
  await card(name).waitFor();
  await card(name).click();
  await assistant(token).first().waitFor({ timeout: 90000 });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.ok(await assistant(token).first().isVisible());
  await page.screenshot({ path: `${artifacts}/reply-mobile.png`, fullPage: true });
  pass("Real assistant history survives reload and is visible at phone width");

  if (process.env.FRESH_VERIFY_DELEGATION === "1") {
    step = "same-Hub delegation";
    await page.setViewportSize({ width: 1440, height: 1000 });
    await card(name).hover();
    await card(name).getByRole("button", { name: "Edit conversation", exact: true }).click();
    await page.getByRole("button", { name: "Agent access", exact: true }).click();
    const access = page.getByRole("dialog", { name: "Agent access", exact: true });
    await access.getByLabel(targetName, { exact: true }).check();
    await access.getByRole("button", { name: "Enable subagents", exact: true }).click();
    await access.locator("[data-delegation-status]").filter({ hasText: "Subagent access enabled" }).waitFor({ timeout: 90000 });
    await access.getByRole("button", { name: "Back", exact: true }).click();
    // Close the underlying edit modal explicitly if it remains mounted.
    const editClose = page.locator("#editViewer").getByRole("button", { name: /^(Close|Cancel)$/ });
    if (await editClose.first().isVisible().catch(() => false)) await editClose.first().click();
    const childName = `Live child ${tag}`, childToken = `CHILD_REPLY_${tag}`;
    await send(`Use codoxear_delegate to discover allowed targets, then spawn exactly one Pi child named "${childName}" on ${targetName} with model "${launch.model}", model_provider "litellm", cwd "/home/node/workspace". Use requestId "fresh-${tag}". Send that child: "Reply with exactly ${childToken} and no other text; do not use tools." Read its messages until the actual assistant answer arrives, and then report that answer. Do not simulate tool results or spawn additional children.`);
    await card(childName).waitFor({ timeout: 240000 });
    await card(childName).click();
    await assistant(childToken).first().waitFor({ timeout: 240000 });
    assert.equal((await assistant(childToken).first().locator(".md").innerText()).trim(), childToken);
    pass("Parent Pi uses delegated tools to create and message a real child on Computer B");
  }
  assert.equal(pageErrors, 0, "No browser runtime exceptions expected");
  passed = true;
} catch (error) {
  failure = { name: sanitize(error instanceof Error ? error.name : "UnknownError"),
    message: sanitize(error instanceof Error ? error.message : error) };
  console.error(`Fresh managed browser acceptance failed during ${step}: ${failure.name}: ${failure.message}`);
  try {
    await page.screenshot({ path: `${artifacts}/failure-main.png`, fullPage: true,
      mask: [page.locator('input[type="password"], input[name="apiKey"], input[name="apiUrl"]')] });
    failureScreenshot = true;
  } catch { /* Preserve the original sanitized failure if the main page closed. */ }
  process.exitCode = 1;
} finally {
  await writeFile(`${artifacts}/results.json`, JSON.stringify({ passed, step, checks, pageErrorCount: pageErrors,
    delegationRequested: process.env.FRESH_VERIFY_DELEGATION === "1", createdAgent: name, failure, failureScreenshot }, null, 2));
  await browser.close();
}
