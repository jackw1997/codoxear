// @ts-nocheck -- Installed-package browser fixtures retain dynamic Playwright contracts.
// Run only in the clean Docker integration container, against installed exports.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import { once } from "node:events";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawn } from "node:child_process";

assert.ok(existsSync("/.dockerenv"), "Package browser acceptance requires Docker");
const frontendRoot = await realpath(process.env.FRONTEND_PACKAGE_ROOT ?? "/installed/frontend");
const hubRoot = await realpath(process.env.HUB_PACKAGE_ROOT ?? "/installed/hub");
const output = resolve(process.argv[2] ?? "/tmp/package-browser-oauth.json");
assert.notEqual(frontendRoot, hubRoot, "Frontend and Hub are separate installed packages");
for (const path of ["frontend", "src/client", "src/computer", "src/identity", "src/server"])
  assert.equal(existsSync(join(hubRoot, path)), false, "Hub export has no peer source: " + path);
assert.ok(existsSync(join(hubRoot, "dist/server/hub/main.js")), "Installed compiled Hub entry");
assert.ok(existsSync(join(frontendRoot, "serve.mjs")), "Installed frontend server entry");
assert.ok(existsSync(join(frontendRoot, "dist/client/index.html")), "Built standalone frontend artifact");
const release = JSON.parse(await readFile(join(hubRoot, "release.json"), "utf8"));
assert.equal(release.component, "hub");
const home = await mkdtemp(join(tmpdir(), "package-browser-oauth-"));
const children = [];
const checks = [];
const pageErrors = [];
const oauthResponses = [];
let browser;
let passed = false;
let failure;
const pass = (name) => { checks.push(name); console.log("PASS", name); };

async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = server.address().port;
  await new Promise((done) => server.close(done));
  return value;
}
function start(entry, cwd, environment) {
  const child = spawn(process.execPath, [entry], {
    cwd, env: { ...process.env, ...environment }, stdio: ["ignore", "pipe", "pipe"],
  });
  let log = "";
  child.stdout.on("data", (data) => { log += data; });
  child.stderr.on("data", (data) => { log += data; });
  children.push(child);
  return { child, log: () => log };
}
async function ready(origin, service) {
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    if (service.child.exitCode !== null) throw new Error(service.log());
    try { if ((await fetch(origin + "/health")).ok) return; } catch {}
    await new Promise((done) => setTimeout(done, 100));
  }
  throw new Error("Installed service failed to start: " + service.log());
}
async function stop(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  const timer = setTimeout(() => { if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL"); }, 5000);
  try { await exited; } finally { clearTimeout(timer); }
}

try {
  const hubPort = await port(), frontendPort = await port();
  const hubOrigin = `http://127.0.0.1:${hubPort}`;
  const frontendOrigin = `http://127.0.0.1:${frontendPort}`;
  const configFile = join(home, "hub.json");
  const password = randomBytes(24).toString("base64url");
  await writeFile(configFile, JSON.stringify({
    origin: hubOrigin, independent: true, hubId: "package-oauth-hub", name: "Installed package Hub",
    database: join(home, "hub.sqlite"), otpKey: randomBytes(32).toString("hex"),
    listenPort: hubPort, secureCookies: false, clientOrigins: [frontendOrigin],
    clients: [{ id: "codoxear-web", redirectUris: [frontendOrigin + "/auth-callback"] }],
    frontendAssetsRoot: join(frontendRoot, "dist"),
  }), { mode: 0o600 });
  const hub = start(join(hubRoot, "dist/server/hub/main.js"), hubRoot, {
    CODOXEAR_HUB_CONFIG: configFile, CODOXEAR_BOOTSTRAP_EMAIL: "owner@example.test", CODOXEAR_BOOTSTRAP_PASSWORD: password,
  });
  const frontend = start(join(frontendRoot, "serve.mjs"), frontendRoot, {
    CODOXEAR_CLIENT_PORT: String(frontendPort), CODOXEAR_CLIENT_HOST: "127.0.0.1",
  });
  await ready(hubOrigin, hub);
  await ready(frontendOrigin, frontend);
  pass("Compiled exported Hub and independently built frontend start from their installed packages");
  for (const path of ["/login", "/hub-login.js", "/appearance/app.css"])
    assert.equal((await fetch(hubOrigin + path)).status, 200, "Attached frontend artifact: " + path);
  pass("Hub browser login assets resolve only from the explicitly attached frontend artifact");

  const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ?? "playwright");
  browser = await chromium.launch({ headless: true, ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {}), args: ["--no-sandbox", "--disable-dev-shm-usage"] });
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  context.on("page", (page) => page.on("pageerror", (error) => pageErrors.push(error.message)));
  context.on("response", (response) => {
    const url = new URL(response.url());
    if (url.origin === hubOrigin && url.pathname.startsWith("/oauth/"))
      oauthResponses.push({ path: url.pathname, method: response.request().method(), status: response.status() });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(20000);
  const network = await context.newCDPSession(page);
  await network.send("Network.enable");
  await network.send("Network.emulateNetworkConditions", { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1, connectionType: "ethernet" });
  await page.goto(frontendOrigin);
  await page.getByRole("button", { name: "Add hub", exact: true }).click();
  await page.getByLabel("Hub address", { exact: true }).fill(hubOrigin);
  const popupReady = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Connect hub", exact: true }).click();
  const popup = await popupReady;
  popup.setDefaultTimeout(20000);
  await popup.getByLabel("Email", { exact: true }).fill("owner@example.test");
  await popup.getByLabel("Password", { exact: true }).fill(password);
  await popup.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Installed package Hub" }).waitFor();
  assert.ok(oauthResponses.some((response) => response.path === "/oauth/token" && response.method === "POST" && response.status === 200), "Real PKCE code exchange succeeded");
  pass("Standalone frontend completes actual popup password login and PKCE exchange against the exported Hub");

  await page.locator("summary").filter({ hasText: "Installed package Hub" }).click();
  await page.getByRole("button", { name: "Add computer", exact: true }).click();
  await page.getByLabel("Computer name", { exact: true }).fill("OAuth package computer");
  await page.getByRole("button", { name: "Add computer", exact: true }).click();
  await page.getByRole("heading", { name: "OAuth package computer", exact: true }).waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  pass("OAuth credential authorizes a real Hub management mutation through the frontend");
  await page.reload();
  await page.getByRole("button", { name: "Hubs & computers", exact: true }).click();
  const summary = page.locator("summary").filter({ hasText: "Installed package Hub" });
  await summary.waitFor();
  await summary.click();
  await page.getByRole("button").filter({ hasText: "OAuth package computer" }).waitFor();
  pass("Reload restores the frontend login and reads the persisted computer from the independently owned Hub database");
  assert.deepEqual(pageErrors, []);
  pass("Package browser integration completes without uncaught page errors");
  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await browser?.close();
  for (const child of children.reverse()) await stop(child);
  await rm(home, { recursive: true, force: true });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ passed, commit: release.commit, packageRoots: { frontend: frontendRoot, hub: hubRoot }, checks, oauthResponses, pageErrors, ...(failure ? { error: failure } : {}) }, null, 2) + "\n");
}
