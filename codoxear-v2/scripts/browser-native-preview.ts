import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { NativeRuntime } from "../src/computer/native/runtime.js";

assert.ok(existsSync("/.dockerenv"), "Docker only");
const base = Number(process.env.CODOXEAR_DEMO_PUBLIC_PORT_BASE ?? 8450);
const host = process.env.CODOXEAR_DEMO_PUBLIC_HOST ?? "codoxear.gzeek.com";
const origin = `https://${host}:${base + 1}`;
const { password } = JSON.parse(
  await readFile("/demo-data/demo.json", "utf8"),
) as { password: string };
const playwright = (await import(
  process.env.PLAYWRIGHT_MODULE ?? "@playwright/test"
)) as typeof import("@playwright/test");
const browser = await playwright.chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: [
    "--no-sandbox",
    "--disable-dev-shm-usage",
    ...(process.env.CODOXEAR_TEST_SPKI
      ? [
          "--ignore-certificate-errors-spki-list=" +
            process.env.CODOXEAR_TEST_SPKI,
        ]
      : []),
  ],
});
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
  ignoreHTTPSErrors: true,
});
const page = await context.newPage();
page.setDefaultTimeout(30000);
const onlinePages = new Map<typeof page, Promise<void>>();
function keepLoopbackOnline(target: typeof page) {
  let pending = onlinePages.get(target);
  if (!pending) {
    pending = (async () => {
      const network = await context.newCDPSession(target);
      await network.send("Network.enable");
      await network.send("Network.emulateNetworkConditions", {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
        connectionType: "ethernet",
      });
    })();
    onlinePages.set(target, pending);
  }
  return pending;
}
await keepLoopbackOnline(page);
const name = "Native terminal acceptance " + Date.now();
const errors: string[] = [];
page.on("pageerror", (error) => errors.push(error.message));
const checks: string[] = [];
const pass = (label: string) => {
  checks.push(label);
  console.log("PASS " + label);
};
async function selectSession() {
  const target = page
    .locator(".session")
    .filter({ has: page.getByText(name, { exact: true }) });
  await target.waitFor();
  const bounds = await target.boundingBox();
  if (!bounds || bounds.x < 0 || bounds.x >= 390)
    await page
      .getByRole("button", { name: "Toggle sidebar", exact: true })
      .click();
  await target.click();
}
const runtime = new NativeRuntime(
  "/demo-data/c0",
  "/demo-data/c0/workspace",
  "/demo-data/c0/computer",
);
try {
  const session = await runtime.createTerminal("pi", name, {});
  assert.ok(session.localId);
  const readyDeadline = Date.now() + 60000;
  while (
    (await runtime.request(`/api/sessions/${session.localId}/state`))
      .readiness !== "ready"
  ) {
    if (Date.now() > readyDeadline)
      throw Error("Native Pi did not become ready");
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 45000 });
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .waitFor({ timeout: 30000 });
  for (const offset of [2, 3]) {
    const connections = page.getByRole("dialog", {
      name: "Hubs & computers",
      exact: true,
    });
    await connections
      .getByRole("button", { name: "Add hub", exact: true })
      .click();
    const panel = page.getByRole("dialog", { name: "Add hub", exact: true });
    await panel
      .getByLabel("Hub address")
      .fill(`https://${host}:${base + offset}`);
    const popupPromise = context.waitForEvent("page", { timeout: 20000 });
    await panel
      .getByRole("button", { name: "Connect hub", exact: true })
      .click();
    const popup = await popupPromise;
    popup.setDefaultTimeout(30000);
    popup.on("pageerror", (error) => errors.push(error.message));
    await keepLoopbackOnline(popup);
    await popup
      .getByLabel("Email", { exact: true })
      .waitFor({ timeout: 30000 });
    await popup.getByLabel("Email", { exact: true }).fill("alice@example.test");
    await popup.getByLabel("Password", { exact: true }).fill(password);
    const closed = popup.waitForEvent("close", { timeout: 30000 });
    await popup.getByRole("button", { name: "Sign in", exact: true }).click();
    await closed;
    await connections
      .getByText(offset === 2 ? "Home demo" : "Work demo", { exact: true })
      .waitFor({ timeout: 30000 });
  }
  pass(
    "Native preview connects two independent hubs through their real OAuth login",
  );
  const connections = page.getByRole("dialog", {
    name: "Hubs & computers",
    exact: true,
  });
  const homeHub = connections
    .locator(".connectionHub")
    .filter({ has: page.getByText("Home demo", { exact: true }) });
  await homeHub.locator("summary").click();
  await homeHub
    .getByRole("button")
    .filter({ has: page.getByText("Home laptop", { exact: true }) })
    .click();
  await page
    .getByRole("button", { name: "Import local session", exact: true })
    .click();
  const importPanel = page.getByRole("dialog", {
    name: "Import a local session",
    exact: true,
  });
  await importPanel.getByLabel(/^Local session/).selectOption(session.localId);
  await importPanel.getByLabel("Agent name", { exact: true }).fill(name);
  await importPanel
    .getByRole("button", { name: "Import session", exact: true })
    .click();
  await selectSession();
  pass(
    "Unified Computer page imports an actual terminal-owned native Pi session",
  );
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("run demo tool");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText(
      "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.",
      { exact: true },
    )
    .first()
    .waitFor({ timeout: 60000 });
  assert.match(
    await readFile("/demo-data/c0/workspace/proof.txt", "utf8"),
    /Executed by the real Pi CLI/,
  );
  pass(
    "Browser sends to native PTY; actual Pi shell tool writes the workspace file",
  );
  await page.reload();
  await page
    .getByText(
      "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.",
      { exact: true },
    )
    .first()
    .waitFor();
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  assert.deepEqual(errors, []);
  pass(
    "Native transcript survives page reload and fits the phone viewport without page errors",
  );
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/native-preview-mobile.png" });
  await writeFile(
    "artifacts/native-preview-results.json",
    JSON.stringify({ origin, checks, errors }, null, 2),
  );
} catch (error) {
  console.error("Original preview failure:", error);
  console.error("Preview page errors:", JSON.stringify(errors));
  try {
    console.error(
      "Preview page:",
      (await page.locator("body").innerText({ timeout: 2000 })).slice(0, 6000),
    );
    await mkdir("artifacts", { recursive: true });
    await page.screenshot({
      path: "artifacts/native-preview-failure.png",
      timeout: 5000,
    });
  } catch (diagnostic) {
    console.error("Preview diagnostic unavailable:", diagnostic);
  }
  throw error;
} finally {
  runtime.close();
  await browser.close();
}
