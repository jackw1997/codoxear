import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createHubApp } from "../src/hub/app.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import { NotificationInbox } from "../src/hub/notifications.js";
import { IdentityClient } from "../frontend/shared/identity.js";
import { credentialKey, ConnectionContext } from "../frontend/shared/context.js";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { createIdentityApp } from "../src/identity/app.js";
import {
  passwordHash,
  secret,
  createHub,
  createComputer,
} from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
async function fixture() {
  const store = new Store(":memory:"),
    issuer = "https://identity.test",
    callback = "https://app.test/auth/callback";
  store.change((s) =>
    s.users.push({
      id: "alice",
      email: "alice@example.test",
      name: "Alice",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    }),
  );
  const accounts = new Accounts(store, secret(), { async send() {} }),
    authority = new Authority(
      store,
      accounts,
      new Tokens(issuer, await signingKey()),
    ),
    owner = accounts.password("alice@example.test", "test-password", "web"),
    hub = store.change((s) => createHub(s, "alice", "Home"));
  const registration = authority.registerHub(
    owner.session,
    hub.id,
    "https://hub.test",
  );
  const computer = store.change((s) =>
    createComputer(s, "alice", hub.id, "Laptop", "alice"),
  ).computer;
  const computer2 = store.change((s) =>
    createComputer(s, "alice", hub.id, "Desktop", "alice"),
  ).computer;
  const app = await createIdentityApp({
      authority,
      clients: [{ id: "native", redirectUris: [callback] }],
    }),
    values = new Map<string, string>();
  const proxyIdentity = (async (input, options) => {
    const url = new URL(String(input));
    const response = await app.inject({
      url: url.pathname + url.search,
      method: (options?.method ?? "GET") as "GET" | "POST",
      headers: Object.fromEntries(new Headers(options?.headers)),
      ...(options?.body ? { payload: String(options.body) } : {}),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const hubSessions = new HubSessions(":memory:");
  const notifications = new NotificationInbox(
    ":memory:",
    hub.id,
    async () => {},
    { testMessage: true, send: async () => "sent" },
  );
  const actualHub = await createHubApp({
    origin: "https://hub.test",
    authority: new AuthorityClient(
      issuer,
      hub.id,
      registration.credential,
      proxyIdentity,
    ),
    sessions: hubSessions,
    tunnels: new Tunnels(),
    notifications,
  });
  let now = Date.now(),
    rotations = 0,
    loseRotation = false;
  const vault = {
    async read(key: string) {
      return values.get(key) ?? null;
    },
    async write(key: string, value: string) {
      values.set(key, value);
    },
    async remove(key: string) {
      values.delete(key);
    },
  };
  const transport = (async (
    input: RequestInfo | URL,
    options: RequestInit = {},
  ) => {
    const url = new URL(String(input));
    assert.equal(options.credentials, "omit");
    assert.equal(options.redirect, "error");
    assert.equal(new Headers(options.headers).has("Cookie"), false);
    if (url.origin === "https://hub.test") {
      const response = await actualHub.inject({
        url: url.pathname + url.search,
        method: (options.method ?? "GET") as "GET" | "POST",
        headers: Object.fromEntries(new Headers(options.headers)),
        ...(options.body ? { payload: String(options.body) } : {}),
      });
      return new Response(response.body, {
        status: response.statusCode,
        headers: { "Content-Type": "application/json" },
      });
    }
    assert.equal(url.origin, issuer);
    const response = await app.inject({
      url: url.pathname + url.search,
      method: (options.method ?? "GET") as "GET" | "POST",
      headers: Object.fromEntries(new Headers(options.headers)),
      ...(options.body ? { payload: String(options.body) } : {}),
    });
    if (String(options.body).includes('"grant_type":"refresh_token"')) {
      rotations++;
      if (loseRotation) throw Error("Response lost after rotation");
    }
    return new Response(response.body, {
      status: response.statusCode,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;
  const context = new ConnectionContext(),
    client = new IdentityClient(
      issuer,
      {
        clientId: "native",
        installationId: "physical-installation-1",
        redirectUri: callback,
      },
      vault,
      context,
      transport,
      () => now,
    );
  const begin = async () => {
    const url = new URL(await client.authorizeUrl());
    const response = await app.inject({
      url: url.pathname + url.search,
      cookies: { codoxear_identity: owner.credential },
    });
    assert.equal(response.statusCode, 302);
    return response.headers.location!;
  };
  return {
    client,
    actualHub,
    notifications,
    context,
    values,
    hub,
    computer,
    computer2,
    begin,
    advance: () => {
      now += 300000;
    },
    rotations: () => rotations,
    lose: () => {
      loseRotation = true;
    },
    close: async () => {
      await actualHub.close();
      hubSessions.close();
      notifications.close();
      await app.close();
      store.close();
    },
  };
}
test("native coordinator completes actual PKCE, discovers authorized hubs/computers and keeps credentials in the vault", async () => {
  const f = await fixture();
  try {
    const callback = await f.begin();
    await assert.rejects(
      f.client.finish(callback.replace("state=", "state=wrong")),
      /transaction/,
    );
    assert.equal(await f.client.finish(callback), "alice");
    await assert.rejects(f.client.finish(callback), /transaction/);
    assert.equal((await f.client.hubs())[0]!.id, f.hub.id);
    const profile = await f.client.selectComputer(f.hub.id, f.computer.id);
    assert.equal(profile.mode, "relay");
    assert.equal(profile.accountId, "alice");
    assert.equal(JSON.stringify(profile).includes("accessToken"), false);
    await assert.rejects(f.client.selectComputer(f.hub.id, "not-authorized"));
    await f.client.logout();
    assert.equal(f.context.profile, null);
    assert.equal(f.values.size, 0);
  } finally {
    await f.close();
  }
});
test("concurrent native requests rotate the installation refresh token once and persist the new credential", async () => {
  const f = await fixture();
  try {
    await f.client.finish(await f.begin());
    const before = [...f.values.values()][0];
    f.advance();
    await Promise.all([f.client.hubs(), f.client.hubs()]);
    assert.equal(f.rotations(), 1);
    assert.notEqual([...f.values.values()][0], before);
    await f.client.restore("alice");
    assert.equal(f.rotations(), 1);
  } finally {
    await f.close();
  }
});
test("lost refresh acknowledgement clears native credentials and never retries the consumed token", async () => {
  const f = await fixture();
  try {
    await f.client.finish(await f.begin());
    await f.client.selectComputer(f.hub.id, f.computer.id);
    f.advance();
    f.lose();
    await assert.rejects(f.client.hubs(), /Response lost/);
    assert.equal(f.context.profile, null);
    assert.equal(f.values.size, 0);
    await assert.rejects(f.client.hubs(), /Sign in/);
    assert.equal(f.rotations(), 1);
  } finally {
    await f.close();
  }
});

test("actual hub subscription API isolates account, installation and computer and never returns provider tokens", async () => {
  const f = await fixture();
  try {
    await f.client.finish(await f.begin());
    const profile = await f.client.selectComputer(f.hub.id, f.computer.id);
    const headers = {
      authorization: "Bearer " + f.values.get(credentialKey(profile)),
    };
    for (const computer of [f.computer, f.computer2]) {
      const result = await f.actualHub.inject({
        method: "POST",
        url: "/api/v1/push/subscriptions",
        headers,
        payload: {
          provider: "harmony",
          computerId: computer.id,
          installationId: "phone",
          token: "private-device-token",
        },
      });
      assert.equal(result.statusCode, 200, result.body);
    }
    const list = await f.actualHub.inject({
      url: "/api/v1/push/subscriptions",
      headers,
    });
    assert.equal(list.json().subscriptions.length, 2);
    assert.equal(list.body.includes("private-device-token"), false);
    const denied = await f.actualHub.inject({
      method: "POST",
      url: "/api/v1/push/subscriptions",
      headers,
      payload: {
        provider: "harmony",
        computerId: "unauthorized",
        installationId: "phone",
        token: "private-device-token",
      },
    });
    assert.equal(denied.statusCode, 403);
    const legacy = await f.actualHub.inject({
      method: "POST",
      url: `/api/v1/computers/${f.computer.id}/api/notifications/harmony`,
      headers,
      payload: {
        device_id: "phone",
        token: "replacement",
        enabled: true,
        server: "attacker-context",
      },
    });
    assert.deepEqual(legacy.json(), { ok: true, registered: true });
    const removed = await f.actualHub.inject({
      method: "DELETE",
      url: `/api/v1/push/subscriptions/phone/${f.computer.id}`,
      headers,
    });
    assert.equal(removed.statusCode, 200);
    assert.equal(f.notifications.counts().subscriptions, 1);
    await f.client.logout();
    const expired = await f.actualHub.inject({
      url: "/api/v1/push/subscriptions",
      headers,
    });
    assert.equal(expired.statusCode, 401);
  } finally {
    await f.close();
  }
});
