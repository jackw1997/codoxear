// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import { existsSync } from "node:fs";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import assert from "node:assert/strict";
if (!existsSync("/.dockerenv")) throw new Error("Run in Docker");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const children = [],
  errors = [],
  steps = [];
const owner = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  alice = await owner.newPage(),
  bobContext = await browser.newContext(),
  bob = await bobContext.newPage();
for (const p of [alice, bob]) {
  p.setDefaultTimeout(12000);
  p.on("pageerror", (e) => errors.push(e.message));
}
const pass = (name) => {
  steps.push(name);
  console.log("PASS", name);
};
async function login(page, name) {
  await page.goto("http://127.0.0.1:19420/?settings=1");
  await page.getByLabel("Email", { exact: true }).fill(name + "@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("heading", { name: "Your hubs" }).waitFor();
}
async function openHub(page, name) {
  // Exercise the optional separate-authority hub login directly. The account
  // portal's Open agents link now opens its aggregated workspace instead.
  const port = { "Home hub": 19430, "Work hub": 19431 }[name];
  assert.ok(port, "Known distributed fixture hub");
  const origin = `http://127.0.0.1:${port}`;
  await page.goto(origin + "/auth/start");
  await page.waitForURL(origin + "/");
  // The optional authority mode retains a management page behind this query.
  await page.goto(origin + "/?settings");
  await page.getByRole("button", { name: "Sign out" }).waitFor();
}
async function computer(page, name) {
  await page.getByRole("button", { name: "Add computer", exact: true }).click();
  await page.getByLabel("Computer name").fill(name);
  const downloading = page.waitForEvent("download");
  await page
    .locator("#modal")
    .getByRole("button", { name: "Add computer", exact: true })
    .click();
  const download = await downloading,
    config = await readFile(await download.path(), "utf8"),
    home = await mkdtemp(join(tmpdir(), "enrolled-")),
    path = join(home, "enrollment.json");
  await writeFile(path, config, { mode: 0o600 });
  const env = { ...process.env, CODOXEAR_COMPUTER_HOME: home };
  execFileSync(
    process.execPath,
    ["dist/server/computer/main.js", "attach", path],
    { env, stdio: "pipe" },
  );
  const child = spawn(
    process.execPath,
    ["dist/server/computer/main.js", "start"],
    { env, stdio: "ignore" },
  );
  children.push(child);
  await page.locator(".dot.online").waitFor();
}
async function agent(page, name) {
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page.getByLabel("Agent name").fill(name);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
}
try {
  await login(alice, "alice");
  assert.equal(await alice.locator("article").count(), 2);
  await openHub(alice, "Home hub");
  await computer(alice, "Home computer");
  await agent(alice, "Home agent");
  await alice.getByLabel("Message", { exact: true }).fill("From my home hub");
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await alice
    .locator(".message.assistant")
    .filter({ hasText: "From my home hub" })
    .waitFor();
  await alice.getByLabel("Message", { exact: true }).fill("Unsent home draft");
  pass(
    "Central login, PKCE hub cookie exchange, single-use enrollment and relayed conversation",
  );
  await openHub(alice, "Work hub");
  await computer(alice, "Work computer");
  await agent(alice, "Work agent");
  assert.equal(
    await alice.getByLabel("Message", { exact: true }).inputValue(),
    "",
  );
  await alice.getByLabel("Message", { exact: true }).fill("From work");
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await alice
    .locator(".message.assistant")
    .filter({ hasText: "From work" })
    .waitFor();
  assert.equal(
    await alice
      .locator(".message")
      .filter({ hasText: "From my home hub" })
      .count(),
    0,
  );
  pass(
    "One account uses two independently running hubs without sharing agent state",
  );
  await alice.screenshot({
    path: "artifacts/04-independent-hub.png",
    fullPage: true,
  });
  await openHub(alice, "Home hub");
  await alice.locator("[data-agent]").filter({ hasText: "Home agent" }).click();
  assert.equal(
    await alice.getByLabel("Message", { exact: true }).inputValue(),
    "Unsent home draft",
  );
  pass("Returning to a hub restores only its own unsent draft");
  await login(bob, "bob");
  assert.equal(await bob.locator("article").count(), 1);
  await openHub(bob, "Home hub");
  await bob.getByText("No computers available.").waitFor();
  pass("Second account sees only its invited hub and no ungranted computers");
  assert.deepEqual(errors, []);
  pass("No uncaught browser errors in the separate-service flow");
} catch (e) {
  await alice.screenshot({
    path: "artifacts/distributed-failure.png",
    fullPage: true,
  });
  console.error(e);
  process.exitCode = 1;
} finally {
  await browser.close();
  for (const child of children) {
    if (child.exitCode === null) {
      child.kill("SIGTERM");
      await new Promise((r) => child.once("exit", r));
    }
  }
  await writeFile(
    "artifacts/distributed-results.json",
    JSON.stringify(
      { at: new Date().toISOString(), steps, errors, syntheticRuntime: true },
      null,
      2,
    ),
  );
}
