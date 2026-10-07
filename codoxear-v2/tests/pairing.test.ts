import { createAllowedComputer } from "../scripts/testing/authorized-fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { createIdentityApp } from "../src/identity/app.js";
import {
  createHub,
  passwordHash,
  digest,
  secret,
} from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
async function fixture() {
  const store = new Store(":memory:");
  const accounts = new Accounts(store, "test-pairing-secret-".repeat(4), {
    async send() {},
  });
  store.change((s) =>
    s.users.push({
      id: "owner",
      name: "Owner",
      email: "owner@example.test",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    }),
  );
  let now = Date.now();
  const authority = new Authority(
    store,
    accounts,
    new Tokens("https://hub.test", await signingKey()),
    () => now,
  );
  const session = accounts.password(
    "owner@example.test",
    "test-password",
    "web",
  ).session;
  const hub = store.change((s) => createHub(s, "owner", "Hub"));
  authority.registerHub(session, hub.id, "https://hub.test");
  const computer = store.change((s) =>
    createAllowedComputer(s, "owner", hub.id, "Computer", "owner"),
  ).computer;
  return {
    store,
    authority,
    session,
    computer,
    advance(ms: number) {
      now += ms;
    },
  };
}
test("8-character pairing codes last exactly 15 minutes, normalize typing and remain single-use", async () => {
  const f = await fixture();
  try {
    const p = f.authority.pairing(f.session, f.computer.id);
    assert.match(p.code, /^[A-HJ-NP-Z2-9]{8}$/);
    assert.equal(p.expiresIn, 900);
    assert.equal(f.store.read().identity.pairings[0]!.codeHash, digest(p.code));
    f.advance(899999);
    const typed =
      p.code.slice(0, 4).toLowerCase() + "-" + p.code.slice(4).toLowerCase();
    assert.equal(f.authority.redeem(typed).computerId, f.computer.id);
    assert.throws(() => f.authority.redeem(p.code));
    const expired = f.authority.pairing(f.session, f.computer.id);
    f.advance(900000);
    assert.throws(() => f.authority.redeem(expired.code));
  } finally {
    f.store.close();
  }
});
test("renewal invalidates earlier codes and long tokens issued before upgrade remain redeemable", async () => {
  const f = await fixture();
  try {
    const previous = f.authority.pairing(f.session, f.computer.id);
    const next = f.authority.pairing(f.session, f.computer.id);
    assert.throws(() => f.authority.redeem(previous.code));
    assert.equal(f.authority.redeem(next.code).computerId, f.computer.id);
    f.authority.pairing(f.session, f.computer.id);
    const oldToken = secret();
    f.store.change((s) => {
      s.identity.pairings[0]!.codeHash = digest(oldToken);
    });
    assert.equal(f.authority.redeem(oldToken).computerId, f.computer.id);
  } finally {
    f.store.close();
  }
});
test("public redemption accepts short codes and rate-limits guesses", async () => {
  const f = await fixture(),
    app = await createIdentityApp({ authority: f.authority });
  try {
    const pairing = f.authority.pairing(f.session, f.computer.id);
    const response = await app.inject({
      method: "POST",
      url: "/api/v1/pairing/redeem",
      payload: { code: pairing.code },
    });
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().computerId, f.computer.id);
    for (let i = 0; i < 29; i++)
      await app.inject({
        method: "POST",
        url: "/api/v1/pairing/redeem",
        payload: { code: "ZZZZZZZZ" },
      });
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/api/v1/pairing/redeem",
          payload: { code: "ZZZZZZZZ" },
        })
      ).statusCode,
      429,
    );
  } finally {
    await app.close();
    f.store.close();
  }
});
