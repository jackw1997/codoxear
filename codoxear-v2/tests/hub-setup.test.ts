import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";
import { configureHubOrganization } from "../src/auth/hub-organization.js";
import { createComputer } from "../src/domain/commands.js";
import type { Provider } from "../src/auth/providers.js";

assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const token = "private-owner-initialization-link-".repeat(3);
function fixture() {
  const store = new Store(":memory:");
  let now = Date.now();
  const hub = store.change((state) => initializeHub(state, "local-hub", "New Hub"));
  const accounts = new Accounts(store, "initialization-tests-secret".repeat(4), { async send() {} }, () => now);
  const initialization = { token, expiresAt: now + 86400000 };
  const setup = hubSetup(store, hub.id, initialization, () => now);
  configureHubOrganization(store, hub.id, ["google", "feishu"].map(method => ({ id: method, method,
    async authorize() { return "https://provider.test"; }, async exchange() { throw Error("unused"); } } as Provider)));
  const identity = (method: "google" | "feishu" = "google", subject = "owner") => ({ connection: method, method, subject,
    tenant: method === "feishu" ? "enterprise" : null, email: method === "google" ? `${subject}@example.test` : null, name: subject });
  const finish = (method: "google" | "feishu", subject = "owner", initializationId?: string) =>
    accounts.finish(identity(method, subject), "browser", undefined, initializationId ? (state, session) => setup.complete(state, session, initializationId) : undefined);
  return { store, hub, accounts, initialization, setup, identity, finish, advance(ms: number) { now += ms; } };
}

test("new Hub has no public first-visitor ownership and rejects invalid or expired initialization links", () => {
  const f = fixture();
  try {
    assert.equal(f.setup.pending(), true);
    const reserved = f.store.read().users.find(user => user.id === f.hub.ownerId)!;
    assert.equal(reserved.disabled, true); assert.equal(reserved.passwordHash, "");
    assert.throws(() => hubSetup(f.store, f.hub.id, undefined), /initialization link/);
    assert.throws(() => hubSetup(f.store, f.hub.id, { token: "short", expiresAt: Date.now() }), /small/);
    f.finish("google", "normal-google"); f.finish("feishu", "normal-feishu");
    assert.equal(f.store.read().hubs[0]!.ownerId, reserved.id);
    assert.deepEqual(f.store.read().memberships, []);
    assert.throws(() => f.setup.prepare("invalid-private-token".repeat(3)), /invalid, expired or already used/);
    assert.equal(f.setup.prepare(token).expiresAt, f.initialization.expiresAt);
    f.advance(86400000);
    assert.throws(() => f.setup.prepare(token), /invalid, expired or already used/);
    assert.equal(f.setup.pending(), true);
  } finally { f.store.close(); }
});

test("initialization accepts either allowed Google or Feishu proof and transfers only deployment-reserved ownership", () => {
  for (const method of ["google", "feishu"] as const) {
    const f = fixture();
    try {
      const reservedComputer = f.store.change(state => {
        const reserved = state.users.find(user => user.id === f.hub.ownerId)!;
        reserved.disabled = false;
        const computer = createComputer(state, reserved.id, f.hub.id, "Pre-provisioned", reserved.id).computer;
        reserved.disabled = true; return computer;
      });
      const prepared = f.setup.prepare(token), owner = f.finish(method, "owner", prepared.id), state = f.store.read();
      assert.equal(state.hubs[0]!.ownerId, owner.session.userId);
      assert.equal(state.computers.find(computer => computer.id === reservedComputer.id)!.ownerId, owner.session.userId);
      assert.equal(state.computers[0]!.binding, reservedComputer.binding);
      assert.equal(state.identity.initializations[0]!.consumedAt !== null, true);
      assert.equal(state.identity.hubOrganizations[0]!.feishuTenant, method === "feishu" ? "enterprise" : null);
      assert.equal(f.setup.pending(), false);
      assert.throws(() => f.setup.prepare(token), /already used/);
      assert.equal(JSON.stringify(state).includes(token), false);
    } finally { f.store.close(); }
  }
});

test("competing initialization callbacks consume once and roll back the losing account and session atomically", () => {
  const f = fixture();
  try {
    const first = f.setup.prepare(token), second = f.setup.prepare(token);
    const owner = f.finish("google", "winner", first.id), before = f.store.read();
    assert.throws(() => f.finish("feishu", "loser", second.id), /already used/);
    const after = f.store.read();
    assert.equal(after.hubs[0]!.ownerId, owner.session.userId);
    assert.equal(after.users.length, before.users.length);
    assert.equal(after.identity.identities.length, before.identity.identities.length);
    assert.equal(after.identity.sessions.length, before.identity.sessions.length);
    assert.equal(after.identity.identities.some(identity => identity.subject === "loser"), false);
  } finally { f.store.close(); }
});

test("expired links and stale, disabled or mismatched proof cannot complete initialization", () => {
  for (const invalid of ["expired", "stale", "disabled", "mismatch"] as const) {
    const f = fixture();
    try {
      const prepared = f.setup.prepare(token), member = f.finish("google");
      if (invalid === "expired") f.advance(86400000);
      if (invalid === "stale") f.advance(300001);
      if (invalid === "disabled") f.store.change(state => { state.users.find(user => user.id === member.session.userId)!.disabled = true; });
      const proof = invalid === "mismatch" ? { ...member.session, context: { ...member.session.context, method: "feishu" as const } } : member.session;
      assert.throws(() => f.store.change(state => f.setup.complete(state, proof, prepared.id)), /Initialization link|fresh verified/);
      assert.equal(f.setup.pending(), true);
      assert.equal(f.store.read().identity.initializations[0]!.consumedAt, null);
    } finally { f.store.close(); }
  }
});
