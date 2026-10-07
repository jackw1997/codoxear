import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash, webcrypto } from "node:crypto";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { DeviceKeys, deviceKeyId } from "../src/auth/device-keys.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import { createIdentityApp } from "../src/auth/app.js";
import { DevicePublicKey } from "../src/contracts/device-keys.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");

async function client() {
  const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
  assert.equal(pair.privateKey.extractable, false);
  const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
  const publicKey = DevicePublicKey.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
  return { publicKey, async sign(payload: string) {
    return Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))).toString("base64url");
  } };
}
function fixture() {
  const store = new Store(":memory:");
  let now = Date.now();
  const accounts = new Accounts(store, "key-tests-secret".repeat(4), { async send() {} }, () => now);
  const provider = accounts.finish({ connection: "google-app", method: "google", subject: "google-user", tenant: null,
    email: "user@example.test", name: "User" }, "provider-browser");
  const keys = new DeviceKeys(accounts, "https://hub.test", () => now);
  return { store, accounts, keys, provider, advance(ms: number) { now += ms; } };
}
async function enroll(f: ReturnType<typeof fixture>, suppliedDevice?: Awaited<ReturnType<typeof client>>) {
  const device = suppliedDevice ?? await client();
  const challenge = f.keys.enrollChallenge(f.provider.session, { publicKey: device.publicKey, name: "Laptop", installationId: "laptop" });
  const result = f.keys.enrollVerify(f.provider.session, challenge.challengeId, await device.sign(challenge.payload));
  return { device, ...result };
}

test("client public-key registration and login preserve provider proof and create no execution grants", async () => {
  const f = fixture();
  try {
    const { device, keyId } = await enroll(f);
    const expected = createHash("sha256").update(JSON.stringify({ crv: "P-256", kty: "EC", x: device.publicKey.x, y: device.publicKey.y })).digest("base64url");
    assert.equal(keyId, expected);
    const challenge = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    const payload = JSON.parse(challenge.payload);
    assert.equal(payload.issuer, "https://hub.test");
    assert.equal(payload.purpose, "login");
    assert.equal(payload.keyId, keyId);
    assert.equal(payload.installationId, "laptop");
    const signed = f.keys.loginVerify(challenge.challengeId, await device.sign(challenge.payload));
    assert.equal(signed.session.deviceKeyId, keyId);
    assert.deepEqual(signed.session.context, f.provider.session.context);
    assert.equal(signed.session.userId, f.provider.session.userId);
    assert.equal(f.accounts.session(signed.credential).id, signed.session.id);
    const state = f.store.read();
    assert.deepEqual(state.memberships, []);
    assert.deepEqual(state.hubs, []);
    assert.deepEqual(state.computers, []);
    assert.deepEqual(state.agentGrants, []);
    assert.deepEqual(Object.keys(f.keys.list(signed.session)[0]!).sort(), ["createdAt", "id", "installationId", "lastUsedAt", "name"]);
    assert.throws(() => f.keys.enrollChallenge(signed.session, { publicKey: device.publicKey, name: "Other", installationId: "other" }), /Sign in with Google or Feishu/);
  } finally { f.store.close(); }
});

test("key proofs are single-use, purpose/issuer/session bound, expire and reject another signing key", async () => {
  const f = fixture();
  try {
    const device = await client(), wrong = await client();
    const challenge = f.keys.enrollChallenge(f.provider.session, { publicKey: device.publicKey, name: "Laptop", installationId: "laptop" });
    assert.throws(() => f.keys.loginVerify(challenge.challengeId, "A".repeat(86)), /proof/);
    assert.throws(() => f.keys.enrollVerify(f.provider.session, challenge.challengeId, "A".repeat(86)), /proof/);
    const otherSession = f.accounts.finish({ connection: "google-app", method: "google", subject: "different-user", tenant: null,
      email: "other@example.test", name: "Other" }, "other-browser").session;
    const bound = f.keys.enrollChallenge(f.provider.session, { publicKey: device.publicKey, name: "Laptop", installationId: "laptop" });
    const boundSignature = await device.sign(bound.payload);
    assert.throws(() => f.keys.enrollVerify(otherSession, bound.challengeId, boundSignature), /proof/);
    assert.throws(() => f.keys.enrollVerify(f.provider.session, bound.challengeId, boundSignature), /proof/);
    const { keyId } = await enroll(f, device);
    assert.throws(() => f.keys.enrollChallenge(f.provider.session, { publicKey: device.publicKey, name: "Duplicate", installationId: "laptop" }), /already registered/);
    const bad = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    assert.throws(() => f.keys.loginChallenge({ keyId, installationId: "another-client" }), /proof/);
    assert.throws(() => f.keys.loginVerify(bad.challengeId, "bad"), /proof/);
    assert.throws(() => f.keys.loginVerify(bad.challengeId, "A".repeat(86)), /proof/);
    const wrongKey = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    const wrongSignature = await wrong.sign(wrongKey.payload);
    assert.throws(() => f.keys.loginVerify(wrongKey.challengeId, wrongSignature), /proof/);
    const otherIssuer = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    const anotherHub = new DeviceKeys(f.accounts, "https://another.test");
    assert.throws(() => anotherHub.loginVerify(otherIssuer.challengeId, "A".repeat(86)), /proof/);
    const expired = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    const signature = await device.sign(expired.payload);
    f.advance(120001);
    assert.throws(() => f.keys.loginVerify(expired.challengeId, signature), /proof/);
    const replay = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    const valid = await device.sign(replay.payload);
    f.keys.loginVerify(replay.challengeId, valid);
    assert.throws(() => f.keys.loginVerify(replay.challengeId, valid), /proof/);
  } finally { f.store.close(); }
});

test("revoking a client key invalidates direct, forked and rotating-refresh sessions without revoking provider sessions", async () => {
  const f = fixture();
  try {
    const { keyId, device } = await enroll(f);
    const challenge = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    const signed = f.keys.loginVerify(challenge.challengeId, await device.sign(challenge.payload));
    const child = f.accounts.forkSession(signed.session.id, "native");
    const token = f.accounts.issueRefresh(child.id);
    const rotated = f.accounts.rotateRefresh(token);
    f.keys.revoke(f.provider.session, keyId);
    assert.throws(() => f.accounts.session(signed.credential));
    assert.throws(() => f.accounts.sessionById(child.id));
    assert.throws(() => f.accounts.rotateRefresh(rotated.refreshToken));
    assert.throws(() => f.keys.loginChallenge({ keyId, installationId: "laptop" }));
    assert.equal(f.accounts.session(f.provider.credential).id, f.provider.session.id);
  } finally { f.store.close(); }
});

test("one thousand signed key logins keep one active root session and refresh family while retaining rotation replay protection", async () => {
  const f = fixture();
  try {
    const { keyId, device } = await enroll(f);
    async function authenticate() {
      const challenge = f.keys.loginChallenge({ keyId, installationId: "laptop" });
      return f.keys.loginVerify(challenge.challengeId, await device.sign(challenge.payload));
    }
    const first = await authenticate();
    let latest = first;
    for (let proof = 1; proof < 1000; proof++) {
      latest = await authenticate();
      assert.equal(latest.session.id, first.session.id);
      assert.deepEqual(latest.session.context, f.provider.session.context);
    }
    const state = f.store.read();
    assert.equal(state.identity.sessions.length, 2); // Provider session + key root.
    assert.equal(state.identity.refresh.length, 1);
    assert.equal(state.identity.deviceKeyChallenges.length, 1);
    assert.throws(() => f.accounts.rotateRefresh(first.refreshToken));
    assert.equal(f.accounts.sessionById(latest.session.id).id, first.session.id);
    const rotated = f.accounts.rotateRefresh(latest.refreshToken);
    assert.throws(() => f.accounts.rotateRefresh(latest.refreshToken), /reuse/);
    assert.throws(() => f.accounts.sessionById(latest.session.id));
    assert.throws(() => f.accounts.rotateRefresh(rotated.refreshToken));
    const recovered = await authenticate();
    assert.notEqual(recovered.session.id, first.session.id);
    assert.throws(() => f.accounts.sessionById(first.session.id));
    assert.equal(f.accounts.sessionById(recovered.session.id).deviceKeyId, keyId);
  } finally { f.store.close(); }
});

test("private JWKs, invalid coordinates, stale provider enrollment and disabled users are rejected", async () => {
  const f = fixture();
  try {
    const device = await client();
    assert.equal(DevicePublicKey.safeParse({ ...device.publicKey, d: "secret" }).success, false);
    assert.throws(() => deviceKeyId({ ...device.publicKey, x: "_".repeat(43), y: "_".repeat(43) }));
    const { keyId } = await enroll(f, device);
    f.advance(300001);
    const next = await client();
    assert.throws(() => f.keys.enrollChallenge(f.provider.session, { publicKey: next.publicKey, name: "Other", installationId: "other" }), /Sign in with Google or Feishu/);
    const pending = f.keys.loginChallenge({ keyId, installationId: "laptop" });
    const signature = await device.sign(pending.payload);
    f.store.change((s) => { s.users[0]!.disabled = true; });
    assert.throws(() => f.keys.loginVerify(pending.challengeId, signature));
    assert.throws(() => f.keys.loginChallenge({ keyId, installationId: "laptop" }));
  } finally { f.store.close(); }
});

test("HTTP registration, public challenge login, bearer access and revocation use browser-compatible P1363 signatures", async () => {
  const f = fixture();
  const tokens = new Tokens("https://hub.test", await signingKey());
  const app = await createIdentityApp({ authority: new Authority(f.store, f.accounts, tokens), secureCookies: false });
  try {
    const options = (await app.inject({ method: "GET", url: "/api/v1/auth/options" })).json();
    assert.equal(options.deviceKeys.algorithm, "ES256");
    assert.equal(Object.hasOwn(options, "password"), false);
    assert.equal(Object.hasOwn(options, "codes"), false);
    for (const url of ["/api/v1/auth/password", "/api/v1/auth/code", "/api/v1/auth/code/verify"])
      assert.equal((await app.inject({ method: "POST", url, payload: {} })).statusCode, 404);
    const providerToken = await tokens.issue(f.provider.session, tokens.issuer, "identity_access");
    const headers = { authorization: "Bearer " + providerToken };
    const device = await client();
    const start = await app.inject({ method: "POST", url: "/api/v1/auth/keys/enroll/challenge", headers,
      payload: { publicKey: device.publicKey, name: "Laptop", installationId: "laptop" } });
    assert.equal(start.statusCode, 200);
    const challenge = start.json();
    const registered = await app.inject({ method: "POST", url: "/api/v1/auth/keys/enroll/verify", headers,
      payload: { challengeId: challenge.challengeId, signature: await device.sign(challenge.payload) } });
    assert.equal(registered.statusCode, 200);
    const { keyId } = registered.json();
    const begin = await app.inject({ method: "POST", url: "/api/v1/auth/keys/challenge", payload: { keyId, installationId: "laptop" } });
    const loginChallenge = begin.json();
    const login = await app.inject({ method: "POST", url: "/api/v1/auth/keys/verify",
      payload: { challengeId: loginChallenge.challengeId, signature: await device.sign(loginChallenge.payload) } });
    assert.equal(login.statusCode, 200);
    assert.equal(login.headers["set-cookie"], undefined);
    const result = login.json();
    assert.equal(result.token_type, "Bearer");
    const authenticated = { authorization: "Bearer " + result.access_token };
    const me = await app.inject({ method: "GET", url: "/api/v1/me", headers: authenticated });
    assert.equal(me.statusCode, 200);
    assert.equal(me.json().id, f.provider.session.userId);
    const listing = await app.inject({ method: "GET", url: "/api/v1/me/keys", headers: authenticated });
    assert.equal(listing.json()[0].id, keyId);
    const denied = await app.inject({ method: "POST", url: "/api/v1/auth/keys/challenge", headers: { origin: "https://evil.test" }, payload: { keyId, installationId: "laptop" } });
    assert.equal(denied.statusCode, 403);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/me/keys/" + keyId, headers })).statusCode, 200);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/me", headers: authenticated })).statusCode, 401);
    assert.equal((await app.inject({ method: "POST", url: "/oauth/token", payload: { grant_type: "refresh_token", refresh_token: result.refresh_token } })).statusCode, 401);
  } finally { await app.close(); f.store.close(); }
});

test("OAuth enrollment authorization reuses only fresh provider proof and preserves stale-session continuation", async () => {
  const f = fixture(), tokens = new Tokens("https://hub.test", await signingKey());
  const app = await createIdentityApp({ authority: new Authority(f.store, f.accounts, tokens), loginPath: "/login",
    clients: [{ id: "web-test", redirectUris: ["https://client.test/auth-callback"] }], secureCookies: false });
  try {
    const url = "/oauth/authorize?" + new URLSearchParams({ client_id: "web-test", redirect_uri: "https://client.test/auth-callback",
      state: "oauth-state-".repeat(3), code_challenge: "A".repeat(43), code_challenge_method: "S256", response_type: "code" });
    const headers = { cookie: "codoxear_identity=" + f.provider.credential };
    const fresh = await app.inject({ method: "GET", url, headers });
    assert.equal(fresh.statusCode, 302);
    assert.equal(new URL(fresh.headers.location!).origin, "https://client.test");
    assert.ok(new URL(fresh.headers.location!).searchParams.get("code"));
    f.store.change((state) => { state.identity.sessions.find((row) => row.id === f.provider.session.id)!.context.authenticatedAt = Date.now() - 300001; });
    const stale = await app.inject({ method: "GET", url, headers });
    const redirect = new URL(stale.headers.location!, tokens.issuer);
    assert.equal(redirect.pathname, "/login");
    assert.equal(redirect.searchParams.get("reauth"), "1");
    assert.equal(redirect.searchParams.get("continue"), url);
    assert.equal(f.store.read().identity.codes.length, 1);
  } finally { await app.close(); f.store.close(); }
});
