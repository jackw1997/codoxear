// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, mkdir, writeFile } from "node:fs/promises";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const { password } = JSON.parse(await readFile("/demo-data/demo.json", "utf8"));
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH, args: ["--no-sandbox", "--disable-dev-shm-usage"] });
const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
const page = await context.newPage(), checks = [], errors = [];
page.setDefaultTimeout(30000);
page.on("pageerror", e => errors.push(e.message));
page.on("response", async r => {
  if (r.url().includes("/messages/") && r.headers()["content-type"]?.includes("application/json")) {
    const v = await r.json().catch(() => ({}));
    console.log("Transcript", r.status(), JSON.stringify({ error: v.error, events: v.events?.length, bound: v.bound, cursor: v.cursor }));
  }
});
const pass = s => { checks.push(s); console.log("PASS", s); };
const origin = "https://codoxear.gzeek.com:8445";
let passed = false;
try {
  await mkdir("artifacts", { recursive: true });
  await page.goto(origin + "/");
  const hubs = () => page.getByRole("dialog", { name: "Hubs & computers", exact: true });
  await hubs().getByRole("button", { name: "Add hub", exact: true }).click();
  const add = page.getByRole("dialog", { name: "Add hub", exact: true });
  await add.getByLabel("Hub address").fill("https://codoxear.gzeek.com:8446");
  const popupEvent = context.waitForEvent("page");
  await add.getByRole("button", { name: "Connect hub", exact: true }).click();
  const popup = await popupEvent;
  await popup.getByLabel("Email", { exact: true }).fill("alice@example.test");
  await popup.getByLabel("Password", { exact: true }).fill(password);
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await popup.waitForEvent("close");
  await hubs().getByText("Home demo", { exact: true }).waitFor();
  const summary = hubs().locator("summary").filter({ hasText: "Home demo" });
  if (!(await summary.evaluate(el => el.parentElement.open))) await summary.click();
  await hubs().getByRole("button", { name: "Home laptop", exact: false }).waitFor();
  assert.equal(await hubs().getByText("This is a static client.", { exact: false }).count(), 0);
  pass("Public hub controls load computers without the reported static-client error");
  await hubs().getByRole("button", { name: "Back", exact: true }).click();
  await page.locator("#newBtn").click();
  const dialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await dialog.waitFor();
  await dialog.getByLabel("Computer & hub", { exact: true }).selectOption({ label: "Home laptop · Home demo" });
  const submit = dialog.getByRole("button", { name: "Create agent", exact: true });
  for (let i = 0; i < 100 && !(await submit.isEnabled()); i++) await page.waitForTimeout(100);
  assert.ok(await submit.isEnabled());
  for (const runtime of ["pi", "codex", "cc"]) {
    await dialog.getByLabel("Runtime", { exact: true }).selectOption(runtime);
    await dialog.getByLabel("Provider", { exact: true }).selectOption({ label: "Custom API" });
    assert.ok(await dialog.getByLabel("API URL", { exact: true }).isVisible());
    assert.ok(await dialog.getByLabel("API key", { exact: true }).isVisible());
    assert.ok(await dialog.getByLabel("Custom model", { exact: true }).isVisible());
    pass(`${runtime}: deployed creation form exposes private endpoint, API key and model`);
  }
  await dialog.getByLabel("Runtime", { exact: true }).selectOption("pi");
  await dialog.getByLabel("Provider", { exact: true }).selectOption({ label: "Custom API" });
  const name = "Private API verified " + Date.now();
  await dialog.getByLabel("Agent name", { exact: true }).fill(name);
  await dialog.getByLabel("API URL", { exact: true }).fill("http://127.0.0.1:19580/v1");
  await dialog.getByLabel("API key", { exact: true }).fill("demo-only");
  await dialog.getByLabel("Custom model", { exact: true }).fill("demo");
  await dialog.getByLabel("API compatibility", { exact: true }).selectOption("openai-completions");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: "artifacts/private-provider-live-mobile.png", fullPage: true });
  assert.ok(await dialog.getByLabel("API URL", { exact: true }).isVisible());
  assert.ok(await dialog.getByLabel("API key", { exact: true }).isVisible());
  pass("Pi provider URL and key are available at phone width");
  await page.setViewportSize({ width: 1440, height: 1000 });
  await dialog.getByRole("button", { name: "Create agent", exact: true }).click();
  await dialog.waitFor({ state: "hidden", timeout: 45000 });
  const created = page.locator(".session").filter({ has: page.getByText(name, { exact: true }) });
  await created.waitFor();
  await created.click();
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("Verify this newly created private API agent responds.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText("Demo (scripted model): received your message.", { exact: false }).first().waitFor({ timeout: 45000 });
  pass("Created a real Pi agent with entered provider URL/key/model and received its response through the public UI");
  await page.reload();
  await page.locator("#newBtn").waitFor();
  await page.locator(".session").filter({ has: page.getByText(name, { exact: true }) }).click();
  await page.getByText("Demo (scripted model): received your message.", { exact: false }).first().waitFor();
  pass("Created agent and transcript survive browser reload");
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  await page.screenshot({ path: "artifacts/private-provider-live-failure.png", fullPage: true });
  throw error;
} finally {
  await writeFile("artifacts/private-provider-live-results.json", JSON.stringify({ passed, origin, checks, errors }, null, 2));
  await browser.close();
}
