// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE),
  config = JSON.parse(
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
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage();
page.setDefaultTimeout(20000);
const checks = [],
  errors = [];
page.on("pageerror", (e) => errors.push(e.message));
const pass = (s) => {
  checks.push(s);
  console.log("PASS", s);
};
const origin = "https://codoxear.gzeek.com:8445";
const view = (name) => page.getByRole("dialog", { name, exact: true });
async function screenshot(name) {
  await page.screenshot({ path: "artifacts/design-" + name + ".png" });
}
async function layout(target) {
  assert.equal(
    await target.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  const invalid = await target
    .locator(
      ".connectionPage button,.connectionPage input,.connectionLogin button,.connectionLogin input",
    )
    .evaluateAll((nodes) =>
      nodes
        .filter((n) => n.getClientRects().length)
        .some((n) => {
          const r = n.getBoundingClientRect();
          return r.x < 0 || r.right > innerWidth + 1 || r.height < 43;
        }),
    );
  assert.equal(
    invalid,
    false,
    "Controls should fit viewport with 44px targets",
  );
}
async function connect(port, first = false) {
  await view("Hubs & computers")
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  const add = view("Add hub");
  if (first) {
    await screenshot("add-hub");
    await add.getByLabel("Hub address").fill("invalid-address");
    await add.getByRole("button", { name: "Connect hub", exact: true }).click();
    await add
      .getByRole("alert")
      .filter({ hasText: /complete HTTPS hub address/ })
      .waitFor();
  }
  await add
    .getByLabel("Hub address")
    .fill("https://codoxear.gzeek.com:" + port);
  const event = context.waitForEvent("page");
  await add.getByRole("button", { name: "Connect hub", exact: true }).click();
  const popup = await event;
  popup.on("pageerror", (e) => errors.push(e.message));
  await popup
    .getByRole("heading", { name: "Codoxear login", exact: true })
    .waitFor();
  await popup.waitForFunction(
    () => document.documentElement.dataset.theme === "clay",
  );
  await popup.setViewportSize({ width: 560, height: 740 });
  await popup.locator("input[name=password]").waitFor();
  if (first) {
    await popup.screenshot({ path: "artifacts/design-login-desktop.png" });
    await popup.setViewportSize({ width: 390, height: 844 });
    await layout(popup);
    await popup.screenshot({ path: "artifacts/design-login-mobile.png" });
    await popup.getByLabel("Email", { exact: true }).fill("alice@example.test");
    await popup
      .getByLabel("Password", { exact: true })
      .fill("incorrect-password");
    await popup.getByRole("button", { name: "Sign in", exact: true }).click();
    await popup
      .getByRole("alert")
      .filter({ hasText: /failed|Invalid|incorrect/i })
      .waitFor();
    pass(
      "Login uses the shared Clay theme, fits mobile, and shows rejected-password feedback",
    );
  }
  await popup.getByLabel("Email", { exact: true }).fill("alice@example.test");
  await popup.getByLabel("Password", { exact: true }).fill(config.password);
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await popup.waitForEvent("close");
  await view("Hubs & computers")
    .getByText(port === 8446 ? "Home demo" : "Work demo", { exact: true })
    .waitFor();
}
try {
  await page.goto(origin + "/");
  await view("Hubs & computers").waitFor();
  await page.evaluate(
    () => (window.__shell = document.querySelector(".sidebar")),
  );
  assert.equal(await view("Hubs & computers").locator("form,input").count(), 0);
  await screenshot("empty");
  await view("Hubs & computers")
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  await view("Add hub")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await view("Hubs & computers").waitFor();
  await connect(8446, true);
  await connect(8447);
  pass(
    "Add hub is a separate page; cancel and successful login return to the hub list",
  );
  assert.equal(await page.locator(".connectionHub").count(), 2);
  assert.equal(await page.locator(".connectionHub[open]").count(), 0);
  assert.equal(await view("Hubs & computers").locator("form,input").count(), 0);
  await screenshot("hubs-collapsed");
  const home = page
      .locator(".connectionHub")
      .filter({ has: page.getByText("Home demo", { exact: true }) }),
    work = page
      .locator(".connectionHub")
      .filter({ has: page.getByText("Work demo", { exact: true }) });
  await home.locator("summary").click();
  await home.getByText("Home laptop", { exact: true }).waitFor();
  await home.getByText("Home workstation", { exact: true }).waitFor();
  assert.equal(
    await home.getByText("Work computer", { exact: true }).count(),
    0,
  );
  await screenshot("hubs-expanded-desktop");
  for (const size of [
    { width: 944, height: 572 },
    { width: 1888, height: 1145 },
    { width: 844, height: 390 },
    { width: 320, height: 640 },
  ]) {
    await page.setViewportSize(size);
    await layout(page);
    const bounds = await page.locator(".connectionPanel").boundingBox();
    assert.ok(bounds.width <= (size.width > 520 ? 522 : size.width));
    assert.ok(bounds.y >= 0 && bounds.y + bounds.height <= size.height + 1);
    await screenshot("hubs-" + size.width + "x" + size.height);
  }
  pass(
    "Hub panels fit desktop, foldable, narrow phone and short landscape viewports",
  );
  await page.setViewportSize({ width: 390, height: 844 });
  await layout(page);
  await screenshot("hubs-expanded-mobile");
  await home.getByRole("button", { name: "Add computer", exact: true }).click();
  await view("Add computer")
    .getByLabel("Computer name")
    .fill("Discard this name");
  await view("Add computer")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  await home.getByText("Home laptop", { exact: true }).waitFor();
  assert.equal(
    await page.getByText("Discard this name", { exact: true }).count(),
    0,
  );
  await home.getByRole("button", { name: "Add computer", exact: true }).click();
  await layout(page);
  await screenshot("add-computer-mobile");
  await view("Add computer")
    .getByLabel("Computer name")
    .fill("Design test computer");
  await view("Add computer")
    .getByRole("button", { name: "Add computer", exact: true })
    .click();
  await view("Pair computer")
    .getByText("Design test computer", { exact: true })
    .waitFor();
  await layout(page);
  const pairingCode = await view("Pair computer")
    .locator("[data-code]")
    .innerText();
  assert.match(pairingCode, /^[A-HJ-NP-Z2-9]{8}$/);
  await view("Pair computer")
    .getByText(/expires in 15 minutes/)
    .waitFor();
  await view("Pair computer")
    .getByRole("button", { name: "Copy attach command", exact: true })
    .click();
  assert.ok(
    (await page.evaluate(() => navigator.clipboard.readText())).includes(
      "--code " + pairingCode,
    ),
  );
  await view("Pair computer")
    .getByRole("button", { name: "Setup guide", exact: true })
    .click();
  await view("Computer setup")
    .getByRole("heading", { name: "1. Install Codoxear Computer", exact: true })
    .waitFor();
  await layout(page);
  await screenshot("computer-setup-mobile");
  await view("Computer setup")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  assert.equal(
    await view("Pair computer").locator("[data-code]").innerText(),
    pairingCode,
  );
  await screenshot("pair-computer-mobile");
  await view("Pair computer")
    .getByRole("button", { name: "Copy code", exact: true })
    .click();
  await view("Pair computer")
    .getByText("Code copied", { exact: true })
    .waitFor();
  await view("Pair computer")
    .getByRole("button", { name: "Done", exact: true })
    .click();
  await home.getByText("Design test computer", { exact: true }).waitFor();
  await home.getByRole("button", { name: /Design test computer/ }).click();
  await view("Design test computer").waitFor();
  await layout(page);
  await screenshot("computer-details-mobile");
  await view("Design test computer")
    .getByRole("button", { name: "Manage access", exact: true })
    .click();
  await view("Manage access").getByLabel("Existing agents").waitFor();
  await layout(page);
  await screenshot("computer-access-mobile");
  await view("Manage access")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await view("Design test computer")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await home.getByText("Home laptop", { exact: true }).waitFor();
  await home.locator("summary").click();
  await home
    .getByText("Home laptop", { exact: true })
    .waitFor({ state: "hidden" });
  await work.locator("summary").click();
  await work.getByText("Work computer", { exact: true }).waitFor();
  assert.equal(
    await work.getByText("Design test computer", { exact: true }).count(),
    0,
  );
  pass(
    "Expandable hub lists contain only their computers; separate Add computer creates and pairs under the selected hub",
  );
  await work.getByRole("button", { name: "Hub settings", exact: true }).click();
  await layout(page);
  await screenshot("hub-settings-mobile");
  await view("Hub settings")
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await layout(page);
  await screenshot("accept-invitation-mobile");
  await view("Accept invitation")
    .getByLabel("Invitation code")
    .fill("not-a-valid-invitation");
  await view("Accept invitation")
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await view("Accept invitation")
    .getByRole("alert")
    .filter({ hasText: /.+/ })
    .waitFor();
  await screenshot("invitation-error-mobile");
  await view("Accept invitation")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await view("Hub settings")
    .getByRole("button", { name: "Disconnect", exact: true })
    .click();
  await layout(page);
  await screenshot("disconnect-mobile");
  await view("Disconnect hub")
    .getByRole("button", { name: "Cancel", exact: true })
    .click();
  const settingsPopup = context.waitForEvent("page");
  await view("Hub settings")
    .getByRole("button", { name: "Sign-in methods", exact: true })
    .click();
  const identities = await settingsPopup;
  await identities
    .getByRole("heading", { name: "Sign-in methods", exact: true })
    .waitFor();
  await identities.setViewportSize({ width: 390, height: 844 });
  await layout(identities);
  await identities.screenshot({
    path: "artifacts/design-sign-in-methods-mobile.png",
  });
  await identities.close();
  pass(
    "Computer details, access, pairing, invitation errors, disconnect and sign-in methods share the same mobile controls",
  );
  await view("Hub settings")
    .getByRole("button", { name: "Manage hub access", exact: true })
    .click();
  await view("Manage access").getByLabel("Existing agents").waitFor();
  await layout(page);
  await screenshot("hub-access-mobile");
  await view("Manage access")
    .getByLabel("Existing agents")
    .selectOption("read_only");
  await view("Manage access")
    .getByRole("button", { name: "Save policy", exact: true })
    .click();
  await view("Manage access")
    .getByText("Policy saved", { exact: true })
    .waitFor();
  await view("Manage access")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await view("Hub settings")
    .getByRole("button", { name: "Manage hub access", exact: true })
    .click();
  assert.equal(
    await view("Manage access").getByLabel("Existing agents").inputValue(),
    "read_only",
  );
  await view("Manage access")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await view("Hub settings")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await view("Hubs & computers")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  assert.equal(
    await page.evaluate(() => document.querySelector("#root").inert),
    false,
  );
  assert.equal(
    await page.evaluate(
      () => window.__shell === document.querySelector(".sidebar"),
    ),
    true,
  );
  assert.equal(new URL(page.url()).origin, origin);
  pass(
    "Settings use separate Back navigation, retain saved policy and restore the mounted agent interface",
  );
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.locator("#settingsBtnSide").click();
  await page.getByRole("radiogroup", { name: "Theme", exact: true }).waitFor();
  for (const family of ["Slate", "Paper", "Clay"]) {
    await page.getByRole("radio", { name: family, exact: true }).click();
    await page.locator("#settingsCloseBtn").click();
    await page
      .getByRole("button", { name: "Hubs & computers", exact: true })
      .click();
    await page.waitForFunction(
      (f) => document.documentElement.dataset.theme === f,
      family.toLowerCase(),
    );
    await screenshot("hubs-" + family.toLowerCase());
    await page.emulateMedia({ colorScheme: "dark" });
    await page.locator('html[data-mode="dark"]').waitFor();
    await screenshot("hubs-" + family.toLowerCase() + "-dark");
    await page.emulateMedia({ colorScheme: "light" });
    await page.locator('html[data-mode="light"]').waitFor();
    await view("Hubs & computers")
      .getByRole("button", { name: "Back", exact: true })
      .click();
    if (family !== "Clay") {
      await page.locator("#settingsBtnSide").click();
    }
  }
  pass(
    "Infrastructure pages follow all three existing theme families through the original Settings controls",
  );
  await page.locator("#logoutBtnSide").click();
  await page
    .getByRole("heading", { name: "Connect to your agents", exact: true })
    .waitFor();
  for (const size of [
    { width: 944, height: 572 },
    { width: 1888, height: 1145 },
    { width: 390, height: 844 },
    { width: 844, height: 390 },
  ]) {
    await page.setViewportSize(size);
    await layout(page);
    const bounds = await page.locator(".connectionLogin").boundingBox();
    assert.ok(
      Math.abs(bounds.x + bounds.width / 2 - size.width / 2) < 2,
      "Signed-out content centered horizontally",
    );
    assert.ok(
      Math.abs(bounds.y + bounds.height / 2 - size.height / 2) < 2,
      "Signed-out content centered vertically",
    );
    await screenshot("signed-out-" + size.width + "x" + size.height);
  }
  await page
    .getByRole("button", { name: "Connect a hub", exact: true })
    .click();
  await view("Hubs & computers")
    .getByRole("heading", { name: "No hubs yet", exact: true })
    .waitFor();
  pass(
    "Signed-out screen is branded, centered at foldable and phone sizes, and reconnect returns to the empty list",
  );
  const callback = await context.newPage();
  await callback.goto(origin + "/auth-callback");
  await callback
    .getByRole("heading", { name: "Return to Codoxear", exact: true })
    .waitFor();
  await layout(callback);
  await callback.screenshot({ path: "artifacts/design-callback.png" });
  await callback.close();
  pass(
    "Expired sign-in callback uses the shared appearance and tells users how to reconnect",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(String(e));
  console.error(e);
  process.exitCode = 1;
  await screenshot("failure");
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/connection-design-results.json",
    JSON.stringify(
      { passed: !errors.length, checks, errors, url: page.url() },
      null,
      2,
    ),
  );
  await browser.close();
}
