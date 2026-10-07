// @ts-nocheck -- Docker-only real browser fixture with controlled provider identities.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { Store } from "../src/persistence/store.js";
import {
  createHub,
  createComputer,
  invite,
  reserveAgent,
} from "../src/domain/commands.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";
import { createStaticServer } from "../frontend/serve.mjs";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const origin = "http://127.0.0.1:19954",
  clientOrigin = "http://127.0.0.1:19955";
const store = new Store(":memory:"),
  sessions = new HubSessions(":memory:");
store.change((state) =>
  state.users.push({
    id: "owner",
    name: "Fixture owner",
    email: "owner@fixture.invalid",
    passwordHash: "",
    disabled: false,
  }),
);
const hubId = store.change(
  (state) => createHub(state, "owner", "Registration Hub").id,
);
const computer = store.change(
  (state) =>
    createComputer(state, "owner", hubId, "Invitation computer", "owner")
      .computer,
);
const agent = store.change((state) =>
  reserveAgent(state, "owner", computer.id, "Identity-scoped agent", "fixture"),
);
const providers = ["feishu", "google"].map((method) => ({
  id: method + "-fixture",
  method,
  ...(method === "feishu" ? { tenant: "fixture-company" } : {}),
  async authorize(state) {
    return (
      origin + "/fixture-provider?" + new URLSearchParams({ state, method })
    );
  },
  async exchange(code) {
    assert.equal(code, "controlled-provider-code");
    return {
      method,
      connection: method + "-fixture",
      subject: method + "-verified-id",
      tenant: method === "feishu" ? "fixture-company" : null,
      email: method === "google" ? "bob@fixture.test" : null,
      name: method === "google" ? "Bob" : "Alice",
    };
  },
}));
const local = await independentAuthority({
  origin,
  hubId,
  store,
  secureCookies: false,
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
        code: "controlled-provider-code",
      }),
  ),
);
let transientKeyFailure = false;
const mutationDispatches = [];
hub.addHook("onRequest", async (request, reply) => {
  if (
    request.method === "POST" &&
    request.url === `/workspace/api/sessions/${agent.id}/send`
  ) {
    const token = request.headers.authorization?.slice(7);
    const me = await local.client.request("/api/v1/me", undefined, token);
    mutationDispatches.push(me.id);
    return reply.send({ accountId: me.id, fixtureDispatch: true });
  }

  if (transientKeyFailure && request.url === "/api/v1/auth/keys/challenge")
    return reply
      .code(503)
      .send({ code: "temporarily_unavailable", error: "Fixture outage" });
});
await hub.listen({ host: "127.0.0.1", port: 19954 });
const staticClient = createStaticServer();
await new Promise((resolve) =>
  staticClient.listen(19955, "127.0.0.1", resolve),
);
const setupOrigin = "http://127.0.0.1:19956",
  setupStore = new Store(":memory:"),
  setupSessions = new HubSessions(":memory:"),
  setupToken = "administrator-private-one-time-code-" + "s".repeat(32);
const pendingHub = setupStore.change((state) =>
  initializeHub(state, "setup-browser-hub", "New browser Hub"),
);
const provisionedComputer = setupStore.change((state) => {
  const reserved = state.users.find((user) => user.id === pendingHub.ownerId);
  reserved.disabled = false;
  const result = createComputer(
    state,
    reserved.id,
    pendingHub.id,
    "Pre-provisioned computer",
    reserved.id,
  ).computer;
  reserved.disabled = true;
  return result;
});
const setupLocal = await independentAuthority({
  origin: setupOrigin,
  hubId: pendingHub.id,
  store: setupStore,
  secureCookies: false,
  setup: hubSetup(setupStore, pendingHub.id, setupToken),
  providers: [
    {
      id: "google-setup",
      method: "google",
      async authorize(state) {
        return (
          setupOrigin +
          "/fixture-provider?" +
          new URLSearchParams({ state, method: "google" })
        );
      },
      async exchange() {
        return {
          method: "google",
          connection: "google-setup",
          subject: "verified-setup-owner",
          tenant: null,
          email: "initial-owner@fixture.test",
          name: "Initial owner",
        };
      },
    },
    {
      id: "feishu-setup",
      method: "feishu",
      tenant: "fixture-company",
      async authorize(state) {
        return (
          setupOrigin +
          "/fixture-provider?" +
          new URLSearchParams({ state, method: "feishu" })
        );
      },
      async exchange() {
        return {
          method: "feishu",
          connection: "feishu-setup",
          subject: "verified-work-member",
          tenant: "fixture-company",
          email: null,
          name: "Work member",
        };
      },
    },
  ],
  clients: [
    { id: "codoxear-web", redirectUris: [clientOrigin + "/auth-callback"] },
  ],
});
const setupHub = await createHubApp({
  origin: setupOrigin,
  authority: setupLocal.client,
  localIdentity: setupLocal.identity,
  sessions: setupSessions,
  tunnels: new Tunnels(),
  secureCookies: false,
  clientOrigins: [clientOrigin],
});
setupHub.get("/fixture-provider", async (request, reply) =>
  reply.redirect(
    `/auth/${request.query.method}-setup/callback?` +
      new URLSearchParams({
        state: request.query.state,
        code: "setup-provider-code",
      }),
  ),
);
await setupHub.listen({ host: "127.0.0.1", port: 19956 });
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
  permissions: ["clipboard-read", "clipboard-write"],
});
const page = await context.newPage(),
  checks = [],
  errors = [];
page.on("pageerror", (error) => errors.push(error.message));
page.setDefaultTimeout(20000);
const pass = (label) => {
  checks.push(label);
  console.log("PASS", label);
};
const panel = (name) => page.getByRole("dialog", { name, exact: true });
async function localRows(database, storeName) {
  return page.evaluate(
    async ({ database, storeName }) => {
      const db = await new Promise((resolve, reject) => {
        const request = indexedDB.open(database);
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      });
      return new Promise((resolve, reject) => {
        const transaction = db.transaction(storeName);
        const request = transaction.objectStore(storeName).getAll();
        request.onsuccess = () =>
          resolve(
            request.result.map((row) =>
              row.privateKey
                ? {
                    ...row,
                    privateKey: {
                      extractable: row.privateKey.extractable,
                      type: row.privateKey.type,
                    },
                  }
                : row,
            ),
          );
        request.onerror = () => reject(request.error);
      });
    },
    { database, storeName },
  );
}
async function startConnect() {
  await panel("Hubs & computers")
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  await panel("Add hub").getByLabel("Hub address").fill(origin);
  await panel("Add hub")
    .getByRole("button", { name: "Connect hub", exact: true })
    .click();
  await panel("Connect hub").waitFor();
}
async function reopenConnections() {
  const connections = page.getByRole("button", {
    name: "Hubs & computers",
    exact: true,
  });
  await connections.waitFor({ state: "attached" });
  const bounds = await connections.boundingBox();
  if (!bounds || bounds.x < 0 || bounds.x + bounds.width > 390)
    await page.locator("#toggleSidebarBtn").click();
  await connections.click();
  await panel("Hubs & computers").waitFor();
}
async function acceptInvitations(tokens, identityName = "Alice") {
  for (const token of tokens) {
    const summary = page.locator(".connectionHub summary");
    if (!(await summary.evaluate((node) => node.parentElement.open)))
      await summary.click();
    await page
      .getByRole("button", { name: "Hub settings", exact: true })
      .click();
    await panel("Hub settings")
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    const identity = (
      await localRows("codoxear-client-identities", "credentials")
    ).find((login) => login.identity.name === identityName);
    await panel("Accept invitation")
      .locator("select[name=login]")
      .selectOption(identity.id);
    await panel("Accept invitation").getByLabel("Invitation code").fill(token);
    await panel("Accept invitation")
      .getByRole("button", { name: "Accept invitation", exact: true })
      .click();
    await panel("Hubs & computers").waitFor();
  }
}
async function directoryValue() {
  return page.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
}
async function providerConnect(method, registration = false) {
  const existing = registration
    ? []
    : await localRows("codoxear-client-identities", "credentials");
  const rotating = existing.some(
    (login) => login.identity.method === method.toLowerCase(),
  );
  await startConnect();
  const popupPromise = context.waitForEvent("page");
  await panel("Connect hub")
    .getByRole("button", {
      name: "Continue with Google or Feishu",
      exact: true,
    })
    .click();
  const popup = await popupPromise;
  await popup.setViewportSize({ width: 390, height: 844 });
  popup.on("pageerror", (error) => errors.push(error.message));
  await popup
    .getByRole("link", { name: "Continue with " + method, exact: true })
    .waitFor();
  assert.equal(
    await popup
      .locator("input[name=password],input[name=email],#codes")
      .count(),
    0,
  );
  if (registration) {
    const continuation = new URL(popup.url()).searchParams.get("continue");
    await popup
      .getByRole("link", { name: "Create an account", exact: true })
      .click();
    await popup
      .getByRole("heading", { name: "Create your account", exact: true })
      .waitFor();
    assert.equal(
      new URL(popup.url()).searchParams.get("continue"),
      continuation,
    );
    assert.equal(
      await popup.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
      true,
    );
    await popup.screenshot({
      path: "artifacts/registration-mobile.png",
      fullPage: true,
    });
  }
  const closed = popup.waitForEvent("close");
  const loaded = rotating ? page.waitForEvent("load") : undefined;
  await popup
    .getByRole("link", { name: "Continue with " + method, exact: true })
    .click();
  await closed;
  if (loaded) {
    await loaded;
    await reopenConnections();
  }
  await panel("Hubs & computers").waitFor();
  await page.waitForFunction(async (expectedMethod) => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("codoxear-client-identities");
      request.onsuccess = () => resolve(request.result);
    });
    return new Promise((resolve) => {
      const request = db
        .transaction("credentials")
        .objectStore("credentials")
        .getAll();
      request.onsuccess = () =>
        resolve(
          request.result.some(
            (login) => login.identity.method === expectedMethod,
          ),
        );
    });
  }, method.toLowerCase());
  const summary = page.locator(".connectionHub summary");
  if (!(await summary.evaluate((node) => node.parentElement.open)))
    await summary.click();
  await page
    .getByText(method === "Google" ? "Bob" : "Alice", { exact: true })
    .waitFor();
}
try {
  await mkdir("artifacts", { recursive: true });
  await page.goto(clientOrigin + "/");
  await panel("Hubs & computers").waitFor();
  await providerConnect("Feishu", true);
  let aliceLogin = (
    await localRows("codoxear-client-identities", "credentials")
  )[0];
  const aliceKey = (await localRows("codoxear-device-identities", "keys"))[0];
  assert.equal(aliceLogin.identity.name, "Alice");
  assert.equal(aliceLogin.deviceKeyId, aliceKey.id);
  assert.equal(aliceKey.privateKey.extractable, false);
  assert.equal(aliceKey.privateKey.type, "private");
  assert.equal(
    await page.evaluate(async () => {
      const db = await new Promise((resolve) => {
        const r = indexedDB.open("codoxear-device-identities");
        r.onsuccess = () => resolve(r.result);
      });
      const key = await new Promise((resolve) => {
        const r = db.transaction("keys").objectStore("keys").getAll();
        r.onsuccess = () => resolve(r.result[0]);
      });
      try {
        await crypto.subtle.exportKey("jwk", key.privateKey);
        return false;
      } catch {
        return true;
      }
    }),
    true,
  );
  assert.equal(store.read().identity.deviceKeys.length, 1);
  assert.equal(
    store.read().identity.deviceKeys[0].userId,
    aliceLogin.accountId,
  );
  assert.equal(
    store
      .read()
      .memberships.some((member) => member.userId === aliceLogin.accountId),
    false,
  );
  pass(
    "Mobile provider registration preserves OAuth continuation and stores a nonextractable private key only on the client; registration grants no access",
  );
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("codoxear-client-identities");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const t = db.transaction("credentials", "readwrite"),
        s = t.objectStore("credentials"),
        r = s.getAll();
      r.onsuccess = () => {
        for (const login of r.result)
          s.put({ ...login, expiresAt: 0 }, login.id);
      };
      t.oncomplete = resolve;
    });
  });
  const recovered = await page.evaluate(async () => {
    const response = await fetch("/api/client/directory");
    return { status: response.status, value: await response.json() };
  });
  assert.equal(recovered.status, 200);
  assert.deepEqual(recovered.value.agents, []);
  assert.ok(store.read().identity.deviceKeys[0].lastUsedAt);
  await page.reload();
  const connectionsButton = page.getByRole("button", {
    name: "Hubs & computers",
    exact: true,
  });
  await connectionsButton.waitFor({ state: "attached" });
  const connectionBounds = await connectionsButton.boundingBox();
  if (
    !connectionBounds ||
    connectionBounds.x < 0 ||
    connectionBounds.x + connectionBounds.width > 390
  )
    await page.locator("#toggleSidebarBtn").click();
  await connectionsButton.click();
  await panel("Hubs & computers").waitFor();
  const restoredKey = (
    await localRows("codoxear-device-identities", "keys")
  )[0];
  assert.equal(restoredKey.id, aliceKey.id);
  assert.equal(restoredKey.privateKey.extractable, false);
  pass(
    "Reload retains the signing key and expired transport credentials recover by signing a real Hub challenge",
  );
  transientKeyFailure = true;
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const request = indexedDB.open("codoxear-client-identities");
      request.onsuccess = () => resolve(request.result);
    });
    await new Promise((resolve) => {
      const t = db.transaction("credentials", "readwrite"),
        s = t.objectStore("credentials"),
        r = s.getAll();
      r.onsuccess = () => {
        for (const login of r.result)
          s.put({ ...login, expiresAt: 0 }, login.id);
      };
      t.oncomplete = resolve;
    });
  });
  const unavailable = await page.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
  assert.equal(unavailable.errors.length, 1);
  assert.equal(
    (await localRows("codoxear-client-identities", "credentials"))[0].id,
    aliceLogin.id,
  );
  assert.equal(
    (await localRows("codoxear-device-identities", "keys"))[0].id,
    aliceKey.id,
  );
  transientKeyFailure = false;
  const afterOutage = await page.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
  assert.equal(afterOutage.errors.length, 0);
  assert.ok(
    (await localRows("codoxear-client-identities", "credentials"))[0]
      .expiresAt > Date.now(),
  );
  pass(
    "A temporary 503 key challenge outage retains saved credentials and signing keys; retry recovers without signing in again",
  );
  const target = {
    method: "feishu",
    connection: "feishu-fixture",
    subject: "feishu-verified-id",
    tenant: "fixture-company",
  };
  const hubInvite = store.change(
    (state) => invite(state, "owner", "hub", hubId, target, "viewer").token,
  );
  const computerInvite = store.change(
    (state) =>
      invite(state, "owner", "computer", computer.id, target, "viewer").token,
  );
  await acceptInvitations([hubInvite, computerInvite]);
  const aliceDirectory = await directoryValue();
  assert.equal(aliceDirectory.agents[0].agentId, agent.id);
  assert.equal(aliceDirectory.placements.length, 0);
  await page.getByRole("button", { name: /Invitation computer/ }).waitFor();
  pass(
    "Owner invitations grant the registered viewer its Computer and read-only agent; operator placement is unavailable",
  );

  const viewerWrite = await page.evaluate(async (scoped) => {
    const response = await fetch(
      "/api/sessions/" + encodeURIComponent(scoped) + "/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Fixture message" }),
      },
    );
    return response.status;
  }, aliceDirectory.agents[0].id);
  assert.equal(viewerWrite, 403);
  assert.equal(mutationDispatches.length, 0);
  await providerConnect("Google");
  const logins = await localRows("codoxear-client-identities", "credentials"),
    keys = await localRows("codoxear-device-identities", "keys");
  const bob = logins.find((login) => login.identity.name === "Bob");
  assert.ok(bob);
  assert.equal(keys.length, 2);
  assert.notEqual(bob.accountKey, aliceLogin.accountKey);
  assert.equal(
    store.read().memberships.some((member) => member.userId === bob.accountId),
    false,
  );
  const bobEmpty = await directoryValue();
  assert.equal(bobEmpty.agents.length, 1);
  assert.equal(bobEmpty.agents[0].id, aliceDirectory.agents[0].id);
  assert.deepEqual(bobEmpty.placements, []);
  assert.equal(
    await page.evaluate(
      async (id) =>
        (await fetch("/api/client/hubs/" + id + "/api/v1/me")).status,
      aliceLogin.id,
    ),
    200,
  );
  pass(
    "Adding Google keeps the existing Feishu identity connected; the same Hub agent remains visible without duplicate entries",
  );
  const bobTarget = {
    method: "google",
    connection: "google-fixture",
    subject: "google-verified-id",
    tenant: null,
  };
  await acceptInvitations(
    [
      store.change(
        (state) =>
          invite(state, "owner", "hub", hubId, bobTarget, "operator").token,
      ),
      store.change(
        (state) =>
          invite(state, "owner", "computer", computer.id, bobTarget, "operator")
            .token,
      ),
    ],
    "Bob",
  );
  const bobDirectory = await directoryValue();
  assert.equal(bobDirectory.agents.length, 1);
  assert.equal(bobDirectory.agents[0].agentId, agent.id);
  assert.equal(bobDirectory.agents[0].id, aliceDirectory.agents[0].id);
  assert.equal(bobDirectory.placements.length, 1);
  assert.ok(bobDirectory.placements[0].loginIds.includes(bob.id));
  assert.ok(bobDirectory.agents[0].loginIds.includes(aliceLogin.id));
  assert.ok(bobDirectory.agents[0].loginIds.includes(bob.id));
  const operatorWrite = await page.evaluate(async (scoped) => {
    const response = await fetch(
      "/api/sessions/" + encodeURIComponent(scoped) + "/send",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "Fixture message" }),
      },
    );
    return { status: response.status, value: await response.json() };
  }, bobDirectory.agents[0].id);
  assert.equal(operatorWrite.status, 200);
  assert.equal(operatorWrite.value.accountId, bob.accountId);
  assert.deepEqual(mutationDispatches, [bob.accountId]);

  await page.getByRole("button", { name: "Hub settings", exact: true }).click();
  await panel("Hub settings")
    .getByRole("button", { name: "Accept invitation", exact: true })
    .click();
  assert.equal(
    await panel("Accept invitation")
      .locator("select[name=login] option")
      .count(),
    2,
  );
  await panel("Accept invitation")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  await panel("Hub settings")
    .getByRole("button", { name: "Back", exact: true })
    .click();
  pass(
    "All saved identities contribute their available rights while each request uses one proof; shared Computer and agent entries are deduplicated",
  );
  const oldAliceKey = aliceLogin.deviceKeyId;
  await providerConnect("Feishu");
  const rotatedLogins = await localRows(
    "codoxear-client-identities",
    "credentials",
  );
  const rotatedAlice = rotatedLogins.find(
    (login) => login.identity.name === "Alice",
  );
  assert.equal(rotatedLogins.length, 2);
  assert.equal(rotatedAlice.id, aliceLogin.id);
  assert.equal(rotatedAlice.accountKey, aliceLogin.accountKey);
  assert.notEqual(rotatedAlice.deviceKeyId, oldAliceKey);
  const rotatedKeys = await localRows("codoxear-device-identities", "keys");
  assert.equal(rotatedKeys.length, 2);
  assert.equal(
    rotatedKeys.some((key) => key.id === oldAliceKey),
    false,
  );
  assert.equal(
    rotatedKeys.some((key) => key.id === bob.deviceKeyId),
    true,
  );
  assert.equal(
    store.read().identity.deviceKeys.find((key) => key.id === oldAliceKey)
      .revoked,
    true,
  );
  assert.equal(
    store.read().identity.deviceKeys.filter((key) => !key.revoked).length,
    2,
  );
  aliceLogin = rotatedAlice;
  pass(
    "Fresh OAuth reauthentication rotates only the same identity's device key, preserves the other account, and does not accumulate active keys",
  );
  const revoke = await page.evaluate(
    async ({ origin, login }) => {
      const response = await fetch(
        origin + "/api/v1/me/keys/" + login.deviceKeyId,
        {
          method: "DELETE",
          credentials: "omit",
          headers: { Authorization: "Bearer " + login.accessToken },
        },
      );
      return response.status;
    },
    { origin, login: aliceLogin },
  );
  assert.equal(revoke, 200);
  await startConnect();
  await panel("Connect hub")
    .getByRole("button", { name: "Continue as Alice", exact: true })
    .click();
  await panel("Connect hub")
    .getByRole("alert")
    .filter({ hasText: /proof|sign-in|key/i })
    .waitFor();
  pass("Revoking a client key prevents that saved account from reconnecting");
  await page.evaluate(async () => {
    const db = await new Promise((resolve) => {
      const r = indexedDB.open("codoxear-client-identities");
      r.onsuccess = () => resolve(r.result);
    });
    await new Promise((resolve) => {
      const tx = db.transaction("credentials", "readwrite"),
        store = tx.objectStore("credentials"),
        r = store.getAll();
      r.onsuccess = () => {
        for (const login of r.result)
          store.put({ ...login, expiresAt: 0 }, login.id);
      };
      tx.oncomplete = resolve;
    });
  });
  const revokedDirectory = await directoryValue();
  assert.equal(revokedDirectory.agents.length, 1);
  assert.equal(revokedDirectory.placements.length, 1);
  assert.ok(revokedDirectory.agents[0].loginIds.includes(bob.id));
  assert.equal(revokedDirectory.errors.length, 1);
  assert.equal(
    (await localRows("codoxear-client-identities", "credentials")).some(
      (login) => login.id === bob.id,
    ),
    true,
  );
  pass(
    "Revoking one identity leaves the other independently authorized identity connected and preserves its Computer access",
  );
  const setupContext = await browser.newContext({
      viewport: { width: 390, height: 844 },
    }),
    setupPage = await setupContext.newPage();
  setupPage.on("pageerror", (error) => errors.push(error.message));
  setupPage.setDefaultTimeout(20000);
  await setupPage.goto(clientOrigin + "/");
  const setupPanel = (name) =>
    setupPage.getByRole("dialog", { name, exact: true });
  await setupPanel("Hubs & computers")
    .getByRole("button", { name: "Add hub", exact: true })
    .click();
  await setupPanel("Add hub").getByLabel("Hub address").fill(setupOrigin);
  await setupPanel("Add hub")
    .getByRole("button", { name: "Connect hub", exact: true })
    .click();
  const setupPopupPromise = setupContext.waitForEvent("page");
  await setupPanel("Connect hub")
    .getByRole("button", {
      name: "Continue with Google or Feishu",
      exact: true,
    })
    .click();
  const setupPopup = await setupPopupPromise;
  await setupPopup.setViewportSize({ width: 390, height: 844 });
  setupPopup.on("pageerror", (error) => errors.push(error.message));
  await setupPopup
    .getByRole("link", { name: "Continue with Google", exact: true })
    .waitFor();
  const originalContinue = new URL(setupPopup.url()).searchParams.get(
    "continue",
  );
  await setupPopup
    .getByRole("link", { name: "Continue with Google", exact: true })
    .click();
  await setupPopup
    .getByRole("heading", { name: "Set up this Hub", exact: true })
    .waitFor();
  assert.equal(
    new URL(setupPopup.url()).searchParams.get("continue"),
    originalContinue,
  );
  assert.equal(setupStore.read().hubs[0].ownerId, pendingHub.ownerId);
  await setupPopup.getByLabel("One-time setup code").fill(setupToken);
  await setupPopup
    .getByRole("button", { name: "Set up this Hub", exact: true })
    .click();
  await setupPopup
    .getByRole("heading", { name: "Set up this Hub", exact: true })
    .waitFor({ state: "hidden" });
  const setupClosed = setupPopup.waitForEvent("close");
  await setupPopup
    .getByRole("link", { name: "Continue to Codoxear", exact: true })
    .click();
  await setupClosed;
  await setupPanel("Hubs & computers")
    .getByText("New browser Hub", { exact: true })
    .waitFor();
  await setupPage.locator(".connectionHub summary").click();
  await setupPage
    .getByRole("button", { name: /Pre-provisioned computer/ })
    .waitFor();
  const newOwner = setupStore.read().hubs[0].ownerId;
  assert.notEqual(newOwner, pendingHub.ownerId);
  assert.equal(
    setupStore
      .read()
      .computers.find((value) => value.id === provisionedComputer.id).ownerId,
    newOwner,
  );
  assert.equal(setupStore.read().identity.deviceKeys[0].userId, newOwner);
  await setupPage.screenshot({
    path: "artifacts/registration-owner-setup-mobile.png",
    fullPage: true,
  });
  const setupSummary = setupPage.locator(".connectionHub summary");
  if (!(await setupSummary.evaluate((node) => node.parentElement.open)))
    await setupSummary.click();
  const memberPopupPromise = setupContext.waitForEvent("page");
  await setupPage
    .getByRole("button", { name: "Add identity", exact: true })
    .click();
  const memberPopup = await memberPopupPromise;
  await memberPopup.setViewportSize({ width: 390, height: 844 });
  const memberClosed = memberPopup.waitForEvent("close");
  await memberPopup
    .getByRole("link", { name: "Continue with Feishu", exact: true })
    .click();
  await memberClosed;
  // Popup closure completes the OAuth token exchange. Device-key enrollment
  // and vault persistence finish afterward, then the Hub identities rerender.
  await setupPage.getByText("Work member", { exact: true }).waitFor();
  await setupPanel("Hubs & computers").waitFor();
  const setupRows = () =>
    setupPage.evaluate(async () => {
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
  const workLogin = (await setupRows()).find(
    (login) => login.identity.method === "feishu",
  );
  assert.ok(workLogin);
  const expireWork = () =>
    setupPage.evaluate(async (loginId) => {
      const db = await new Promise((resolve) => {
        const r = indexedDB.open("codoxear-client-identities");
        r.onsuccess = () => resolve(r.result);
      });
      await new Promise((resolve) => {
        const tx = db.transaction("credentials", "readwrite"),
          s = tx.objectStore("credentials"),
          r = s.get(loginId);
        r.onsuccess = () => s.put({ ...r.result, expiresAt: 0 }, loginId);
        tx.oncomplete = resolve;
      });
    }, workLogin.id);
  await expireWork();
  await setupPage
    .getByRole("button", { name: "Hub settings", exact: true })
    .click();
  await setupPanel("Hub settings")
    .getByRole("button", { name: "Allowed sign-in types", exact: true })
    .click();
  await setupPanel("Allowed sign-in types")
    .getByLabel("Feishu", { exact: true })
    .uncheck();
  await setupPanel("Allowed sign-in types")
    .getByRole("button", { name: "Save allowed types", exact: true })
    .click();
  await setupPanel("Hubs & computers").waitFor();
  const allowedOptions = await (
    await fetch(setupOrigin + "/api/v1/auth/options")
  ).json();
  assert.deepEqual(allowedOptions.loginMethods.allowedMethods, ["google"]);
  assert.ok(allowedOptions.loginMethods.availableMethods.includes("feishu"));
  await expireWork();
  const blockedDirectory = await setupPage.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
  assert.equal(blockedDirectory.errors.length, 1);
  assert.equal((await setupRows()).length, 2);
  assert.equal(
    (await setupRows()).find((login) => login.id === workLogin.id).deviceKeyId,
    workLogin.deviceKeyId,
  );

  if (!(await setupSummary.evaluate((node) => node.parentElement.open)))
    await setupSummary.click();
  await setupPage
    .getByRole("button", { name: "Hub settings", exact: true })
    .click();
  await setupPanel("Hub settings")
    .getByRole("button", { name: "Allowed sign-in types", exact: true })
    .click();
  await setupPanel("Allowed sign-in types")
    .getByLabel("Feishu", { exact: true })
    .check();
  await setupPanel("Allowed sign-in types")
    .getByRole("button", { name: "Save allowed types", exact: true })
    .click();
  await setupPanel("Hubs & computers").waitFor();
  const bothOptions = await (
    await fetch(setupOrigin + "/api/v1/auth/options")
  ).json();
  assert.equal(bothOptions.loginMethods.allowedMethods.length, 2);
  const reallowedDirectory = await setupPage.evaluate(
    async () => await (await fetch("/api/client/directory")).json(),
  );
  assert.equal(reallowedDirectory.errors.length, 0);
  assert.equal(
    (await setupRows()).find((login) => login.id === workLogin.id).deviceKeyId,
    workLogin.deviceKeyId,
  );
  assert.ok(
    (await setupRows()).find((login) => login.id === workLogin.id).expiresAt >
      Date.now(),
  );

  pass(
    "The owner configures Google-only or both; a blocked saved Feishu key is retained and resumes automatically when allowed again",
  );
  await setupContext.close();
  pass(
    "Fresh Google registration preserves pending setup continuation; one-time owner proof claims the Hub and pre-provisioned Computer before device key enrollment",
  );
  assert.deepEqual(errors, []);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
    true,
  );
} catch (error) {
  errors.push(String(error));
  await page
    .screenshot({ path: "artifacts/registration-failure.png", fullPage: true })
    .catch(() => {});
  const failures = [];
  for (const activeContext of browser.contexts()) {
    for (const activePage of activeContext.pages()) {
      const index = failures.length;
      const url = new URL(activePage.url());
      failures.push({ index, origin: url.origin, path: url.pathname });
      await writeFile(
        `artifacts/registration-failure-${index}.html`,
        await activePage.content(),
      ).catch(() => {});
      await activePage
        .screenshot({
          path: `artifacts/registration-failure-${index}.png`,
          fullPage: true,
        })
        .catch(() => {});
    }
  }
  await writeFile(
    "artifacts/registration-failure-pages.json",
    JSON.stringify(failures, null, 2),
  );
  throw error;
} finally {
  await writeFile(
    "artifacts/registration-results.json",
    JSON.stringify(
      {
        passed: errors.length === 0,
        checks,
        errors,
        provider:
          "Controlled Google/Feishu identity fixture; live provider credentials are not used",
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
  setupHub.server.closeAllConnections();
  await setupHub.close();
  await setupLocal.identity.close();
  setupSessions.close();
  setupStore.close();
}
