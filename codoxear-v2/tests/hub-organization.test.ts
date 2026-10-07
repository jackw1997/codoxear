import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { Accounts, type VerifiedIdentity } from "../src/auth/accounts.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import { createIdentityApp } from "../src/auth/app.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";
import { configureHubOrganization } from "../src/auth/hub-organization.js";
import { HubProviders, ProviderConfig, type Provider } from "../src/auth/providers.js";
import { createComputer, invite, setComputerAccess, secret } from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const origin = "https://organization.test", privateToken = "private-administrator-initialization-link-".repeat(3);
const credentials = { clientId: "test-app", clientSecret: "test-server-secret" };
function feishuProvider(tenant?: string): Provider {
  return { id: "work-feishu", method: "feishu", ...(tenant ? { tenant } : {}),
    async authorize(state) { return "https://feishu.test/oauth?state=" + state; }, async exchange() { throw Error("unused"); } };
}
async function fixture(tenant?: string) {
  const store = new Store(":memory:"), hub = store.change(state => initializeHub(state, "one-hub", "Organization Hub"));
  const accounts = new Accounts(store, "organization-tests-".repeat(4), { async send() {} });
  const tokens = new Tokens(origin, await signingKey()), authority = new Authority(store, accounts, tokens);
  const setup = hubSetup(store, hub.id, { token: privateToken, expiresAt: Date.now() + 86400000 });
  const profiles = new Map<string, VerifiedIdentity>();
  const feishu: Provider = { ...feishuProvider(tenant), async exchange(code) { return profiles.get(code)!; } };
  const google: Provider = { id: "hub-google", method: "google", async authorize(state) { return "https://google.test/oauth?state=" + state; },
    async exchange(code) { return profiles.get(code)!; } };
  const app = await createIdentityApp({ authority, localHubId: hub.id, providers: [feishu, google], setup, secureCookies: false });
  async function signIn(method: "google" | "feishu", subject: string, verifiedTenant: string | null, initialize = false) {
    const connection = method === "feishu" ? feishu.id : google.id, code = secret(), cookies: Record<string,string> = {};
    profiles.set(code, { connection, method, subject, tenant: verifiedTenant, email: method === "google" ? "same@example.test" : null, name: subject });
    if (initialize) {
      const entry = await app.inject({ method: "GET", url: "/initialize?" + new URLSearchParams({ token: privateToken }) });
      assert.equal(entry.statusCode, 302, entry.body);
      const browser = entry.cookies.find(cookie => cookie.name === "codoxear_identity_initialize")!; cookies[browser.name] = browser.value;
    }
    const start = await app.inject({ method: "GET", url: "/auth/" + connection + "/start", cookies });
    if (start.statusCode !== 302) return { callback: start, credential: undefined, session: undefined };
    const browser = start.cookies.find(cookie => cookie.name === "codoxear_identity_oauth")!;
    const callback = await app.inject({ method: "GET", url: "/auth/" + connection + "/callback?" + new URLSearchParams({
      state: new URL(start.headers.location!).searchParams.get("state")!, code }), cookies: { [browser.name]: browser.value } });
    const credential = callback.cookies.find(cookie => cookie.name === "codoxear_identity")?.value;
    return { callback, credential, session: credential ? accounts.session(credential) : undefined };
  }
  async function join(owner: NonNullable<Awaited<ReturnType<typeof signIn>>["session"]>,
    member: Awaited<ReturnType<typeof signIn>>) {
    const identity = store.read().identity.identities.find(value => value.id === member.session!.context.identityId)!;
    assert.ok(identity.method === "google" || identity.method === "feishu");
    const invitation = store.change(state => invite(state, owner.userId, "hub", hub.id, {
      method: identity.method as "google" | "feishu", connection: identity.connection,
      subject: identity.subject, tenant: identity.tenant,
    }, "member"));
    const accepted = await app.inject({ method: "POST", url: "/api/v1/invitations/accept",
      cookies: { codoxear_identity: member.credential! }, payload: { token: invitation.token } });
    assert.equal(accepted.statusCode, 200, accepted.body);
  }
  return { store, accounts, tokens, authority, app, setup, hub, feishu, google, signIn, join,
    async close() { await app.close(); store.close(); } };
}

test("Hub provider configuration has one Feishu application and singular tenant, with extensible independent login policy", () => {
  const feishu = { kind: "feishu" as const, id: "work-feishu", ...credentials, tenant: "team-a" };
  assert.equal(HubProviders.parse([feishu])[0]!.kind, "feishu");
  assert.equal(HubProviders.safeParse([feishu, { ...feishu, id: "second-app" }]).success, false);
  assert.equal(ProviderConfig.safeParse({ ...feishu, allowedTenants: ["team-a", "team-b"] }).success, false);
  assert.equal(HubProviders.safeParse([feishu, { kind: "google", id: "work-feishu", ...credentials }]).success, false);
  assert.equal(HubProviders.safeParse([feishu, { kind: "google", id: "google", ...credentials }]).success, true);
});

test("configured Feishu tenant rejects foreign callbacks before recording an account or consuming initialization", async () => {
  const f = await fixture("team-a");
  try {
    const options = (await f.app.inject({ method: "GET", url: "/api/v1/auth/options" })).json();
    assert.deepEqual(options.organization, { feishuTenant: "team-a", tenantBindingRequired: false });
    assert.equal(options.setupRequired, true); assert.equal(Object.hasOwn(options, "deviceKeys"), false);
    const foreign = await f.signIn("feishu", "foreign", "team-b", true);
    assert.equal(foreign.callback.statusCode, 403); assert.equal(foreign.callback.json().code, "wrong_organization");
    assert.equal(f.store.read().users.length, 1); assert.equal(f.store.read().identity.initializations[0]!.consumedAt, null);
    const member = await f.signIn("feishu", "member", "team-a");
    assert.equal(member.callback.statusCode, 302); assert.deepEqual(f.store.read().memberships, []);
    assert.equal(f.store.read().hubs[0]!.ownerId, f.hub.ownerId);
  } finally { await f.close(); }
});

test("Google may initialize a Hub with Feishu configured without granting any subsequent visitor membership", async () => {
  const f = await fixture();
  try {
    const owner = await f.signIn("google", "owner", null, true);
    assert.equal(owner.callback.statusCode, 302); assert.equal(f.store.read().hubs[0]!.ownerId, owner.session!.userId);
    assert.equal(f.store.read().identity.hubOrganizations[0]!.feishuTenant, null);
    const visitor = await f.signIn("feishu", "visitor", "team-a");
    assert.equal(visitor.callback.statusCode, 302);
    const profile = await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: visitor.credential! } });
    assert.equal(profile.json().hubRole, null); assert.deepEqual(f.authority.directory(visitor.session!), []);
    assert.equal(f.store.read().identity.hubOrganizations[0]!.feishuTenant, null);
  } finally { await f.close(); }
});

test("binding Feishu rejects already-issued foreign sessions, refreshes and cached Hub tokens", async () => {
  const f = await fixture();
  try {
    const owner = await f.signIn("google", "owner", null, true);
    const foreign = await f.signIn("feishu", "foreign", "team-b"), cached = await f.tokens.issue(foreign.session!, f.hub.id);
    const refresh = f.accounts.issueRefresh(foreign.session!.id);
    await f.join(owner.session!, foreign);
    configureHubOrganization(f.store, f.hub.id, [feishuProvider("team-a"), f.google]);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: foreign.credential! } })).statusCode, 403);
    assert.throws(() => f.accounts.rotateRefresh(refresh), /organization/);
    await assert.rejects(f.authority.principal(cached, f.hub.id), /organization/);
    assert.throws(() => configureHubOrganization(f.store, f.hub.id, [feishuProvider("team-b")]), /cannot be changed/);
  } finally { await f.close(); }
});

test("same Hub independent Google and Feishu accounts receive only their own explicitly assigned membership and Computer grants", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a", true), a = await f.signIn("google", "a", null),
      b = await f.signIn("google", "b", null), colleague = await f.signIn("feishu", "colleague", "team-a");
    assert.equal(new Set([owner.session!.userId,a.session!.userId,b.session!.userId,colleague.session!.userId]).size, 4);
    assert.deepEqual(f.authority.directory(a.session!), []); assert.deepEqual(f.authority.directory(b.session!), []);
    await f.join(owner.session!, a);
    await f.join(owner.session!, colleague);
    const computer = f.store.change(state => createComputer(state, owner.session!.userId, f.hub.id, "Work Computer", owner.session!.userId)).computer;
    assert.deepEqual(f.authority.computers(a.session!, f.hub.id), []);
    f.store.change(state => setComputerAccess(state, owner.session!.userId, computer.id, a.session!.userId, "read"));
    assert.equal(f.authority.computers(a.session!, f.hub.id).length, 1);
    assert.deepEqual(f.authority.computers(colleague.session!, f.hub.id), []);
    assert.deepEqual(f.authority.directory(b.session!), []);
    assert.throws(() => f.accounts.finish({ connection: "hub-google", method: "google", subject: "b", tenant: null,
      email: "same@example.test", name: "B" }, "linked", a.session!.id), /another account/);
  } finally { await f.close(); }
});

test("owner account-type selection is configured, persistent, and cannot remove its acting proof", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a", true), member = await f.signIn("google", "member", null);
    const request = (credential: string, allowedMethods: string[]) => f.app.inject({ method: "PUT",
      url: `/api/v1/hubs/${f.hub.id}/login-methods`, cookies: { codoxear_identity: credential }, payload: { allowedMethods } });
    assert.equal((await request(member.credential!, ["feishu"])).statusCode, 403);
    assert.equal((await request(owner.credential!, [])).statusCode, 400);
    assert.equal((await request(owner.credential!, ["feishu","feishu"])).statusCode, 400);
    assert.equal((await request(owner.credential!, ["feishu","unconfigured"])).statusCode, 400);
    assert.equal((await request(owner.credential!, ["google"])).statusCode, 409);
    const selected = await request(owner.credential!, ["feishu"]); assert.equal(selected.statusCode, 200);
    assert.deepEqual(selected.json(), { availableMethods: ["feishu","google"], allowedMethods: ["feishu"] });
    configureHubOrganization(f.store, f.hub.id, [f.feishu, f.google]);
    assert.deepEqual(f.store.read().identity.hubOrganizations[0]!.allowedMethods, ["feishu"]);
    assert.equal((await f.app.inject({ method: "GET", url: "/auth/hub-google/start" })).statusCode, 403);
  } finally { await f.close(); }
});

test("account-type policy rejects existing cookies, refreshes and tokens and preserves their independent grants if reallowed", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a", true), google = await f.signIn("google", "google-member", null);
    await f.join(owner.session!, google);
    const cached = await f.tokens.issue(google.session!, f.hub.id), refresh = f.accounts.issueRefresh(google.session!.id);
    const select = (allowedMethods: string[]) => f.app.inject({ method: "PUT", url: `/api/v1/hubs/${f.hub.id}/login-methods`,
      cookies: { codoxear_identity: owner.credential! }, payload: { allowedMethods } });
    assert.equal((await select(["feishu"])).statusCode, 200);
    const denied = await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: google.credential! } });
    assert.equal(denied.statusCode, 403); assert.equal(denied.json().code, "login_method_not_allowed");
    assert.throws(() => f.accounts.rotateRefresh(refresh), /account type/);
    await assert.rejects(f.authority.principal(cached, f.hub.id), /account type/);
    assert.equal((await select(["feishu","google"])).statusCode, 200);
    assert.equal((await f.app.inject({ method: "GET", url: "/api/v1/me", cookies: { codoxear_identity: google.credential! } })).statusCode, 200);
    assert.equal(f.authority.directory(google.session!).length, 1);
  } finally { await f.close(); }
});

test("owner selects Google only after explicit proof linking and disabled Feishu sessions cannot act", async () => {
  const f = await fixture("team-a");
  try {
    const owner = await f.signIn("feishu", "owner", "team-a", true);
    const linked = f.accounts.finish({ method:"google",connection:"hub-google",subject:"owner-google",tenant:null,email:"owner@example.test",name:"Owner" },"google-owner",owner.session!.id);
    const selected = await f.app.inject({ method:"PUT",url:`/api/v1/hubs/${f.hub.id}/login-methods`,cookies:{codoxear_identity:linked.credential},payload:{allowedMethods:["google"]} });
    assert.equal(selected.statusCode,200);assert.deepEqual(selected.json().allowedMethods,["google"]);
    assert.equal((await f.app.inject({method:"GET",url:"/api/v1/me",cookies:{codoxear_identity:owner.credential!}})).statusCode,403);
    assert.equal((await f.app.inject({method:"GET",url:"/api/v1/me",cookies:{codoxear_identity:linked.credential}})).json().hubRole,"owner");
  } finally { await f.close(); }
});

test("generic identity authority retains separate immutable provider/tenant identities without independent-Hub policy", () => {
  const store = new Store(":memory:"), accounts = new Accounts(store,"compatibility-tests".repeat(4),{async send(){}});
  try {
    const common={connection:"enterprise",method:"feishu" as const,subject:"same-open-id",email:null,name:"Person"};
    const a=accounts.finish({...common,tenant:"team-a"},"a"),b=accounts.finish({...common,tenant:"team-b"},"b");
    assert.notEqual(a.session.userId,b.session.userId);assert.equal(accounts.finish({...common,tenant:"team-a"},"returning").session.userId,a.session.userId);
  } finally { store.close(); }
});
