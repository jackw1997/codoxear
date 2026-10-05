// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const host = process.env.CODOXEAR_DEMO_PUBLIC_HOST,
  issuer = host ? `https://${host}:8445` : "http://127.0.0.1:19520",
  guide = host ? `https://${host}:8444` : "http://127.0.0.1:19500";
const credentials = process.env.CODOXEAR_DEMO_CREDENTIAL_FILE
  ? JSON.parse(
      await readFile(process.env.CODOXEAR_DEMO_CREDENTIAL_FILE, "utf8"),
    )
  : await (await fetch(guide + "/credentials")).json();
const home = issuer + "/gateway/hubs/" + credentials.computers[0].hubId;
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
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
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
page.setDefaultTimeout(25000);
await page.addInitScript(() => {
  const Original = window.EventSource;
  window.__activeAgentStreams = new Set();
  window.EventSource = class extends Original {
    constructor(url, options) {
      super(url, options);
      if (String(url).includes("/sessions/"))
        window.__activeAgentStreams.add(this);
    }
    close() {
      window.__activeAgentStreams.delete(this);
      return super.close();
    }
  };
});
const hubBrowserRequests = [];
context.on("request", (request) => {
  const url = new URL(request.url());
  if (
    url.hostname === new URL(issuer).hostname &&
    ["8446", "8447", "19530", "19531"].includes(url.port)
  )
    hubBrowserRequests.push(request.url());
});
const checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", async (r) => {
  if (r.status() >= 400 && r.url().includes("/workspace/api/"))
    console.log(
      "API failure",
      new URL(r.url()).pathname,
      r.status(),
      (await r.text().catch(() => "")).slice(0, 300),
    );
});
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
async function login(p, name) {
  await p.goto(issuer);
  await p.getByLabel("Email", { exact: true }).fill(name + "@example.test");
  await p.getByLabel("Password", { exact: true }).fill(credentials.password);
  await p.getByRole("button", { name: "Sign in", exact: true }).click();
  await p
    .getByRole("navigation", { name: "Your agents", exact: true })
    .waitFor();
}
async function create(name, computer) {
  const dialog = page.locator("dialog[open]");
  await dialog.waitFor();
  await dialog.getByLabel("Agent name", { exact: true }).fill(name);
  await dialog
    .locator("[name=placement] option")
    .first()
    .waitFor({ state: "attached" });
  const target = await dialog
    .locator("[name=placement] option")
    .allTextContents();
  const index = target.findIndex((s) => s.includes(computer));
  assert.ok(index >= 0);
  await dialog
    .getByLabel("Computer & hub", { exact: true })
    .selectOption(String(index));
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await page.waitForURL((url) => url.pathname === "/workspace/");
  await page
    .getByRole("navigation", { name: "Your agents", exact: true })
    .getByRole("link")
    .filter({ hasText: name })
    .waitFor();
  await page.getByRole("textbox", { name: "Message", exact: true }).waitFor();
}
let passed = false;
try {
  await page.goto(guide);
  await page.getByRole("heading", { name: "Sign in to Codoxear" }).waitFor();
  await page.screenshot({ path: "artifacts/agent-login.png" });
  pass("Demo URL opens sign-in directly, without an infrastructure dashboard");
  await login(page, "alice");
  assert.equal(await page.locator("#hub-select").count(), 0);
  await page.screenshot({ path: "artifacts/agent-home.png" });
  await page
    .getByRole("button", { name: "New agent", exact: true })
    .first()
    .click();
  await create("Writing companion", "Home laptop");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("run demo tool");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText(
      "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.",
      { exact: true },
    )
    .waitFor({ timeout: 45000 });
  pass(
    "Create agent opens original Codoxear conversation and executes actual Pi shell tool",
  );
  assert.ok(
    (await page.locator(".directory-agent").first().innerText()).includes(
      "Home laptop",
    ),
  );
  assert.ok(
    (await page.locator(".directory-agent").first().innerText()).includes(
      "Home demo",
    ),
  );
  await page.screenshot({ path: "artifacts/agent-conversation.png" });
  await page.getByRole("button", { name: "View file", exact: true }).click();
  await page
    .getByRole("button", { name: "Download file", exact: true })
    .waitFor();
  const toggle = page.getByRole("button", { name: "Toggle diff", exact: true });
  await page
    .locator("#fileViewer")
    .getByText("Executed by the real Pi CLI in the isolated demo.", {
      exact: true,
    })
    .first()
    .waitFor();
  if (await toggle.evaluate((b) => b.classList.contains("active")))
    await toggle.click();
  await page.getByRole("button", { name: "Edit file", exact: true }).click();
  await page.keyboard.press("Control+A");
  await page.keyboard.type("Edited in the original Codoxear workspace.");
  const saved = page.waitForResponse(
    (r) => r.url().includes("/file/write") && r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Save file", exact: true }).click();
  assert.equal((await saved).status(), 200);
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download file", exact: true })
    .click();
  assert.equal(
    await readFile(await (await downloading).path(), "utf8"),
    "Edited in the original Codoxear workspace.",
  );
  await page.locator("#fileCloseBtn").click();
  pass("Original file viewer edits, saves and downloads the real file");
  await page.evaluate(() => {
    window.__creationShell = document.querySelector(".sidebar");
  });
  await page.getByRole("link", { name: "+ New agent", exact: true }).click();
  await create("Code reviewer", "Home workstation");
  await page.getByRole("link", { name: "+ New agent", exact: true }).click();
  await create("Release notes", "Work computer");
  assert.equal(
    await page.evaluate(
      () => window.__creationShell === document.querySelector(".sidebar"),
    ),
    true,
  );
  assert.equal(await page.locator("[data-directory-agent]").count(), 3);
  const workspaceOrigin = new URL(page.url()).origin;
  await page.evaluate(() => {
    window.__originalShell = document.querySelector(".sidebar");
  });
  await page
    .locator("[data-directory-agent]")
    .filter({ hasText: "Writing companion" })
    .click();
  await page
    .getByText(
      "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.",
      { exact: true },
    )
    .waitFor();
  pass(
    "One sidebar lists agents across two hubs and three Computers; cross-hub click opens agent directly",
  );
  assert.equal(new URL(page.url()).origin, workspaceOrigin);
  assert.equal(
    await page.evaluate(
      () => window.__originalShell === document.querySelector(".sidebar"),
    ),
    true,
  );
  const writer = await page
    .locator("[data-directory-agent]")
    .filter({ hasText: "Writing companion" })
    .getAttribute("data-directory-agent");
  const composer = page.getByRole("textbox", { name: "Message", exact: true });
  await composer.fill("An unsent draft kept while switching hubs");
  await page
    .locator("[data-directory-agent]")
    .filter({ hasText: "Release notes" })
    .click();
  await page.waitForFunction((id) => !location.hash.includes(id), writer);
  await composer.fill("A separate draft for release notes");
  let releaseTail;
  const gate = new Promise((resolve) => {
    releaseTail = resolve;
  });
  await page.route(
    `**/workspace/api/sessions/${writer}/messages/tail?*`,
    async (route) => {
      await gate;
      await route.continue();
    },
  );
  const accessCheck = page.waitForResponse((r) =>
    r.url().includes(`/sessions/${writer}/access`),
  );
  await page
    .locator("[data-directory-agent]")
    .filter({ hasText: "Writing companion" })
    .click();
  assert.equal((await accessCheck).status(), 200);
  await page
    .getByText(
      "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.",
      { exact: true },
    )
    .waitFor({ timeout: 2000 });
  assert.equal(
    await composer.inputValue(),
    "An unsent draft kept while switching hubs",
  );
  releaseTail();
  await page.unroute(`**/workspace/api/sessions/${writer}/messages/tail?*`);
  assert.equal(
    await page.evaluate(
      () => window.__originalShell === document.querySelector(".sidebar"),
    ),
    true,
  );
  assert.ok(await page.evaluate(() => window.__activeAgentStreams.size <= 1));
  pass(
    "Cross-hub switches preserve the same shell and separate drafts; cached text appears before the fresh tail, after an access check; at most one agent stream remains",
  );
  await composer.fill("x".repeat(60000));
  await page.locator("[data-storage-full]").waitFor();
  await page
    .locator("[data-directory-agent]")
    .filter({ hasText: "Release notes" })
    .click();
  assert.ok(page.url().includes(writer));
  assert.equal((await composer.inputValue()).length, 60000);
  await composer.fill("");
  // Saving a small draft resolves the full state without dropping the current text.
  await composer.fill("Draft after quota recovery");
  await page.locator("[data-storage-full]").waitFor({ state: "detached" });
  const persisted = await page.evaluate(() => Object.entries(localStorage));
  assert.ok(
    persisted.reduce((n, [k, v]) => n + 2 * (k.length + v.length), 0) <=
      100 * 1024,
  );
  assert.equal(
    persisted.some(([, v]) => v.includes("Demo (scripted model):")),
    false,
  );
  pass(
    "100 KB local limit warns, blocks switching with an unsaved oversized draft, recovers after editing, and stores no transcript text",
  );
  await page
    .getByRole("button", { name: "Agent settings", exact: true })
    .click();
  await page
    .getByRole("heading", { name: "Manage access", exact: true })
    .waitFor();
  assert.equal(await page.locator(".sidebar").isVisible(), false);
  await page.screenshot({ path: "artifacts/agent-settings.png" });
  const grant = page.locator('.workspace-form[data-member="bob"]');
  await grant.getByLabel("Workspace access for Bob").selectOption("read");
  const granted = page.waitForResponse(
    (r) =>
      r.url().endsWith("/workspace-access/bob") &&
      r.request().method() === "PUT",
  );
  await grant
    .getByRole("button", { name: "Save file access", exact: true })
    .click();
  assert.equal((await granted).status(), 200);
  pass(
    "Agent settings contains inherited hub/computer access controls and saves scoped grants",
  );
  await page.goto(issuer + "/?settings=1");
  await page
    .getByRole("heading", { name: "Hubs & Computers", exact: true })
    .waitFor();
  assert.equal(await page.locator("article").count(), 2);
  await page.getByText("Create a hub", { exact: true }).click();
  await page.getByLabel("Hub name", { exact: true }).fill("UI acceptance hub");
  await page.getByRole("button", { name: "Create hub", exact: true }).click();
  await page
    .locator("article")
    .filter({ hasText: "UI acceptance hub" })
    .waitFor();
  const homeCard = page.locator("article").filter({ hasText: "Home demo" });
  await homeCard.getByText("Add a computer", { exact: true }).click();
  await homeCard
    .getByLabel("Computer name", { exact: true })
    .fill("UI acceptance computer");
  const configDownload = page.waitForEvent("download");
  await homeCard
    .getByRole("button", { name: "Add computer", exact: true })
    .click();
  const config = JSON.parse(
    await readFile(await (await configDownload).path(), "utf8"),
  );
  assert.ok(config.enrollment.code);
  await page
    .getByRole("heading", { name: "UI acceptance computer", exact: true })
    .waitFor();
  await page.screenshot({
    path: "artifacts/hubs-computers-settings.png",
    fullPage: true,
  });
  pass(
    "Secondary Hubs & Computers page creates a hub and downloads a private Computer enrollment configuration",
  );
  await page.goto(issuer);
  await page.getByRole("button", { name: "Appearance", exact: true }).click();
  await page.getByLabel("Theme", { exact: true }).selectOption("slate");
  await page.getByLabel("Color mode", { exact: true }).selectOption("dark");
  assert.equal(await page.locator("html").getAttribute("data-theme"), "slate");
  await page.getByRole("button", { name: "Close appearance" }).click();
  await page.screenshot({ path: "artifacts/agent-home-dark.png" });
  pass("Account UI uses the original Slate dark theme and theme controller");
  const bobContext = await browser.newContext(),
    bob = await bobContext.newPage();
  bob.setDefaultTimeout(20000);
  await login(bob, "bob");
  assert.equal(await bob.locator("[data-directory-agent]").count(), 1);
  await bob.locator("[data-directory-agent]").click();
  await bob.getByRole("textbox", { name: "Message", exact: true }).waitFor();
  assert.equal(await bob.locator("[data-directory-agent]").count(), 1);
  await bob
    .getByText(
      "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.",
      { exact: true },
    )
    .waitFor();
  const bobAgent = (
    await (await context.request.get(home + "/api/agent-directory")).json()
  ).agents.find((a) => a.name === "Writing companion");
  const hubResource = home + `/api/resources/hub/${bobAgent.hubId}`;
  const computerResource =
    home + `/api/resources/computer/${bobAgent.computerId}`;
  const originalPolicy = (
    await (await context.request.get(home + "/api/hubs")).json()
  )[0].policy;
  try {
    assert.equal(
      (
        await context.request.put(hubResource + "/policy", {
          data: { policy: "read_only" },
        })
      ).status(),
      200,
    );
    assert.equal(
      (
        await context.request.delete(computerResource + "/members/bob")
      ).status(),
      200,
    );
    await bob
      .locator(".directory-agent")
      .getByText("Read-only", { exact: true })
      .waitFor();
    const deniedSend = await bob.request.post(
      new URL(`/workspace/api/sessions/${bobAgent.id}/send`, bob.url()).href,
      { data: { text: "This must not be sent" } },
    );
    assert.equal(deniedSend.status(), 403);
    assert.equal(
      (
        await context.request.put(hubResource + "/policy", {
          data: { policy: "none" },
        })
      ).status(),
      200,
    );
    await bob.locator("[data-directory-agent]").waitFor({ state: "detached" });
    await bob
      .getByText(
        "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.",
        { exact: true },
      )
      .waitFor({ state: "detached" });
    assert.equal(
      (
        await bob.request.get(
          new URL(
            `/workspace/api/sessions/${bobAgent.id}/messages/tail`,
            bob.url(),
          ).href,
        )
      ).status(),
      404,
    );
    pass(
      "Live hub policy changes enforce read-only retention, reject sends, then remove cached and displayed content when access becomes none",
    );
  } finally {
    const invitation = await context.request.post(
      computerResource + "/invitations",
      { data: { email: "bob@example.test", role: "operator" } },
    );
    assert.equal(invitation.status(), 200);
    assert.equal(
      (
        await bob.request.post(home + "/api/invitations/accept", {
          data: { token: (await invitation.json()).token },
        })
      ).status(),
      200,
    );
    await context.request.put(hubResource + "/policy", {
      data: { policy: originalPolicy },
    });
    await context.request.put(
      home + `/api/computers/${bobAgent.computerId}/workspace-access/bob`,
      { data: { access: "read" } },
    );
  }
  await bob.goto(issuer + `/workspace/#session=${bobAgent.id}`);
  await bob
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("Private Bob draft");
  const bobKeys = await bob.evaluate(() =>
    Object.keys(localStorage).filter((k) => k.startsWith('["codoxear-v2"')),
  );
  assert.ok(bobKeys.length);
  assert.equal(
    (
      await bob.request.post(issuer + "/workspace/api/logout", { data: {} })
    ).status(),
    200,
  );
  await bob.waitForFunction(
    () =>
      !Object.keys(localStorage).some((k) => k.startsWith('["codoxear-v2"')),
    { timeout: 20000 },
  );
  const storageProbe = await bobContext.newPage();
  await storageProbe.goto(issuer + "/health");
  assert.equal(
    await storageProbe.evaluate(() =>
      Object.keys(localStorage).some((k) => k.startsWith('["codoxear-v2"')),
    ),
    false,
  );
  await storageProbe.close();
  pass("Logging out clears the workspace's persisted account content");
  await bobContext.close();
  pass(
    "Bob sees only his authorized agent in both account and workspace navigation",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto(issuer);
  await page.getByRole("button", { name: "Open agents", exact: true }).click();
  await page
    .getByRole("searchbox", { name: "Search agents", exact: true })
    .fill("Writing");
  assert.equal(await page.locator("[data-directory-agent]:visible").count(), 1);
  await page.getByRole("button", { name: "Close agents", exact: true }).click();
  assert.ok(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  );
  await page.screenshot({ path: "artifacts/agent-mobile.png" });
  pass("Mobile agent drawer, search, close and page width work at 390px");
  assert.deepEqual(hubBrowserRequests, []);
  assert.equal(new URL(page.url()).origin, issuer);
  pass(
    "Sign-in, creation on both hubs, agent switching, settings and file access never request either hub origin from the browser",
  );
  assert.deepEqual(errors, []);
  passed = true;
  pass("No uncaught browser errors");
} catch (e) {
  errors.push(String(e));
  console.error(e);
  console.error((await page.locator("body").innerText()).slice(-3000));
  await page.screenshot({
    path: "artifacts/agent-ui-failure.png",
    fullPage: true,
  });
  process.exitCode = 1;
} finally {
  await writeFile(
    "artifacts/agent-ui-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        origin: issuer,
        tls: process.env.CODOXEAR_TEST_SPKI
          ? "Docker fixture certificate"
          : "Browser default certificate trust",
      },
      null,
      2,
    ),
  );
  await browser.close();
}
