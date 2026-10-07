import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { DomainError } from "../src/contracts/model.js";
import { provider, ProviderConfig } from "../src/auth/providers.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const verifier = "provider-verifier-".repeat(4);
const nonce = createHash("sha256")
  .update("google-nonce:" + verifier)
  .digest("base64url");
const callback = "https://hub.example.test/auth/google-main/callback";
const rejected = (error: unknown) => {
  assert.ok(error instanceof DomainError);
  assert.equal(error.status, 401);
  assert.equal(error.code, "provider_rejected");
  assert.equal(error.message, "Provider authorization was rejected");
  assert.equal(error.cause, undefined);
  return true;
};

test("only configured Google/Feishu connections with valid IDs and credentials are accepted", () => {
  const base = {
    id: "google-main",
    clientId: "google-client",
    clientSecret: "secret",
  };
  for (const kind of ["google", "feishu"])
    assert.ok(ProviderConfig.safeParse({ ...base, kind }).success);
  for (const kind of ["wechat", "oidc", "password"])
    assert.equal(ProviderConfig.safeParse({ ...base, kind }).success, false);
  for (const bad of ["", "contains/slash", "contains space"])
    assert.equal(
      ProviderConfig.safeParse({ ...base, kind: "google", id: bad }).success,
      false,
    );
  assert.equal(
    ProviderConfig.safeParse({ ...base, kind: "google", clientId: " " })
      .success,
    false,
  );
  assert.equal(
    ProviderConfig.safeParse({ ...base, kind: "feishu", clientSecret: "" })
      .success,
    false,
  );
});

async function googleFixture(
  claims: Record<string, unknown> = {},
  forged = false,
) {
  const trusted = await generateKeyPair("RS256", { extractable: true });
  const signer = forged ? await generateKeyPair("RS256") : trusted;
  const key = {
    ...(await exportJWK(trusted.publicKey)),
    kid: "google-key",
    use: "sig",
    alg: "RS256",
  };
  const signed = await new SignJWT({
    nonce,
    name: "Google Person",
    email: "same@example.test",
    email_verified: true,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "google-key" })
    .setIssuer(
      typeof claims.iss === "string"
        ? claims.iss
        : "https://accounts.google.com",
    )
    .setAudience(typeof claims.aud === "string" ? claims.aud : "google-client")
    .setSubject(
      typeof claims.sub === "string" ? claims.sub : "stable-google-subject",
    )
    .setIssuedAt()
    .setExpirationTime(typeof claims.exp === "number" ? claims.exp : "5m")
    .sign(signer.privateKey);
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: typeof fetch = async (input, init = {}) => {
    const url = String(input);
    calls.push({ url, init });
    assert.equal(init.redirect, "error");
    assert.ok(init.signal instanceof AbortSignal);
    if (url === "https://accounts.google.com/.well-known/openid-configuration")
      return Response.json({
        issuer: "https://accounts.google.com",
        authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth",
        token_endpoint: "https://oauth2.googleapis.com/token",
        jwks_uri: "https://www.googleapis.com/oauth2/v3/certs",
        id_token_signing_alg_values_supported: ["RS256"],
        authorization_response_iss_parameter_supported: true,
      });
    if (url === "https://oauth2.googleapis.com/token")
      return Response.json({
        access_token: "google-access-token",
        token_type: "Bearer",
        id_token: signed,
      });
    if (url === "https://www.googleapis.com/oauth2/v3/certs")
      return Response.json({ keys: [key] });
    assert.fail("Unexpected provider request: " + url);
  };
  return {
    calls,
    adapter: provider(
      {
        kind: "google",
        id: "google-main",
        clientId: "google-client",
        clientSecret: "server-google-secret",
      },
      { fetch: transport },
    ),
  };
}

test("Google uses discovery, state, nonce, PKCE and validates signed identity", async () => {
  const f = await googleFixture();
  const url = new URL(
    await f.adapter.authorize("browser-bound-state", verifier, callback),
  );
  assert.equal(
    url.origin + url.pathname,
    "https://accounts.google.com/o/oauth2/v2/auth",
  );
  assert.equal(url.searchParams.get("state"), "browser-bound-state");
  assert.equal(url.searchParams.get("nonce"), nonce);
  assert.notEqual(url.searchParams.get("nonce"), verifier);
  assert.equal(url.searchParams.get("redirect_uri"), callback);
  assert.equal(url.searchParams.get("scope"), "openid profile email");
  assert.equal(url.searchParams.get("prompt"), "select_account");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
  assert.equal(url.searchParams.has("client_secret"), false);
  const identity = await f.adapter.exchange(
    "google-code",
    verifier,
    callback,
    "https://accounts.google.com",
  );
  assert.deepEqual(identity, {
    connection: "google-main",
    method: "google",
    subject: "stable-google-subject",
    tenant: null,
    email: "same@example.test",
    name: "Google Person",
  });
  const request = f.calls.find(
    (x) => x.url === "https://oauth2.googleapis.com/token",
  )!;
  const body = new URLSearchParams(String(request.init.body));
  assert.equal(body.get("client_secret"), "server-google-secret");
  assert.equal(body.get("client_id"), "google-client");
  assert.equal(body.get("code"), "google-code");
  assert.equal(body.get("redirect_uri"), callback);
  assert.equal(body.get("code_verifier"), verifier);
  assert.ok(
    f.calls.some((x) => x.url === "https://www.googleapis.com/oauth2/v3/certs"),
  );
  assert.equal(
    f.calls.filter((x) => x.url.endsWith("openid-configuration")).length,
    1,
  );
});

test("Google rejects forged signature, issuer, audience, nonce and expired tokens", async () => {
  for (const [claims, forged] of [
    [{}, true],
    [{ iss: "https://attacker.example.test" }, false],
    [{ aud: "another-client" }, false],
    [{ nonce: "other-browser" }, false],
    [{ exp: Math.floor(Date.now() / 1000) - 120 }, false],
    [{ sub: "" }, false],
  ] as Array<[Record<string, unknown>, boolean]>) {
    const f = await googleFixture(claims, forged);
    await assert.rejects(
      f.adapter.exchange(
        "code",
        verifier,
        callback,
        "https://accounts.google.com",
      ),
      rejected,
    );
  }
});

test("Google callback issuer must match discovery and be present", async () => {
  for (const issuer of [undefined, "https://attacker.example.test"]) {
    const f = await googleFixture();
    await assert.rejects(
      f.adapter.exchange("code", verifier, callback, issuer),
      rejected,
    );
    assert.equal(
      f.calls.some(
        (call) => call.url === "https://oauth2.googleapis.com/token",
      ),
      false,
    );
  }
});

test("Google unverified email does not become identity and provider diagnostics stay private", async () => {
  const f = await googleFixture({ email_verified: false });
  const identity = await f.adapter.exchange(
    "code",
    verifier,
    callback,
    "https://accounts.google.com",
  );
  assert.equal(identity.email, null);
  assert.equal(identity.subject, "stable-google-subject");
  const adapter = provider(
    {
      kind: "google",
      id: "google-main",
      clientId: "client",
      clientSecret: "private",
    },
    {
      fetch: async () => {
        throw new Error("client_secret=private&code=private-code");
      },
    },
  );
  await assert.rejects(
    adapter.authorize("state", verifier, callback),
    rejected,
  );
  await assert.rejects(adapter.exchange("code", verifier, callback), rejected);
});

function feishuFixture(
  token: unknown = { code: 0, access_token: "feishu-access" },
  info: unknown = {
    code: 0,
    data: {
      open_id: "app-open-id",
      tenant_key: "tenant-key",
      name: "Feishu Person",
      email: "same@example.test",
    },
  },
  connection: { id?: string; name?: string; tenant?: string } = {},
) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const transport: typeof fetch = async (input, init = {}) => {
    calls.push({ url: String(input), init });
    assert.equal(init.redirect, "error");
    if (String(input) === "https://accounts.feishu.cn/oauth/v3/token")
      return Response.json(token);
    if (
      String(input) === "https://open.feishu.cn/open-apis/authen/v1/user_info"
    )
      return Response.json(info);
    assert.fail("Unexpected provider request");
  };
  return {
    calls,
    adapter: provider(
      {
        kind: "feishu",
        id: "feishu-main",
        clientId: "feishu-client",
        clientSecret: "server-feishu-secret",
        ...connection,
      },
      { fetch: transport },
    ),
  };
}

test("Feishu organization connections expose labels and reject another tenant", async () => {
  const team = feishuFixture(undefined, undefined, { id: "feishu-team-a", name: "Team A", tenant: "tenant-key" });
  assert.equal(team.adapter.name, "Team A");
  assert.equal((await team.adapter.exchange("code", verifier, callback)).connection, "feishu-team-a");
  const other = feishuFixture(undefined, undefined, { id: "feishu-team-b", name: "Team B", tenant: "another-tenant" });
  await assert.rejects(other.adapter.exchange("code", verifier, callback), rejected);
});

test("Feishu v3 exchanges PKCE and binds app connection, tenant and open_id without email", async () => {
  const f = feishuFixture(),
    redirect = "https://hub.example.test/auth/feishu-main/callback";
  const url = new URL(
    await f.adapter.authorize("browser-bound-state", verifier, redirect),
  );
  assert.equal(
    url.origin + url.pathname,
    "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
  );
  assert.equal(url.searchParams.get("state"), "browser-bound-state");
  assert.equal(url.searchParams.get("code_challenge_method"), "S256");
  assert.equal(
    url.searchParams.get("code_challenge"),
    createHash("sha256").update(verifier).digest("base64url"),
  );
  assert.equal(url.searchParams.get("redirect_uri"), redirect);
  assert.equal(url.searchParams.has("client_secret"), false);
  assert.deepEqual(
    await f.adapter.exchange("feishu-code", verifier, redirect),
    {
      connection: "feishu-main",
      method: "feishu",
      subject: "app-open-id",
      tenant: "tenant-key",
      email: null,
      name: "Feishu Person",
    },
  );
  const body = new URLSearchParams(String(f.calls[0]!.init.body));
  assert.equal(body.get("client_id"), "feishu-client");
  assert.equal(body.get("client_secret"), "server-feishu-secret");
  assert.equal(body.get("code_verifier"), verifier);
  assert.equal(body.get("redirect_uri"), redirect);
  assert.equal(body.get("code"), "feishu-code");
  assert.equal(
    new Headers(f.calls[0]!.init.headers).get("content-type"),
    "application/x-www-form-urlencoded",
  );
  assert.equal(
    new Headers(f.calls[1]!.init.headers).get("authorization"),
    "Bearer feishu-access",
  );
});

test("Feishu rejects provider errors, absent token, missing tenant and invalid identities", async () => {
  for (const token of [
    { code: 20002, error_description: "private secret" },
    { access_token: "token" },
    { code: 0, access_token: "" },
  ]) {
    const f = feishuFixture(token);
    await assert.rejects(
      f.adapter.exchange(
        "code",
        verifier,
        callback,
        "https://accounts.google.com",
      ),
      rejected,
    );
    assert.equal(f.calls.length, 1);
  }
  for (const info of [
    { code: 20021, msg: "private provider details" },
    { code: 0, data: { open_id: "id" } },
    { code: 0, data: { open_id: "", tenant_key: "tenant" } },
  ]) {
    await assert.rejects(
      feishuFixture(undefined, info).adapter.exchange(
        "code",
        verifier,
        callback,
      ),
      rejected,
    );
  }
  for (const response of [
    new Response("private", { status: 302 }),
    new Response("not JSON", { status: 200 }),
  ]) {
    const adapter = provider(
      {
        kind: "feishu",
        id: "feishu-main",
        clientId: "client",
        clientSecret: "secret",
      },
      { fetch: async () => response },
    );
    await assert.rejects(
      adapter.exchange("code", verifier, callback),
      rejected,
    );
  }
});
