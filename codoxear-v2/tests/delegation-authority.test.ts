import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { Authority } from "../src/auth/authority.js";
import { Tokens, signingKey } from "../src/auth/tokens.js";
import {
  createHub,
  createComputer,
  reserveAgent,
  passwordHash,
  digest,
} from "../src/domain/commands.js";
import type { DelegationAuthorization } from "../src/contracts/delegation.js";
import { createIdentityApp } from "../src/auth/app.js";
import { createHubApp } from "../src/hub/app.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { HubSessions } from "../src/hub/sessions.js";
import { DelegationStore } from "../src/hub/delegation.js";
import { Tunnels } from "../src/protocol/tunnels.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");

async function fixture() {
  const store = new Store(":memory:");
  const state = store.change((s) => {
    for (const user of ["owner", "operator"])
      s.users.push({
        id: user,
        name: user,
        email: `${user}@example.test`,
        passwordHash: passwordHash("test-password"),
        disabled: false,
      });
    const hub = createHub(s, "owner", "Hub");
    const sourceCreation = createComputer(
      s,
      "owner",
      hub.id,
      "Source",
      "owner",
    );
    const source = sourceCreation.computer;
    const target = createComputer(
      s,
      "owner",
      hub.id,
      "Target",
      "owner",
    ).computer;
    s.memberships.push(
      {
        resource: "hub",
        resourceId: hub.id,
        userId: "operator",
        role: "viewer",
      },
      {
        resource: "computer",
        resourceId: source.id,
        userId: "operator",
        role: "operator",
      },
      {
        resource: "computer",
        resourceId: target.id,
        userId: "operator",
        role: "operator",
      },
    );
    const parent = reserveAgent(s, "operator", source.id, "Parent", "codex");
    parent.state = "ready";
    parent.localId = "native-parent";
    const foreignHub = createHub(s, "owner", "Other Hub");
    const foreign = createComputer(
      s,
      "owner",
      foreignHub.id,
      "Foreign",
      "owner",
    ).computer;
    return {
      hub,
      source,
      sourceCredential: sourceCreation.credential,
      target,
      parent,
      foreign,
    };
  });
  const accounts = new Accounts(store, "private-otp-secret".repeat(4), {
    async send() {
      throw new Error("OTP delivery unavailable in this fixture");
    },
  });
  const signed = accounts.password(
    "operator@example.test",
    "test-password",
    "installation",
  );
  const authority = new Authority(
    store,
    accounts,
    new Tokens("https://hub.example.test", await signingKey()),
  );
  const scope: DelegationAuthorization & { hubId: string } = {
    hubId: state.hub.id,
    actorId: "operator",
    identitySessionId: signed.session.id,
    parentId: state.parent.id,
    sourceComputerId: state.source.id,
    sourceBinding: state.source.binding,
    targetComputerId: state.target.id,
    action: "create",
  };
  return { store, accounts, authority, signed, scope, ...state };
}

test("delegation revalidates native sign-in revocation, target create membership and source binding", async () => {
  const f = await fixture();
  try {
    assert.equal(f.authority.authorizeDelegation(f.scope).actorId, "operator");
    assert.throws(() =>
      f.authority.authorizeDelegation({
        ...f.scope,
        targetComputerId: f.foreign.id,
      }),
    );
    f.store.change((s) => {
      s.memberships = s.memberships.filter((m) => m.resourceId !== f.target.id);
    });
    assert.throws(() => f.authority.authorizeDelegation(f.scope));
    f.store.change((s) => {
      s.memberships.push({
        resource: "computer",
        resourceId: f.target.id,
        userId: "operator",
        role: "operator",
      });
      s.computers.find((c) => c.id === f.source.id)!.binding++;
    });
    assert.throws(() => f.authority.authorizeDelegation(f.scope));
    const freshScope = { ...f.scope, sourceBinding: f.scope.sourceBinding + 1 };
    assert.equal(
      f.authority.authorizeDelegation(freshScope).sourceBinding,
      freshScope.sourceBinding,
    );
    f.accounts.revoke(f.signed.credential);
    assert.throws(() => f.authority.authorizeDelegation(freshScope));
  } finally {
    f.store.close();
  }
});

test("delegated rich launches retain owner authority and reserved child ID commits exactly once", async () => {
  const f = await fixture();
  try {
    assert.throws(() =>
      f.authority.reserveDelegatedAgent({
        ...f.scope,
        agentId: "child",
        name: "Child",
        backend: "codex",
        launch: { cwd: "/private/work" },
      }),
    );
    const args = {
      ...f.scope,
      agentId: "child",
      name: "Child",
      backend: "codex" as const,
    };
    const first = f.authority.reserveDelegatedAgent(args);
    const retry = f.authority.reserveDelegatedAgent(args);
    assert.equal(first.id, "child");
    assert.equal(retry.id, first.id);
    assert.equal(
      f.store.read().agents.filter((a) => a.id === "child").length,
      1,
    );
    assert.equal(
      f.store
        .read()
        .audit.filter(
          (a) => a.action === "agent.create" && a.resourceId === "child",
        ).length,
      1,
    );
    assert.throws(() =>
      f.authority.reserveDelegatedAgent({ ...args, name: "Different" }),
    );
    assert.throws(() =>
      f.authority.authorizeDelegation({
        ...f.scope,
        childId: f.parent.id,
        action: "send",
      }),
    );
  } finally {
    f.store.close();
  }
});

test("real Hub routes use machine credential plus scoped sign-in and refuse native targets before dispatch", async () => {
  const f = await fixture();
  const origin = "https://hub.example.test";
  const hubCredential = "private-hub-service-credential";
  f.store.change((s) => {
    s.identity.hubs.push({
      hubId: f.hub.id,
      origin,
      credentialHash: digest(hubCredential),
      enabled: true,
    });
  });
  const identity = await createIdentityApp({ authority: f.authority });
  const transport: typeof fetch = async (input, init) => {
    const response = await identity.inject({
      method: "POST",
      url: new URL(String(input)).pathname,
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: init?.body as string,
    });
    return new Response(response.body, { status: response.statusCode });
  };
  const client = new AuthorityClient(
    origin,
    f.hub.id,
    hubCredential,
    transport,
  );
  const sessions = new HubSessions(":memory:");
  const delegations = new DelegationStore(":memory:");
  const tunnels = new Tunnels();
  let managed = false,
    requests = 0;
  const installs = new Map<string, { grant: string; expiresAt: number }>();
  tunnels.online = () => true;
  tunnels.supports = (_id, capability) =>
    capability === "managed-runtime"
      ? managed
      : ["launch-receipts", "delegation-tools"].includes(capability);
  tunnels.request = async (_computerId, operation) => {
    if (operation.op === "delegation-install") {
      installs.set(operation.parentId, {
        grant: operation.grant,
        expiresAt: operation.expiresAt,
      });
      return {
        installed: true,
        parentId: operation.parentId,
        localId: operation.localId,
        expiresAt: operation.expiresAt,
        grantDigest: createHash("sha256").update(operation.grant).digest("hex"),
      };
    }
    if (operation.op === "delegation-status") {
      const installed = installs.get(operation.parentId);
      return installed
        ? {
            installed: true,
            expiresAt: installed.expiresAt,
            grantDigest: createHash("sha256")
              .update(installed.grant)
              .digest("hex"),
          }
        : { installed: false };
    }
    if (operation.op === "delegation-revoke") {
      installs.delete(operation.parentId);
      return { installed: false };
    }
    requests++;
    return { localId: "native-child" };
  };
  const hub = await createHubApp({
    origin,
    authority: client,
    sessions,
    delegations,
    tunnels,
  });
  try {
    const token = await f.authority.tokens.issue(f.signed.session, f.hub.id);
    const grantResponse = await hub.inject({
      method: "POST",
      url: `/api/agents/${f.parent.id}/delegation-grants`,
      headers: { authorization: `Bearer ${token}` },
      payload: { targetComputerIds: [f.target.id] },
    });
    assert.equal(grantResponse.statusCode, 200);
    assert.equal("token" in grantResponse.json(), false);
    assert.equal(grantResponse.json().installed, true);
    const grant = installs.get(f.parent.id)!.grant;
    const headers = {
      authorization: `Bearer ${f.sourceCredential}`,
      "x-codoxear-delegation-grant": grant,
    };
    const url = `/connect/v1/computers/${f.source.id}/agents/${f.parent.id}/delegations`;
    const payload = {
      requestId: "request",
      name: "Child",
      backend: "codex",
      targetComputerId: f.target.id,
    };
    const refused = await hub.inject({ method: "POST", url, headers, payload });
    assert.equal(refused.statusCode, 200);
    assert.equal(refused.json().state, "failed");
    assert.match(refused.json().error, /managed-runtime/);
    assert.equal(requests, 0);
    managed = true;
    const ready = await hub.inject({
      method: "POST",
      url,
      headers,
      payload: { ...payload, requestId: "managed" },
    });
    assert.equal(ready.statusCode, 200);
    assert.equal(ready.json().state, "ready");
    assert.equal(
      f.store.read().agents.find((a) => a.id === ready.json().childId)?.localId,
      "native-child",
    );
    assert.equal(requests, 1);
    const retry = await hub.inject({
      method: "POST",
      url,
      headers,
      payload: { ...payload, requestId: "managed" },
    });
    assert.equal(retry.json().childId, ready.json().childId);
    assert.equal(requests, 1);
    f.accounts.revoke(f.signed.credential);
    const revoked = await hub.inject({
      method: "POST",
      url,
      headers,
      payload: { ...payload, requestId: "revoked" },
    });
    assert.equal(revoked.statusCode, 401);
    assert.equal(requests, 1);
  } finally {
    await hub.close();
    await identity.close();
    delegations.close();
    sessions.close();
    f.store.close();
  }
});
