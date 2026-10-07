// @ts-nocheck -- Docker-only browser acceptance using controlled real OAuth providers.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Store } from "../src/persistence/store.js";
import { createComputer, reserveAgent } from "../src/domain/commands.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import { createStaticServer } from "../frontend/serve.mjs";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const origin = "http://127.0.0.1:19954",
  clientOrigin = "http://127.0.0.1:19955";
const store = new Store(":memory:"),
  sessions = new HubSessions(":memory:");
const initialization = {
  token: "private-initialization-fixture-" + "t".repeat(40),
  expiresAt: Date.now() + 3600000,
};
const pending = store.change((state) =>
  initializeHub(state, "registration-hub", "Registration Hub"),
);
const computer = store.change((state) => {
  const reserved = state.users.find((user) => user.id === pending.ownerId);
  reserved.disabled = false;
  const value = createComputer(
    state,
    reserved.id,
    pending.id,
    "Shared computer",
    reserved.id,
  ).computer;
  reserved.disabled = true;
  return value;
});
let googleAccount = "owner",
  transientRefresh = false;
const providers = ["google", "feishu"].map((method) => ({
  id: method + "-fixture",
  method,
  ...(method === "feishu" ? { tenant: "fixture-company" } : {}),
  async authorize(state) {
    return (
      origin + "/fixture-provider?" + new URLSearchParams({ state, method })
    );
  },
  async exchange() {
    return method === "google"
      ? {
          method,
          connection: method + "-fixture",
          subject: googleAccount + "-verified-id",
          tenant: null,
          email: googleAccount + "@fixture.test",
          name: googleAccount === "owner" ? "Hub owner" : "Bob",
        }
      : {
          method,
          connection: method + "-fixture",
          subject: "alice-verified-id",
          tenant: "fixture-company",
          email: null,
          name: "Alice",
        };
  },
}));
const local = await independentAuthority({
  origin,
  hubId: pending.id,
  store,
  secureCookies: false,
  setup: hubSetup(store, pending.id, initialization),
  providers,
  clients: [
    { id: "codoxear-web", redirectUris: [clientOrigin + "/auth-callback"] },
  ],
});
const hub = await createHubApp({
  origin,
  authority: local.client,
  localIdentity: local.identity,
  sessions,
  tunnels: new Tunnels(),
  secureCookies: false,
  clientOrigins: [clientOrigin],
});
hub.get("/fixture-provider", async (request, reply) =>
  reply.redirect(
    `/auth/${request.query.method}-fixture/callback?` +
      new URLSearchParams({
        state: request.query.state,
        code: "controlled-code",
      }),
  ),
);
const dispatches = [];
let agent;
hub.addHook("preHandler", async (request, reply) => {
  if (
    transientRefresh &&
    request.url === "/oauth/token" &&
    request.body?.grant_type === "refresh_token"
  )
    return reply
      .code(503)
      .send({ code: "temporarily_unavailable", error: "Fixture outage" });
  if (
    agent &&
    request.method === "POST" &&
    request.url === `/workspace/api/sessions/${agent.id}/send`
  ) {
    const me = await local.client.request(
      "/api/v1/me",
      undefined,
      request.headers.authorization?.slice(7),
    );
    dispatches.push(me.id);
    return reply.send({ accountId: me.id });
  }
});
await hub.listen({ host: "127.0.0.1", port: 19954 });
const staticClient = createStaticServer();
await new Promise((resolve) =>
  staticClient.listen(19955, "127.0.0.1", resolve),
);
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
const context = await browser.newContext({
  viewport: { width: 390, height: 844 },
});
await context.grantPermissions(["clipboard-read", "clipboard-write"], {
  origin: clientOrigin,
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.setDefaultTimeout(20000);
page.on("pageerror", (error) => errors.push(error.message));
const panel = (name) => page.getByRole("dialog", { name, exact: true });
const pass = (label) => {
  checks.push(label);
  console.log("PASS", label);
};
async function rows() {
  return page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("codoxear-client-identities");
      r.onsuccess = () => resolve(r.result);
    });
    return new Promise((resolve) => {
      const r = db
        .transaction("credentials")
        .objectStore("credentials")
        .getAll();
      r.onsuccess = () => resolve(r.result);
    });
  });
}
async function expire(id) {
  await page.evaluate(async (id) => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("codoxear-client-identities");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("credentials", "readwrite"),
        s = tx.objectStore("credentials"),
        r = s.getAll();
      r.onsuccess = () => {
        for (const value of r.result)
          if (!id || value.id === id)
            s.put({ ...value, expiresAt: 0 }, value.id);
      };
      tx.oncomplete = resolve;
    });
  }, id);
}
const directory = () =>
  page.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
async function openPanel() {
  if (await page.locator(".connectionPage").count()) {
    await panel("Hubs & computers").waitFor();
    return;
  }
  const button = page.locator(".sidebar footer").getByRole("button", {
    name: "Hubs & computers",
    exact: true,
  });
  await button.waitFor({ state: "attached" });
  const bounds = await button.boundingBox();
  if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 390)
    await page.locator("#toggleSidebarBtn").click();
  await button.click();
}
async function expand() {
  const summary = panel("Hubs & computers").locator(".connectionHub summary");
  if (!(await summary.evaluate((node) => node.parentElement.open)))
    await summary.click();
  await panel("Hubs & computers")
    .getByRole("button", { name: "Hub settings", exact: true })
    .waitFor();
}
async function settings() {
  await openPanel();
  await expand();
  await page.getByRole("button", { name: "Hub settings", exact: true }).click();
}
async function connect(method, name, account = "owner") {
  googleAccount = account;
  await openPanel();
  await panel("Hubs & computers")
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  await panel("Add hub").getByLabel("Hub address").fill(origin);
  await panel("Add hub")
    .getByRole("button", { name: "Connect hub", exact: true })
    .click();
  const choices = panel("Sign in to Hub");
  await choices.waitFor();
  const old = (await rows()).find((login) => login.identity.name === name);
  const loaded = old ? page.waitForEvent("load") : undefined;
  const popupPromise = context.waitForEvent("page");
  const closed = popupPromise.then((popup) =>
    popup.isClosed() ? undefined : popup.waitForEvent("close"),
  );
  await choices
    .getByRole("button", { name: "Continue with " + method, exact: true })
    .click();
  const popup = await popupPromise;
  if (!popup.isClosed())
    await popup.setViewportSize({ width: 390, height: 844 }).catch(() => {});
  await closed;
  if (loaded) {
    await loaded;
    await openPanel();
  }
  await panel("Hubs & computers").waitFor();
  await expand();
  await page.getByText(name, { exact: true }).waitFor();
  return (await rows()).find((login) => login.identity.name === name);
}
async function accept(name, token, expectSuccess = true) {
  await settings();
  await panel("Hub settings")
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  const login = (await rows()).find((row) => row.identity.name === name);
  await panel("Accept invitation")
    .locator("select[name=login]")
    .selectOption(login.id);
  await panel("Accept invitation").getByLabel("Invitation code").fill(token);
  await panel("Accept invitation")
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  if (expectSuccess) await panel("Hubs & computers").waitFor();
}
async function invite(name, method, subject, role) {
  await settings();
  await panel("Hub settings")
    .getByRole("button", { name: "Manage Hub members", exact: true })
    .click();
  const members = panel("Hub members");
  await members.getByLabel("Invite by", { exact: true }).selectOption(method);
  await members.getByLabel("Sign-in connection").fill(method + "-fixture");
  await members.getByLabel("Identity ID").fill(subject);
  if (method === "feishu")
    await members.getByLabel("Tenant (optional)").fill("fixture-company");
  await members.getByLabel("Hub role", { exact: true }).selectOption(role);
  await members
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await members
    .locator("output")
    .filter({ hasText: "Invitation code:" })
    .waitFor();
  const token = (await members.locator("output").textContent()).split(": ")[1];
  await members.getByRole("button", { name: "Back", exact: true }).click();
  await panel("Hub settings")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  return token;
}
async function allow(name, access) {
  await openPanel();
  await expand();
  await page.getByRole("button", { name: /Shared computer/ }).click();
  await panel("Shared computer")
    .getByRole("button", { name: "Manage access", exact: true })
    .click();
  const allowlist = panel("Computer allowlist");
  await allowlist.getByLabel("Hub member", { exact: true }).selectOption({
    label:
      name +
      " · " +
      (name === "Hub owner" ? "Owner" : name === "Alice" ? "Admin" : "Member"),
  });
  await allowlist
    .getByLabel("Computer access", { exact: true })
    .selectOption(access);
  await allowlist
    .getByRole("button", { name: "Grant computer access", exact: true })
    .click();
  await allowlist
    .locator(".connectionRow")
    .filter({ has: page.getByText(name, { exact: true }) })
    .waitFor();
  await allowlist.getByRole("button", { name: "Back", exact: true }).click();
  await panel("Shared computer")
    .getByRole("button", { name: "Back", exact: true })
    .click();
}
async function policy(feishu) {
  await settings();
  await panel("Hub settings")
    .getByRole("button", { name: "Allowed sign-in types", exact: true })
    .click();
  const dialog = panel("Allowed sign-in types");
  await dialog.getByLabel("Feishu", { exact: true }).setChecked(feishu);
  await dialog
    .getByRole("button", { name: "Save allowed types", exact: true })
    .click();
  await panel("Hubs & computers").waitFor();
}
try {
  await mkdir("artifacts", { recursive: true });
  const initializationPage = await context.newPage();
  await initializationPage.goto(
    origin +
      "/initialize?" +
      new URLSearchParams({ token: initialization.token }),
  );
  assert.equal(
    new URL(initializationPage.url()).searchParams.has("token"),
    false,
  );
  await initializationPage
    .getByRole("link", { name: "Continue with Google", exact: true })
    .click();
  await initializationPage
    .getByText("Signed in as", { exact: false })
    .waitFor();
  assert.equal(store.read().hubs[0].ownerId === pending.ownerId, false);
  assert.equal(
    store.read().identity.initializations[0].consumedAt !== null,
    true,
  );
  await initializationPage.close();
  pass(
    "Private expiring initialization URL binds the first owner to a verified provider identity without a code form",
  );
  await page.goto(clientOrigin + "/");
  await panel("Hubs & computers").waitFor();
  assert.equal(
    await page.getByRole("button", { name: "Work Hub", exact: true }).count(),
    0,
  );
  let owner = await connect("Google", "Hub owner");
  assert.equal(owner.role, "owner");
  assert.equal((await directory()).placements.length, 0);
  assert.equal((await directory()).agents.length, 0);
  await page.getByRole("button", { name: /Shared computer/ }).waitFor();
  await page.screenshot({
    path: "artifacts/registration-mobile.png",
    fullPage: true,
  });
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
  pass(
    "Add Hub URL exposes parallel configured provider buttons; owner sees computers but has no implicit usage or agent creation grant",
  );
  const databases = await page.evaluate(
    async () => await indexedDB.databases(),
  );
  assert.equal(
    databases.some((db) => db.name === "codoxear-device-identities"),
    false,
  );
  const before = owner.refreshToken;
  await expire(owner.id);
  await directory();
  owner = (await rows()).find((login) => login.id === owner.id);
  assert.notEqual(owner.refreshToken, before);
  pass(
    "Reloadable Hub credentials use standard rotating OAuth refresh sessions without a browser signing-key database",
  );
  transientRefresh = true;
  await expire(owner.id);
  const unavailable = await directory();
  assert.equal(unavailable.errors.length, 1);
  assert.equal((await rows()).length, 1);
  transientRefresh = false;
  assert.equal((await directory()).errors.length, 0);
  pass(
    "Temporary refresh outage preserves the saved account and recovers without provider reauthentication",
  );
  const alice = await connect("Feishu", "Alice");
  assert.equal(alice.role, null);
  assert.equal((await rows()).length, 2);
  await page.getByText("Not a member", { exact: true }).waitFor();
  const aliceInvite = await invite(
    "Alice",
    "feishu",
    "alice-verified-id",
    "admin",
  );
  await accept("Alice", "invalid-invitation-code", false);
  await panel("Accept invitation")
    .getByRole("alert")
    .filter({ hasText: /Invalid request/ })
    .waitFor();
  await panel("Accept invitation")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await panel("Hub settings")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await accept("Alice", aliceInvite);
  await expand();
  await page.getByText("Admin", { exact: true }).waitFor();
  assert.equal((await directory()).placements.length, 0);
  pass(
    "A registered identity remains a nonmember until a targeted invitation; Admin status grants management without Computer usage",
  );
  const adminContext = await browser.newContext({
    viewport: { width: 390, height: 844 },
  });
  const adminPage = await adminContext.newPage();
  adminPage.on("pageerror", (error) => errors.push(error.message));
  adminPage.setDefaultTimeout(20000);
  const adminPanel = (name) =>
    adminPage.getByRole("dialog", { name, exact: true });
  await adminPage.goto(clientOrigin + "/");
  await adminPanel("Hubs & computers")
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  await adminPanel("Add hub").getByLabel("Hub address").fill(origin);
  await adminPanel("Add hub")
    .getByRole("button", { name: "Connect hub", exact: true })
    .click();
  const adminPopup = adminContext.waitForEvent("page");
  const adminClosed = adminPopup.then((popup) =>
    popup.isClosed() ? undefined : popup.waitForEvent("close"),
  );
  await adminPanel("Sign in to Hub")
    .getByRole("button", { name: "Continue with Feishu", exact: true })
    .click();
  await adminClosed;
  await adminPanel("Hubs & computers").waitFor();
  await adminPanel("Hubs & computers").locator("summary").click();
  await adminPage.getByText("Admin", { exact: true }).waitFor();
  const adminDirectory = await adminPage.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
  assert.deepEqual(adminDirectory.agents, []);
  assert.deepEqual(adminDirectory.placements, []);
  await adminPage.getByRole("button", { name: /Shared computer/ }).waitFor();
  await adminPanel("Hubs & computers")
    .getByRole("button", { name: "Hub settings", exact: true })
    .click();
  assert.equal(
    await adminPanel("Hub settings")
      .getByRole("button", { name: "Allowed sign-in types", exact: true })
      .count(),
    0,
  );
  await adminPanel("Hub settings")
    .getByRole("button", { name: "Manage Hub members", exact: true })
    .click();
  await adminPanel("Hub members").getByLabel("Hub role", { exact: true }).waitFor();
  assert.deepEqual(
    await adminPanel("Hub members")
      .locator("select[name=role] option")
      .evaluateAll((options) => options.map((option) => option.value)),
    ["member"],
  );
  assert.equal(
    await adminPanel("Hub members")
      .getByRole("button", { name: /Make admin|Make member/ })
      .count(),
    0,
  );
  const adminInvite = adminPanel("Hub members");
  await adminInvite
    .getByLabel("Invite by", { exact: true })
    .selectOption("google");
  await adminInvite.getByLabel("Sign-in connection").fill("google-fixture");
  await adminInvite.getByLabel("Identity ID").fill("bob-verified-id");
  await adminInvite
    .getByRole("button", { name: "Create invitation", exact: true })
    .click();
  await adminInvite
    .locator("output")
    .filter({ hasText: "Invitation code:" })
    .waitFor();
  const bobInvite = (await adminInvite.locator("output").textContent()).split(
    ": ",
  )[1];
  await adminPage.screenshot({
    path: "artifacts/registration-admin-mobile.png",
    fullPage: true,
  });
  await adminContext.close();
  pass(
    "An Admin-only browser sees computers without usage, invites normal Members, and has no admin-promotion or owner-policy controls",
  );
  await allow("Hub owner", "write");
  const ownerId = store.read().hubs[0].ownerId;
  agent = store.change((state) =>
    reserveAgent(state, ownerId, computer.id, "Shared agent", "fixture"),
  );
  await allow("Alice", "read");
  const reader = await directory();
  assert.equal(reader.agents.length, 1);
  assert.equal(reader.placements.length, 1);
  const bob = await connect("Google", "Bob", "bob");
  assert.equal(bob.role, null);
  await accept("Bob", aliceInvite, false);
  await panel("Accept invitation")
    .getByRole("alert")
    .filter({ hasText: /different verified identity|already used/ })
    .waitFor();
  await panel("Accept invitation")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await panel("Hub settings")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await accept("Bob", bobInvite);
  await allow("Bob", "write");
  const combined = await directory();
  assert.equal(combined.agents.length, 1);
  assert.equal(combined.placements.length, 1);
  assert.equal(combined.agents[0].loginIds.length, 3);
  pass(
    "Parallel identities remain connected and shared Computer and agent resources are deduplicated across explicit allowlists",
  );
  const sent = await page.evaluate(async (scoped) => {
    const response = await fetch(
      "/api/sessions/" + encodeURIComponent(scoped) + "/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Fixture message" }),
      },
    );
    return { status: response.status, value: await response.json() };
  }, combined.agents[0].id);
  assert.equal(sent.status, 200);
  assert.ok([ownerId, bob.accountId].includes(sent.value.accountId));
  assert.equal(dispatches.length, 1);
  pass(
    "A mutation selects one write-authorized identity and dispatches once without retrying another identity",
  );
  await expire(alice.id);
  await policy(false);
  await expire(alice.id);
  const blocked = await directory();
  assert.equal(blocked.errors.length, 1);
  assert.equal((await rows()).length, 3);
  await policy(true);
  assert.equal((await directory()).errors.length, 0);
  pass(
    "Owner sign-in policy blocks and reallows a saved Feishu OAuth session without deleting or recreating the identity",
  );
  googleAccount = "owner";
  const renewed = await connect("Google", "Hub owner");
  assert.equal(renewed.id, owner.id);
  assert.equal((await rows()).length, 3);
  assert.notEqual(renewed.refreshToken, owner.refreshToken);
  pass(
    "Fresh provider authentication replaces only that identity session while other identities stay connected",
  );
  assert.deepEqual(errors, []);
} catch (error) {
  errors.push(String(error));
  const failurePages = browser.contexts().flatMap((context) => context.pages());
  for (const [index, tab] of failurePages.entries()) {
    await tab
      .screenshot({
        path: `artifacts/registration-failure-${index}.png`,
        fullPage: true,
      })
      .catch(() => {});
    await writeFile(
      `artifacts/registration-failure-${index}.html`,
      await tab.content(),
    ).catch(() => {});
  }
  throw error;
} finally {
  await writeFile(
    "artifacts/registration-results.json",
    JSON.stringify(
      {
        passed: errors.length === 0,
        checks,
        errors,
        provider: "Controlled Google/Feishu; no live credentials",
      },
      null,
      2,
    ),
  );
  await browser.close();
  await new Promise((resolve) => staticClient.close(resolve));
  hub.server.closeAllConnections();
  await hub.close();
  await local.identity.close();
  sessions.close();
  store.close();
}
