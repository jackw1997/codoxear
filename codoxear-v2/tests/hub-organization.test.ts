import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { webcrypto } from "node:crypto";
import { Store } from "../src/persistence/store.js";
import { Accounts, type VerifiedIdentity } from "../src/auth/accounts.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import { DeviceKeys } from "../src/auth/device-keys.js";
import { createIdentityApp } from "../src/auth/app.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";
import { configureHubOrganization } from "../src/auth/hub-organization.js";
import { HubProviders, ProviderConfig, type Provider } from "../src/auth/providers.js";
import { DevicePublicKey } from "../src/contracts/device-keys.js";
import { acceptInvite, createComputer, createHub, invite, secret, digest } from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const origin = "https://organization.test", setupCode = "private-administrator-setup-code-".repeat(3);
const credentials = { clientId: "test-app", clientSecret: "test-server-secret" };

function feishuProvider(tenant?: string): Provider {
  return { id: "work-feishu", method: "feishu", ...(tenant ? { tenant } : {}),
    async authorize(state) { return "https://feishu.test/oauth?state=" + state; },
    async exchange() { throw new Error("No callback configured"); },
  };
}
async function fixture(tenant?: string) {
  const store = new Store(":memory:");
  const hub = store.change((state) => initializeHub(state, "one-hub", "Organization Hub"));
  const accounts = new Accounts(store, "organization-tests-".repeat(4), { async send() {} });
  const tokens = new Tokens(origin, await signingKey()), authority = new Authority(store, accounts, tokens);
  const setup = hubSetup(store, hub.id, setupCode), profiles = new Map<string, VerifiedIdentity>();
  const feishu: Provider = { ...feishuProvider(tenant), async exchange(code) { return profiles.get(code)!; } };
  const google: Provider = { id: "hub-google", method: "google", async authorize(state) { return "https://google.test/oauth?state=" + state; },
    async exchange(code) { return profiles.get(code)!; } };
  const app = await createIdentityApp({ authority, localHubId: hub.id, providers: [feishu, google], setup, secureCookies: false });
  async function signIn(method: "google" | "feishu", subject: string, verifiedTenant: string | null) {
    const connection = method === "feishu" ? feishu.id : google.id, code = secret();
    profiles.set(code, { connection, method, subject, tenant: verifiedTenant,
      email: method === "google" ? "verified@example.test" : null, name: subject });
    const start = await app.inject({ method: "GET", url: "/auth/" + connection + "/start" });
    const browser = start.cookies.find((cookie) => cookie.name === "codoxear_identity_oauth")!;
    const callback = await app.inject({ method: "GET", url: "/auth/" + connection + "/callback?" + new URLSearchParams({
      state: new URL(start.headers.location!).searchParams.get("state")!, code,
    }), cookies: { [browser.name]: browser.value } });
    const credential = callback.cookies.find((cookie) => cookie.name === "codoxear_identity")?.value;
    return { callback, credential, session: credential ? accounts.session(credential) : undefined };
  }
  return { store, accounts, tokens, authority, app, setup, hub, feishu, signIn,
    async close() { await app.close(); store.close(); } };
}

test("Hub provider configuration has one Feishu app and one optional tenant, with independent Google connections", () => {
  const feishu = { kind: "feishu" as const, id: "work-feishu", ...credentials, tenant: "team-a" };
  assert.equal(HubProviders.parse([feishu])[0]!.kind, "feishu");
  assert.equal(HubProviders.safeParse([feishu, { ...feishu, id: "second-app" }]).success, false);
  assert.equal(ProviderConfig.safeParse({ ...feishu, allowedTenants: ["team-a", "team-b"] }).success, false);
  assert.equal(HubProviders.safeParse([feishu, { kind: "google", id: "work-feishu", ...credentials }]).success, false);
  assert.equal(HubProviders.safeParse([feishu, { kind: "google", id: "google", ...credentials }]).success, true);
});

test("configured Feishu organization rejects foreign OAuth callback before account creation", async () => {
  const f = await fixture("team-a");
  try {
    const options = (await f.app.inject({ method: "GET", url: "/api/v1/auth/options" })).json();
    assert.deepEqual(options.organization, { feishuTenant: "team-a", tenantBindingRequired: false });
    assert.equal(options.setupRequired, true);
    assert.equal(Object.hasOwn(options, "loginBroker"), false);
    const foreign = await f.signIn("feishu", "foreign", "team-b");
    assert.equal(foreign.callback.statusCode, 403);
    assert.equal(foreign.callback.json().code, "wrong_organization");
    assert.equal(f.store.read().users.length, 1);
    assert.equal(f.store.read().identity.identities.length, 0);
    const member = await f.signIn("feishu", "member", "team-a");
    assert.equal(member.callback.statusCode, 302);
    assert.deepEqual(f.store.read().memberships, []);
    assert.equal(f.store.read().hubs[0]!.ownerId, f.hub.ownerId);
  } finally { await f.close(); }
});

test("only the private initial owner setup code plus this Hub's Feishu proof can bind an unconfigured organization", async () => {
  const f = await fixture();
  try {
    const google = await f.signIn("google", "google-owner", null);
    const googleSetup = await f.app.inject({ method: "POST", url: "/api/v1/auth/setup", cookies: { codoxear_identity: google.credential! }, payload: { token: setupCode } });
    assert.equal(googleSetup.statusCode, 403);
    assert.equal(googleSetup.json().code, "feishu_setup_required");
    const owner = await f.signIn("feishu", "owner", "team-a");
    const badCode = await f.app.inject({ method: "POST", url: "/api/v1/auth/setup", cookies: { codoxear_identity: owner.credential! }, payload: { token: "wrong-code".repeat(6) } });
    assert.equal(badCode.statusCode, 403);
    assert.equal(f.store.read().identity.hubOrganizations[0]!.feishuTenant, null);
    const claimed = await f.app.inject({ method: "POST", url: "/api/v1/auth/setup", cookies: { codoxear_identity: owner.credential! }, payload: { token: setupCode, name: "Work" } });
    assert.equal(claimed.statusCode, 200);
    assert.equal(f.store.read().identity.hubOrganizations[0]!.feishuTenant, "team-a");
    assert.equal(f.store.read().hubs[0]!.ownerId, owner.session!.userId);
    assert.equal(f.store.read().hubs[0]!.name, "Work");
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/auth/options" })).json().organization.tenantBindingRequired, false);
    assert.throws(() => configureHubOrganization(f.store, f.hub.id, [feishuProvider("team-b")]), /cannot be changed/);
    assert.equal(f.store.read().identity.hubOrganizations[0]!.feishuTenant, "team-a");
  } finally { await f.close(); }
});

test("binding the organization rejects preexisting foreign tenant sessions, cached Hub tokens and key challenges", async () => {
  const f = await fixture();
  try {
    const foreign = await f.signIn("feishu", "foreign", "team-b");
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    const publicKey = DevicePublicKey.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    const keys = new DeviceKeys(f.accounts, origin);
    const enroll = keys.enrollChallenge(foreign.session!, { publicKey, name: "Foreign browser", installationId: "foreign-browser" });
    const signature = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(enroll.payload))).toString("base64url");
    const { keyId } = keys.enrollVerify(foreign.session!, enroll.challengeId, signature);
    const pending = keys.loginChallenge({ keyId, installationId: "foreign-browser" });
    const proof = Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(pending.payload))).toString("base64url");
    const cached = await f.tokens.issue(foreign.session!, f.hub.id);
    const owner = await f.signIn("feishu", "owner", "team-a");
    f.setup.claim(owner.session!, setupCode);
    f.store.change((state) => state.memberships.push({ resource: "hub", resourceId: f.hub.id, userId: foreign.session!.userId, role: "viewer" }));
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: foreign.credential! } })).statusCode, 403);
    assert.throws(() => keys.loginChallenge({ keyId, installationId: "foreign-browser" }), /organization/);
    assert.throws(() => keys.loginVerify(pending.challengeId, proof), /organization/);
    await assert.rejects(f.authority.principal(cached, f.hub.id), /organization/);
    assert.throws(() => f.accounts.finish({ connection: "work-feishu", method: "feishu", subject: "another", tenant: "team-b", email: null, name: "Another" }, "browser"), /organization/);
  } finally { await f.close(); }
});

test("one Hub admits multiple independent Google/Feishu identities only through explicit account grants", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a");
    f.setup.claim(owner.session!, setupCode);
    const a = await f.signIn("google", "google-a", null), b = await f.signIn("google", "google-b", null), colleague = await f.signIn("feishu", "colleague", "team-a");
    assert.equal(new Set([a.session!.userId, b.session!.userId, colleague.session!.userId, owner.session!.userId]).size, 4);
    assert.deepEqual(f.authority.directory(a.session!), []);
    assert.deepEqual(f.authority.directory(b.session!), []);
    const hubInvite = f.store.change((state) => invite(state, owner.session!.userId, "hub", f.hub.id,
      { method: "google", connection: "hub-google", subject: "google-a", tenant: null }, "viewer"));
    const accept = (credential: string) => f.app.inject({ method: "POST", url: "/api/v1/invitations/accept", cookies: { codoxear_identity: credential }, payload: { token: hubInvite.token } });
    assert.equal((await accept(b.credential!)).statusCode, 403);
    assert.equal((await accept(a.credential!)).statusCode, 200);
    assert.equal(f.authority.directory(a.session!).length, 1);
    assert.deepEqual(f.authority.directory(b.session!), []);
    const computer = f.store.change((state) => createComputer(state, owner.session!.userId, f.hub.id, "Work computer", owner.session!.userId)).computer;
    assert.deepEqual(f.authority.computers(a.session!, f.hub.id), []);
    f.store.change((state) => acceptInvite(state, a.session!.userId, invite(state, owner.session!.userId, "computer", computer.id,
      { method: "google", connection: "hub-google", subject: "google-a", tenant: null }, "viewer").token));
    assert.equal(f.authority.computers(a.session!, f.hub.id).length, 1);
    assert.throws(() => f.accounts.finish({ connection: "hub-google", method: "google", subject: "google-b", tenant: null, email: "verified@example.test", name: "B" }, "linked", a.session!.id), /another account/);
    assert.equal(f.store.read().memberships.some((grant) => grant.userId === b.session!.userId || grant.userId === colleague.session!.userId), false);
  } finally { await f.close(); }
});

test("already configured Hubs require an explicit tenant before enabling Feishu", () => {
  const store = new Store(":memory:");
  try {
    store.change((state) => { state.users.push({ id: "owner", email: "owner@example.test", name: "Owner", disabled: false, passwordHash: "" }); createHub(state, "owner", "Home").id = "home"; });
    assert.throws(() => configureHubOrganization(store, "home", [feishuProvider()]), /already configured/);
    assert.equal(store.read().identity.hubOrganizations.length, 0);
    configureHubOrganization(store, "home", [feishuProvider("team-a")]);
    assert.equal(store.read().identity.hubOrganizations[0]!.feishuTenant, "team-a");
  } finally { store.close(); }
});

test("shared-authority compatibility preserves stable identity tuples without enforcing an independent Hub organization", () => {
  const store = new Store(":memory:"), accounts = new Accounts(store, "compatibility-tests".repeat(4), { async send() {} });
  try {
    const common = { connection: "enterprise", method: "feishu" as const, subject: "same-open-id", email: null, name: "Person" };
    const a = accounts.finish({ ...common, tenant: "team-a" }, "a"), b = accounts.finish({ ...common, tenant: "team-b" }, "b");
    assert.notEqual(a.session.userId, b.session.userId);
    assert.equal(accounts.finish({ ...common, tenant: "team-a" }, "returning").session.userId, a.session.userId);
    assert.equal(store.read().identity.identities.length, 2);
  } finally { store.close(); }
});

test("only the owner selects configured account types, with an acting-proof lockout guard and persistent policy", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a");
    f.setup.claim(owner.session!, setupCode);
    const member = await f.signIn("google", "member", null);
    const request = (credential: string, allowedMethods: string[]) => f.app.inject({ method: "PUT",
      url: `/api/v1/hubs/${f.hub.id}/login-methods`, cookies: { codoxear_identity: credential }, payload: { allowedMethods } });
    assert.equal((await request(member.credential!, ["feishu"])).statusCode, 403);
    assert.equal((await request(owner.credential!, [])).statusCode, 400);
    assert.equal((await request(owner.credential!, ["feishu", "feishu"])).statusCode, 400);
    assert.equal((await request(owner.credential!, ["feishu", "unconfigured"])).statusCode, 400);
    const lockout = await request(owner.credential!, ["google"]);
    assert.equal(lockout.statusCode, 409);
    assert.equal(lockout.json().code, "owner_login_method_required");
    assert.deepEqual(f.store.read().identity.hubOrganizations[0]!.allowedMethods, ["feishu", "google"]);
    const selected = await request(owner.credential!, ["feishu"]);
    assert.equal(selected.statusCode, 200);
    assert.deepEqual(selected.json(), { availableMethods: ["feishu", "google"], allowedMethods: ["feishu"] });
    configureHubOrganization(f.store, f.hub.id, [f.feishu, { id: "hub-google", method: "google",
      async authorize() { return "https://google.test"; }, async exchange() { throw new Error("unused"); } }]);
    assert.deepEqual(f.store.read().identity.hubOrganizations[0]!.allowedMethods, ["feishu"]);
    assert.deepEqual((await f.app.inject({ method: "GET", url: "/api/v1/auth/options" })).json().loginMethods,
      { availableMethods: ["feishu", "google"], allowedMethods: ["feishu"] });
    assert.equal((await f.app.inject({ method: "GET", url: "/auth/hub-google/start" })).statusCode, 403);
  } finally { await f.close(); }
});

test("a changed account-type policy rejects existing cookies, refreshes, cached tokens and pending key proofs", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a");
    f.setup.claim(owner.session!, setupCode);
    const google = await f.signIn("google", "google-member", null);
    f.store.change((state) => state.memberships.push({ resource: "hub", resourceId: f.hub.id, userId: google.session!.userId, role: "viewer" }));
    const cached = await f.tokens.issue(google.session!, f.hub.id), refresh = f.accounts.issueRefresh(google.session!.id);
    const keys = new DeviceKeys(f.accounts, origin);
    const pair = await webcrypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, false, ["sign", "verify"]);
    const jwk = await webcrypto.subtle.exportKey("jwk", pair.publicKey);
    const publicKey = DevicePublicKey.parse({ kty: jwk.kty, crv: jwk.crv, x: jwk.x, y: jwk.y });
    const sign = async (payload: string) => Buffer.from(await webcrypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, pair.privateKey, new TextEncoder().encode(payload))).toString("base64url");
    const enrollment = keys.enrollChallenge(google.session!, { publicKey, name: "Google browser", installationId: "google-browser" });
    const { keyId } = keys.enrollVerify(google.session!, enrollment.challengeId, await sign(enrollment.payload));
    const pending = keys.loginChallenge({ keyId, installationId: "google-browser" }), pendingSignature = await sign(pending.payload);
    const policy = await f.app.inject({ method: "PUT", url: `/api/v1/hubs/${f.hub.id}/login-methods`,
      cookies: { codoxear_identity: owner.credential! }, payload: { allowedMethods: ["feishu"] } });
    assert.equal(policy.statusCode, 200);
    const denied = await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: google.credential! } });
    assert.equal(denied.statusCode, 403); assert.equal(denied.json().code, "login_method_not_allowed");
    assert.throws(() => f.accounts.rotateRefresh(refresh), /account type/);
    await assert.rejects(f.authority.principal(cached, f.hub.id), /account type/);
    assert.throws(() => keys.loginChallenge({ keyId, installationId: "google-browser" }), /account type/);
    assert.throws(() => keys.loginVerify(pending.challengeId, pendingSignature), /account type/);
    assert.throws(() => f.accounts.finish({ method: "google", connection: "hub-google", subject: "new", tenant: null, email: null, name: "New" }, "new-browser"), /account type/);
    // Reallowing Google preserves independent accounts and their exact grants.
    assert.equal((await f.app.inject({ method: "PUT", url: `/api/v1/hubs/${f.hub.id}/login-methods`,
      cookies: { codoxear_identity: owner.credential! }, payload: { allowedMethods: ["feishu", "google"] } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: google.credential! } })).statusCode, 200);
    assert.equal(f.authority.directory(google.session!).length, 1);
    assert.notEqual(f.accounts.session(google.credential!).userId, owner.session!.userId);
  } finally { await f.close(); }
});

test("owner can select Google only after explicitly proving its own linked Google identity", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a");
    f.setup.claim(owner.session!, setupCode);
    const linked = f.accounts.finish({ method: "google", connection: "hub-google", subject: "owner-google",
      tenant: null, email: "owner@example.test", name: "Owner" }, "google-owner-browser", owner.session!.id);
    assert.equal(linked.session.userId, owner.session!.userId);
    const selected = await f.app.inject({ method: "PUT", url: `/api/v1/hubs/${f.hub.id}/login-methods`,
      cookies: { codoxear_identity: linked.credential }, payload: { allowedMethods: ["google"] } });
    assert.equal(selected.statusCode, 200);
    assert.deepEqual(selected.json().allowedMethods, ["google"]);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: owner.credential! } })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: linked.credential } })).statusCode, 200);
    assert.equal((await f.app.inject({ method: "GET", url: "/auth/work-feishu/start" })).statusCode, 403);
  } finally { await f.close(); }
});
