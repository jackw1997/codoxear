// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const { password } = JSON.parse(
  await readFile(process.env.CODOXEAR_DEMO_CREDENTIAL_FILE, "utf8"),
);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(30000);
const checks = [],
  errors = [],
  hubRequests = [];
page.on("request", (request) => {
  const url = new URL(request.url());
  if (
    url.hostname === "codoxear.gzeek.com" &&
    ["8446", "8447"].includes(url.port)
  )
    hubRequests.push(request.url());
});
page.on("pageerror", (error) => errors.push(error.message));
const pass = (message) => {
  checks.push(message);
  console.log("PASS", message);
};
const reuse = process.env.CODOXEAR_CACHE_REUSE === "1";
const names = [
  "Switch demo · Laptop",
  "Switch demo · Workstation",
  "Switch demo · Work",
];
async function create(name, computer) {
  const dialog = page.locator("dialog[open]");
  await dialog.getByLabel("Agent name", { exact: true }).fill(name);
  const options = await dialog
    .locator("[name=placement] option")
    .allTextContents();
  await dialog
    .getByLabel("Computer & hub", { exact: true })
    .selectOption(String(options.findIndex((s) => s.includes(computer))));
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname === "/workspace/");
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  await page
    .locator(".directory-agent.selected")
    .filter({ hasText: name })
    .waitFor();
}
let passed = false;
try {
  await page.goto("https://codoxear.gzeek.com:8445/");
  await page.getByLabel("Email", { exact: true }).fill("alice@example.test");
  await page.getByLabel("Password", { exact: true }).fill(password);
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  if (reuse) {
    await page
      .locator("[data-directory-agent]")
      .filter({ has: page.getByText(names[0], { exact: true }) })
      .click();
  } else {
    await page
      .getByRole("button", { name: "New agent", exact: true })
      .first()
      .click();
    await create(names[0], "Home laptop");
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("run demo tool");
    await page.getByRole("button", { name: "Send", exact: true }).click();
  }
  const result =
    "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.";
  await page.getByText(result, { exact: true }).waitFor({ timeout: 45000 });
  pass(
    reuse
      ? "Public trusted HTTPS: open the live agent and its real Pi tool result"
      : "Public trusted HTTPS: create an agent and execute the real Pi shell tool",
  );
  if (!reuse)
    for (const [index, computer] of [
      [1, "Home workstation"],
      [2, "Work computer"],
    ]) {
      await page
        .getByRole("link", { name: "+ New agent", exact: true })
        .click();
      await create(names[index], computer);
    }
  const origin = new URL(page.url()).origin;
  await page.evaluate(() => {
    window.__shell = document.querySelector(".sidebar");
  });
  const writer = page
    .locator("[data-directory-agent]")
    .filter({ hasText: names[0] });
  const id = await writer.getAttribute("data-directory-agent");
  await writer.click();
  await page.getByText(result, { exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("This draft stays with the laptop agent.");
  await page
    .locator("[data-directory-agent]")
    .filter({ has: page.getByText(names[2], { exact: true }) })
    .click();
  await page
    .locator(".directory-agent.selected")
    .filter({ has: page.getByText(names[2], { exact: true }) })
    .waitFor();
  await page.waitForFunction(
    () =>
      document.querySelector('textarea[aria-label="Message"]')?.value === "",
  );
  let release;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route(
    `**/workspace/api/sessions/${id}/messages/tail?*`,
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  const access = page.waitForResponse((r) =>
    r.url().includes(`/sessions/${id}/access`),
  );
  await writer.click();
  assert.equal((await access).status(), 200);
  await page.getByText(result, { exact: true }).waitFor({ timeout: 2000 });
  assert.equal(
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .inputValue(),
    "This draft stays with the laptop agent.",
  );
  release();
  await page.unroute(`**/workspace/api/sessions/${id}/messages/tail?*`);
  assert.equal(new URL(page.url()).origin, origin);
  assert.equal(
    await page.evaluate(
      () => window.__shell === document.querySelector(".sidebar"),
    ),
    true,
  );
  pass(
    "Same document and shell across hubs; authorized cached preview and draft restored before fresh tail response",
  );
  const assets = await page.evaluate(() =>
    [...document.querySelectorAll("script[src]")].map((s) => s.src),
  );
  const bundle = assets.find((url) => url.includes("app.bundle.js"));
  assert.ok(bundle);
  assert.match(
    (await page.request.get(bundle)).headers()["cache-control"],
    /immutable/,
  );
  assert.equal(
    (
      await page.request.get(
        new URL("/workspace/api/sessions", page.url()).href,
      )
    ).headers()["cache-control"],
    "no-store",
  );
  pass("Static workspace bundle is version-cached; account API is no-store");
  await page.getByRole("button", { name: "View file", exact: true }).click();
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
    "Original file preview and download work through the public shared workspace",
  );
  await page.getByRole("textbox", { name: "Message", exact: true }).fill("");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/cache-live-desktop.png" });
  // Exercise creation on another hub through the same mounted workspace.
  await page.getByRole("link", { name: "+ New agent", exact: true }).click();
  await create("One origin check", "Work computer");
  assert.equal(
    await page.evaluate(
      () => window.__shell === document.querySelector(".sidebar"),
    ),
    true,
  );
  await writer.click();
  await page.getByText(result, { exact: true }).waitFor();
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Verify the single-origin update");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText(
      "Demo (scripted model): received your message. This is a real isolated Pi session with deterministic replies, not live AI inference. Send ‘run demo tool’ to execute the supplied shell-file demonstration.",
      { exact: true },
    )
    .waitFor();
  pass(
    "Create on another hub without replacing the workspace; the existing laptop agent still answers after web deployment",
  );
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Manage access", exact: true })
    .waitFor();
  await page
    .getByRole("link", { name: "← Back to agent", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  assert.equal(new URL(page.url()).origin, "https://codoxear.gzeek.com:8445");
  assert.deepEqual(hubRequests, []);
  pass(
    "Login, cross-hub creation, switching, settings and downloads all stay on 8445 with no browser requests to hub ports",
  );
  await page.screenshot({ path: "artifacts/central-live-desktop.png" });
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(String(error));
  console.error(error);
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/cache-live-failure.png" });
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/cache-live-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        url: page.url(),
        tls: "Browser default certificate trust",
        agents: names,
      },
      null,
      2,
    ),
  );
  await browser.close();
}
