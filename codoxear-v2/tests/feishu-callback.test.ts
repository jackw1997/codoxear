import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import { provider } from "../src/auth/providers.js";
import { createIdentityApp } from "../src/auth/app.js";
import { initializeHub, hubSetup } from "../src/auth/hub-setup.js";

assert.ok(existsSync("/.dockerenv"), "Run in Docker");

test("real Feishu adapter callback accepts no-code token success, preserves OAuth continuation and initializes only through the private browser-bound link", async () => {
  const origin = "https://callback-hub.test", cookieName = "codoxear_identity_callback-hub";
  const token = "private-initial-owner-link-".repeat(3), store = new Store(":memory:");
  const hub = store.change((state) => initializeHub(state, "callback-hub", "New Hub"));
  const accounts = new Accounts(store, "callback-tests-secret-".repeat(4), { async send() {} });
  const authority = new Authority(store, accounts, new Tokens(origin, await signingKey()));
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let expectedPkceChallenge = "";
  const transport: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    assert.equal(init.redirect, "error");
    if (String(input) === "https://open.feishu.cn/open-apis/authen/v2/oauth/token") {
      assert.equal(init.method, "POST");
      assert.equal(new Headers(init.headers).get("content-type"), "application/json; charset=utf-8");
      const body = JSON.parse(String(init.body));
      assert.equal(body.grant_type, "authorization_code");
      assert.equal(body.client_id, "fixture-app");
      assert.equal(body.client_secret, "fixture-private-app-secret");
      assert.ok(["normal-provider-code", "initial-owner-provider-code"].includes(body.code));
      assert.equal(body.redirect_uri, origin + "/auth/work-feishu/callback");
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), expectedPkceChallenge);
      return Response.json({ access_token: "fixture-user-token", token_type: "Bearer", expires_in: 7200 });
    }
    assert.equal(String(input), "https://open.feishu.cn/open-apis/authen/v1/user_info");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-user-token");
    return Response.json({ code: 0, data: { open_id: "verified-app-open-id", tenant_key: "verified-team", name: "Owner" } });
  };
  const app = await createIdentityApp({ authority, localHubId: hub.id, cookieName, loginPath: "/login",
    setup: hubSetup(store, hub.id, { token, expiresAt: Date.now() + 86400000 }), secureCookies: false,
    providers: [provider({ kind: "feishu", id: "work-feishu", clientId: "fixture-app", clientSecret: "fixture-private-app-secret" }, { fetch: transport })],
    clients: [{ id: "fixture-client", redirectUris: ["https://client.test/auth-callback"] }],
  });
  try {
    const continuation = "/oauth/authorize?" + new URLSearchParams({ client_id: "fixture-client", redirect_uri: "https://client.test/auth-callback",
      response_type: "code", state: "browser-client-state-123456789", code_challenge_method: "S256",
      code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url") });
    const options = await app.inject({ method: "GET", url: "/api/v1/auth/options" });
    assert.equal(options.body.includes(token), false);
    assert.equal(Object.hasOwn(options.json(), "deviceKeys"), false);
    const startUrl = "/auth/work-feishu/start?" + new URLSearchParams({ continue: continuation });
    const normalStart = await app.inject({ method: "GET", url: startUrl });
    const normalAuthorize = new URL(normalStart.headers.location!), normalCookie = normalStart.cookies.find(cookie => cookie.name === cookieName + "_oauth")!;
    expectedPkceChallenge = normalAuthorize.searchParams.get("code_challenge")!;
    const normalCallback = await app.inject({ method: "GET", url: "/auth/work-feishu/callback?" + new URLSearchParams({
      state: normalAuthorize.searchParams.get("state")!, code: "normal-provider-code" }), cookies: { [normalCookie.name]: normalCookie.value } });
    assert.equal(normalCallback.statusCode, 302, normalCallback.body);
    assert.equal(normalCallback.headers.location, continuation);
    const normalCredential = normalCallback.cookies.find(cookie => cookie.name === cookieName)!.value;
    const normalProfile = await app.inject({ method: "GET", url: "/api/v1/me", cookies: { [cookieName]: normalCredential } });
    assert.equal(normalProfile.json().hubRole, null);
    assert.equal(store.read().hubs[0]!.ownerId, hub.ownerId);
    assert.deepEqual(store.read().memberships, []);
    const initialize = await app.inject({ method: "GET", url: "/initialize?" + new URLSearchParams({ token, continue: continuation }) });
    assert.equal(initialize.statusCode, 302, initialize.body);
    assert.equal(new URL(initialize.headers.location!, origin).searchParams.get("continue"), continuation);
    assert.equal(initialize.headers.location!.includes(token), false);
    const initializeCookie = initialize.cookies.find(cookie => cookie.name === cookieName + "_initialize")!;
    assert.equal(initializeCookie.httpOnly, true); assert.equal(initializeCookie.path, "/auth/");
    const start = await app.inject({ method: "GET", url: startUrl, cookies: { [initializeCookie.name]: initializeCookie.value } });
    assert.equal(start.statusCode, 302);
    const authorize = new URL(start.headers.location!), flowCookie = start.cookies.find(cookie => cookie.name === cookieName + "_oauth")!;
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    expectedPkceChallenge = authorize.searchParams.get("code_challenge")!;
    const callbackUrl = "/auth/work-feishu/callback?" + new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "initial-owner-provider-code" });
    assert.equal((await app.inject({ method: "GET", url: callbackUrl, cookies: { [initializeCookie.name]: initializeCookie.value } })).statusCode, 401);
    const callback = await app.inject({ method: "GET", url: callbackUrl, cookies: { [flowCookie.name]: flowCookie.value } });
    assert.equal(callback.statusCode, 302, callback.body); assert.equal(callback.headers.location, continuation);
    const credential = callback.cookies.find(cookie => cookie.name === cookieName)!.value, session = accounts.session(credential);
    assert.equal(session.userId, accounts.session(normalCredential).userId);
    assert.equal(session.context.method, "feishu"); assert.equal(session.context.tenant, "verified-team");
    assert.equal(store.read().hubs[0]!.ownerId, session.userId);
    assert.equal(store.read().identity.hubOrganizations[0]!.feishuTenant, "verified-team");
    assert.equal(store.read().identity.initializations[0]!.consumedAt !== null, true);
    const profile = await app.inject({ method: "GET", url: "/api/v1/me", cookies: { [cookieName]: credential } });
    assert.equal(profile.json().hubRole, "owner");
    const continued = await app.inject({ method: "GET", url: continuation, cookies: { [cookieName]: credential } });
    assert.equal(continued.statusCode, 302, continued.body);
    const returned = new URL(continued.headers.location!);
    assert.equal(returned.origin + returned.pathname, "https://client.test/auth-callback");
    assert.equal(returned.searchParams.get("state"), "browser-client-state-123456789"); assert.ok(returned.searchParams.get("code"));
    assert.equal((await app.inject({ method: "GET", url: callbackUrl, cookies: { [flowCookie.name]: flowCookie.value } })).statusCode, 401);
    assert.equal((await app.inject({ method: "GET", url: "/initialize?" + new URLSearchParams({ token }) })).statusCode, 403);
    assert.equal(calls.length, 4, "Invalid browser callbacks and initialization replay do not retry provider codes");
    for (const path of ["/api/v1/auth/setup", "/api/v1/auth/keys/challenge", "/api/v1/auth/keys/verify"])
      assert.equal((await app.inject({ method: "POST", url: path, payload: {} })).statusCode, 404);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/me/keys" })).statusCode, 404);
  } finally { await app.close(); store.close(); }
});
