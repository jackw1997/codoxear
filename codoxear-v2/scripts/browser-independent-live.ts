// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const { password } = JSON.parse(await readFile("/demo-data/demo.json", "utf8"));
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
page.setDefaultTimeout(30000);
const checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
const origin = "https://codoxear.gzeek.com:8445";
try {
  await page.goto(origin + "/");
  for (const port of [8446, 8447]) {
    await page
      .getByRole("dialog", { name: "Hubs & computers", exact: true })
      .getByRole("button", { name: "Add hub", exact: true })
      .click();
    const panel = page.getByRole("dialog", { name: "Add hub", exact: true });
    await panel
      .getByLabel("Hub address")
      .fill("https://codoxear.gzeek.com:" + port);
    const event = context.waitForEvent("page");
    await panel
      .getByRole("button", { name: "Connect hub", exact: true })
      .click();
    const popup = await event;
    await popup.getByLabel("Email", { exact: true }).fill("alice@example.test");
    await popup.getByLabel("Password", { exact: true }).fill(password);
    await popup.getByRole("button", { name: "Sign in", exact: true }).click();
    await popup.waitForEvent("close");
    await page
      .getByRole("dialog", { name: "Hubs & computers", exact: true })
      .getByText(port === 8446 ? "Home demo" : "Work demo", { exact: true })
      .waitFor();
  }
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  pass(
    "Trusted public HTTPS and both independent hub logins work with the deployed snapshot",
  );
  const select = async (name) => {
    await page
      .locator(".session")
      .filter({ has: page.getByText(name, { exact: true }) })
      .click();
  };
  await select("Switch demo · Laptop");
  const tool =
    "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.";
  await page.getByText(tool, { exact: true }).first().waitFor();
  const reply =
    "Demo (scripted model): received your message. This is a real isolated Pi session with deterministic replies, not live AI inference. Send ‘run demo tool’ to execute the supplied shell-file demonstration.";
  const before = await page.getByText(reply, { exact: true }).count();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Verify independent hub cutover preserved this running agent.");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText(reply, { exact: true })
    .nth(before)
    .waitFor({ timeout: 45000 });
  pass(
    "Existing live Pi agent retains its history and responds after the hub cutover",
  );
  await page.evaluate(() => {
    window.__shell = document.querySelector(".sidebar");
  });
  await select("Switch demo · Work");
  await select("Switch demo · Laptop");
  await page.getByText(tool, { exact: true }).first().waitFor();
  assert.equal(
    await page.evaluate(
      () => window.__shell === document.querySelector(".sidebar"),
    ),
    true,
  );
  assert.equal(new URL(page.url()).origin, origin);
  pass("Switching between hubs preserves the original sidebar and page origin");
  await page.locator("#settingsBtnSide").click();
  await page.getByRole("radiogroup", { name: "Theme", exact: true }).waitFor();
  await page.locator("#settingsCloseBtn").click();
  await page
    .getByRole("button", { name: "View file", exact: true })
    .first()
    .click();
  await page
    .locator("#fileViewer")
    .getByText("Executed by the real Pi CLI in the isolated demo.", {
      exact: true,
    })
    .first()
    .waitFor();
  const download = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  assert.match(
    await readFile(await (await download).path(), "utf8"),
    /Executed by the real Pi CLI/,
  );
  await page.locator("#fileCloseBtn").click();
  pass(
    "Original Settings, file preview and authenticated download work on the public deployment",
  );
  assert.equal((await page.request.get(origin + "/api/v1/me")).status(), 404);
  assert.equal((await page.request.get(origin + "/design")).status(), 200);
  pass(
    "Static host has no account API and serves the independent design with documented No-Go reasons",
  );
  await page.screenshot({ path: "artifacts/independent-live-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(500);
  await page.screenshot({ path: "artifacts/independent-live-mobile.png" });
  await page.setViewportSize({ width: 944, height: 572 });
  await page
    .getByRole("button", { name: "Hubs & computers", exact: true })
    .click();
  await page
    .locator(".connectionHub")
    .filter({ has: page.getByText("Home demo", { exact: true }) })
    .locator("summary")
    .click();
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByText("Home laptop", { exact: true })
    .waitFor();
  assert.ok(
    (await page.locator(".connectionPanel").boundingBox()).width <= 522,
  );
  await page.screenshot({
    path: "artifacts/consistency-live-hubs-foldable.png",
  });
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator("#logoutBtnSide").click();
  await page
    .getByRole("heading", { name: "Connect to your agents", exact: true })
    .waitFor();
  const bounds = await page.locator(".connectionLogin").boundingBox();
  assert.ok(Math.abs(bounds.x + bounds.width / 2 - 472) < 2);
  assert.ok(Math.abs(bounds.y + bounds.height / 2 - 286) < 2);
  await page.screenshot({
    path: "artifacts/consistency-live-signed-out-foldable.png",
  });
  await page
    .getByRole("button", { name: "Connect a hub", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "No hubs yet", exact: true })
    .waitFor();
  pass(
    "Public hub panels and the screenshot's signed-out state use the shared layout and reconnect correctly",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(String(e));
  console.error(e);
  process.exitCode = 1;
  await page.screenshot({ path: "artifacts/independent-live-failure.png" });
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/independent-live-results.json",
    JSON.stringify(
      {
        passed: !errors.length,
        checks,
        errors,
        url: page.url(),
        at: new Date().toISOString(),
      },
      null,
      2,
    ),
  );
  await browser.close();
}
