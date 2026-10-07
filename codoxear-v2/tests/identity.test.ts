import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { Accounts, type VerifiedIdentity } from "../src/identity/accounts.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { Authority } from "../src/identity/authority.js";
import { createIdentityApp } from "../src/identity/app.js";
import { createHubApp } from "../src/hub/app.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import {
  createHub,
  createComputer,
  passwordHash,
  invite,
  acceptInvite,
  removeMember,
  setPolicy,
} from "../src/domain/commands.js";
import { createHash } from "node:crypto";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
function fixture() {
  const store = new Store(":memory:");
  let now = Date.now();
  const delivered: Array<{ method: string; target: string; code: string }> = [];
  const accounts = new Accounts(
    store,
    "test-otp-secret-".repeat(4),
    {
      async send(method, target, code) {
        delivered.push({ method, target, code });
      },
    },
    () => now,
  );
  store.change((s) =>
    s.users.push({
      id: "alice",
      email: "alice@example.test",
      name: "Alice",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    }),
  );
  return { store, accounts, delivered, advance: (ms: number) => (now += ms) };
}
// Controlled provider fixture for HTTP session tests; production uses verified adapters.
function fixtureGoogle(store: Store, users = ["alice"]) {
  store.change((state) => {
    for (const userId of users)
      state.identity.identities.push({
        id: "google-" + userId,
        userId,
        connection: "test-google",
        method: "google",
        subject: userId,
        tenant: null,
        email: null,
        verifiedAt: Date.now(),
      });
  });
  return {
    id: "test-google",
    method: "google" as const,
    async authorize(state: string, _verifier: string, redirectUri: string) {
      const url = new URL("https://provider.example.test/authorize");
      url.search = new URLSearchParams({
        state,
        redirect_uri: redirectUri,
      }).toString();
      return url.href;
    },
    async exchange(code: string) {
      assert.ok(users.includes(code), "Unknown controlled provider user");
      return {
        connection: "test-google",
        method: "google" as const,
        subject: code,
        tenant: null,
        email: null,
        name: code,
      };
    },
  };
}
async function providerCookie(
  app: Awaited<ReturnType<typeof createIdentityApp>>,
  userId: string,
) {
  const start = await app.inject({ url: "/auth/test-google/start" });
  assert.equal(start.statusCode, 302);
  const state = new URL(start.headers.location!).searchParams.get("state")!;
  const browser = start.cookies.find(
    (cookie) => cookie.name === "codoxear_identity_oauth",
  )!;
  const callback = await app.inject({
    url:
      "/auth/test-google/callback?" +
      new URLSearchParams({ state, code: userId }),
    cookies: { [browser.name]: browser.value },
  });
  assert.equal(callback.statusCode, 302);
  return callback.cookies.find((cookie) => cookie.name === "codoxear_identity")!
    .value;
}
test("single-use OTP is transaction bound, attempt limited and expires", async () => {
  const f = fixture();
  try {
    const c = await f.accounts.challenge("email", "first@example.test");
    assert.throws(() =>
      f.accounts.verifyChallenge(
        c.challengeId,
        "wrong",
        f.delivered[0]!.code,
        "phone",
      ),
    );
    const signed = f.accounts.verifyChallenge(
      c.challengeId,
      c.transaction,
      f.delivered[0]!.code,
      "phone",
    );
    assert.equal(signed.session.context.method, "email");
    assert.throws(() =>
      f.accounts.verifyChallenge(
        c.challengeId,
        c.transaction,
        f.delivered[0]!.code,
        "phone",
      ),
    );
    const failed = await f.accounts.challenge("phone", "+8613800000000");
    const wrong = f.delivered[1]!.code === "000000" ? "111111" : "000000";
    for (let i = 0; i < 5; i++)
      assert.throws(() =>
        f.accounts.verifyChallenge(
          failed.challengeId,
          failed.transaction,
          wrong,
          "phone",
        ),
      );
    assert.throws(() =>
      f.accounts.verifyChallenge(
        failed.challengeId,
        failed.transaction,
        f.delivered[1]!.code,
        "phone",
      ),
    );
    const expired = await f.accounts.challenge("email", "expiry@example.test");
    f.advance(300001);
    assert.throws(() =>
      f.accounts.verifyChallenge(
        expired.challengeId,
        expired.transaction,
        f.delivered[2]!.code,
        "phone",
      ),
    );
  } finally {
    f.store.close();
  }
});
test("queue permits only authorize their current actor, session, agent and computer binding", async () => {
  const f = fixture();
  try {
    f.store.change((s) =>
      s.users.push({
        id: "bob",
        email: "bob@example.test",
        name: "Bob",
        passwordHash: passwordHash("test-password"),
        disabled: false,
      }),
    );
    const a = new Authority(
        f.store,
        f.accounts,
        new Tokens("https://identity.test", await signingKey()),
      ),
      alice = f.accounts.password(
        "alice@example.test",
        "test-password",
        "web",
      ).session,
      bob = f.accounts.password(
        "bob@example.test",
        "test-password",
        "native",
      ).session,
      hub = f.store.change((s) => createHub(s, "alice", "Hub")),
      c = f.store.change((s) =>
        createComputer(s, "alice", hub.id, "Computer", "alice"),
      );
    f.store.change((s) => {
      acceptInvite(
        s,
        "bob",
        invite(s, "alice", "hub", hub.id, "bob@example.test", "operator").token,
      );
      acceptInvite(
        s,
        "bob",
        invite(
          s,
          "alice",
          "computer",
          c.computer.id,
          "bob@example.test",
          "operator",
        ).token,
      );
    });
    const published = a.importAgent(
      alice,
      hub.id,
      c.computer.id,
      "local",
      "Local",
      "pi",
    );
    assert.equal(
      a.notificationTarget(hub.id, c.computer.id, c.credential, "local")
        .agentId,
      published.id,
    );
    assert.equal(
      a.notificationTarget(hub.id, c.computer.id, c.credential, "unpublished")
        .agentId,
      null,
    );
    assert.throws(() =>
      a.notificationTarget(hub.id, c.computer.id, "old-credential", "local"),
    );
    assert.equal(
      a.authorizeNotification(
        hub.id,
        bob.id,
        published.id,
        c.computer.id,
        c.computer.binding,
      ).ok,
      true,
    );
    assert.throws(() =>
      a.authorizeNotification(
        hub.id,
        bob.id,
        published.id,
        c.computer.id,
        c.computer.binding + 1,
      ),
    );
    const permit = a.queuePermit(
      bob,
      hub.id,
      c.computer.id,
      "/api/sessions/local/enqueue",
    ).queuePermit;
    assert.equal(
      a.authorizeQueue(hub.id, c.computer.id, c.credential, permit, "local")
        .actorId,
      "bob",
    );
    await assert.rejects(a.principal(permit, hub.id), /Token/);
    assert.throws(() =>
      a.authorizeQueue(hub.id, c.computer.id, c.credential, permit, "another"),
    );
    assert.throws(() =>
      a.queuePermit(bob, hub.id, c.computer.id, "/api/sessions/local/send"),
    );
    f.store.change((s) => {
      setPolicy(s, "alice", "hub", hub.id, "read_only");
      removeMember(s, "alice", "computer", c.computer.id, "bob");
    });
    assert.throws(() =>
      a.authorizeQueue(hub.id, c.computer.id, c.credential, permit, "local"),
    );
    assert.equal(
      a.authorizeNotification(
        hub.id,
        bob.id,
        published.id,
        c.computer.id,
        c.computer.binding,
      ).ok,
      true,
    );
    f.store.change((s) => setPolicy(s, "alice", "hub", hub.id, "none"));
    assert.throws(() =>
      a.authorizeNotification(
        hub.id,
        bob.id,
        published.id,
        c.computer.id,
        c.computer.binding,
      ),
    );
    const own = a.queuePermit(
      alice,
      hub.id,
      c.computer.id,
      "/api/sessions/local/enqueue",
    ).queuePermit;
    f.store.change((s) => {
      s.identity.sessions.find((x) => x.id === alice.id)!.revoked = true;
    });
    assert.throws(() =>
      a.authorizeNotification(
        hub.id,
        alice.id,
        published.id,
        c.computer.id,
        c.computer.binding,
      ),
    );
    assert.throws(() =>
      a.authorizeQueue(hub.id, c.computer.id, c.credential, own, "local"),
    );
  } finally {
    f.store.close();
  }
});
test("matching email does not merge accounts; explicit linking requires fresh proof and uniqueness", async () => {
  const f = fixture();
  try {
    const login = f.accounts.password(
      "alice@example.test",
      "test-password",
      "web",
    );
    const identity: VerifiedIdentity = {
      connection: "work",
      method: "feishu",
      subject: "subject",
      tenant: "t",
      email: "alice@example.test",
      name: "Alice via provider",
    };
    const separate = f.accounts.finish(identity, "native");
    assert.notEqual(separate.session.userId, "alice");
    assert.throws(() => f.accounts.finish(identity, "web", login.session.id));
    const code = await f.accounts.challenge(
      "email",
      "linked@example.test",
      login.credential,
    );
    const linked = f.accounts.verifyChallenge(
      code.challengeId,
      code.transaction,
      f.delivered[0]!.code,
      "web",
    );
    assert.equal(linked.session.userId, "alice");
    f.advance(300001);
    assert.throws(() =>
      f.accounts.unlink(login.credential, linked.session.context.identityId!),
    );
  } finally {
    f.store.close();
  }
});
test("refresh reuse revokes one installation; refresh preserves provider authentication age", () => {
  const f = fixture();
  try {
    const login = f.accounts.password(
        "alice@example.test",
        "test-password",
        "web",
      ),
      a = f.accounts.forkSession(login.session.id, "phone"),
      b = f.accounts.forkSession(login.session.id, "tablet"),
      refresh = f.accounts.issueRefresh(a.id);
    f.advance(1000);
    const next = f.accounts.rotateRefresh(refresh);
    assert.equal(
      next.session.context.authenticatedAt,
      login.session.context.authenticatedAt,
    );
    assert.throws(() => f.accounts.rotateRefresh(refresh));
    assert.throws(() => f.accounts.rotateRefresh(next.refreshToken));
    assert.equal(f.accounts.sessionById(b.id).installationId, "tablet");
    f.accounts.revoke(login.credential);
    assert.throws(() => f.accounts.sessionById(b.id));
  } finally {
    f.store.close();
  }
});
test("signed tokens bind issuer, type and exactly one hub audience", async () => {
  const f = fixture();
  try {
    const tokens = new Tokens("https://identity.test", await signingKey()),
      s = f.accounts.password(
        "alice@example.test",
        "test-password",
        "web",
      ).session,
      token = await tokens.issue(s, "hub-a");
    assert.equal((await tokens.verify(token, "hub-a")).userId, "alice");
    await assert.rejects(tokens.verify(token, "hub-b"));
    await assert.rejects(tokens.verify(token, "hub-a", "identity_access"));
    await assert.rejects(
      new Tokens("https://other.test", await signingKey()).verify(
        token,
        "hub-a",
      ),
    );
  } finally {
    f.store.close();
  }
});
test("login requirement challenges linked personal context and accepts only verified required organization", async () => {
  const f = fixture();
  try {
    const a = new Authority(
        f.store,
        f.accounts,
        new Tokens("https://identity.test", await signingKey()),
      ),
      personal = f.accounts.password(
        "alice@example.test",
        "test-password",
        "web",
      ),
      hub = f.store.change((s) => createHub(s, "alice", "Work"));
    f.store.change((s) =>
      s.identity.requirements.push({
        hubId: hub.id,
        rule: {
          method: "feishu",
          connection: "work",
          tenant: "approved",
          maxAgeSeconds: 3600,
        },
      }),
    );
    assert.equal(
      a.directory(personal.session)[0]!.access,
      "reauthentication_required",
    );
    const work = f.accounts.finish(
      {
        connection: "work",
        method: "feishu",
        subject: "s",
        tenant: "approved",
        email: null,
        name: "Alice",
      },
      "web",
      personal.session.id,
    );
    assert.equal(a.context(work.session, hub.id).id, hub.id);
    f.accounts.unlink(personal.credential, work.session.context.identityId!);
    assert.throws(() => f.accounts.sessionById(work.session.id));
  } finally {
    f.store.close();
  }
});
test("pairing is single-use; transfer fences old credentials and drops old grants and catalog by explicit choice", async () => {
  const f = fixture();
  try {
    const a = new Authority(
        f.store,
        f.accounts,
        new Tokens("https://identity.test", await signingKey()),
      ),
      session = f.accounts.password(
        "alice@example.test",
        "test-password",
        "web",
      ).session;
    const h1 = f.store.change((s) => createHub(s, "alice", "One")),
      h2 = f.store.change((s) => createHub(s, "alice", "Two"));
    a.registerHub(session, h1.id, "https://one.test");
    a.registerHub(session, h2.id, "https://two.test");
    const c = f.store.change((s) =>
      createComputer(s, "alice", h1.id, "Computer", "alice"),
    ).computer;
    const pairing = a.pairing(session, c.id),
      bound = a.redeem(pairing.code);
    assert.throws(() => a.redeem(pairing.code));
    assert.equal(a.device(h1.id, c.id, bound.credential).binding, 1);
    a.transferComputer(session, c.id, h2.id, false);
    assert.throws(() => a.device(h1.id, c.id, bound.credential));
    assert.throws(() => a.device(h2.id, c.id, bound.credential));
    const next = a.redeem(a.pairing(session, c.id).code);
    assert.equal(next.binding, 2);
    assert.equal(next.hubId, h2.id);
  } finally {
    f.store.close();
  }
});
test("independent hub servers reject each other’s tokens and fail closed when identity goes offline", async () => {
  const f = fixture(),
    issuer = "http://127.0.0.1:19370";
  const a = new Authority(
    f.store,
    f.accounts,
    new Tokens(issuer, await signingKey()),
  );
  const session = f.accounts.password(
      "alice@example.test",
      "test-password",
      "native",
    ).session,
    h1 = f.store.change((s) => createHub(s, "alice", "One")),
    h2 = f.store.change((s) => createHub(s, "alice", "Two")),
    r1 = a.registerHub(session, h1.id, "http://127.0.0.1:19371"),
    r2 = a.registerHub(session, h2.id, "http://127.0.0.1:19372");
  const identity = await createIdentityApp({
      authority: a,
      secureCookies: false,
    }),
    s1 = new HubSessions(":memory:"),
    s2 = new HubSessions(":memory:");
  const one = await createHubApp({
      origin: r1.origin,
      authority: new AuthorityClient(issuer, h1.id, r1.credential),
      sessions: s1,
      tunnels: new Tunnels(),
      secureCookies: false,
    }),
    two = await createHubApp({
      origin: r2.origin,
      authority: new AuthorityClient(issuer, h2.id, r2.credential),
      sessions: s2,
      tunnels: new Tunnels(),
      secureCookies: false,
    });
  let identityClosed = false;
  try {
    await identity.listen({ host: "127.0.0.1", port: 19370 });
    await one.listen({ host: "127.0.0.1", port: 19371 });
    await two.listen({ host: "127.0.0.1", port: 19372 });
    const t1 = (await a.hubToken(session, h1.id)).accessToken,
      t2 = (await a.hubToken(session, h2.id)).accessToken;
    assert.equal(
      (
        await one.inject({
          url: "/api/me",
          headers: { authorization: "Bearer " + t1 },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await two.inject({
          url: "/api/me",
          headers: { authorization: "Bearer " + t1 },
        })
      ).statusCode,
      401,
    );
    assert.equal(
      (
        await two.inject({
          url: "/api/me",
          headers: { authorization: "Bearer " + t2 },
        })
      ).statusCode,
      200,
    );
    await identity.close();
    identityClosed = true;
    assert.equal(
      (
        await one.inject({
          url: "/api/me",
          headers: { authorization: "Bearer " + t1 },
        })
      ).statusCode,
      503,
    );
  } finally {
    await one.close();
    await two.close();
    if (!identityClosed) await identity.close();
    s1.close();
    s2.close();
    f.store.close();
  }
});
test("authorization code validates exact redirect and PKCE and cannot be redeemed twice", async () => {
  const f = fixture(),
    a = new Authority(
      f.store,
      f.accounts,
      new Tokens("http://127.0.0.1:19375", await signingKey()),
    ),
    app = await createIdentityApp({
      authority: a,
      secureCookies: false,
      providers: [fixtureGoogle(f.store)],
      clients: [{ id: "native", redirectUris: ["https://app.test/return"] }],
    });
  try {
    const cookie = await providerCookie(app, "alice"),
      verifier = "v".repeat(43);
    const query = {
      client_id: "native",
      redirect_uri: "https://app.test/return",
      response_type: "code",
      state: "s".repeat(32),
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    };
    const auth = await app.inject({
      url: "/oauth/authorize?" + new URLSearchParams(query),
      cookies: { codoxear_identity: cookie },
    });
    assert.equal(auth.statusCode, 302);
    const code = new URL(auth.headers.location!).searchParams.get("code")!,
      body = {
        grant_type: "authorization_code",
        code,
        client_id: "native",
        redirect_uri: "https://app.test/return",
        code_verifier: "x".repeat(43),
      };
    assert.equal(
      (await app.inject({ method: "POST", url: "/oauth/token", payload: body }))
        .statusCode,
      401,
    );
    body.code_verifier = verifier;
    assert.equal(
      (await app.inject({ method: "POST", url: "/oauth/token", payload: body }))
        .statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: "POST", url: "/oauth/token", payload: body }))
        .statusCode,
      401,
    );
    assert.equal(
      (
        await app.inject({
          url:
            "/oauth/authorize?" +
            new URLSearchParams({
              ...query,
              redirect_uri: "https://evil.test/return",
            }),
          cookies: { codoxear_identity: cookie },
        })
      ).statusCode,
      403,
    );
  } finally {
    await app.close();
    f.store.close();
  }
});
test("local import and computer-wide files/settings require the computer owner, and import is idempotent", async () => {
  const f = fixture();
  try {
    f.store.change((s) =>
      s.users.push({
        id: "bob",
        email: "bob@example.test",
        name: "Bob",
        passwordHash: passwordHash("test-password"),
        disabled: false,
      }),
    );
    const authority = new Authority(
        f.store,
        f.accounts,
        new Tokens("https://identity.test", await signingKey()),
      ),
      alice = f.accounts.password(
        "alice@example.test",
        "test-password",
        "web",
      ).session,
      bob = f.accounts.password(
        "bob@example.test",
        "test-password",
        "native",
      ).session,
      h = f.store.change((s) => createHub(s, "alice", "Hub"));
    f.store.change((s) =>
      acceptInvite(
        s,
        "bob",
        invite(s, "alice", "hub", h.id, "bob@example.test", "operator").token,
      ),
    );
    const c = f.store.change((s) =>
      createComputer(s, "alice", h.id, "Alice computer", "alice"),
    ).computer;
    f.store.change((s) =>
      acceptInvite(
        s,
        "bob",
        invite(s, "alice", "computer", c.id, "bob@example.test", "operator")
          .token,
      ),
    );
    assert.throws(() =>
      authority.importAgent(bob, h.id, c.id, "external", "Imported", "pi"),
    );
    const imported = authority.importAgent(
      alice,
      h.id,
      c.id,
      "external",
      "Imported",
      "pi",
    );
    assert.equal(
      authority.importAgent(alice, h.id, c.id, "external", "Again", "pi").id,
      imported.id,
    );
    assert.equal(authority.agents(bob, h.id, c.id).length, 1);
    assert.throws(() =>
      authority.relay(bob, h.id, c.id, "POST", "/api/files/inspect"),
    );
    assert.throws(() =>
      authority.relay(
        bob,
        h.id,
        c.id,
        "GET",
        "/api/sessions/external/file/read?path=x",
      ),
    );
    assert.equal(
      authority.relay(alice, h.id, c.id, "POST", "/api/files/inspect").actorId,
      "alice",
    );
    assert.equal(
      authority.relay(alice, h.id, c.id, "GET", "/api/settings/voice").actorId,
      "alice",
    );
  } finally {
    f.store.close();
  }
});
test("provider account linking fails without an existing authenticated browser", async () => {
  const f = fixture(),
    authority = new Authority(
      f.store,
      f.accounts,
      new Tokens("https://identity.test", await signingKey()),
    ),
    app = await createIdentityApp({
      authority,
      secureCookies: false,
      providers: [fixtureGoogle(f.store)],
    });
  try {
    const response = await app.inject({
      url: "/auth/test-google/start?link=1",
    });
    assert.equal(response.statusCode, 401);
    assert.equal(f.delivered.length, 0);
  } finally {
    await app.close();
    f.store.close();
  }
});
test("transfer to a differently owned hub requires scoped single-use owner admission and fences old access", async () => {
  const f = fixture();
  try {
    f.store.change((s) =>
      s.users.push({
        id: "bob",
        email: "bob@example.test",
        name: "Bob",
        passwordHash: passwordHash("test-password"),
        disabled: false,
      }),
    );
    const a = new Authority(
        f.store,
        f.accounts,
        new Tokens("https://identity.test", await signingKey()),
      ),
      alice = f.accounts.password(
        "alice@example.test",
        "test-password",
        "web",
      ).session,
      bob = f.accounts.password(
        "bob@example.test",
        "test-password",
        "web",
      ).session,
      home = f.store.change((s) => createHub(s, "alice", "Home")),
      work = f.store.change((s) => createHub(s, "bob", "Work"));
    a.registerHub(alice, home.id, "https://home.test");
    a.registerHub(bob, work.id, "https://work.test");
    const c = f.store.change((s) =>
      createComputer(s, "alice", home.id, "Laptop", "alice"),
    );
    assert.throws(() => a.admitComputer(bob, work.id, c.computer.id));
    f.store.change((s) =>
      acceptInvite(
        s,
        "alice",
        invite(s, "bob", "hub", work.id, "alice@example.test", "operator")
          .token,
      ),
    );
    a.importAgent(
      alice,
      home.id,
      c.computer.id,
      "existing",
      "Existing session",
      "pi",
    );
    assert.throws(() =>
      a.transferComputer(alice, c.computer.id, work.id, true),
    );
    assert.throws(() => a.admitComputer(alice, work.id, c.computer.id));
    const admission = a.admitComputer(bob, work.id, c.computer.id);
    assert.throws(() =>
      a.transferComputer(alice, c.computer.id, work.id, true, "wrong"),
    );
    a.transferComputer(alice, c.computer.id, work.id, true, admission.token);
    assert.throws(() => a.device(home.id, c.computer.id, c.credential));
    assert.equal(a.agents(alice, work.id, c.computer.id).length, 1);
    assert.equal(
      a.agents(bob, work.id, c.computer.id).length,
      0,
      "Hub ownership does not inherit computer agent access",
    );
    assert.equal(f.store.read().identity.admissions.length, 0);
    a.transferComputer(alice, c.computer.id, home.id, true);
    assert.throws(() =>
      a.transferComputer(alice, c.computer.id, work.id, true, admission.token),
    );
  } finally {
    f.store.close();
  }
});

test("workspace grants are separate from agent roles and end on revocation, ownership or binding changes", async () => {
  const f = fixture();
  const a = new Authority(
    f.store,
    f.accounts,
    new Tokens("https://identity.test", await signingKey()),
  );
  try {
    f.store.change((s) =>
      s.users.push({
        id: "bob",
        name: "Bob",
        email: "bob@example.test",
        passwordHash: passwordHash("test-password"),
        disabled: false,
      }),
    );
    const owner = f.accounts.password(
      "alice@example.test",
      "test-password",
      "owner",
    ).session;
    const member = f.accounts.password(
      "bob@example.test",
      "test-password",
      "member",
    ).session;
    const h = f.store.change((s) => createHub(s, "alice", "Workspace"));
    const c = f.store.change((s) =>
      createComputer(s, "alice", h.id, "Computer", "alice"),
    ).computer;
    const join = (kind: "hub" | "computer", id: string) =>
      f.store.change((s) =>
        acceptInvite(
          s,
          "bob",
          invite(s, "alice", kind, id, "bob@example.test", "operator").token,
        ),
      );
    join("hub", h.id);
    join("computer", c.id);
    const agent = a.createAgent(owner, h.id, c.id, "Session", "pi");
    const localId = "broker-" + "a".repeat(32),
      base = "/api/sessions/" + localId;
    f.store.change((s) => {
      const row = s.agents.find((x) => x.id === agent.id)!;
      row.localId = localId;
      row.state = "ready";
    });
    const read = () => a.relay(member, h.id, c.id, "GET", base + "/file/read");
    assert.throws(read);
    assert.throws(() =>
      a.setWorkspaceAccess(member, h.id, c.id, "bob", "read"),
    );
    a.setWorkspaceAccess(owner, h.id, c.id, "bob", "read");
    assert.deepEqual((read() as { workspace: unknown }).workspace, {
      id: "default",
      access: "read",
      paths: ["."],
      git: false,
      uploads: false,
      transcode: false,
      binding: c.binding,
      ownerRevision: c.revision,
      grantRevision: f.store.read().identity.workspaceGrants[0]!.grantRevision,
    });
    assert.throws(() =>
      a.relay(member, h.id, c.id, "POST", base + "/file/write"),
    );
    for (const [method, path] of [
      ["GET", "/api/file/blob"],
      ["GET", base + "/git/diff"],
      ["POST", base + "/inject_file"],
    ])
      assert.throws(() => a.relay(member, h.id, c.id, method!, path!));
    a.setWorkspaceAccess(owner, h.id, c.id, "bob", "write");
    assert.deepEqual(
      (
        a.relay(member, h.id, c.id, "POST", base + "/file/write") as {
          workspace: unknown;
        }
      ).workspace,
      {
        id: "default",
        access: "write",
        paths: ["."],
        git: false,
        uploads: false,
        transcode: false,
        binding: c.binding,
        ownerRevision: c.revision,
        grantRevision:
          f.store.read().identity.workspaceGrants[0]!.grantRevision,
      },
    );
    f.store.change((s) => {
      setPolicy(s, "alice", "hub", h.id, "retain");
      removeMember(s, "alice", "computer", c.id, "bob");
    });
    assert.ok(a.authorize(member, h.id, agent.id, "read"));
    assert.throws(read, "Retaining the agent does not retain file access");
    join("computer", c.id);
    assert.throws(read, "Joining again cannot revive a removed file grant");
    a.setWorkspaceAccess(owner, h.id, c.id, "bob", "read");
    f.store.change((s) => {
      s.computers.find((x) => x.id === c.id)!.binding++;
    });
    assert.throws(read);
    a.setWorkspaceAccess(owner, h.id, c.id, "bob", "read");
    f.store.change((s) => {
      s.computers.find((x) => x.id === c.id)!.revision++;
    });
    assert.throws(read);
    a.setWorkspaceAccess(owner, h.id, c.id, "bob", "read");
    f.store.change((s) => removeMember(s, "alice", "hub", h.id, "bob"));
    assert.throws(read);
    join("hub", h.id);
    assert.throws(read);
  } finally {
    f.store.close();
  }
});

test("account agent directory spans authorized hubs, omits restricted agents and updates after revocation", async () => {
  const f = fixture();
  const authority = new Authority(
    f.store,
    f.accounts,
    new Tokens("https://identity.test", await signingKey()),
  );
  f.store.change((s) =>
    s.users.push({
      id: "bob",
      name: "Bob",
      email: "bob@example.test",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    }),
  );
  const alice = f.accounts.password(
    "alice@example.test",
    "test-password",
    "test",
  ).session;
  const bob = f.accounts.password(
    "bob@example.test",
    "test-password",
    "test",
  ).session;
  const first = f.store.change((s) => createHub(s, "alice", "Home")),
    second = f.store.change((s) => createHub(s, "alice", "Work"));
  authority.registerHub(alice, first.id, "https://home.test");
  authority.registerHub(alice, second.id, "https://work.test");
  const c1 = f.store.change((s) =>
    createComputer(s, "alice", first.id, "Laptop", "alice"),
  ).computer;
  const c2 = f.store.change((s) =>
    createComputer(s, "alice", second.id, "Workstation", "alice"),
  ).computer;
  const a1 = authority.importAgent(
    alice,
    first.id,
    c1.id,
    "broker-local-1",
    "Writing",
    "pi",
  );
  authority.importAgent(
    alice,
    second.id,
    c2.id,
    "broker-local-2",
    "Review",
    "pi",
  );
  f.store.change((s) => {
    acceptInvite(
      s,
      "bob",
      invite(s, "alice", "hub", first.id, "bob@example.test", "operator").token,
    );
    acceptInvite(
      s,
      "bob",
      invite(s, "alice", "computer", c1.id, "bob@example.test", "operator")
        .token,
    );
  });
  assert.equal(authority.agentDirectory(alice).agents.length, 2);
  assert.deepEqual(
    authority.agentDirectory(bob).agents.map((a) => a.id),
    [a1.id],
  );
  assert.equal(authority.agentDirectory(bob).placements.length, 1);
  assert.deepEqual(authority.agentDirectory(bob).agents[0]?.actions, ["read", "send", "interrupt"]);
  f.store.change((s) => {
    s.memberships.find((membership) => membership.resource === "computer" && membership.resourceId === c1.id && membership.userId === "bob")!.role = "viewer";
  });
  // Both roles use access='member'; explicit actions distinguish their rights.
  assert.equal(authority.agentDirectory(bob).agents[0]?.access, "member");
  assert.deepEqual(authority.agentDirectory(bob).agents[0]?.actions, ["read"]);
  assert.equal(authority.agentDirectory(bob).placements.length, 0);
  f.store.change((s) => {
    s.memberships.find((membership) => membership.resource === "computer" && membership.resourceId === c1.id && membership.userId === "bob")!.role = "operator";
  });
  f.store.change((s) => setPolicy(s, "alice", "hub", first.id, "read_only"));
  f.store.change((s) => removeMember(s, "alice", "computer", c1.id, "bob"));
  assert.equal(authority.agentDirectory(bob).agents[0]?.access, "read_only");
  assert.deepEqual(authority.agentDirectory(bob).agents[0]?.actions, ["read"]);
  assert.equal(authority.agentDirectory(bob).placements.length, 0);
  f.store.change((s) =>
    s.identity.requirements.push({
      hubId: first.id,
      rule: { method: "wechat", maxAgeSeconds: 3600 },
    }),
  );
  assert.equal(authority.agentDirectory(bob).agents.length, 0);
  f.store.close();
});

test("settings Computer creation requires the hub owner and returns only one-time enrollment", async () => {
  const f = fixture();
  const authority = new Authority(
    f.store,
    f.accounts,
    new Tokens("https://identity.test", await signingKey()),
  );
  f.store.change((s) =>
    s.users.push({
      id: "bob",
      name: "Bob",
      email: "bob@example.test",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    }),
  );
  const h = f.store.change((s) => createHub(s, "alice", "Home"));
  authority.registerHub(
    f.accounts.password("alice@example.test", "test-password", "setup").session,
    h.id,
    "https://home.test",
  );
  f.store.change((s) =>
    acceptInvite(
      s,
      "bob",
      invite(s, "alice", "hub", h.id, "bob@example.test", "operator").token,
    ),
  );
  const app = await createIdentityApp({
    authority,
    providers: [fixtureGoogle(f.store, ["alice", "bob"])],
  });
  try {
    const owner = await providerCookie(app, "alice"),
      member = await providerCookie(app, "bob");
    const url = `/api/v1/hubs/${h.id}/computers`;
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          payload: { name: "Denied" },
          cookies: { codoxear_identity: member },
        })
      ).statusCode,
      403,
    );
    const response = await app.inject({
      method: "POST",
      url,
      payload: { name: "Laptop" },
      cookies: { codoxear_identity: owner },
    });
    assert.equal(response.statusCode, 200);
    const result = response.json();
    assert.ok(result.enrollment.code);
    assert.equal(result.credential, undefined);
    assert.equal(result.computer.credentialHash, undefined);
    assert.equal(
      authority.redeem(result.enrollment.code).computerId,
      result.computer.id,
    );
    assert.throws(() => authority.redeem(result.enrollment.code));
  } finally {
    await app.close();
    f.store.close();
  }
});
