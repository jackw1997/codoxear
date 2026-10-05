import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Accounts } from "../src/identity/accounts.js";
import { Store } from "../src/persistence/store.js";
import { emptyState, State } from "../src/contracts/model.js";
import {
  InvitationRequest,
  type InvitationTarget,
} from "../src/contracts/invitations.js";
import {
  invite,
  acceptInvite,
  createHub,
  transferOwner,
  removeMember,
} from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
function fixture() {
  const s = emptyState();
  for (const name of ["alice", "bob", "eve"])
    s.users.push({
      id: name,
      email: `${name}@example.test`,
      name,
      passwordHash: "unused",
      disabled: false,
    });
  const h = createHub(s, "alice", "Hub");
  const identity = {
    id: "bob-phone",
    userId: "bob",
    method: "phone" as const,
    connection: "phone",
    subject: "+8613800138000",
    tenant: null,
    email: null,
    verifiedAt: Date.now(),
  };
  s.identity.identities.push(identity);
  return { s, h, identity };
}
test("phone invitation requires the current verified phone and remains single-use", () => {
  const { s, h, identity } = fixture();
  const { token } = invite(
    s,
    "alice",
    "hub",
    h.id,
    { method: "phone", phone: identity.subject },
    "viewer",
  );
  assert.throws(() => acceptInvite(s, "eve", token));
  identity.verifiedAt = 0;
  assert.throws(() => acceptInvite(s, "bob", token));
  identity.verifiedAt = Date.now();
  s.users.find((u) => u.id === "bob")!.disabled = true;
  assert.throws(() => acceptInvite(s, "bob", token));
  s.users.find((u) => u.id === "bob")!.disabled = false;
  const linked = s.identity.identities.splice(0);
  assert.throws(() => acceptInvite(s, "bob", token));
  s.identity.identities.push(...linked);
  acceptInvite(s, "bob", token);
  assert.equal(s.memberships[0]!.role, "viewer");
  assert.throws(() => acceptInvite(s, "bob", token));
});
for (const method of ["feishu", "wechat", "oidc"] as const)
  test(`${method} invitations bind connection, subject, tenant and method`, () => {
    const { s, h } = fixture();
    const target: InvitationTarget = {
      method,
      connection: "enterprise",
      subject: "recipient-id",
      tenant: "team-a",
    };
    const { token } = invite(s, "alice", "hub", h.id, target, "operator");
    const identity = {
      ...target,
      id: "recipient",
      userId: "bob",
      email: null,
      verifiedAt: Date.now(),
    };
    s.identity.identities.push(identity);
    for (const field of [
      "connection",
      "subject",
      "tenant",
      "method",
    ] as const) {
      const before = identity[field];
      Object.assign(identity, {
        [field]: field === "method" ? "phone" : "mismatched",
      });
      assert.throws(() => acceptInvite(s, "bob", token));
      Object.assign(identity, { [field]: before });
    }
    assert.throws(() => invite(s, "bob", "hub", h.id, target, "operator"));
    acceptInvite(s, "bob", token);
    assert.equal(s.memberships[0]!.role, "operator");
  });
test("phone/provider invites preserve expiry and ownership revision checks", () => {
  const { s, h, identity } = fixture();
  const target: InvitationTarget = { method: "phone", phone: identity.subject };
  const expired = invite(s, "alice", "hub", h.id, target, "operator");
  expired.invitation.expiresAt = Date.now() - 1;
  assert.throws(() => acceptInvite(s, "bob", expired.token));
  const first = invite(s, "alice", "hub", h.id, target, "operator");
  acceptInvite(s, "bob", first.token);
  const stale = invite(s, "alice", "hub", h.id, target, "viewer");
  transferOwner(s, "alice", "hub", h.id, "bob");
  assert.throws(() => acceptInvite(s, "bob", stale.token));
  removeMember(s, "bob", "hub", h.id, "alice");
});
test("new recipient records and legacy email-only invitations survive schema reload", () => {
  const { s, h, identity } = fixture();
  const legacy = invite(
    s,
    "alice",
    "hub",
    h.id,
    " BOB@EXAMPLE.TEST ",
    "viewer",
  );
  delete (legacy.invitation as { target?: unknown }).target;
  const phone = invite(
    s,
    "alice",
    "hub",
    h.id,
    { method: "phone", phone: identity.subject },
    "operator",
  );
  const loaded = State.parse(JSON.parse(JSON.stringify(s)));
  acceptInvite(loaded, "bob", legacy.token);
  acceptInvite(loaded, "bob", phone.token);
  assert.equal(loaded.memberships[0]!.role, "operator");
});
test("invitation requests reject ambiguous targets, unknown fields and invalid international numbers", () => {
  assert.equal(
    InvitationRequest.parse({ email: " BOB@EXAMPLE.TEST ", role: "viewer" })
      .email,
    "bob@example.test",
  );
  for (const body of [
    { role: "viewer" },
    {
      email: "bob@example.test",
      target: { method: "phone", phone: "+8613800138000" },
      role: "viewer",
    },
    { target: { method: "phone", phone: "13800138000" }, role: "viewer" },
    {
      target: { method: "feishu", connection: "", subject: "id" },
      role: "viewer",
    },
    {
      target: {
        method: "wechat",
        connection: "one",
        subject: "id",
        name: "Bob",
      },
      role: "viewer",
    },
    { email: "bob@example.test", role: "viewer", ownerId: "eve" },
  ])
    assert.equal(InvitationRequest.safeParse(body).success, false);
});
test("fresh provider claims replace stale tenant/email invitation proofs without merging accounts", () => {
  const store = new Store(":memory:"),
    f = fixture();
  store.change((s) => Object.assign(s, f.s));
  const accounts = new Accounts(store, "test-otp-secret".repeat(4), {
    async send() {},
  });
  const identity = {
    method: "feishu" as const,
    connection: "company",
    subject: "recipient",
    tenant: "old-team",
    email: "old@example.test",
    name: "Colleague",
  };
  try {
    const first = accounts.finish(identity, "first");
    const stale = store.change((s) =>
      invite(
        s,
        "alice",
        "hub",
        f.h.id,
        {
          method: "feishu",
          connection: "company",
          subject: "recipient",
          tenant: "old-team",
        },
        "viewer",
      ),
    );
    const email = store.change((s) =>
      invite(s, "alice", "hub", f.h.id, "old@example.test", "viewer"),
    );
    const fresh = accounts.finish(
      { ...identity, tenant: "new-team", email: "new@example.test" },
      "second",
    );
    assert.equal(first.session.userId, fresh.session.userId);
    assert.throws(() =>
      store.change((s) => acceptInvite(s, fresh.session.userId, stale.token)),
    );
    assert.throws(() =>
      store.change((s) => acceptInvite(s, fresh.session.userId, email.token)),
    );
    const current = store.change((s) =>
      invite(
        s,
        "alice",
        "hub",
        f.h.id,
        {
          method: "feishu",
          connection: "company",
          subject: "recipient",
          tenant: "new-team",
        },
        "viewer",
      ),
    );
    store.change((s) => acceptInvite(s, fresh.session.userId, current.token));
    assert.equal(store.read().memberships[0]?.userId, fresh.session.userId);
  } finally {
    store.close();
  }
});
