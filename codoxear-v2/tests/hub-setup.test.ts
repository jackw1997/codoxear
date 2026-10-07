import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import { createIdentityApp } from "../src/auth/app.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";
import { createComputer } from "../src/domain/commands.js";

assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const setupToken = "setup-code-known-only-to-administrator-" + "z".repeat(32);
function fixture() {
  const store = new Store(":memory:");
  let now = Date.now();
  const hub = store.change((state) => initializeHub(state, "local-hub", "New Hub"));
  const accounts = new Accounts(store, "setup-tests-secret".repeat(4), { async send() {} }, () => now);
  const setup = hubSetup(store, hub.id, setupToken, () => now);
  function provider(method: "google" | "feishu" | "email" = "google", subject = "owner") {
    return accounts.finish({ connection: method, method, subject, tenant: method === "feishu" ? "enterprise" : null,
      email: `${subject}@example.test`, name: subject }, "provider-browser");
  }
  return { store, hub, accounts, setup, provider, advance(ms: number) { now += ms; } };
}

test("new Hub reserves a disabled owner and requires an explicit private setup token", () => {
  const f = fixture();
  try {
    assert.equal(f.setup.pending(), true);
    const reserved = f.store.read().users.find((user) => user.id === f.hub.ownerId)!;
    assert.equal(reserved.disabled, true);
    assert.equal(reserved.passwordHash, "");
    assert.throws(() => hubSetup(f.store, f.hub.id, undefined), /setupToken/);
    assert.throws(() => hubSetup(f.store, f.hub.id, "too-short"), /setupToken/);
    const member = f.provider();
    assert.equal(f.store.read().hubs[0]!.ownerId, reserved.id);
    assert.deepEqual(f.store.read().memberships, []);
    assert.throws(() => f.setup.claim(member.session, "wrong-token"), /Incorrect setup code/);
    assert.equal(f.setup.pending(), true);
    assert.equal(f.store.read().hubs[0]!.ownerId, reserved.id);
  } finally { f.store.close(); }
});

test("fresh Google/Feishu setup transfers only reserved ownership and cannot replay", () => {
  for (const method of ["google", "feishu"] as const) {
    const f = fixture();
    try {
      const member = f.provider(method);
      const computer = f.store.change((state) => {
        // Provisioning can reserve execution resources before browser setup.
        const reserved = state.users.find((user) => user.id === f.hub.ownerId)!;
        reserved.disabled = false;
        const created = createComputer(state, reserved.id, f.hub.id, "Pre-provisioned", reserved.id);
        reserved.disabled = true;
        return created.computer;
      });
      const other = f.provider(method, "member");
      const otherComputer = f.store.change((state) => {
        state.memberships.push({ resource: "hub", resourceId: f.hub.id, userId: other.session.userId, role: "operator" });
        return createComputer(state, f.hub.ownerId, f.hub.id, "Other owner", other.session.userId).computer;
      });
      f.setup.claim(member.session, setupToken);
      const state = f.store.read();
      assert.equal(state.hubs[0]!.ownerId, member.session.userId);
      assert.equal(state.hubs[0]!.revision, f.hub.revision + 1);
      const claimed = state.computers.find((value) => value.id === computer.id)!;
      assert.equal(claimed.ownerId, member.session.userId);
      assert.equal(claimed.revision, computer.revision + 1);
      assert.equal(claimed.binding, computer.binding);
      assert.equal(claimed.credentialHash, computer.credentialHash);
      assert.equal(state.computers.find((value) => value.id === otherComputer.id)!.ownerId, other.session.userId);
      assert.equal(f.setup.pending(), false);
      assert.throws(() => f.setup.claim(other.session, setupToken), /already complete/);
      assert.equal(f.store.read().hubs[0]!.ownerId, member.session.userId);
    } finally { f.store.close(); }
  }
});

test("setup rejects stale, disabled and non-provider accounts", () => {
  const f = fixture();
  try {
    const email = f.provider("email", "email-user");
    assert.throws(() => f.setup.claim(email.session, setupToken), /Google or Feishu/);
    const member = f.provider();
    f.store.change((state) => { state.users.find((u) => u.id === member.session.userId)!.disabled = true; });
    assert.throws(() => f.setup.claim(member.session, setupToken), /Google or Feishu/);
    f.store.change((state) => { state.users.find((u) => u.id === member.session.userId)!.disabled = false; });
    f.advance(300001);
    assert.throws(() => f.setup.claim(member.session, setupToken), /Google or Feishu/);
    assert.equal(f.setup.pending(), true);
  } finally { f.store.close(); }
});

test("HTTP setup never auto-owns a Hub and requires live provider proof plus the setup code", async () => {
  const f = fixture(), tokens = new Tokens("https://hub.test", await signingKey());
  const app = await createIdentityApp({ authority: new Authority(f.store, f.accounts, tokens), localHubId: f.hub.id,
    setup: f.setup, secureCookies: false });
  try {
    const options = await app.inject({ method: "GET", url: "/api/v1/auth/options" });
    assert.equal(options.json().setupRequired, true);
    assert.equal(options.body.includes(setupToken), false);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/auth/setup", payload: { token: setupToken } })).statusCode, 401);
    const member = f.provider();
    const accessToken = await tokens.issue(member.session, tokens.issuer, "identity_access");
    const headers = { authorization: "Bearer " + accessToken };
    assert.equal(f.store.read().hubs[0]!.ownerId, f.hub.ownerId);
    assert.deepEqual((await app.inject({ method: "GET", url: "/api/v1/me/hubs", headers })).json(), []);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/hubs", headers, payload: { name: "Unauthorized Hub" } })).statusCode, 403);
    const rejected = await app.inject({ method: "POST", url: "/api/v1/auth/setup", headers, payload: { token: "wrong".repeat(10) } });
    assert.equal(rejected.statusCode, 403);
    assert.equal(f.setup.pending(), true);
    const claimed = await app.inject({ method: "POST", url: "/api/v1/auth/setup", headers, payload: { token: setupToken } });
    assert.equal(claimed.statusCode, 200);
    assert.deepEqual(claimed.json(), { ok: true });
    assert.equal(f.store.read().hubs[0]!.ownerId, member.session.userId);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/auth/options" })).json().setupRequired, false);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/auth/setup", headers, payload: { token: setupToken } })).statusCode, 409);
    f.accounts.revoke(member.credential);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/auth/setup", headers, payload: { token: setupToken } })).statusCode, 401);
  } finally { await app.close(); f.store.close(); }
});
