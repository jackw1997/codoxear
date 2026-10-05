import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { createIdentityApp } from "../src/identity/app.js";
import { createHub, passwordHash } from "../src/domain/commands.js";

test("account gateway keeps hub grants server-side and rejects unauthenticated, cross-origin and unknown routes", async () => {
  const store = new Store(":memory:");
  store.change((s) =>
    s.users.push({
      id: "alice",
      email: "alice@example.test",
      name: "Alice",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    }),
  );
  const accounts = new Accounts(store, "test-secret".repeat(8), {
    async send() {},
  });
  const authority = new Authority(
    store,
    accounts,
    new Tokens("https://account.test", await signingKey()),
  );
  const signed = accounts.password(
    "alice@example.test",
    "test-password",
    "browser",
  );
  const hub = store.change((s) => createHub(s, "alice", "Target"));
  const upstream = Fastify();
  let calls = 0;
  upstream.get("/api/computers/laptop/launch-defaults", async (r) => {
    assert.equal(r.headers.cookie, undefined);
    assert.equal(
      (await authority.principal(r.headers.authorization!.slice(7), hub.id))
        .userId,
      "alice",
    );
    return {
      new_session_defaults: {
        backends: { pi: { provider_choices: ["configured"] } },
      },
    };
  });
  upstream.route({
    method: ["GET", "DELETE", "POST"],
    url: "/api/resources/hub/:id/members",
    handler: async (r) => {
      calls++;
      assert.equal(r.headers.cookie, undefined);
      assert.equal(r.headers.origin, undefined);
      assert.equal(
        (await authority.principal(r.headers.authorization!.slice(7), hub.id))
          .userId,
        "alice",
      );
      return { ok: true, body: r.body ?? null };
    },
  });
  const origin = await upstream.listen({ host: "127.0.0.1", port: 0 });
  authority.registerHub(signed.session, hub.id, origin);
  const app = await createIdentityApp({ authority, secureCookies: false });
  const url = `/gateway/hubs/${hub.id}/api/resources/hub/${hub.id}/members`;
  const headers = { cookie: "codoxear_identity=" + signed.credential };
  try {
    assert.equal((await app.inject(url)).statusCode, 401);
    for (const method of ["GET", "DELETE"] as const) {
      const result = await app.inject({ method, url, headers });
      assert.equal(result.statusCode, 200, result.body);
      assert.deepEqual(result.json(), { ok: true, body: null });
    }
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url,
          headers: { ...headers, origin: "https://other.test" },
          payload: {},
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await app.inject({
          method: "GET",
          url: `/gateway/hubs/${hub.id}/api/internal/device`,
          headers,
        })
      ).statusCode,
      403,
    );
    assert.equal(calls, 2);
    const defaults = await app.inject({
      url: `/gateway/hubs/${hub.id}/api/computers/laptop/launch-defaults`,
      headers,
    });
    assert.equal(defaults.statusCode, 200, defaults.body);
    assert.deepEqual(
      defaults.json().new_session_defaults.backends.pi.provider_choices,
      ["configured"],
    );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/workspace/api/logout",
          headers,
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (await app.inject({ method: "GET", url, headers })).statusCode,
      401,
    );
  } finally {
    await app.close();
    await upstream.close();
    store.close();
  }
});
