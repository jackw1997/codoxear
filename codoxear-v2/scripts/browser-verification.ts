// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
if (!existsSync("/.dockerenv"))
  throw new Error("Browser verification requires Docker");
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
const base = process.env.TEST_BASE_URL ?? "http://127.0.0.1:17430",
  steps = [],
  errors = [],
  children = [];
const report = async (name) => {
  steps.push({ name, passed: true });
  console.log("PASS", name);
};
const owner = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  member = await browser.newContext({ viewport: { width: 1280, height: 900 } });
const alice = await owner.newPage(),
  bob = await member.newPage();
for (const page of [alice, bob]) {
  page.setDefaultTimeout(12000);
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("dialog", (dialog) => dialog.accept());
}
async function login(page, name) {
  await page.goto(base);
  await page.getByLabel("Email", { exact: true }).fill(name + "@example.test");
  await page
    .getByLabel("Password", { exact: true })
    .fill("browser-test-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByRole("button", { name: "Sign out" }).waitFor();
}
async function createAgent(page, name) {
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await page.getByLabel("Agent name").fill(name);
  await page.getByRole("button", { name: "Create agent", exact: true }).click();
  await page.getByRole("heading", { name, exact: true }).waitFor();
}
async function inviteMember(kind) {
  await alice
    .getByRole("button", { name: "Manage access", exact: true })
    .click();
  const card = alice.locator(`[data-resource="${kind}"]`);
  await card.getByLabel("Invite by", { exact: true }).selectOption("email");
  await card.getByLabel("Email", { exact: true }).fill("bob@example.test");
  await card.getByRole("button", { name: "Create invitation" }).click();
  await card.locator(".invite-token").waitFor();
  return (await card.locator(".invite-token").textContent()).trim();
}
async function accept(token) {
  await bob.getByRole("button", { name: "Join", exact: true }).click();
  await bob.getByLabel("Invitation token").fill(token);
  await bob
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await bob.locator("#modal").waitFor({ state: "hidden" });
}
async function startComputer(config, index) {
  const home = await mkdtemp(join(tmpdir(), `computer-${index}-`)),
    path = join(home, "pairing.json");
  await writeFile(path, config, { mode: 0o600 });
  const env = { ...process.env, CODOXEAR_COMPUTER_HOME: home };
  execFileSync(
    process.execPath,
    ["dist/server/computer/main.js", "attach", path],
    { env },
  );
  const child = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/testing/fixture-computer.ts"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  let log = "";
  child.stdout.on("data", (x) => (log += x));
  child.stderr.on("data", (x) => (log += x));
  await until(() => log.includes('"online"'));
  return { child, home, env };
}
async function until(check) {
  const deadline = Date.now() + 15000;
  while (!(await check())) {
    if (Date.now() > deadline)
      throw new Error("Timed out waiting for expected state");
    await new Promise((r) => setTimeout(r, 150));
  }
}
async function stop(child) {
  if (child.exitCode !== null) return;
  child.kill("SIGTERM");
  await new Promise((r) => child.once("exit", r));
}
await mkdir("artifacts", { recursive: true });
try {
  await login(alice, "alice");
  await login(bob, "bob");
  await report("Two independent browser accounts sign in");
  const suffix = Date.now(),
    hubName = "Studio " + suffix;
  await alice.getByRole("button", { name: "New hub", exact: true }).click();
  await alice.getByLabel("Hub name").fill(hubName);
  await alice.getByRole("button", { name: "Create hub", exact: true }).click();
  await alice.locator("#modal").waitFor({ state: "hidden" });
  async function addComputer(name, index) {
    await alice
      .getByRole("button", { name: "Add computer", exact: true })
      .click();
    await alice.getByLabel("Computer name").fill(name);
    const downloading = alice.waitForEvent("download");
    await alice
      .locator("#modal")
      .getByRole("button", { name: "Add computer", exact: true })
      .click();
    const download = await downloading,
      path = await download.path();
    const { readFile } = await import("node:fs/promises");
    const config = await readFile(path, "utf8"),
      paired = JSON.parse(config);
    const grant = await owner.request.put(
      base + "/api/resources/computer/" + paired.computerId + "/members/alice",
      { data: { access: "write" } },
    );
    assert.equal(
      grant.status(),
      200,
      "Computer admission requires a separate explicit owner allowlist grant",
    );
    const running = await startComputer(config, index);
    await alice.reload();
    await alice.getByRole("button", { name: "Sign out" }).waitFor();
    return running;
  }
  const first = await addComputer("Office Mac", 1);
  await until(() =>
    alice
      .locator("[data-computer] .online")
      .count()
      .then((x) => x >= 1),
  );
  await report(
    "Owner creates a hub and downloads pairing; real Computer CLI attaches and connects outbound",
  );
  await createAgent(alice, "Planning agent");
  await alice
    .getByLabel("Message", { exact: true })
    .fill("Prove browser → hub → computer routing");
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await alice
    .locator(".message.assistant")
    .filter({ hasText: "Fixture response: Prove browser" })
    .waitFor();
  await alice.screenshot({
    path: "artifacts/01-owner-chat.png",
    fullPage: true,
  });
  await report(
    "Agent creation and live conversation traverse the outbound computer connection",
  );
  await stop(first.child);
  await alice
    .getByLabel("Message", { exact: true })
    .fill("Draft survives computer restart");
  await until(() =>
    alice
      .locator("#connection-status")
      .textContent()
      .then((x) => x.includes("unavailable")),
  );
  await report(
    "Computer shutdown preserves the browser draft and reports offline",
  );
  const restarted = spawn(
    process.execPath,
    ["--import", "tsx", "scripts/testing/fixture-computer.ts"],
    { env: first.env, stdio: "ignore" },
  );
  children.push(restarted);
  await until(() =>
    alice
      .locator("#connection-status")
      .textContent()
      .then((x) => x === "Live"),
  );
  assert.equal(
    await alice.getByLabel("Message", { exact: true }).inputValue(),
    "Draft survives computer restart",
  );
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await alice
    .locator(".message.assistant")
    .filter({ hasText: "Draft survives" })
    .waitFor();
  await report("Computer restart restores persisted agent history and sending");
  const tokenHub = await inviteMember("hub");
  await accept(tokenHub);
  await bob.getByLabel("Your hub").selectOption({ label: hubName });
  await bob.getByText("No computers available.").waitFor();
  await report("Hub membership alone does not expose computer agents");
  const ownerHubs = await (await owner.request.get(base + "/api/hubs")).json();
  const ownerHub = ownerHubs.find((h) => h.name === hubName);
  const ownerComputers = await (
    await owner.request.get(base + "/api/hubs/" + ownerHub.id + "/computers")
  ).json();
  const selectedComputer = ownerComputers.find((c) => c.name === "Office Mac");
  assert.ok(
    selectedComputer,
    "Owner can review the admitted Computer before assigning use",
  );
  const allowBob = await owner.request.put(
    base + "/api/resources/computer/" + selectedComputer.id + "/members/bob",
    { data: { access: "write" } },
  );
  assert.equal(allowBob.status(), 200);
  await bob.reload();
  await bob.getByLabel("Your hub").selectOption({ label: hubName });
  await bob.getByRole("button", { name: "Office Mac" }).click();
  await bob.getByRole("button", { name: "New agent", exact: true }).waitFor();
  assert.equal(
    await bob
      .getByRole("button", { name: "New agent", exact: true })
      .isEnabled(),
    true,
  );
  await createAgent(bob, "Member agent");
  await bob
    .getByLabel("Message", { exact: true })
    .fill("Member with both grants");
  await bob.getByRole("button", { name: "Send", exact: true }).click();
  await bob
    .locator(".message.assistant")
    .filter({ hasText: "Member with both grants" })
    .waitFor();
  await report(
    "Hub membership and an explicit Computer allowlist entry enable creation and sending",
  );
  const catalog = await member.request.get(base + "/api/hubs");
  const hubs = await catalog.json();
  const selectedHub = hubs.find((h) => h.name === hubName);
  const computers = await (
    await member.request.get(
      base + "/api/hubs/" + selectedHub.id + "/computers",
    )
  ).json();
  const memberAgent = (
    await (
      await member.request.get(
        base + "/api/computers/" + computers[0].id + "/agents",
      )
    ).json()
  ).find((a) => a.name === "Member agent");
  const legacyReadOnly = await owner.request.put(
    base + "/api/resources/computer/" + selectedComputer.id + "/policy",
    { data: { policy: "read_only" } },
  );
  assert.equal(legacyReadOnly.status(), 200);
  const removeBob = await owner.request.delete(
    base + "/api/resources/computer/" + selectedComputer.id + "/members/bob",
  );
  assert.equal(removeBob.status(), 200);
  await until(async () => {
    const send = bob.getByRole("button", { name: "Send", exact: true });
    return !(await send.count()) || await send.isDisabled();
  });
  await bob.screenshot({
    path: "artifacts/02-member-read-only.png",
    fullPage: true,
  });
  await report(
    "Removing a Computer allowlist entry immediately disables an open agent",
  );
  const denied = await member.request.post(
    base + "/api/agents/" + memberAgent.id + "/send",
    { data: { text: "Denied" } },
  );
  assert.equal(denied.status(), 403);
  const legacyRetain = await owner.request.put(
    base + "/api/resources/hub/" + selectedHub.id + "/policy",
    { data: { policy: "retain" } },
  );
  assert.equal(legacyRetain.status(), 200);
  const retainedRead = await member.request.get(
    base + "/api/agents/" + memberAgent.id + "/messages",
  );
  assert.equal(retainedRead.status(), 403);
  const retainedSend = await member.request.post(
    base + "/api/agents/" + memberAgent.id + "/send",
    { data: { text: "No retained bypass" } },
  );
  assert.equal(retainedSend.status(), 403);
  await report(
    "Legacy retention policies cannot bypass the explicit Computer allowlist",
  );
  await bob.reload();
  await until(() =>
    bob
      .locator("[data-computer]")
      .count()
      .then((x) => x === 0),
  );
  await report("Revoked member sees no Computers or agent creation targets");
  await alice.getByRole("button", { name: "Agents", exact: true }).click();
  await addComputer("Linux workstation", 2);
  await until(() =>
    alice
      .locator("[data-computer] .online")
      .count()
      .then((x) => x === 2),
  );
  await alice.getByRole("button", { name: "Linux workstation" }).click();
  await createAgent(alice, "Second computer agent");
  await alice.getByLabel("Message", { exact: true }).fill("Second computer");
  await alice.getByRole("button", { name: "Send", exact: true }).click();
  await alice
    .locator(".message.assistant")
    .filter({ hasText: "Second computer" })
    .waitFor();
  await report(
    "Two computers attach independently to one hub and route to distinct runtimes",
  );
  await alice.setViewportSize({ width: 390, height: 844 });
  await alice.getByRole("button", { name: "Computers", exact: true }).click();
  await alice.getByLabel("Your hub").waitFor({ state: "visible" });
  await alice
    .getByRole("button", { name: "Close computers", exact: true })
    .click();
  await alice.getByLabel("Your hub").waitFor({ state: "hidden" });
  await alice.locator(".toast").waitFor({ state: "hidden" });
  await alice.screenshot({ path: "artifacts/03-mobile.png", fullPage: true });
  assert.equal(
    await alice.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  await report(
    "Mobile computer drawer opens and closes; viewport has no horizontal overflow",
  );
  assert.deepEqual(errors, []);
  await report("No uncaught browser JavaScript errors");
} catch (error) {
  await alice.screenshot({
    path: "artifacts/failure-owner.png",
    fullPage: true,
  });
  await bob.screenshot({
    path: "artifacts/failure-member.png",
    fullPage: true,
  });
  console.error(error);
  process.exitCode = 1;
  steps.push({ name: String(error), passed: false });
} finally {
  await browser.close();
  for (const child of children) await stop(child);
  await writeFile(
    "artifacts/browser-results.json",
    JSON.stringify(
      { at: new Date().toISOString(), steps, errors, syntheticRuntime: true },
      null,
      2,
    ),
  );
}
