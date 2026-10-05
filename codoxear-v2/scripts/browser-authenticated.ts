// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import assert from "node:assert/strict";
import { existsSync, openSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { spawn } from "node:child_process";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = process.env.CODOXEAR_AUTH_TEST_HOME ?? "/live";
const { password } = JSON.parse(await readFile("/demo-data/demo.json", "utf8"));
const runtime = JSON.parse(await readFile(home + "/runtime.json", "utf8"));
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE);
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
const pass = (name) => {
  checks.push(name);
  console.log("PASS", name);
};
const view = (name) => page.getByRole("dialog", { name, exact: true });
const origin = "https://codoxear.gzeek.com:8445",
  hub = "https://codoxear.gzeek.com:8446";
async function screenshot(name) {
  await page.screenshot({ path: home + "/artifacts/auth-" + name + ".png" });
}
async function command(args, input = "") {
  const child = spawn(process.execPath, args, {
    cwd: "/work",
    env: { ...process.env, CODOXEAR_COMPUTER_HOME: home + "/computer" },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let output = "",
    stderr = "";
  child.stdout.on("data", (v) => (output += v));
  child.stderr.on("data", (v) => (stderr += v));
  child.stdin.end(input);
  const code = await new Promise((resolve, reject) => {
    child.on("error", reject);
    child.on("exit", resolve);
  });
  assert.equal(
    code,
    0,
    (output + stderr).replaceAll(runtime.password, "[redacted]"),
  );
  return output;
}
try {
  await mkdir(home + "/artifacts", { recursive: true });
  await page.goto(origin);
  await view("Hubs & computers")
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  await view("Add hub").getByLabel("Hub address").fill(hub);
  const popupEvent = context.waitForEvent("page");
  await view("Add hub")
    .getByRole("button", { name: "Connect hub", exact: true })
    .click();
  const popup = await popupEvent;
  await popup.getByLabel("Email", { exact: true }).fill("alice@example.test");
  await popup.getByLabel("Password", { exact: true }).fill(password);
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await popup.waitForEvent("close");
  const homeHub = page
    .locator(".connectionHub")
    .filter({ has: page.getByText("Home demo", { exact: true }) });
  await homeHub.locator("summary").click();
  const attached = existsSync(home + "/computer/attachment.json");
  if (!attached) {
    await homeHub
      .getByRole("button", { name: "Add computer", exact: true })
      .click();
    await view("Add computer")
      .getByLabel("Computer name")
      .fill("Authenticated Computer");
    await view("Add computer")
      .getByRole("button", { name: "Add computer", exact: true })
      .click();
    await view("Pair computer")
      .locator("[data-code]")
      .filter({ hasText: /[A-Z2-9]{8}/ })
      .waitFor();
    const code = await view("Pair computer").locator("[data-code]").innerText();
    assert.match(code, /^[A-HJ-NP-Z2-9]{8}$/);
    await view("Pair computer")
      .getByText(/15 minutes/)
      .waitFor();
    await view("Pair computer")
      .getByRole("button", { name: "Setup guide", exact: true })
      .click();
    const downloadEvent = page.waitForEvent("download");
    await view("Computer setup")
      .getByRole("link", { name: "Download Computer source", exact: true })
      .click();
    const download = await downloadEvent;
    await download.saveAs(home + "/computer-source.tar.gz");
    assert.equal(
      (await readFile(home + "/computer-source.tar.gz"))
        .subarray(0, 2)
        .toString("hex"),
      "1f8b",
    );
    await screenshot("setup-guide");
    await view("Computer setup")
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await command(
      [
        "dist/server/computer/main.js",
        "attach",
        "--hub",
        hub,
        "--code",
        code.toLowerCase(),
        "--local-url",
        "http://127.0.0.1:19549",
        "--workspace",
        home + "/workspace",
      ],
      runtime.password + "\n",
    );
    await view("Pair computer")
      .getByRole("button", { name: "Done", exact: true })
      .click();
  }
  const status = JSON.parse(
    await command(["dist/server/computer/main.js", "status"]),
  );
  assert.equal(status.attached, true);
  if (!status.running) {
    const log = openSync(home + "/computer.log", "a", 0o600);
    const service = spawn(
      process.execPath,
      ["dist/server/computer/main.js", "start"],
      {
        cwd: "/work",
        env: { ...process.env, CODOXEAR_COMPUTER_HOME: home + "/computer" },
        stdio: ["ignore", log, log],
        detached: true,
      },
    );
    service.unref();
    await writeFile(home + "/computer.pid", String(service.pid));
  }
  // Refresh the collapsed tree through normal navigation to observe the live connection.
  for (let attempt = 0; attempt < 20; attempt++) {
    const row = homeHub.getByRole("button", { name: /Authenticated Computer/ });
    if ((await row.count()) && /Online/.test(await row.innerText())) break;
    await view("Hubs & computers")
      .getByRole("button", { name: "Back", exact: true })
      .click();
    await page
      .getByRole("button", { name: "Hubs & computers", exact: true })
      .click();
    await homeHub.locator("summary").click();
    await page.waitForTimeout(500);
  }
  await homeHub
    .getByRole("button", { name: /Authenticated Computer.*Online/ })
    .waitFor();
  await screenshot("computer-online");
  pass(
    "Browser creates a Computer, downloads setup sources, and CLI attaches with an 8-character code; Computer becomes Online",
  );
  await view("Hubs & computers")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  for (const backend of ["Codex", "Pi"]) {
    const name = backend + " · authenticated";
    const directory = await page.evaluate(async () =>
      (await fetch("/api/client/directory")).json(),
    );
    const existing = directory.agents
      .filter(
        (a) => a.name === name && a.computerName === "Authenticated Computer",
      )
      .sort((a, b) => a.createdAt - b.createdAt)[0];
    const row = existing
      ? page.locator('.session[data-session-id="' + existing.id + '"]')
      : page
          .locator(".session")
          .filter({ has: page.getByText(name, { exact: true }) })
          .first();
    if (!existing) {
      await page.locator("#newBtn").click();
      await page
        .getByLabel("Computer & hub", { exact: true })
        .selectOption({ label: "Authenticated Computer · Home demo" });
      // The existing workspace refreshes available runtime defaults through its session catalog.
      await page.waitForTimeout(5500);
      await view("New session")
        .getByRole("button", { name: backend, exact: true })
        .click();
      await view("New session")
        .getByLabel("Session name", { exact: true })
        .fill(name);
      await page.locator("#newSessionCwdInput").fill(home + "/workspace");
      await screenshot("new-" + backend.toLowerCase());
      await view("New session")
        .getByRole("button", { name: "Start session", exact: true })
        .click();
      await view("New session").waitFor({ state: "hidden", timeout: 90000 });
      await row.waitFor({ timeout: 90000 });
    }
    await row.waitFor({ timeout: 30000 });
    await row.click();
    const marker = backend.toUpperCase() + "_WEB_PROOF_OK",
      file = backend.toLowerCase() + "-live-proof.txt";
    const hasProof =
      existsSync(home + "/workspace/" + file) &&
      (await page
        .getByText(marker, { exact: true })
        .last()
        .waitFor({ timeout: 5000 })
        .then(
          () => true,
          () => false,
        ));
    if (!hasProof) {
      await page
        .getByRole("textbox", { name: "Message", exact: true })
        .fill(
          `Use a shell tool to write the text '${backend} real authenticated tool execution' to ${file} in the current workspace, then use a shell tool to read it back. Do not access credentials or unrelated files. Reply exactly ${marker} when the read succeeds.`,
        );
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await page
        .getByText(marker, { exact: true })
        .last()
        .waitFor({ timeout: 180000 });
    }
    assert.equal(
      (await readFile(home + "/workspace/" + file, "utf8")).trim(),
      backend + " real authenticated tool execution",
    );
    await screenshot(backend.toLowerCase() + "-reply");
    await page.locator("#fileBtn").click();
    await page.locator("#filePickerInput").fill(file);
    await page
      .locator("#filePickerMenu")
      .getByText(file, { exact: false })
      .first()
      .click();
    await page
      .locator("#fileViewer")
      .getByText(backend + " real authenticated tool execution", {
        exact: false,
      })
      .first()
      .waitFor();
    await screenshot(backend.toLowerCase() + "-file");
    await page.locator("#fileCloseBtn").click();
    pass(
      backend +
        " creates an authenticated agent through the hub, runs real shell tools, streams a reply and displays its file in the browser",
    );
  }
  assert.equal(new URL(page.url()).origin, origin);
  assert.deepEqual(errors, []);
} catch (e) {
  errors.push(String(e));
  console.error(e);
  process.exitCode = 1;
  await screenshot("failure");
} finally {
  await writeFile(
    home + "/artifacts/authenticated-results.json",
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
