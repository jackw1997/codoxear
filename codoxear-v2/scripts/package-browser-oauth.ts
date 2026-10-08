// @ts-nocheck -- Installed-package browser fixtures retain dynamic Playwright contracts.
// Run only in the clean Docker integration container, against installed exports.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { randomBytes, createHash } from "node:crypto";
import { createServer } from "node:net";
import { createServer as createHttpServer } from "node:http";
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
const browserDiagnostics = [];
const providerDiagnostics = [];
let stage = "start packages";
let browser;
let controlledProvider;
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
function start(entry, cwd, environment, preload) {
  const child = spawn(process.execPath, [...(preload ? ["--import", preload] : []), entry], {
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
  const initialization = { token: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 3600000 };
  const providerSecret = randomBytes(32).toString("base64url");
  const codes = new Map(), providerTokens = new Set();
  const escape = value => String(value).replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]);
  // Only provider transport is controlled. The installed Hub still validates
  // OAuth state, provider PKCE/tenant, initialization and its client PKCE flow.
  controlledProvider = createHttpServer(async (request, response) => {
    try {
      const url = new URL(request.url, "http://127.0.0.1");
      providerDiagnostics.push({ path: url.pathname, method: request.method });
      const json = (status, body) => { response.writeHead(status, { "Content-Type": "application/json" }); response.end(JSON.stringify(body)); };
      if (url.pathname === "/authorize") {
        assert.equal(url.searchParams.get("client_id"), "package-feishu");
        assert.equal(url.searchParams.get("code_challenge_method"), "S256");
        response.writeHead(200, { "Content-Type": "text/html" });
        response.end(`<!doctype html><title>Controlled Feishu provider</title><h1>Controlled Feishu provider</h1><p>Isolated package fixture; no live provider acceptance.</p><form action="/choose" method="get">${[...url.searchParams].map(([name, value]) => `<input type="hidden" name="${escape(name)}" value="${escape(value)}">`).join("")}<button>Sign in as Package Owner</button></form>`);
      } else if (url.pathname === "/choose") {
        const redirect = new URL(url.searchParams.get("redirect_uri"));
        assert.equal(redirect.origin, hubOrigin);
        const code = randomBytes(32).toString("base64url");
        codes.set(code, { challenge: url.searchParams.get("code_challenge"), redirect: redirect.href });
        redirect.searchParams.set("state", url.searchParams.get("state"));
        redirect.searchParams.set("code", code);
        response.writeHead(302, { Location: redirect.href }); response.end();
      } else if (url.pathname === "/open-apis/authen/v2/oauth/token") {
        let text = ""; for await (const chunk of request) text += chunk;
        const body = JSON.parse(text), proof = codes.get(body.code);
        assert.ok(proof, "Controlled provider code exists and is single-use");
        assert.equal(body.client_id, "package-feishu"); assert.equal(body.client_secret, providerSecret);
        assert.equal(body.grant_type, "authorization_code"); assert.equal(body.redirect_uri, proof.redirect);
        assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), proof.challenge);
        codes.delete(body.code);
        const access = randomBytes(32).toString("base64url"); providerTokens.add(access);
        json(200, { access_token: access });
      } else if (url.pathname === "/open-apis/authen/v1/user_info") {
        assert.ok(providerTokens.has(String(request.headers.authorization).replace(/^Bearer /, "")));
        json(200, { code: 0, data: { open_id: "package-owner", tenant_key: "package-organization", name: "Package Owner" } });
      } else json(404, { error: "Not found" });
    } catch { providerDiagnostics.push({ rejected: true }); response.writeHead(400, { "Content-Type": "application/json" }); response.end(JSON.stringify({ error: "Controlled provider rejected request" })); }
  });
  controlledProvider.listen(0, "127.0.0.1"); await once(controlledProvider, "listening");
  const providerOrigin = "http://127.0.0.1:" + controlledProvider.address().port;
  const preload = join(home, "controlled-provider-fetch.mjs");
  await writeFile(preload, `const nativeFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const url = new URL(typeof input === "string" ? input : input.url ?? input.href);
  if (url.origin === "https://open.feishu.cn" && ["/open-apis/authen/v2/oauth/token", "/open-apis/authen/v1/user_info"].includes(url.pathname)) return nativeFetch(${JSON.stringify(providerOrigin)} + url.pathname, init);
  return nativeFetch(input, init);
};
`, { mode: 0o600 });
  await writeFile(configFile, JSON.stringify({
    initialization, providers: [{ kind: "feishu", id: "package-feishu", clientId: "package-feishu", clientSecret: providerSecret, tenant: "package-organization" }],
    origin: hubOrigin, independent: true, hubId: "package-oauth-hub", name: "Installed package Hub",
    database: join(home, "hub.sqlite"), otpKey: randomBytes(32).toString("hex"),
    listenPort: hubPort, secureCookies: false, clientOrigins: [frontendOrigin],
    clients: [{ id: "codoxear-web", redirectUris: [frontendOrigin + "/auth-callback"] }],
    frontendAssetsRoot: join(frontendRoot, "dist"),
  }), { mode: 0o600 });
  const hub = start(join(hubRoot, "dist/server/hub/main.js"), hubRoot, {
    CODOXEAR_HUB_CONFIG: configFile,
  }, preload);
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
  // Playwright invokes routing for the initial request in a server redirect
  // chain. Intercept the Hub start URL, execute that real request without
  // following its redirect, and replace only the validated provider destination.
  // Its actual state/PKCE generation and Set-Cookie response remain intact.
  await context.route(url => url.origin === hubOrigin && url.pathname === "/auth/package-feishu/start", async route => {
    const upstream = await route.fetch({ maxRedirects: 0 });
    assert.equal(upstream.status(), 302, "Installed Hub starts real provider authorization");
    const authorize = new URL(upstream.headers().location);
    assert.equal(authorize.origin, "https://accounts.feishu.cn");
    assert.equal(authorize.pathname, "/open-apis/authen/v1/authorize");
    assert.equal(authorize.searchParams.get("client_id"), "package-feishu");
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    assert.ok(authorize.searchParams.get("state"));
    assert.ok(authorize.searchParams.get("code_challenge"));
    assert.equal(new URL(authorize.searchParams.get("redirect_uri")).origin, hubOrigin);
    browserDiagnostics.push({ event: "controlled_provider_authorize", path: authorize.pathname });
    await route.fulfill({ response: upstream, headers: { ...upstream.headers(), location: providerOrigin + "/authorize" + authorize.search } });
  });
  context.on("page", page => {
    page.on("pageerror", error => pageErrors.push(error.message));
    page.on("requestfailed", request => {
      const url = new URL(request.url());
      browserDiagnostics.push({ event: "requestfailed", origin: url.origin, path: url.pathname, error: request.failure()?.errorText });
    });
  });
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
  stage = "private initialization provider sign-in";
  const initialize = await context.newPage();
  await initialize.goto(hubOrigin + "/initialize?" + new URLSearchParams({ token: initialization.token }));
  assert.equal(new URL(initialize.url()).searchParams.has("token"), false, "Private initialization token is removed from the address");
  await initialize.getByRole("link", { name: "Continue with Feishu", exact: true }).click();
  await initialize.getByRole("button", { name: "Sign in as Package Owner", exact: true }).click();
  await initialize.getByText("Signed in as", { exact: false }).waitFor();
  assert.match(await initialize.getByText("Signed in as", { exact: false }).textContent(), /· Owner/, "Verified initialization identity becomes Owner");
  await initialize.close();
  pass("Private single-use initialization assigns Owner through controlled Feishu provider sign-in without account seeding");
  stage = "client provider popup and PKCE";
  await page.goto(frontendOrigin);
  await page.getByRole("button", { name: "Add hub", exact: true }).click();
  await page.getByLabel("Hub address", { exact: true }).fill(hubOrigin);
  await page.getByRole("button", { name: "Connect hub", exact: true }).click();
  const popupReady = page.waitForEvent("popup");
  await page.getByRole("button", { name: "Continue with Feishu", exact: true }).click();
  const popup = await popupReady;
  popup.setDefaultTimeout(20000);
  await popup.getByRole("button", { name: "Sign in as Package Owner", exact: true }).click();
  await page.locator("summary").filter({ hasText: "Installed package Hub" }).waitFor();
  assert.ok(oauthResponses.some((response) => response.path === "/oauth/token" && response.method === "POST" && response.status === 200), "Real PKCE code exchange succeeded");
  pass("Standalone frontend completes actual popup provider login and PKCE exchange against the exported Hub");

  stage = "browser Computer mutation";
  await page.locator("summary").filter({ hasText: "Installed package Hub" }).click();
  await page.getByRole("button", { name: "Add computer", exact: true }).click();
  await page.getByLabel("Computer name", { exact: true }).fill("OAuth package computer");
  await page.getByRole("button", { name: "Add computer", exact: true }).click();
  await page.getByRole("heading", { name: "OAuth package computer", exact: true }).waitFor();
  await page.getByRole("button", { name: "Done", exact: true }).click();
  pass("OAuth credential authorizes a real Hub management mutation through the frontend");
  stage = "reload persistence";
  await page.reload();
  const sidebarToggle = page.getByRole("button", { name: "Toggle sidebar", exact: true });
  await sidebarToggle.waitFor({ state: "visible" });
  if (!(await page.evaluate(() => document.body.classList.contains("sidebar-open"))))
    await sidebarToggle.click();
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
  // Capture visible page state before teardown; never record URL queries,
  // hidden form fields, cookies or access credentials.
  for (const context of browser?.contexts() ?? []) for (const page of context.pages()) {
    try {
      const url = new URL(page.url());
      browserDiagnostics.push({ event: "failure_page", origin: url.origin, path: url.pathname,
        title: await page.title(), visibleText: (await page.locator("body").innerText()).slice(0, 2000) });
    } catch {}
  }
  throw error;
} finally {
  await browser?.close();
  if (controlledProvider) await new Promise(done => controlledProvider.close(done));
  for (const child of children.reverse()) await stop(child);
  await rm(home, { recursive: true, force: true });
  await mkdir(dirname(output), { recursive: true });
  await writeFile(output, JSON.stringify({ passed, stage, browserDiagnostics, providerDiagnostics, providerBoundary: "Controlled Feishu browser page and HTTPS fetch transport; real installed provider adapter/state/PKCE/tenant/initialization and Hub-client OAuth; no live provider acceptance or seeded accounts", commit: release.commit, packageRoots: { frontend: frontendRoot, hub: hubRoot }, checks, oauthResponses, pageErrors, ...(failure ? { error: failure } : {}) }, null, 2) + "\n");
}
