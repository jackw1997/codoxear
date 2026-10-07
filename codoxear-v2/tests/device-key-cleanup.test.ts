import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { DeviceKeys } from "../src/auth/device-keys.js";
import { DevicePublicKey } from "../src/contracts/device-keys.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");

async function register(keys: DeviceKeys, session: Parameters<DeviceKeys["enrollChallenge"]>[0], installationId: string) {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = DevicePublicKey.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  const sign = async (payload: string) => Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" },
    pair.privateKey, new TextEncoder().encode(payload))).toString("base64url");
  const enrollment = keys.enrollChallenge(session, { publicKey, installationId, name: installationId });
  const enrolled = keys.enrollVerify(session, enrollment.challengeId, await sign(enrollment.payload));
  const challenge = keys.loginChallenge({ keyId: enrolled.keyId, installationId });
  return { ...enrolled, publicKey, signed: keys.loginVerify(challenge.challengeId, await sign(challenge.payload)) };
}

test("revoking a key discards its complete credential tree and keeps unrelated identity credentials", async () => {
  const store = new Store(":memory:");
  const accounts = new Accounts(store, "cleanup-tests-secret".repeat(4), { async send() {} });
  const provider = accounts.finish({ connection: "google-app", method: "google", subject: "person", tenant: null,
    email: null, name: "Person" }, "web");
  const keys = new DeviceKeys(accounts, "https://hub.test");
  try {
    const target = await register(keys, provider.session, "target-phone");
    const other = await register(keys, provider.session, "other-phone");
    const child = accounts.forkSession(target.signed.session.id, "child");
    const grandchild = accounts.forkSession(child.id, "grandchild");
    const childRefresh = accounts.issueRefresh(child.id);
    const grandchildRefresh = accounts.issueRefresh(grandchild.id);
    const ids = new Set([target.signed.session.id, child.id, grandchild.id]);
    const expiry = Date.now() + 120000;
    store.change((state) => {
      // Exercise transitive ancestry even for old children without a key tag.
      for (const row of state.identity.sessions) if (row.id === child.id || row.id === grandchild.id) delete row.deviceKeyId;
      state.identity.codes.push({ hash: "target-code", sessionId: grandchild.id, clientId: "client", redirectUri: "https://client.test/callback", challenge: "pkce", used: false, expiresAt: expiry });
      state.identity.codes.push({ hash: "other-code", sessionId: other.signed.session.id, clientId: "client", redirectUri: "https://client.test/callback", challenge: "pkce", used: false, expiresAt: expiry });
      state.identity.flows.push({ id: "target-flow", stateHash: "state", browserHash: "browser", connection: "google-app", verifier: "verifier", used: false, expiresAt: expiry, linkUserId: provider.session.userId, linkSessionId: child.id });
      state.identity.challenges.push({ id: "target-otp", transactionHash: "transaction", method: "email", target: "person@example.test", codeHash: "code", expiresAt: expiry, attempts: 0, used: false, linkUserId: provider.session.userId, linkSessionId: grandchild.id });
      state.identity.queuePermits.push({ tokenHash: "permit", sessionId: child.id, hubId: "hub", computerId: "computer", localId: "runtime", binding: 1, expiresAt: expiry });
    });
    const targetChallenge = keys.loginChallenge({ keyId: target.keyId, installationId: "target-phone" });
    keys.revoke(provider.session, target.keyId);
    const state = store.read();
    assert.equal(state.identity.deviceKeys.find((row) => row.id === target.keyId)?.revoked, true);
    assert.equal(state.identity.sessions.some((row) => ids.has(row.id)), false);
    assert.equal(state.identity.refresh.some((row) => ids.has(row.sessionId)), false);
    assert.deepEqual(state.identity.codes.map((row) => row.hash), ["other-code"]);
    assert.deepEqual(state.identity.flows, []);
    assert.deepEqual(state.identity.challenges, []);
    assert.deepEqual(state.identity.queuePermits, []);
    assert.equal(state.identity.deviceKeyChallenges.some((row) => row.id === targetChallenge.challengeId), false);
    assert.throws(() => accounts.sessionById(grandchild.id));
    assert.throws(() => accounts.rotateRefresh(childRefresh));
    assert.throws(() => accounts.rotateRefresh(grandchildRefresh));
    assert.throws(() => accounts.rotateRefresh(target.signed.refreshToken));
    assert.equal(accounts.sessionById(other.signed.session.id).id, other.signed.session.id);
    assert.equal(accounts.sessionById(provider.session.id).id, provider.session.id);
    assert.throws(() => keys.enrollChallenge(provider.session, { publicKey: target.publicKey, installationId: "target-phone", name: "Phone" }), /already registered/);
    keys.revoke(provider.session, target.keyId);
    assert.equal(store.read().identity.sessions.length, 2);
  } finally { store.close(); }
});
