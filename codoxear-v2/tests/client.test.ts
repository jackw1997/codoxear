import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import {
  ConnectionContext,
  apiAddress,
  profileKey,
  credentialKey,
  recoveryKey,
  refreshKey,
  SupersededConnection,
  type RelayProfile,
  type CredentialVault,
} from "../frontend/shared/context.js";
import { ClientTransport, ClientFailure } from "../frontend/shared/transport.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const profile: RelayProfile = {
  mode: "relay",
  id: "home",
  origin: "https://hub.test",
  issuer: "https://identity.test",
  accountId: "alice",
  hubId: "home",
  computerId: "laptop",
};
const vault: CredentialVault = {
  async read() {
    return "hub-secret";
  },
  async write() {},
  async remove() {},
};
test("profile, credential and recovery keys fence account/hub/computer and direct mode", () => {
  const next = { ...profile, computerId: "desktop" };
  assert.notEqual(profileKey(next), profileKey(profile));
  assert.notEqual(recoveryKey(next, "same"), recoveryKey(profile, "same"));
  assert.equal(credentialKey(next), credentialKey(profile));
  assert.notEqual(
    credentialKey({ ...profile, hubId: "work" }),
    credentialKey(profile),
  );
  assert.notEqual(
    refreshKey(profile.issuer, "alice", "phone"),
    refreshKey(profile.issuer, "bob", "phone"),
  );
  const direct = {
    mode: "direct" as const,
    id: "local",
    origin: "http://127.0.0.1:8743",
    accountId: "alice",
  };
  assert.notEqual(credentialKey(direct), credentialKey(profile));
  assert.equal(
    apiAddress(profile, "/api/sessions/s/live"),
    profile.origin + "/api/v1/computers/laptop/api/sessions/s/live",
  );
  assert.equal(apiAddress(direct, "/api/me"), direct.origin + "/api/me");
  for (const path of [
    "https://evil.test/api/me",
    "/api/../login",
    "/api/%2e%2e/login",
    "/api/%252e%252e/login",
    "/api/\\evil",
  ])
    assert.throws(() => apiAddress(profile, path));
});
test("switching context rejects stale responses and never forwards a saved direct cookie to a hub", async () => {
  const context = new ConnectionContext();
  context.select(profile);
  let finish!: (r: Response) => void;
  const client = new ClientTransport(context, vault, async (_url, options) => {
    const headers = new Headers(options?.headers);
    assert.equal(headers.get("cookie"), null);
    assert.equal(headers.get("authorization"), "Bearer hub-secret");
    return new Promise<Response>((r) => (finish = r));
  });
  const request = client.request("/api/sessions/s/messages/tail", {
    headers: { Cookie: "old-password-cookie" },
  });
  await new Promise((r) => setTimeout(r, 0));
  context.select({ ...profile, hubId: "work" });
  finish(new Response("{}"));
  await assert.rejects(request, SupersededConnection);
});
test("loss of a mutation response is reported once as unknown without retry or direct fallback", async () => {
  const context = new ConnectionContext();
  context.select(profile);
  let calls = 0;
  const client = new ClientTransport(context, vault, async () => {
    calls++;
    throw new Error("Connection lost");
  });
  await assert.rejects(
    client.request("/api/sessions/s/send", { method: "POST", body: "{}" }),
    (e) => e instanceof ClientFailure && e.code === "outcome_unknown",
  );
  assert.equal(calls, 1);
});
test("switching context cancels an already-open streaming response", async () => {
  const context = new ConnectionContext();
  context.select(profile);
  let closed = false;
  const client = new ClientTransport(
    context,
    vault,
    async () =>
      new Response(
        new ReadableStream({
          pull(c) {
            c.enqueue(new Uint8Array([1]));
          },
          cancel() {
            closed = true;
          },
        }),
      ),
  );
  const response = await client.request("/api/sessions/s/live"),
    reader = response.body!.getReader();
  await reader.read();
  context.select(null);
  await assert.rejects(async () => {
    for (let i = 0; i < 4; i++) await reader.read();
  }, SupersededConnection);
  assert.equal(closed, true);
});
