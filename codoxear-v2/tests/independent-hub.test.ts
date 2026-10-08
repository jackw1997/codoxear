import { setComputerAccess, removeMember } from "../src/domain/commands.js";
import { createAllowedComputer } from "../scripts/testing/authorized-fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { Store } from "../src/persistence/store.js";
import { independentAuthority } from "../src/hub/independent.js";
import { configureHubOrganization } from "../src/auth/hub-organization.js";
import { provider as configuredProvider } from "../src/auth/providers.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import {
  createHub,
  passwordHash,
  invite,
  acceptInvite,
  reserveAgent,
  digest,
} from "../src/domain/commands.js";
import { createHash } from "node:crypto";
assert.ok(existsSync("/.dockerenv"), "Docker only");
async function fixture(origin: string) {
  const store = new Store(":memory:");
  let hubId = "";
  store.change((s) => {
    s.users.push({
      id: "alice",
      email: "alice@example.test",
      name: "Alice",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    });
    hubId = createHub(s, "alice", "Independent hub").id;
    createAllowedComputer(s, "alice", hubId, "Laptop", "alice");
  });
  const local = await independentAuthority({
    origin,
    hubId,
    store,
    otpKey: "independent-test-otp".repeat(3),
    secureCookies: false,
    clients: [
      {
        id: "codoxear-web",
        redirectUris: ["https://client.test/auth-callback"],
      },
    ],
  });
  const sessions = new HubSessions(":memory:");
  const tunnels = new Tunnels();
  const app = await createHubApp({
    origin,
    authority: local.client,
    localIdentity: local.identity,
    clientOrigins: ["https://client.test"],
    sessions,
    tunnels,
    webRoot: "/no-assets",
    secureCookies: false,
  });
  const signed = local.authority.accounts.password(
    "alice@example.test",
    "test-password",
    "test",
  );
  const token = await local.authority.tokens.issue(
    signed.session,
    origin,
    "identity_access",
  );
  return {
    app,
    store,
    local,
    hubId,
    token,
    signed,
    tunnels,
    async close() {
      await app.close();
      await local.identity.close();
      sessions.close();
      store.close();
    },
  };
}
test("independent hub Google/Feishu Computer invitations flow through the public API without linking email", async () => {
  const origin = "https://invitation.test",
    f = await fixture(origin);
  try {
    const owner = f.local.authority.accounts.finish(
      {
        method: "google",
        connection: "personal-google",
        subject: "alice-google",
        tenant: null,
        email: "alice@example.test",
        name: "Alice",
      },
      "owner-provider-browser",
      f.signed.session.id,
    );
    const ownerToken = await f.local.authority.tokens.issue(
      owner.session,
      origin,
      "identity_access",
    );
    configureHubOrganization(f.store, f.hubId, [
      configuredProvider({
        kind: "feishu",
        id: "company",
        clientId: "fixture-app",
        clientSecret: "fixture-secret",
        tenant: "team",
      }),
      configuredProvider({
        kind: "google",
        id: "personal-google",
        clientId: "fixture-google-app",
        clientSecret: "fixture-google-secret",
      }),
    ]);
    const bob = f.local.authority.accounts.finish(
      {
        method: "google",
        connection: "personal-google",
        subject: "bob-google",
        tenant: null,
        email: null,
        name: "Bob",
      },
      "bob-browser",
    );
    const bobToken = await f.local.authority.tokens.issue(
      bob.session,
      origin,
      "identity_access",
    );
    const headers = { authorization: "Bearer " + ownerToken };
    const join = async (credential: string) => {
      const link = await f.app.inject({method:"POST",url:`/api/hubs/${f.hubId}/invitation-links`,headers,payload:{}});
      assert.equal(link.statusCode,200,link.body);
      const accepted = await f.app.inject({method:"POST",url:`/api/invitation-links/${link.json().token}/accept`,headers:{authorization:"Bearer "+credential},payload:{}});
      assert.equal(accepted.statusCode,200,accepted.body);
    };
    await join(bobToken);

    const create = (body: unknown, auth = headers) =>
      f.app.inject({
        method: "POST",
        url: `/api/resources/computer/${f.store.read().computers[0]!.id}/invitations`,
        payload: JSON.stringify(body),
        headers: { ...auth, "content-type": "application/json" },
      });
    assert.equal(
      (
        await create({
          target: {
            method: "google",
            connection: "personal-google",
            subject: "",
          },
          role: "viewer",
        })
      ).statusCode,
      400,
    );
    assert.equal(
      (
        await create({
          email: "bob@example.test",
          target: {
            method: "google",
            connection: "personal-google",
            subject: "bob-google",
            tenant: null,
          },
          role: "viewer",
        })
      ).statusCode,
      400,
    );
    const invited = await create({
      target: {
        method: "google",
        connection: "personal-google",
        subject: "bob-google",
        tenant: null,
      },
      role: "viewer",
    });
    assert.equal(invited.statusCode, 200, invited.body);
    const accept = (token: string, credential: string) =>
      f.app.inject({
        method: "POST",
        url: "/api/v1/invitations/accept",
        headers: { authorization: "Bearer " + credential },
        payload: { token },
      });
    assert.equal(
      (await accept(invited.json().token, ownerToken)).statusCode,
      403,
    );
    assert.equal(
      (await accept(invited.json().token, bobToken)).statusCode,
      200,
    );
    assert.equal(
      (await accept(invited.json().token, bobToken)).statusCode,
      409,
    );
    assert.equal(
      (
        await create(
          {
            target: {
              method: "google",
              connection: "personal-google",
              subject: "bob-google",
              tenant: null,
            },
            role: "viewer",
          },
          { authorization: "Bearer " + bobToken },
        )
      ).statusCode,
      403,
    );
    assert.equal(
      f.store.read().memberships.find((m) => m.userId === bob.session.userId)
        ?.role,
      "member",
    );
    const provider = f.local.authority.accounts.finish(
      {
        method: "feishu",
        connection: "company",
        subject: "open-id",
        tenant: "team",
        email: null,
        name: "Colleague",
      },
      "colleague-browser",
    );
    const providerToken = await f.local.authority.tokens.issue(
      provider.session,
      origin,
      "identity_access",
    );
    await join(providerToken);
    const targeted = await create({
      target: {
        method: "feishu",
        connection: "company",
        subject: "open-id",
        tenant: "team",
      },
      role: "viewer",
    });
    assert.equal(targeted.statusCode, 200, targeted.body);
    assert.equal(
      (await accept(targeted.json().token, bobToken)).statusCode,
      403,
    );
    assert.equal(
      (await accept(targeted.json().token, providerToken)).statusCode,
      200,
    );
    assert.ok(
      f.store
        .read()
        .users.find((u) => u.id === provider.session.userId)!
        .email.endsWith("@accounts.invalid"),
    );
  } finally {
    await f.close();
  }
});
test("selective agent shares enforce creation, queue, push and live-stream revocation", async () => {
  const origin = "https://sharing.test",
    f = await fixture(origin);
  const computerId = f.store.read().computers[0]!.id;
  const bob = f.local.authority.accounts.finish(
    {
      method: "phone",
      connection: "phone",
      subject: "+8613800138000",
      tenant: null,
      email: null,
      name: "Bob",
    },
    "bob-browser",
  );
  let agentId = "",
    privateId = "";
  f.store.change((s) => {
    acceptInvite(
      s,
      bob.session.userId,
      invite(
        s,
        "alice",
        "hub",
        f.hubId,
        { method: "phone", phone: "+8613800138000" },
        "member",
      ).token,
    );
    s.computers[0]!.credentialHash = digest("fixture-device");
    const a = reserveAgent(s, "alice", computerId, "Shared", "fixture");
    a.localId = "shared-local";
    a.state = "ready";
    agentId = a.id;
    privateId = reserveAgent(s, "alice", computerId, "Private", "fixture").id;
  });
  const bobToken = await f.local.authority.tokens.issue(
    bob.session,
    origin,
    "identity_access",
  );
  const owner = { authorization: "Bearer " + f.token },
    member = { authorization: "Bearer " + bobToken };
  let dispatches = 0;
  f.tunnels.online = () => true;
  f.tunnels.request = async (_id, operation) => {
    if (operation.op === "messages") return { messages: [] };
    dispatches++;
    return { ok: true };
  };
  const share = (role: "viewer" | "operator" | null, headers = owner) =>
    f.app.inject({
      method: "PUT",
      url: `/api/agents/${agentId}/shares/${bob.session.userId}`,
      headers,
      payload: { role },
    });
  const send = () =>
    f.app.inject({
      method: "POST",
      url: `/api/agents/${agentId}/send`,
      headers: member,
      payload: { text: "hello" },
    });
  let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    assert.equal((await share("viewer", member)).statusCode, 403);
    assert.equal((await share("viewer")).statusCode, 200);
    assert.equal((await send()).statusCode, 403);
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: `/api/agents/${privateId}/access`,
          headers: member,
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/computers/${computerId}/agents`,
          headers: member,
          payload: { name: "Forbidden", backend: "pi" },
        })
      ).statusCode,
      403,
    );
    assert.throws(() =>
      f.local.authority.relay(
        bob.session,
        f.hubId,
        computerId,
        "GET",
        "/api/sessions/shared-local/file/read?path=secret",
      ),
    );
    assert.equal((await share("operator")).statusCode, 200);
    assert.equal(
      (await send()).statusCode,
      403,
      "Agent share cannot bypass Computer allowlist",
    );
    f.store.change((state) =>
      setComputerAccess(
        state,
        "alice",
        computerId,
        bob.session.userId,
        "write",
      ),
    );
    assert.equal((await send()).statusCode, 200);
    assert.equal(dispatches, 1);
    const permit = f.local.authority.queuePermit(
      bob.session,
      f.hubId,
      computerId,
      "/api/sessions/shared-local/enqueue",
    );
    assert.ok(
      f.local.authority.authorizeQueue(
        f.hubId,
        computerId,
        "fixture-device",
        permit.queuePermit,
        "shared-local",
      ),
    );
    assert.deepEqual(
      f.local.authority.agentDirectory(bob.session).agents.map((a) => a.id),
      [agentId, privateId],
    );
    assert.equal(
      f.local.authority.agentDirectory(bob.session).placements.length,
      1,
    );
    assert.ok(
      f.local.authority.authorizeNotification(
        f.hubId,
        bob.session.id,
        agentId,
        computerId,
        1,
      ),
    );
    const url = await f.app.listen({ host: "127.0.0.1", port: 0 });
    const live = await fetch(`${url}/api/agents/${agentId}/live`, {
      headers: member,
      signal: AbortSignal.timeout(10000),
    });
    reader = live.body!.getReader();
    const decoder = new TextDecoder();
    let received = "";
    async function until(text: string) {
      while (!received.includes(text)) {
        const part = await reader!.read();
        if (part.done) throw new Error("Stream ended before " + text);
        received += decoder.decode(part.value, { stream: true });
      }
    }
    await until("Computer write allowlist");
    assert.equal((await share("viewer")).statusCode, 200);
    f.store.change((state) =>
      setComputerAccess(state, "alice", computerId, bob.session.userId, "read"),
    );
    await until("Computer read allowlist");
    assert.throws(() =>
      f.local.authority.authorizeQueue(
        f.hubId,
        computerId,
        "fixture-device",
        permit.queuePermit,
        "shared-local",
      ),
    );
    assert.equal((await send()).statusCode, 403);
    assert.equal((await share(null)).statusCode, 200);
    f.store.change((state) =>
      removeMember(state, "alice", "computer", computerId, bob.session.userId),
    );
    await until("event: access_lost");
    assert.throws(() =>
      f.local.authority.authorizeNotification(
        f.hubId,
        bob.session.id,
        agentId,
        computerId,
        1,
      ),
    );
    assert.deepEqual(f.local.authority.agentDirectory(bob.session).agents, []);
    assert.equal((await send()).statusCode, 403);
    assert.equal(dispatches, 1);
  } finally {
    await reader?.cancel();
    await f.close();
  }
});
test("agent creation forwards runtime selections and preserves write/capability boundaries", async () => {
  const f = await fixture("https://launch.test");
  const computerId = f.store.read().computers[0]!.id;
  const operations: unknown[] = [];
  f.tunnels.online = () => true;
  let capability = true;
  f.tunnels.supports = () => capability;
  f.tunnels.request = async (_id, operation) => {
    operations.push(operation);
    return { localId: "broker-" + operations.length };
  };
  const headers = { authorization: "Bearer " + f.token };
  const launch = {
    model: "gpt-example",
    model_provider: "openai",
    preferred_auth_method: "chatgpt",
    reasoning_effort: "high",
    service_tier: "fast",
  };
  try {
    const create = (payload: unknown, auth = headers) =>
      f.app.inject({
        method: "POST",
        url: `/api/computers/${computerId}/agents`,
        headers: auth,
        payload: payload as object,
      });
    const result = await create({
      name: "Configured",
      backend: "codex",
      launch,
    });
    assert.equal(result.statusCode, 200, result.body);
    assert.equal(result.json().state, "ready");
    assert.deepEqual(operations, [
      {
        op: "create",
        agentId: result.json().id,
        name: "Configured",
        backend: "codex",
        launch,
      },
    ]);
    capability = false;
    assert.equal(
      (await create({ name: "Old computer", backend: "codex", launch }))
        .statusCode,
      409,
    );
    assert.equal(operations.length, 1);
    assert.equal(
      (
        await create({
          name: "Invalid",
          backend: "codex",
          launch: { api_key: "not-supported" },
        })
      ).statusCode,
      400,
    );
    assert.equal(operations.length, 1);
    f.store.change((s) => {
      s.users.push({
        id: "bob",
        name: "Bob",
        email: "bob@example.test",
        passwordHash: passwordHash("test-password"),
        disabled: false,
      });
      for (const [resource, resourceId] of [
        ["hub", f.hubId],
        ["computer", computerId],
      ] as const)
        acceptInvite(
          s,
          "bob",
          invite(
            s,
            "alice",
            resource,
            resourceId,
            "bob@example.test",
            resource === "hub" ? "member" : "operator",
          ).token,
        );
    });
    const bob = f.local.authority.accounts.password(
      "bob@example.test",
      "test-password",
      "test",
    ).session;
    const bobHeaders = {
      authorization:
        "Bearer " +
        (await f.local.authority.tokens.issue(
          bob,
          "https://launch.test",
          "identity_access",
        )),
    };
    capability = true;
    const explicit = await create({
      name: "Member options", backend: "pi", launch: { model: "custom" },
    }, bobHeaders);
    assert.equal(explicit.statusCode, 200, explicit.body);
    assert.equal(operations.length, 2);
    assert.deepEqual(operations[1], {
      op: "create", agentId: explicit.json().id, name: "Member options",
      backend: "pi", launch: { model: "custom" },
    });
    const simple = await create(
      { name: "Computer defaults", backend: "pi" },
      bobHeaders,
    );
    assert.equal(simple.statusCode, 200, simple.body);
    assert.equal(operations.length, 3);
    f.store.change((s) => setComputerAccess(s, "alice", computerId, "bob", "read"));
    const readOnly = await create({
      name: "Read-only options", backend: "pi", launch: { model: "custom" },
    }, bobHeaders);
    assert.equal(readOnly.statusCode, 403, readOnly.body);
    assert.equal(operations.length, 3, "Read-only launch selections never reach the Computer");
  } finally {
    await f.close();
  }
});
test("independent hubs authenticate, authorize and revoke without any remote authority", async () => {
  const a = await fixture("https://a.test"),
    b = await fixture("https://b.test");
  try {
    const headers = {
      authorization: "Bearer " + a.token,
      origin: "https://client.test",
    };
    const me = await a.app.inject({ url: "/api/me", headers });
    assert.equal(me.statusCode, 200, me.body);
    assert.equal(me.json().id, "alice");
    const directory = await a.app.inject({
      url: "/api/agent-directory",
      headers,
    });
    assert.equal(directory.statusCode, 200, directory.body);
    assert.equal(directory.json().placements.length, 1);
    const wrong = await b.app.inject({ url: "/api/me", headers });
    assert.equal(wrong.statusCode, 401);
    const forged = await a.app.inject({
      url: "/api/me",
      headers: { authorization: "Bearer logged-in-as-alice" },
    });
    assert.equal(forged.statusCode, 401);
    const cors = await a.app.inject({
      method: "OPTIONS",
      url: "/oauth/token",
      headers: {
        origin: "https://client.test",
        "access-control-request-method": "POST",
      },
    });
    assert.equal(cors.statusCode, 204);
    assert.equal(
      cors.headers["access-control-allow-origin"],
      "https://client.test",
    );
    const events = await a.app.inject({
      method: "OPTIONS",
      url: "/workspace/api/sessions/session/live",
      headers: {
        origin: "https://client.test",
        "access-control-request-method": "GET",
        "access-control-request-headers":
          "authorization,cache-control,last-event-id",
      },
    });
    assert.equal(events.statusCode, 204);
    const permitted = String(events.headers["access-control-allow-headers"])
      .toLowerCase()
      .split(",")
      .map((value) => value.trim());
    for (const header of ["authorization", "cache-control", "last-event-id"])
      assert.ok(permitted.includes(header), header);
    const denied = await a.app.inject({
      method: "OPTIONS",
      url: "/oauth/token",
      headers: { origin: "https://evil.test" },
    });
    assert.equal(denied.statusCode, 403);
    const csrf = await a.app.inject({
      method: "POST",
      url: "/api/v1/auth/password",
      headers: { origin: "https://client.test" },
      payload: { email: "alice@example.test", password: "test-password" },
    });
    assert.equal(csrf.statusCode, 403);
    const revoke = await a.app.inject({
      method: "POST",
      url: "/api/v1/auth/logout",
      headers,
      payload: {},
    });
    assert.equal(revoke.statusCode, 200, revoke.body);
    assert.equal(
      (await a.app.inject({ url: "/api/me", headers })).statusCode,
      401,
    );
    assert.equal(
      (
        await b.app.inject({
          url: "/api/me",
          headers: { authorization: "Bearer " + b.token },
        })
      ).statusCode,
      200,
    );
  } finally {
    await a.close();
    await b.close();
  }
});
test("hub-local PKCE login issues client credentials and rejects replay and unregistered clients", async () => {
  const f = await fixture("https://hub.test");
  try {
    const verified = f.local.authority.accounts.finish(
      {
        method: "google",
        connection: "google-fixture",
        subject: "alice",
        tenant: null,
        email: null,
        name: "Alice",
      },
      "fixture",
      f.signed.session.id,
    );
    const cookie = "codoxear_identity_" + f.hubId + "=" + verified.credential;
    const verifier = "v".repeat(43),
      challenge = createHash("sha256").update(verifier).digest("base64url");
    const q = new URLSearchParams({
      client_id: "codoxear-web",
      redirect_uri: "https://client.test/auth-callback",
      response_type: "code",
      state: "state".repeat(8),
      code_challenge_method: "S256",
      code_challenge: challenge,
    });
    const auth = await f.app.inject({
      url: "/oauth/authorize?" + q,
      headers: { cookie },
    });
    assert.equal(auth.statusCode, 302, auth.body);
    assert.equal(
      new URL(auth.headers.location!).searchParams.get("iss"),
      "https://hub.test",
    );
    const code = new URL(auth.headers.location!).searchParams.get("code");
    assert.ok(code);
    const payload = {
      grant_type: "authorization_code",
      client_id: "codoxear-web",
      redirect_uri: "https://client.test/auth-callback",
      code,
      code_verifier: verifier,
    };
    const exchange = await f.app.inject({
      method: "POST",
      url: "/oauth/token",
      headers: { origin: "https://client.test" },
      payload,
    });
    assert.equal(exchange.statusCode, 200, exchange.body);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/oauth/token",
          headers: { origin: "https://client.test" },
          payload,
        })
      ).statusCode,
      401,
    );
    const access = await f.app.inject({
      url: "/api/v1/me",
      headers: {
        authorization: "Bearer " + exchange.json().access_token,
        origin: "https://client.test",
      },
    });
    assert.equal(access.statusCode, 200, access.body);
    q.set("redirect_uri", "https://evil.test/auth-callback");
    assert.equal(
      (
        await f.app.inject({
          url: "/oauth/authorize?" + q,
          headers: { cookie },
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});
test("provider claims do not merge owners by email; explicit proof links identities locally", async () => {
  const f = await fixture("https://hub.test");
  try {
    const identity = {
      connection: "google",
      method: "oidc" as const,
      subject: "google-subject",
      tenant: null,
      email: "alice@example.test",
      name: "Unlinked Google",
    };
    const first = f.local.authority.accounts.finish(identity, "web");
    assert.notEqual(first.session.userId, "alice");
    assert.deepEqual(f.local.authority.directory(first.session), []);
    assert.throws(
      () =>
        f.local.authority.accounts.finish(identity, "web", f.signed.session.id),
      /never automatically merged/,
    );
    const second = f.local.authority.accounts.finish(
      { ...identity, subject: "explicitly-linked-google" },
      "web",
      f.signed.session.id,
    );
    assert.equal(second.session.userId, "alice");
    assert.equal(f.local.authority.directory(second.session).length, 1);
    const token = await f.local.authority.tokens.issue(
      second.session,
      "https://hub.test",
      "identity_access",
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/me",
          headers: { authorization: "Bearer " + token },
        })
      ).statusCode,
      200,
    );
    f.local.authority.accounts.unlink(
      f.signed.credential,
      second.session.context.identityId!,
    );
    assert.equal(
      (
        await f.app.inject({
          url: "/api/me",
          headers: { authorization: "Bearer " + token },
        })
      ).statusCode,
      401,
    );
  } finally {
    await f.close();
  }
});

test("a newcomer can accept hub and computer invitations without an existing hub grant", async () => {
  const f = await fixture("https://hub.test");
  try {
    f.store.change((s) =>
      s.users.push({
        id: "bob",
        name: "Bob",
        email: "bob@example.test",
        passwordHash: passwordHash("bob-password"),
        disabled: false,
      }),
    );
    const login = f.local.authority.accounts.password(
      "bob@example.test",
      "bob-password",
      "test",
    );
    const token = await f.local.authority.tokens.issue(
      login.session,
      "https://hub.test",
      "identity_access",
    );
    const headers = {
      authorization: "Bearer " + token,
      origin: "https://client.test",
    };
    const computer = f.store.read().computers[0]!;
    const invitation = await f.app.inject({method:"POST",url:`/api/hubs/${f.hubId}/invitation-links`,headers:{authorization:"Bearer "+f.token},payload:{}});
    assert.equal(invitation.statusCode,200,invitation.body);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/invitation-links/${invitation.json().token}/accept`,
          headers: { authorization: "Bearer " + f.token },
          payload: {},
        })
      ).statusCode,
      409,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/invitation-links/${invitation.json().token}/accept`,
          headers,
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `/api/invitation-links/${invitation.json().token}/accept`,
          headers,
          payload: {},
        })
      ).statusCode,
      409,
    );
    const before = await f.app.inject({ url: "/api/agent-directory", headers });
    assert.equal(before.json().placements.length, 0);
    const second = f.store.change((s) =>
      invite(
        s,
        "alice",
        "computer",
        computer.id,
        "bob@example.test",
        "operator",
      ),
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: "/api/v1/invitations/accept",
          headers,
          payload: { token: second.token },
        })
      ).statusCode,
      200,
    );
    const after = await f.app.inject({ url: "/api/agent-directory", headers });
    assert.equal(after.statusCode, 200);
    assert.equal(after.json().placements.length, 1);
  } finally {
    await f.close();
  }
});

test("migration isolates hub state while retaining live Computer and agent bindings", async () => {
  const { isolateHub } = await import("../src/hub/migration.js");
  const f = await fixture("https://hub.test");
  try {
    f.store.change((s) => {
      const h = createHub(s, "alice", "Other hub");
      createAllowedComputer(s, "alice", h.id, "Other Computer", "alice");
      s.agents.push({
        id: "live-agent",
        hubId: f.hubId,
        computerId: s.computers[0]!.id,
        creatorId: "alice",
        name: "Existing agent",
        backend: "pi",
        localId: "existing-cli",
        state: "ready",
        createdAt: Date.now(),
      });
    });
    const source = f.store.read(),
      before = structuredClone(source);
    const isolated = isolateHub(source, f.hubId);
    assert.deepEqual(source, before);
    assert.equal(isolated.hubs.length, 1);
    assert.equal(isolated.computers.length, 1);
    assert.deepEqual(isolated.computers[0], source.computers[0]);
    assert.equal(isolated.agents[0]!.localId, "existing-cli");
    assert.equal(isolated.identity.sessions.length, 0);
    assert.equal(isolated.identity.refresh.length, 0);
    assert.equal(isolated.identity.hubs.length, 0);
    const destination = new Store(":memory:");
    try {
      destination.change((s) => Object.assign(s, isolated));
      assert.equal(destination.read().hubs[0]!.id, f.hubId);
    } finally {
      destination.close();
    }
  } finally {
    await f.close();
  }
});

test("private providers cross both creation APIs without being stored in agent records", async () => {
  const f = await fixture("https://private-launch.test");
  const computerId = f.store.read().computers[0]!.id;
  const operations: Array<{ launch?: unknown }> = [];
  let providerCapability = true;
  f.tunnels.online = () => true;
  f.tunnels.supports = (_id, capability) =>
    capability !== "provider-launch" || providerCapability;
  f.tunnels.request = async (_id, operation) => {
    operations.push(operation as { launch?: unknown });
    return { localId: "broker-private-" + operations.length };
  };
  const headers = { authorization: "Bearer " + f.token };
  const launch = {
    model: "PrivateModel",
    provider_config: {
      base_url: "https://private.test/v1",
      api_key: "fixture-private-key",
    },
    env_vars: { PRIVATE_SETTING: "fixture-env-value" },
  };
  try {
    for (const backend of ["pi", "codex", "cc"] as const) {
      const rich = {
        ...launch,
        ...(backend === "cc"
          ? { command: "my-claude", service_tier: "fast" }
          : {}),
      };
      const basic = await f.app.inject({
        method: "POST",
        url: `/api/computers/${computerId}/agents`,
        headers,
        payload: { name: backend, backend, launch: rich },
      });
      assert.equal(basic.statusCode, 200, basic.body);
      assert.deepEqual(operations.at(-1)?.launch, rich);
      const client = await f.app.inject({
        method: "POST",
        url: `/api/v1/computers/${computerId}/api/sessions`,
        headers,
        payload: {
          name: backend,
          agent_backend: backend,
          ...rich,
          create_in_tmux: false,
        },
      });
      assert.equal(client.statusCode, 200, client.body);
      assert.deepEqual(operations.at(-1)?.launch, {
        ...rich,
        create_in_tmux: false,
      });
      assert.ok(
        !JSON.stringify(f.store.read()).includes("fixture-private-key"),
      );
      assert.ok(!JSON.stringify(f.store.read()).includes("fixture-env-value"));
    }
    providerCapability = false;
    for (const url of [
      `/api/computers/${computerId}/agents`,
      `/api/v1/computers/${computerId}/api/sessions`,
    ]) {
      const payload = url.endsWith("/agents")
        ? { name: "old", backend: "pi", launch }
        : { agent_backend: "pi", ...launch };
      const rejected = await f.app.inject({
        method: "POST",
        url,
        headers,
        payload,
      });
      assert.equal(rejected.statusCode, 409, rejected.body);
    }
    assert.equal(operations.length, 6);
  } finally {
    await f.close();
  }
});

test("write-allowlisted Members read launch configuration and create explicit agents without local import or history authority", async () => {
  const origin = "https://member-launch.test", f = await fixture(origin);
  try {
    const computerId = f.store.read().computers[0]!.id;
    const member = f.local.authority.accounts.finish({
      method: "google", connection: "google", subject: "member-launch",
      tenant: null, email: "member@example.test", name: "Member",
    }, "member-browser");
    f.store.change((s) => {
      acceptInvite(s, member.session.userId, invite(s, "alice", "hub", f.hubId, "member@example.test", "member").token);
      setComputerAccess(s, "alice", computerId, member.session.userId, "write");
    });
    const token = await f.local.authority.tokens.issue(member.session, origin, "identity_access");
    const headers = { authorization: `Bearer ${token}` };
    const launch = { model_provider: "gateway", model: "explicit-model", reasoning_effort: "off" };
    const operations: Array<{ op: string; launch?: unknown }> = [];
    let revokeDuringDiscover = false;
    f.tunnels.online = () => true;
    f.tunnels.supports = () => true;
    f.tunnels.request = async (_id, operation) => {
      operations.push(operation);
      if (operation.op === "discover") {
        if (revokeDuringDiscover) f.store.change((s) => setComputerAccess(s, "alice", computerId, member.session.userId, "read"));
        return { sessions: [], recent_cwds: ["/owner/private-history"], new_session_defaults: { backends: { pi: { model: "explicit-model", provider_choice: "gateway" } } } };
      }
      return { localId: "managed-" + String(operations.length).padStart(32, "0") };
    };
    const defaults = await f.app.inject({ url: `/api/computers/${computerId}/launch-defaults`, headers });
    assert.equal(defaults.statusCode, 200, defaults.body);
    assert.equal(defaults.json().new_session_defaults.backends.pi.provider_choice, "gateway");
    assert.deepEqual(defaults.json().recent_cwds, []);
    for (const [url, payload] of [
      [`/api/computers/${computerId}/agents`, { name: "Explicit member agent", backend: "pi", launch }],
      [`/api/v1/computers/${computerId}/api/sessions`, { name: "Explicit member session", agent_backend: "pi", ...launch }],
    ] as const) {
      const created = await f.app.inject({ method: "POST", url, headers, payload });
      assert.equal(created.statusCode, 200, created.body);
      assert.deepEqual(operations.at(-1)?.launch, launch);
    }
    const dispatches = operations.length;
    for (const [method, url, payload] of [
      ["GET", `/api/computers/${computerId}/discovered`, undefined],
      ["POST", `/api/computers/${computerId}/import`, { localId: "broker-" + "a".repeat(32), name: "Private local", backend: "pi" }],
      ["GET", `/api/computers/${computerId}/resume-candidates?backend=pi&cwd=%2Fworkspace`, undefined],
      ["POST", `/api/computers/${computerId}/agents`, { name: "Private resume", backend: "pi", launch: { ...launch, resume_session_id: "private-native-session" } }],
      ["POST", `/api/v1/computers/${computerId}/api/sessions`, { agent_backend: "pi", ...launch, resume_session_id: "private-native-session" }],
    ] as const) {
      const denied = await f.app.inject({ method, url, headers, ...(payload ? { payload } : {}) });
      assert.equal(denied.statusCode, 403, denied.body);
    }
    assert.equal(operations.length, dispatches, "Owner-only import/history actions never reach the Computer");
    assert.equal(f.store.read().computers[0]!.ownerId, "alice");
    revokeDuringDiscover = true;
    assert.equal((await f.app.inject({ url: `/api/computers/${computerId}/launch-defaults`, headers })).statusCode, 403);
    const afterRevocation = operations.length;
    assert.equal((await f.app.inject({ url: `/api/computers/${computerId}/launch-defaults`, headers })).statusCode, 403);
    assert.equal((await f.app.inject({ method: "POST", url: `/api/computers/${computerId}/agents`, headers, payload: { name: "Read only", backend: "pi", launch } })).statusCode, 403);
    assert.equal(operations.length, afterRevocation);
  } finally { await f.close(); }
});

test("saved-session candidates require Computer ownership and recheck it after dispatch", async () => {
  const origin = "https://resume.test",
    f = await fixture(origin);
  try {
    const computerId = f.store.read().computers[0]!.id;
    let dispatches = 0,
      revoke = false;
    f.tunnels.supports = () => true;
    f.tunnels.request = async (_computerId, operation) => {
      dispatches++;
      assert.deepEqual(operation, {
        op: "resume-candidates",
        backend: "codex",
        cwd: "/workspace",
      });
      if (revoke)
        f.store.change((s) => {
          s.users.push({
            ...s.users[0]!,
            id: "other",
            email: "other@example.test",
          });
          s.computers[0]!.ownerId = "other";
        });
      return {
        sessions: [
          {
            session_id: "native-session",
            alias: "Saved task",
            log_path: "/private/log",
            api_key: "secret",
          },
        ],
      };
    };
    const request = () =>
      f.app.inject({
        method: "GET",
        url: `/api/computers/${computerId}/resume-candidates?backend=codex&cwd=%2Fworkspace`,
        headers: { authorization: `Bearer ${f.token}` },
      });
    const found = await request();
    assert.equal(found.statusCode, 200, found.body);
    assert.deepEqual(found.json(), {
      sessions: [{ session_id: "native-session", alias: "Saved task" }],
    });
    f.tunnels.supports = () => false;
    const outdated = await request();
    assert.equal(outdated.statusCode, 409);
    assert.equal(dispatches, 1);
    f.tunnels.supports = () => true;
    revoke = true;
    const revoked = await request();
    assert.equal(revoked.statusCode, 403, revoked.body);
    assert.equal(dispatches, 2);
    const forbidden = await request();
    assert.equal(forbidden.statusCode, 403);
    assert.equal(dispatches, 2);
  } finally {
    await f.close();
  }
});
