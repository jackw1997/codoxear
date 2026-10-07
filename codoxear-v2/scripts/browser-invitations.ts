// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import Fastify from "fastify";
import { build } from "esbuild";
import { Store } from "../src/persistence/store.ts";
import {
  createHub,
  createComputer,
  passwordHash,
  reserveAgent,
} from "../src/domain/commands.ts";
import { independentAuthority } from "../src/hub/independent.ts";
import { createHubApp } from "../src/hub/app.ts";
import { HubSessions } from "../src/hub/sessions.ts";
import { Tunnels } from "../src/server/tunnels.ts";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const proxy = Fastify(),
  store = new Store(":memory:"),
  sessions = new HubSessions(":memory:");
let hub, local, origin, hubId, browser, ownerSession;
const tokens = {},
  logins = {},
  checks = [],
  errors = [];
let passed = false;
store.change((s) => {
  s.users.push({
    id: "alice",
    name: "Owner",
    email: "alice@example.test",
    passwordHash: passwordHash("fixture-password"),
    disabled: false,
  });
  hubId = createHub(s, "alice", "Invitation hub").id;
  const { computer } = createComputer(s, "alice", hubId, "Laptop", "alice");
  const shared = reserveAgent(
    s,
    "alice",
    computer.id,
    "Shared agent",
    "fixture",
  );
  shared.localId = "shared-local";
  shared.state = "ready";
  reserveAgent(s, "alice", computer.id, "Private agent", "fixture");
});
const bundle = await build({
  stdin: {
    contents: `import {openConnections, openAgentAccess} from './frontend/web/client/connections.ts'; import {vault} from './frontend/web/client/vault.ts';
  window.signAs = async (id) => { for(const login of await vault.list()) await vault.remove(login.id); const login=await (await fetch('/fixture/login/'+id)).json(); await vault.put(login); await openConnections(async()=>{},()=>{}); };
  document.querySelector('button').onclick = () => window.signAs('alice'); document.querySelector('[data-agent]').onclick = async()=>openAgentAccess(await (await fetch('/fixture/agent')).json());`,
    resolveDir: process.cwd(),
    loader: "ts",
  },
  bundle: true,
  format: "esm",
  write: false,
});
proxy.get("/", async (_r, reply) =>
  reply
    .type("text/html")
    .send(
      '<!doctype html><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/connections.css"><div id="root"><button>Hubs & computers</button><button data-agent>Agent access</button></div><script type="module" src="/fixture.js"></script>',
    ),
);
proxy.get("/fixture.js", async (_r, reply) =>
  reply.type("application/javascript").send(bundle.outputFiles[0].text),
);
for (const [url, file] of [
  ["/app.css", "dist/client/app.css"],
  ["/connections.css", "dist/client/connections.css"],
])
  proxy.get(url, async (_r, reply) =>
    reply.type("text/css").send(await readFile(file)),
  );
proxy.get("/fixture/login/:id", async (r) => logins[r.params.id]);
proxy.get("/fixture/agent", async () => {
  const a = local.authority
    .agentDirectory(local.authority.accounts.sessionById(ownerSession))
    .agents.find((a) => a.name === "Shared agent");
  return { ...a, id: "alice~" + a.id, agentId: a.id, loginId: "alice" };
});
proxy.route({
  method: ["GET", "POST", "PUT", "DELETE"],
  url: "/api/client/hubs/:id/*",
  handler: async (r, reply) => {
    const result = await hub.inject({
      method: r.method,
      url: "/" + r.params["*"],
      headers: { authorization: "Bearer " + tokens[r.params.id] },
      ...(r.body ? { payload: r.body } : {}),
    });
    return reply
      .code(result.statusCode)
      .type("application/json")
      .send(result.body);
  },
});
for (const url of ["/login", "/hub-login.js", "/api/v1/*", "/appearance/*"])
  proxy.get(url, async (r, reply) => {
    const result = await hub.inject({
      method: "GET",
      url: r.url,
      headers: { authorization: "Bearer " + tokens.feishu },
    });
    return reply
      .code(result.statusCode)
      .type(result.headers["content-type"] ?? "text/plain")
      .send(result.rawPayload);
  });
try {
  origin = await proxy.listen({ host: "127.0.0.1", port: 0 });
  local = await independentAuthority({
    origin,
    hubId,
    store,
    otpKey: "invitation-browser-fixture".repeat(3),
    secureCookies: false,
  });
  const tunnels = new Tunnels();
  tunnels.online = () => true;
  tunnels.request = async (_id, operation) =>
    operation.op === "messages" ? { messages: [] } : { ok: true };
  hub = await createHubApp({
    origin,
    authority: local.client,
    localIdentity: local.identity,
    sessions,
    tunnels,
    webRoot: "/no-assets",
    secureCookies: false,
  });
  const owner = local.authority.accounts.password(
    "alice@example.test",
    "fixture-password",
    "owner-browser",
  );
  ownerSession = owner.session.id;
  const google = local.authority.accounts.finish(
    {
      method: "google",
      connection: "google",
      subject: "verified-google-id",
      tenant: null,
      email: "member@google.fixture",
      name: "Google member",
    },
    "google-browser",
  );
  const colleague = local.authority.accounts.finish(
    {
      method: "feishu",
      connection: "company",
      subject: "open-id",
      tenant: "team-a",
      email: null,
      name: "Feishu member",
    },
    "feishu-browser",
  );
  for (const [id, signed] of [
    ["alice", owner],
    ["google", google],
    ["feishu", colleague],
  ]) {
    tokens[id] = await local.authority.tokens.issue(
      signed.session,
      origin,
      "identity_access",
    );
    logins[id] = {
      id,
      accountKey: id,
      origin,
      hubId,
      name: "Invitation hub",
      accountId: signed.session.userId,
      accessToken: "fixture",
      refreshToken: "fixture",
      expiresAt: Date.now() + 3600000,
      identity: { name: id, method: signed.session.context.method, key: id },
    };
  }
  browser = await chromium.launch({
    headless: true,
    executablePath: process.env.CHROMIUM_PATH,
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  });
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } });
  page.on("pageerror", (e) => errors.push(e.message));
  page.setDefaultTimeout(12000);
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Hubs & computers", exact: true })
    .click();
  const dialog = () => page.getByRole("dialog");
  async function settings() {
    await dialog().locator("summary").click();
    await dialog()
      .getByRole("button", { name: "Hub settings", exact: true })
      .click();
  }
  await settings();
  await dialog()
    .getByRole("button", { name: "Manage hub access", exact: true })
    .click();
  await dialog()
    .getByLabel("Invite by", { exact: true })
    .selectOption("google");
  await dialog().getByLabel("Sign-in connection").fill("google");
  await dialog().getByLabel("Identity ID").fill("verified-google-id");
  assert.equal(
    await dialog().getByLabel("Email", { exact: true }).isVisible(),
    false,
  );
  await dialog()
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await dialog()
    .locator("output")
    .filter({ hasText: "Invitation code:" })
    .waitFor();
  const googleCode = (await dialog().locator("output").textContent()).split(
    ": ",
  )[1];
  await dialog()
    .getByLabel("Invite by", { exact: true })
    .selectOption("feishu");
  await dialog().getByLabel("Sign-in connection").fill("company");
  await dialog().getByLabel("Identity ID").fill("open-id");
  await dialog().getByLabel("Tenant (optional)").fill("team-a");
  await mkdir("artifacts", { recursive: true });
  await page.screenshot({ path: "artifacts/invitations-mobile.png" });
  assert.equal(
    await dialog().evaluate((e) => e.scrollWidth <= e.clientWidth),
    true,
  );
  await dialog()
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await dialog()
    .locator("output")
    .filter({ hasText: "Invitation code:" })
    .waitFor();
  const feishuCode = (await dialog().locator("output").textContent()).split(
    ": ",
  )[1];
  checks.push(
    "Owner creates Google and tenant-specific Feishu invitations using the actual mobile Manage access form",
  );
  async function acceptAs(id, code) {
    await page.evaluate((id) => window.signAs(id), id);
    await settings();
    await dialog()
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await dialog().getByLabel("Invitation code", { exact: true }).fill(code);
    await dialog()
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
  }
  assert.equal(
    store
      .read()
      .memberships.some((member) =>
        [google.session.userId, colleague.session.userId].includes(
          member.userId,
        ),
      ),
    false,
  );
  await acceptAs("google", "invalid-invitation-code");
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "Invalid request" })
    .waitFor();
  checks.push(
    "No provider account gains access before accepting an invitation; malformed codes display an error",
  );
  await acceptAs("google", feishuCode);
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "different verified identity" })
    .waitFor();
  checks.push("An unrelated Google identity cannot redeem a Feishu invitation");
  await dialog()
    .getByLabel("Invitation code", { exact: true })
    .fill(googleCode);
  await dialog()
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .waitFor();
  assert.ok(
    store
      .read()
      .memberships.some(
        (m) => m.userId === google.session.userId && m.role === "viewer",
      ),
  );
  await acceptAs("feishu", feishuCode);
  await page
    .getByRole("dialog", { name: "Hubs & computers", exact: true })
    .waitFor();
  assert.ok(
    store
      .read()
      .memberships.some(
        (m) => m.userId === colleague.session.userId && m.role === "viewer",
      ),
  );
  checks.push(
    "Google and Feishu users accept through the actual invitation screen with verified provider identities",
  );
  await acceptAs("google", googleCode);
  await dialog()
    .getByRole("alert")
    .filter({ hasText: "already used" })
    .waitFor();
  checks.push(
    "Reusing a redeemed code displays an error without another membership change",
  );
  await page.evaluate(() => window.signAs("alice"));
  await dialog().getByRole("button", { name: "Back", exact: true }).click();
  await page.getByRole("button", { name: "Agent access", exact: true }).click();
  const form = dialog()
    .locator("form")
    .filter({
      has: page.getByRole("heading", { name: "Google member", exact: true }),
    });
  await form
    .getByLabel("Shared access for Google member")
    .selectOption("viewer");
  await form.getByRole("button", { name: "Save agent access" }).click();
  await form
    .getByRole("status")
    .filter({ hasText: "Agent access saved" })
    .waitFor();
  const recipient = await browser.newPage({
    viewport: { width: 390, height: 844 },
  });
  recipient.on("pageerror", (e) => errors.push(e.message));
  await recipient.goto(origin);
  await recipient.evaluate(() => window.signAs("google"));
  const snapshot = () =>
    recipient.evaluate(async () =>
      (await fetch("/api/client/hubs/google/api/agent-directory")).json(),
    );
  let directory = await snapshot();
  assert.deepEqual(
    directory.agents.map((a) => a.name),
    ["Shared agent"],
  );
  assert.deepEqual(directory.placements, []);
  const sharedId = directory.agents[0].id;
  const trySend = () =>
    recipient.evaluate(
      async (id) =>
        (
          await fetch(`/api/client/hubs/google/api/agents/${id}/send`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ text: "hello" }),
          })
        ).status,
      sharedId,
    );
  assert.equal(await trySend(), 403);
  await form
    .getByLabel("Shared access for Google member")
    .selectOption("operator");
  const upgraded = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.url().includes("/shares/") &&
      r.status() === 200,
  );
  await form.getByRole("button", { name: "Save agent access" }).click();
  await upgraded;
  assert.equal(await trySend(), 200);
  await form
    .locator("[data-current-access]")
    .filter({ hasText: "Shared agent operator" })
    .waitFor();
  await page.screenshot({ path: "artifacts/agent-sharing-mobile.png" });
  await form
    .getByLabel("Shared access for Google member")
    .selectOption("viewer");
  const downgraded = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.url().includes("/shares/") &&
      r.status() === 200,
  );
  await form.getByRole("button", { name: "Save agent access" }).click();
  await downgraded;
  await form
    .locator("[data-current-access]")
    .filter({ hasText: "Shared agent viewer" })
    .waitFor();
  assert.equal(await trySend(), 403);
  await form.getByLabel("Shared access for Google member").selectOption("");
  const saved = page.waitForResponse(
    (r) =>
      r.request().method() === "PUT" &&
      r.url().includes("/shares/") &&
      r.status() === 200,
  );
  await form.getByRole("button", { name: "Save agent access" }).click();
  await saved;
  directory = await snapshot();
  assert.deepEqual(directory.agents, []);
  assert.equal(await trySend(), 403);
  checks.push(
    "Two browser accounts verify single-agent viewer/operator sharing and revocation without computer membership, private-agent visibility or creation rights",
  );
  await recipient.close();
  const identityPage = await browser.newPage();
  identityPage.on("pageerror", (e) => errors.push(e.message));
  await identityPage
    .context()
    .grantPermissions(["clipboard-read", "clipboard-write"], { origin });
  await identityPage.goto(origin + "/login");
  await identityPage
    .getByRole("button", { name: "Copy invitation details" })
    .click();
  await identityPage
    .getByRole("button", { name: "Copied", exact: true })
    .waitFor();
  assert.deepEqual(
    JSON.parse(
      await identityPage.evaluate(() => navigator.clipboard.readText()),
    ),
    {
      method: "feishu",
      connection: "company",
      subject: "open-id",
      tenant: "team-a",
    },
  );
  checks.push(
    "Actual hub Sign-in methods copies the exact connection, identity and tenant for an invitation",
  );
  await identityPage.close();
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/invitation-results.json",
    JSON.stringify({ passed, checks, errors }, null, 2),
  );
  await browser?.close();
  await hub?.close();
  await local?.identity.close();
  await proxy.close();
  sessions.close();
  store.close();
}
console.log(JSON.stringify({ passed, checks, errors }, null, 2));
