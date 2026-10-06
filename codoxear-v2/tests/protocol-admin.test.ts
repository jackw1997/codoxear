import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import { createIdentityApp } from "../src/auth/app.js";
import { independentAuthority } from "../src/hub/independent.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import { createHub, createComputer, passwordHash, reserveAgent } from "../src/domain/commands.js";
import { adminOperationSchemas, AccountProfile, PublicSigningKeys, InternalCallRequest, InternalCallSuccess, RelayAuthorization, MemberWorkspaceGrant } from "../src/protocol/admin-contracts.js";
import { registeredContract } from "../src/protocol/inventory.js";
assert.ok(existsSync("/.dockerenv"), "Administrative HTTP acceptance runs in Docker");
const observations: Array<{ component: string; method: string; path: string; status: number; operation?: string }> = [];
let publishedSchemaValidations = 0;
function validatePublished(schema: any, value: unknown) {
  z.fromJSONSchema(schema).parse(value);
  publishedSchemaValidations++;
}
const documents: Record<string, any> = {};
async function document(component: string) {
  return documents[component] ??= JSON.parse(await readFile("protocol/" + component + ".openapi.json", "utf8"));
}
async function publishedResponse(component: string, method: string, path: string, status: number, contentType: string, value: unknown) {
  const name = path.replace(/:([A-Za-z][A-Za-z0-9_]*)/g, "{$1}");
  const operation = (await document(component)).paths[name]?.[method.toLowerCase()];
  assert.ok(operation, "Published operation " + method + " " + name);
  const schema = operation.responses[status]?.content?.[contentType]?.schema;
  assert.ok(schema && Object.keys(schema).length, "Concrete published response " + method + " " + name);
  validatePublished(schema, value);
}
async function fixture(independent: boolean) {
  const store = new Store(":memory:"), delivered: string[] = [];
  store.change(state => { for (const id of ["alice", "bob"]) state.users.push({ id, email: id + "@admin.invalid", name: id, passwordHash: passwordHash("fixture-password"), disabled: false }); });
  const created = store.change(state => {
    const hub = createHub(state, "alice", "Admin schemas");
    const computer = createComputer(state, "alice", hub.id, "Admin Computer", "alice");
    state.memberships.push({ resource: "hub", resourceId: hub.id, userId: "bob", role: "operator" }, { resource: "computer", resourceId: computer.computer.id, userId: "bob", role: "operator" });
    const agent = reserveAgent(state, "alice", computer.computer.id, "Published fixture", "fixture"); agent.state = "ready"; agent.localId = "admin-local";
    return { ...computer, hub, agent };
  });
  const origin = independent ? "https://admin-independent.test" : "https://admin-hub.test", identityOrigin = independent ? origin : "https://admin-authority.test";
  const clients = [{ id: "admin-client", redirectUris: ["https://admin-native.test/callback"] }];
  const delivery = { async send(_method: string, _target: string, code: string) { delivered.push(code); } };
  let local: { authority: Authority; identity: FastifyInstance; client: AuthorityClient };
  if (independent) local = await independentAuthority({ origin, hubId: created.hub.id, store, otpKey: "admin-fixture-key".repeat(4), delivery, codeDelivery: ["email"], clients, secureCookies: false });
  else {
    const accounts = new Accounts(store, "admin-fixture-key".repeat(4), delivery), authority = new Authority(store, accounts, new Tokens(identityOrigin, await signingKey()));
    const owner = accounts.password("alice@admin.invalid", "fixture-password", "registration");
    const registration = authority.registerHub(owner.session, created.hub.id, origin);
    const identity = await createIdentityApp({ authority, clients, codeDelivery: ["email"], secureCookies: false });
    const transport: typeof fetch = async (input, init) => {
      const address = new URL(String(input)); assert.equal(address.origin, identityOrigin);
      const method = address.pathname === "/api/v1/me" ? "GET" : "POST", headers = Object.fromEntries(new Headers(init?.headers));
      if (method === "GET") delete headers["content-type"];
      const response = await identity.inject({ method, url: address.pathname + address.search, headers, ...(method === "POST" ? { payload: init?.body as string } : {}) });
      return new Response(response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
    };
    local = { authority, identity, client: new AuthorityClient(identityOrigin, created.hub.id, registration.credential, transport) };
  }
  const signed = Object.fromEntries(["alice", "bob"].map(id => [id, local.authority.accounts.password(id + "@admin.invalid", "fixture-password", "fixture-" + id)]));
  const identityTokens: Record<string, string> = {}, hubTokens: Record<string, string> = {};
  for (const id of ["alice", "bob"]) { identityTokens[id] = await local.authority.tokens.issue(signed[id]!.session, identityOrigin, "identity_access"); hubTokens[id] = (await local.authority.hubToken(signed[id]!.session, created.hub.id)).accessToken; }
  const tunnels = new Tunnels(), sessions = new HubSessions(":memory:");
  const hub = await createHubApp({ origin, authority: local.client, ...(independent ? { localIdentity: local.identity } : {}), tunnels, sessions, secureCookies: false, webRoot: "/no-static-fixture" });
  const cookieName = independent ? "codoxear_identity_" + created.hub.id : "codoxear_identity";
  async function request(component: "hub" | "identity", method: "GET" | "POST" | "PUT" | "DELETE", path: string, registeredPath: string, body?: unknown, actor = "alice") {
    const app = component === "hub" ? hub : local.identity;
    const response = await app.inject({ method, url: path, headers: { authorization: "Bearer " + (component === "hub" ? hubTokens[actor] : identityTokens[actor]), cookie: cookieName + "=" + signed[actor]!.credential, origin: component === "hub" ? origin : identityOrigin }, ...(body === undefined ? {} : { payload: body as any }) });
    assert.equal(response.statusCode, 200, `${component} ${method} ${path}: ${response.body}`);
    const contract = registeredContract(component).find(endpoint => endpoint.method === method && endpoint.path === registeredPath);
    assert.ok(contract, `Registered contract ${method} ${registeredPath}`);
    const contentType = String(response.headers["content-type"] ?? "").split(";")[0]!;
    const schema = contract.responseContents?.[contentType] ?? contract.response;
    assert.ok(schema, `Typed success ${method} ${registeredPath}`);
    const value = contentType === "application/json" ? response.json() : response.body;
    schema.parse(value);
    await publishedResponse(component, method, registeredPath, response.statusCode, contentType, value);
    observations.push({ component: independent ? "independent-" + component : "shared-" + component, method, path: registeredPath, status: response.statusCode });
    return value as any;
  }
  async function call(op: string, args: Record<string, unknown> = {}, actor = "alice") {
    const contract = adminOperationSchemas[op]; assert.ok(contract, "Explicit dispatcher operation " + op);
    InternalCallRequest.parse({ op, args }); contract.request.parse(args);
    const value = await local.client.call(hubTokens[actor]!, op, args);
    contract.response.parse(value); InternalCallSuccess.parse(value);
    const published = (await document("internal")).paths["/internal/call"].post;
    validatePublished(published.requestBody.content["application/json"].schema, { op, args });
    const selected = published["x-dispatch-operation-schemas"][op];
    assert.ok(selected, "Published dispatcher operation " + op);
    validatePublished(selected.args, args);
    validatePublished(selected.response, value);
    await publishedResponse("internal", "POST", "/internal/call", 200, "application/json", value);
    observations.push({ component: independent ? "independent-internal" : "shared-internal", method: "POST", path: "/internal/call", status: 200, operation: op });
    return value as any;
  }
  return { store, local, signed, created, hub, request, call, delivered, origin, identityOrigin, async close() { tunnels.close(); await hub.close(); await local.identity.close(); sessions.close(); store.close(); } };
}
test("independent Hub administrative and account responses conform to exact registered success contracts", async () => {
  const f = await fixture(true);
  try {
    await f.request("hub", "GET", "/health", "/health");
    await f.request("identity", "GET", "/health", "/health");
    await f.request("hub", "GET", "/api/me", "/api/me");
    await f.request("hub", "GET", "/api/hubs", "/api/hubs");
    await f.request("hub", "GET", "/api/v1/computers", "/api/v1/computers");
    await f.request("hub", "GET", `/api/hubs/${f.created.hub.id}/computers`, "/api/hubs/:id/computers");
    await f.request("hub", "GET", `/api/v1/computers/${f.created.computer.id}/api/me`, "/api/v1/computers/:computerId/api/me");
    await f.request("hub", "GET", `/api/agents/${f.created.agent.id}/shares`, "/api/agents/:id/shares");
    await f.request("hub", "PUT", `/api/agents/${f.created.agent.id}/shares/bob`, "/api/agents/:id/shares/:userId", { role: "viewer" });
    await f.call("workspace-access", { computerId: f.created.computer.id, userId: "bob", access: "read", paths: ["allowed"], git: true });
    await f.request("hub", "GET", `/api/resources/computer/${f.created.computer.id}/members`, "/api/resources/:kind/:id/members");
    await f.request("hub", "PUT", `/api/resources/computer/${f.created.computer.id}/policy`, "/api/resources/:kind/:id/policy", { policy: "retain" });
    await f.request("hub", "POST", `/api/resources/computer/${f.created.computer.id}/owner`, "/api/resources/:kind/:id/owner", { ownerId: "alice" });
    await f.request("hub", "POST", `/api/hubs/${f.created.hub.id}/computers`, "/api/hubs/:id/computers", { name: "Additional owned Computer" });
    await f.request("hub", "POST", `/api/hubs/${f.created.hub.id}/computers`, "/api/hubs/:id/computers", { name: "Other member's Computer", ownerId: "bob" });
    await f.request("identity", "GET", "/api/v1/auth/options", "/api/v1/auth/options");
    await f.request("identity", "GET", "/api/v1/me", "/api/v1/me");
    await f.request("identity", "GET", "/api/v1/me/hubs", "/api/v1/me/hubs");
    await f.request("identity", "GET", "/api/v1/me/computers", "/api/v1/me/computers");
    const before = f.store.read().agents.length;
    const directory = await f.request("identity", "POST", "/api/v1/me/agents", "/api/v1/me/agents");
    assert.ok(directory.agents.some((agent: any) => agent.id === f.created.agent.id)); assert.equal(f.store.read().agents.length, before);
    await f.request("identity", "POST", "/api/v1/hub-token", "/api/v1/hub-token", { hubId: f.created.hub.id });
    await f.request("identity", "PUT", `/api/v1/hubs/${f.created.hub.id}/auth-requirement`, "/api/v1/hubs/:id/auth-requirement", { rule: { method: "password", maxAgeSeconds: 3600 } });
    const enrollment = await f.request("identity", "POST", `/api/v1/hubs/${f.created.hub.id}/computers`, "/api/v1/hubs/:id/computers", { name: "Enrollment" });
    await f.request("identity", "POST", "/api/v1/pairing/redeem", "/api/v1/pairing/redeem", { code: enrollment.enrollment.code });
    const challenge = await f.request("identity", "POST", "/api/v1/auth/code", "/api/v1/auth/code", { method: "email", target: "linked@admin.invalid", link: true });
    await f.request("identity", "POST", "/api/v1/auth/code/verify", "/api/v1/auth/code/verify", { challengeId: challenge.challengeId, transaction: challenge.transaction, code: f.delivered.at(-1), installationId: "linked-email" });
    const profile = await f.request("identity", "GET", "/api/v1/me", "/api/v1/me"); assert.equal(profile.identities.length, 1);
    await f.request("identity", "DELETE", `/api/v1/me/identities/${profile.identities[0].id}`, "/api/v1/me/identities/:id");
    const invitation = await f.call("invite", { kind: "computer", id: f.created.computer.id, email: "bob@admin.invalid", role: "viewer" });
    await f.request("hub", "POST", "/api/invitations/accept", "/api/invitations/accept", { token: invitation.token }, "bob");
    const another = await f.call("invite", { kind: "computer", id: f.created.computer.id, email: "bob@admin.invalid", role: "operator" });
    await f.request("identity", "POST", "/api/v1/invitations/accept", "/api/v1/invitations/accept", { token: another.token }, "bob");
    await f.request("hub", "DELETE", `/api/resources/computer/${f.created.computer.id}/members/bob`, "/api/resources/:kind/:id/members/:memberId");
    await f.request("identity", "GET", "/.well-known/jwks.json", "/.well-known/jwks.json");
    await f.request("identity", "GET", `/agent-settings/?settings=${f.created.agent.id}`, "/agent-settings/");
    const assets = await readdir("dist/web/assets");
    for (const extension of ["js", "css"]) {
      const file = assets.find(file => file.endsWith("." + extension));
      assert.ok(file, "A built " + extension + " management asset exists");
      const asset = await f.local.identity.inject({ method: "GET", url: "/management-assets/" + file });
      assert.equal(asset.statusCode, 200, "Management assets are public static bytes");
      const type = extension === "css" ? "text/css" : "text/javascript";
      assert.equal(String(asset.headers["content-type"]).split(";")[0], type);
      assert.equal(registeredContract("identity").find(e => e.path === "/management-assets/:file")!.auth, "public");
      await publishedResponse("identity", "GET", "/management-assets/:file", 200, type, asset.body);
      observations.push({ component: "independent-public-asset", method: "GET", path: "/management-assets/:file", status: 200 });
    }
    await f.request("identity", "GET", "/appearance/app.css", "/appearance/app.css");
    await f.request("identity", "GET", "/appearance/favicon.svg", "/appearance/favicon.svg");
    const query = new URLSearchParams({ client_id: "admin-client", redirect_uri: "https://admin-native.test/callback", state: "admin-state-".repeat(3), code_challenge: createHash("sha256").update("v".repeat(43)).digest("base64url"), code_challenge_method: "S256", response_type: "code" });
    const redirect = await f.local.identity.inject({ method: "GET", url: "/oauth/authorize?" + query, headers: { cookie: "codoxear_identity_" + f.created.hub.id + "=" + f.signed.alice!.credential } });
    assert.equal(redirect.statusCode, 302); assert.equal(new URL(String(redirect.headers.location)).origin, "https://admin-native.test"); assert.equal(redirect.body, "");
    const redirectContract = (await document("identity")).paths["/oauth/authorize"].get.responses[302];
    assert.ok(redirectContract.headers.Location); assert.equal(redirectContract.content, undefined);
    const invalidAsset = await f.local.identity.inject({ method: "GET", url: "/management-assets/invalid.txt" });
    assert.equal(invalidAsset.statusCode, 404);
    await publishedResponse("identity", "GET", "/management-assets/:file", 404, "application/json", invalidAsset.json());
    observations.push({ component: "independent-identity", method: "GET", path: "/oauth/authorize", status: 302 });
  } finally { await f.close(); }
});
test("all authority dispatcher operations have their own argument and actual unwrapped response schema", async () => {
  const f = await fixture(true);
  try {
    for (const op of ["notification-session", "me", "hub", "computers"]) await f.call(op);
    for (const op of ["notification-subject", "computer-owner", "agents", "pair"]) await f.call(op, { computerId: f.created.computer.id });
    await f.call("authorize", { agentId: f.created.agent.id, action: "read" });
    await f.call("relay", { computerId: f.created.computer.id, method: "GET", path: "/api/settings/voice" });
    await f.call("relay", { computerId: f.created.computer.id, method: "GET", path: "/api/sessions/admin-local/file/read?path=allowed" });
    const permit = await f.call("queue-permit", { computerId: f.created.computer.id, path: "/api/sessions/admin-local/enqueue" });
    const device = await f.local.client.device(f.created.computer.id, f.created.credential); registeredContract("identity").find(e => e.path === "/internal/device")!.response!.parse(device);
    await publishedResponse("internal", "POST", "/internal/device", 200, "application/json", device);
    const target = await f.local.client.request("/internal/notification-target", { hubId: f.created.hub.id, computerId: f.created.computer.id, credential: f.created.credential, localId: "admin-local" }); registeredContract("identity").find(e => e.path === "/internal/notification-target")!.response!.parse(target);
    await publishedResponse("internal", "POST", "/internal/notification-target", 200, "application/json", target);
    const authorization = await f.local.client.request("/internal/queue-authorize", { hubId: f.created.hub.id, computerId: f.created.computer.id, credential: f.created.credential, localId: "admin-local", permit: permit.queuePermit }); RelayAuthorization.parse(authorization);
    await publishedResponse("internal", "POST", "/internal/queue-authorize", 200, "application/json", authorization);
    const download = await f.local.client.request("/internal/download-authorize", { hubId: f.created.hub.id, sessionId: f.signed.alice!.session.id, agentId: f.created.agent.id, computerId: f.created.computer.id, binding: f.created.computer.binding, path: "/api/sessions/admin-local/file/download?path=allowed" }); RelayAuthorization.parse(download);
    await publishedResponse("internal", "POST", "/internal/download-authorize", 200, "application/json", download);
    await f.call("members", { kind: "computer", id: f.created.computer.id });
    await f.call("agent-shares", { agentId: f.created.agent.id });
    await f.call("agent-share", { agentId: f.created.agent.id, userId: "bob", role: "viewer" });
    await f.call("workspace-access", { computerId: f.created.computer.id, userId: "bob", access: "read", paths: ["allowed"], uploads: true });
    const imported = await f.call("import-agent", { computerId: f.created.computer.id, localId: "admin-import", name: "Imported", backend: "fixture" });
    assert.equal(imported.state, "ready");
    await f.call("create-agent", { computerId: f.created.computer.id, name: "Reserved", backend: "fixture" });
    await f.call("create-computer", { name: "Created" });
    const invitation = await f.call("invite", { kind: "computer", id: f.created.computer.id, email: "bob@admin.invalid", role: "viewer" });
    await f.call("accept", { token: invitation.token }, "bob");
    await f.call("remove", { kind: "computer", id: f.created.computer.id, memberId: "bob" });
    await f.call("policy", { kind: "computer", id: f.created.computer.id, policy: "read_only" });
    await f.call("owner", { kind: "computer", id: f.created.computer.id, ownerId: "alice" });
    await f.call("forget-deleted-agent", { computerId: f.created.computer.id, localId: imported.localId });
    assert.equal(InternalCallRequest.safeParse({ op: "unknown-operation", args: {} }).success, false);
    assert.equal(InternalCallRequest.safeParse({ op: "authorize", args: {} }).success, false);
    const bearer = (await f.local.authority.hubToken(f.signed.alice!.session, f.created.hub.id)).accessToken;
    await assert.rejects(f.local.client.call(bearer, "unknown-operation"), /Unknown authority operation/);
    const seen = new Set(observations.filter(row => row.operation).map(row => row.operation));
    assert.deepEqual([...seen].sort(), Object.keys(adminOperationSchemas).sort());
  } finally { await f.close(); }
});
test("shared-authority compatibility publishes precise registration, admission, account directory and transfer receipts", async () => {
  const f = await fixture(false);
  try {
    const target = await f.request("identity", "POST", "/api/v1/hubs", "/api/v1/hubs", { name: "Target shared Hub" });
    await f.request("identity", "POST", `/api/v1/hubs/${target.id}/register`, "/api/v1/hubs/:id/register", { origin: "https://admin-target.test" });
    await f.request("identity", "GET", "/api/v1/me/hubs", "/api/v1/me/hubs");
    await f.request("identity", "POST", `/api/v1/hubs/${target.id}/admissions`, "/api/v1/hubs/:id/admissions", { computerId: f.created.computer.id });
    await f.request("hub", "GET", "/api/me", "/api/me");
    await f.request("hub", "GET", "/api/hubs", "/api/hubs");
    await f.request("hub", "GET", "/api/v1/computers", "/api/v1/computers");
    await f.request("identity", "POST", `/api/v1/computers/${f.created.computer.id}/transfer`, "/api/v1/computers/:id/transfer", { targetHubId: target.id, exposeHistory: false });
  } finally { await f.close(); }
});
test("account and authorization schemas reject missing structured fields and private signing-key material", () => {
  assert.equal(AccountProfile.safeParse({ id: "alice", name: "Alice", email: "alice@admin.invalid", context: {}, identities: [] }).success, false);
  assert.equal(RelayAuthorization.safeParse({ actorId: "alice", action: "read" }).success, false);
  assert.equal(MemberWorkspaceGrant.safeParse({ computerId: "computer", userId: "bob", workspaceId: "default", access: "read" }).success, false);
  assert.equal(PublicSigningKeys.safeParse({ keys: [{ kty: "OKP", crv: "Ed25519", x: "public", kid: "key", alg: "EdDSA", use: "sig", d: "private" }] }).success, false);
  for (const schema of [AccountProfile, RelayAuthorization, MemberWorkspaceGrant, InternalCallRequest, InternalCallSuccess]) assert.ok(z.toJSONSchema(schema, { unrepresentable: "any" }).anyOf || z.toJSONSchema(schema, { unrepresentable: "any" }).properties);
});
test.after(async () => { await mkdir("artifacts", { recursive: true }); await writeFile("artifacts/protocol-admin-conformance-results.json", JSON.stringify({ publishedSchemaValidations, observations, runtime: "actual independent Hub and optional shared authority handlers; no native execution required for administrative responses" }, null, 2)); });
