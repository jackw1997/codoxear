// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
const config = JSON.parse(
  await readFile(process.env.CODOXEAR_DEMO_CREDENTIAL_FILE, "utf8"),
);
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
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
page.on("console", (m) => {
  if (m.type() === "error") console.log("BROWSER", m.text());
});
page.on("requestfailed", (r) =>
  console.log("NETWORK", r.url(), r.failure()?.errorText),
);
const checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
page.on("response", async (r) => {
  if (r.status() >= 500)
    console.log(
      "HTTP",
      r.status(),
      r.url(),
      (await r.text().catch(() => "")).slice(0, 200),
    );
});
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
const origin = "https://codoxear.gzeek.com:8445";
async function connect(
  port,
  email = "alice@example.test",
  clientPage = page,
  clientContext = context,
) {
  await clientPage
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  const panel = clientPage.getByRole("dialog", {
    name: "Add hub",
    exact: true,
  });
  await panel
    .getByLabel("Hub address")
    .fill("https://codoxear.gzeek.com:" + port);
  const popupEvent = clientContext.waitForEvent("page");
  await panel.getByRole("button", { name: "Connect hub", exact: true }).click();
  const popup = await popupEvent;
  await popup.getByLabel("Email", { exact: true }).fill(email);
  await popup.getByLabel("Password", { exact: true }).fill(config.password);
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await popup.waitForEvent("close");
  await clientPage
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByText(port === 8446 ? "Home demo" : "Work demo", {
      exact: false,
    })
    .first()
    .waitFor();
  assert.equal(new URL(clientPage.url()).origin, origin);
}
async function create(index, name) {
  await page
    .getByRole("button", { name: "New session", exact: true })
    .first()
    .click();
  const d = page.getByRole("dialog", { name: "New agent", exact: true });
  const select = d.getByLabel("Computer & hub");
  await select.selectOption({
    label:
      config.computers[index].name +
      " · " +
      (index < 2 ? "Home demo" : "Work demo"),
  });
  await d.getByLabel("Runtime", { exact: true }).selectOption("pi");
  await d.getByLabel("Agent name", { exact: true }).fill(name);
  await d.getByText("More", { exact: true }).click();
  await d
    .getByLabel("Working directory", { exact: true })
    .fill(process.env.CODOXEAR_DEMO_HOME + "/c" + index + "/workspace");
  await d.getByRole("button", { name: "Create agent", exact: true }).click();
  await d.waitFor({ state: "hidden", timeout: 45000 });
  await page
    .locator(".session")
    .filter({ has: page.getByText(name, { exact: true }) })
    .waitFor({ timeout: 45000 });
}
try {
  await page.goto(origin + "/");
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .waitFor();
  await connect(8446);
  await connect(8447);
  // A compromised Home endpoint attempts to pass a valid Work authorization
  // response to the client under Home's pending state/challenge.
  const intercepted = "https://codoxear.gzeek.com:8446/oauth/authorize?**";
  await context.route(intercepted, (route) => {
    const url = new URL(route.request().url());
    url.port = "8447";
    return route.fulfill({ status: 302, headers: { location: url.href } });
  });
  let exchanged = 0;
  const watch = (r) => {
    if (r.url().endsWith("/oauth/token") && r.method() === "POST") exchanged++;
  };
  context.on("request", watch);
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  const panel = page.getByRole("dialog", { name: "Add hub", exact: true });
  await panel.getByLabel("Hub address").fill("https://codoxear.gzeek.com:8446");
  await panel.getByRole("button", { name: "Connect hub", exact: true }).click();
  await panel
    .getByRole("alert")
    .filter({ hasText: "Login issuer mismatch" })
    .waitFor();
  assert.equal(exchanged, 0);
  context.off("request", watch);
  await context.unroute(intercepted);
  await panel.getByRole("button", { name: "Back", exact: true }).click();
  pass(
    "Cross-hub OAuth mix-up is rejected before sending code or verifier to the wrong hub",
  );

  pass(
    "Two hubs authenticate independently through PKCE; the main page stays on 8445",
  );
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await page.locator("#settingsBtnSide").click();
  await page.locator("#settingsViewer").waitFor({ state: "visible" });
  await page.getByRole("radiogroup", { name: "Theme", exact: true }).waitFor();
  await page.locator("#settingsCloseBtn").click();
  assert.equal(await page.locator(".directory-workspace-nav").count(), 0);
  assert.equal(await page.locator("#sessions").count(), 1);
  pass(
    "Original sidebar and original Settings dialog retained without replacement layout",
  );
  await page.evaluate(() => {
    window.__originalShell = document.querySelector(".sidebar");
  });
  await create(0, "Independent laptop");
  await page
    .getByRole("textbox", { name: "Message", exact: true })
    .fill("run demo tool");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  const result =
    "Demo (scripted model): the real Pi CLI executed the shell tool. Open proof.txt to see the result.";
  await page.getByText(result, { exact: true }).waitFor({ timeout: 60000 });
  pass(
    "Original New session creates a real Pi agent through its independent hub; shell tool runs",
  );
  const selectedRow = page
    .locator(".session")
    .filter({ has: page.getByText("Independent laptop", { exact: true }) });
  await selectedRow.hover();
  await selectedRow
    .getByRole("button", { name: "Edit conversation", exact: true })
    .click();
  await page
    .locator("#editViewer")
    .getByRole("button", { name: "Agent access", exact: true })
    .click();
  const agentAccess = page.getByRole("dialog", {
    name: "Agent access",
    exact: true,
  });
  await agentAccess.getByText("Independent laptop", { exact: true }).waitFor();
  await page.screenshot({ path: "artifacts/design-agent-access-desktop.png" });
  await page.keyboard.press("Escape");
  assert.equal(
    await agentAccess.isVisible(),
    true,
    "Escape must not dismiss the page",
  );
  await agentAccess
    .getByRole("button", { name: "Manage computer access", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Manage access", exact: true })
    .getByLabel("Existing agents")
    .waitFor();
  await page
    .getByRole("dialog", { name: "Manage access", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await agentAccess.getByRole("button", { name: "Back", exact: true }).click();
  await page.locator("#editViewer").waitFor({ state: "visible" });
  await page.locator("#editCloseBtn").click();
  pass(
    "Agent access opens above Edit conversation, supports nested access pages and explicit Back navigation",
  );
  await create(2, "Independent work");
  await page
    .locator(".session")
    .filter({ has: page.getByText("Independent laptop", { exact: true }) })
    .click();
  await page.getByText(result, { exact: true }).waitFor();
  assert.equal(
    await page.evaluate(
      () => window.__originalShell === document.querySelector(".sidebar"),
    ),
    true,
  );
  assert.equal(new URL(page.url()).origin, origin);
  pass(
    "Cross-hub creation and switching keep the original webpage and sidebar mounted",
  );
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
    "Authenticated file preview and download use the local client transport",
  );
  await page.reload();
  await page.getByText(result, { exact: true }).waitFor();
  pass(
    "Hub credentials persist locally across reload without a central account login",
  );
  const staticLogin = await page.request.get(origin + "/api/v1/me");
  assert.equal(staticLogin.status(), 404);
  pass("The web host has no account API or identity database");
  const bobContext = await browser.newContext();
  const bob = await bobContext.newPage();
  await bob.goto(origin + "/");
  await connect(8446, "bob@example.test", bob, bobContext);
  await bob
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await bob
    .locator(".session")
    .filter({ has: bob.getByText("Independent laptop", { exact: true }) })
    .click();
  await bob.getByText(result, { exact: true }).waitFor();
  assert.equal(
    await bob.getByText("Independent work", { exact: true }).count(),
    0,
  );
  const d = await page.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
  const home = d.agents.find((a) => a.name === "Independent laptop");
  async function policy(value) {
    return page.evaluate(
      async ({ home, value }) => {
        const r = await fetch(
          "/api/client/hubs/" +
            home.loginId +
            "/api/resources/hub/" +
            home.hubId +
            "/policy",
          {
            method: "PUT",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ policy: value }),
          },
        );
        return r.status;
      },
      { home, value },
    );
  }
  assert.equal(await policy("read_only"), 200);
  assert.equal(
    await page.evaluate(
      async (home) =>
        (
          await fetch(
            "/api/client/hubs/" +
              home.loginId +
              "/api/resources/computer/" +
              home.computerId +
              "/members/bob",
            { method: "DELETE" },
          )
        ).status,
      home,
    ),
    200,
  );
  const bobId = new URL(bob.url()).hash.slice(1);
  const sid = new URLSearchParams(bobId).get("session");
  const denied = await bob.evaluate(
    async (id) =>
      (
        await fetch("/api/sessions/" + encodeURIComponent(id) + "/send", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ text: "must be rejected" }),
        })
      ).status,
    sid,
  );
  assert.equal(denied, 403);
  assert.equal(await policy("none"), 200);
  await bob
    .getByText(result, { exact: true })
    .waitFor({ state: "hidden", timeout: 15000 });
  await bobContext.close();
  pass(
    "Independent hub enforces Bob's restricted visibility, read-only retention and removal of displayed content after revocation",
  );
  const workPid = Number(
    await readFile(process.env.CODOXEAR_DEMO_HOME + "/hub-1.pid", "utf8"),
  );
  const replyText =
    "Demo (scripted model): received your message. This is a real isolated Pi session with deterministic replies, not live AI inference. Send ‘run demo tool’ to execute the supplied shell-file demonstration.";
  const count = await page.getByText(replyText, { exact: true }).count();
  process.kill(workPid, "SIGSTOP");
  try {
    await page
      .getByRole("textbox", { name: "Message", exact: true })
      .fill("Independent hub availability check");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByText(replyText, { exact: true })
      .nth(count)
      .waitFor({ timeout: 15000 });
  } finally {
    process.kill(workPid, "SIGCONT");
  }
  pass(
    "Home agent continues responding while the independent Work hub is stopped",
  );
  await page.screenshot({ path: "artifacts/independent-desktop.png" });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator("#toggleSidebarBtn").click();
  await page.waitForTimeout(500);
  await page.screenshot({ path: "artifacts/independent-mobile.png" });
  await page.locator("#logoutBtnSide").click();
  await page
    .getByText("Hub credentials removed from this device.", { exact: true })
    .waitFor();
  assert.equal(
    await page.evaluate(
      async () =>
        (await (await fetch("/api/client/directory")).json()).agents.length,
    ),
    0,
  );
  await page
    .getByRole("button", { name: "Connect a hub", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .waitFor();
  assert.equal(await page.locator("[data-forget]").count(), 0);
  pass(
    "Local logout clears credentials and reopens hub connection without a central login form",
  );
  assert.deepEqual(errors, []);
  pass("Desktop/mobile use the original theme and no uncaught browser errors");
} catch (e) {
  errors.push(String(e));
  console.error(e);
  await page.screenshot({ path: "artifacts/independent-failure.png" });
  process.exitCode = 1;
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/independent-results.json",
    JSON.stringify(
      { passed: !errors.length, checks, errors, url: page.url() },
      null,
      2,
    ),
  );
  await browser.close();
}
