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

test("Feishu's no-code token response completes the real adapter callback and preserves private Hub setup continuation", async () => {
  const origin = "https://callback-hub.test", cookieName = "codoxear_identity_callback-hub";
  const setupCode = "private-initial-owner-code-".repeat(3), store = new Store(":memory:");
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
      assert.equal(body.code, "fresh-provider-code");
      assert.equal(body.redirect_uri, origin + "/auth/work-feishu/callback");
      assert.ok(typeof body.code_verifier === "string" && body.code_verifier.length >= 43);
      assert.equal(createHash("sha256").update(body.code_verifier).digest("base64url"), expectedPkceChallenge);
      return Response.json({ access_token: "fixture-user-token", token_type: "Bearer", expires_in: 7200 });
    }
    assert.equal(String(input), "https://open.feishu.cn/open-apis/authen/v1/user_info");
    assert.equal(new Headers(init.headers).get("authorization"), "Bearer fixture-user-token");
    return Response.json({ code: 0, data: { open_id: "verified-app-open-id", tenant_key: "verified-team", name: "Owner" } });
  };
  const app = await createIdentityApp({ authority, localHubId: hub.id, cookieName, loginPath: "/login",
    setup: hubSetup(store, hub.id, setupCode), secureCookies: false,
    providers: [provider({ kind: "feishu", id: "work-feishu", clientId: "fixture-app", clientSecret: "fixture-private-app-secret" }, { fetch: transport })],
    clients: [{ id: "fixture-client", redirectUris: ["https://client.test/auth-callback"] }],
  });
  try {
    const continuation = "/oauth/authorize?" + new URLSearchParams({ client_id: "fixture-client", redirect_uri: "https://client.test/auth-callback",
      response_type: "code", state: "browser-client-state-123456789", code_challenge_method: "S256",
      code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url") });
    const start = await app.inject({ method: "GET", url: "/auth/work-feishu/start?" + new URLSearchParams({ continue: continuation }) });
    assert.equal(start.statusCode, 302);
    const authorize = new URL(start.headers.location!), flowCookie = start.cookies.find((cookie) => cookie.name === cookieName + "_oauth")!;
    assert.equal(authorize.searchParams.get("code_challenge_method"), "S256");
    expectedPkceChallenge = authorize.searchParams.get("code_challenge")!;
    const callbackUrl = "/auth/work-feishu/callback?" + new URLSearchParams({ state: authorize.searchParams.get("state")!, code: "fresh-provider-code" });
    const callback = await app.inject({ method: "GET", url: callbackUrl, cookies: { [flowCookie.name]: flowCookie.value } });
    assert.equal(callback.statusCode, 302, callback.body);
    assert.equal(callback.headers.location, "/login?continue=" + encodeURIComponent(continuation));
    const credential = callback.cookies.find((cookie) => cookie.name === cookieName)!.value, session = accounts.session(credential);
    assert.equal(session.context.method, "feishu");
    assert.equal(session.context.tenant, "verified-team");
    const identity = store.read().identity.identities.find((identity) => identity.id === session.context.identityId)!;
    assert.equal(identity.subject, "verified-app-open-id");
    assert.equal(identity.connection, "work-feishu");
    assert.equal(identity.email, null);
    assert.equal(store.read().hubs[0]!.ownerId, hub.ownerId);
    assert.deepEqual(store.read().memberships, []);
    assert.equal(store.read().identity.hubOrganizations[0]!.feishuTenant, null);
    assert.equal((await app.inject({ method: "GET", url: "/api/v1/me", cookies: { [cookieName]: credential } })).statusCode, 200);
    const claimed = await app.inject({ method: "POST", url: "/api/v1/auth/setup", cookies: { [cookieName]: credential }, payload: { token: setupCode } });
    assert.equal(claimed.statusCode, 200, claimed.body);
    assert.equal(store.read().hubs[0]!.ownerId, session.userId);
    assert.equal(store.read().identity.hubOrganizations[0]!.feishuTenant, "verified-team");
    const continued = await app.inject({ method: "GET", url: continuation, cookies: { [cookieName]: credential } });
    assert.equal(continued.statusCode, 302, continued.body);
    const returned = new URL(continued.headers.location!);
    assert.equal(returned.origin + returned.pathname, "https://client.test/auth-callback");
    assert.equal(returned.searchParams.get("state"), "browser-client-state-123456789");
    assert.ok(returned.searchParams.get("code"));
    const tokenBody = JSON.parse(String(calls[0]!.init.body));
    assert.equal(createHash("sha256").update(tokenBody.code_verifier).digest("base64url"), authorize.searchParams.get("code_challenge"));
    assert.equal((await app.inject({ method: "GET", url: callbackUrl, cookies: { [flowCookie.name]: flowCookie.value } })).statusCode, 401);
    assert.equal(calls.length, 2, "Replayed browser callbacks never retry the single-use provider code");
  } finally { await app.close(); store.close(); }
});
