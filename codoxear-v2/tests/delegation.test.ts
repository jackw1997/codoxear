import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import Fastify from "fastify";
import { z } from "zod";
import { DomainError, type Agent } from "../src/contracts/model.js";
import {
  DelegationStore,
  registerDelegationRoutes,
  type DelegationContext,
  type DelegationDependencies,
  type DelegationOutcome,
} from "../src/hub/delegation.js";
import type { DelegationReceipt } from "../src/contracts/delegation.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");

const parent: Agent = {
  id: "parent",
  hubId: "hub",
  computerId: "source",
  creatorId: "user",
  name: "Parent",
  backend: "codex",
  localId: "native-parent",
  state: "ready",
  createdAt: 1,
};
const base = "/connect/v1/computers/source/agents/parent/delegations";
async function fixture(
  path = ":memory:",
  overrides: Partial<DelegationDependencies> = {},
  disableControl = false,
) {
  const app = Fastify();
  const store = new DelegationStore(path);
  let allowed = true,
    binding = 1,
    clock = 1000,
    launches = 0,
    reconciliations = 0;
  let outcome: DelegationOutcome = { state: "ready", localId: "native-child" };
  const controls: unknown[] = [];
  const installations = new Map<string, { grant: string; expiresAt: number }>();
  function context(targetId: string, parentId = "parent"): DelegationContext {
    if (!allowed)
      throw new DomainError(403, "forbidden", "Delegation permission revoked");
    return {
      actorId: "user",
      identitySessionId: "signed-in-session",
      parent: { ...parent, id: parentId },
      target: {
        id: targetId,
        hubId: targetId === "foreign" ? "other-hub" : "hub",
      },
      sourceBinding: binding,
    };
  }
  const deps: DelegationDependencies = {
    hubId: "hub",
    store,
    now: () => clock,
    async authorizeUser(request, parentId, targetId) {
      if (request.headers.authorization !== "Bearer user-token")
        throw new DomainError(
          401,
          "unauthorized",
          "User authentication required",
        );
      return context(targetId, parentId);
    },
    async authorizeParent(request, parentId) {
      if (request.headers.authorization !== "Bearer user-token")
        throw new DomainError(401, "unauthorized", "User required");
      return context("target", parentId);
    },
    async installGrant(_context, input) {
      installations.set(input.parentId, {
        grant: input.grant,
        expiresAt: input.expiresAt,
      });
    },
    async checkInstallation(context) {
      const installed = installations.get(context.parent.id);
      return installed
        ? {
            installed: true,
            expiresAt: installed.expiresAt,
            grantDigest: createHash("sha256")
              .update(installed.grant)
              .digest("hex"),
          }
        : { installed: false };
    },
    async revokeInstallation(context) {
      installations.delete(context.parent.id);
    },
    async childContext(grant, childId, targetId) {
      const child = store.child(grant.actorId, grant.parentId, childId)!;
      const childContext = context(targetId, childId);
      childContext.parent = {
        ...childContext.parent,
        computerId: child.targetComputerId,
        localId: child.localId,
      };
      return childContext;
    },
    async authenticateComputer(request, computerId) {
      if (request.headers.authorization !== "Bearer machine-secret")
        throw new DomainError(
          401,
          "unauthorized",
          "Computer authentication required",
        );
      return { computerId, hubId: "hub", binding };
    },
    async authorizeGrant(grant, targetId) {
      const current = context(targetId, grant.parentId);
      current.parent = {
        ...current.parent,
        computerId: grant.sourceComputerId,
        localId: grant.parentId === "parent" ? "native-parent" : "native-child",
      };
      return current;
    },
    async launch() {
      launches++;
      return outcome;
    },
    async reconcile() {
      reconciliations++;
      return outcome;
    },
    async control(_ctx, receipt, input) {
      controls.push({ childId: receipt.childId, ...input });
      return { accepted: true };
    },
    async readMessages() {
      return {
        messages: [
          { id: "answer", role: "assistant", text: "Child answer", at: 1 },
        ],
      };
    },
    ...overrides,
  };
  const install = deps.installGrant!;
  deps.installGrant = async (context, input) => {
    await install(context, input);
    installations.set(input.parentId, {
      grant: input.grant,
      expiresAt: input.expiresAt,
    });
  };
  if (disableControl) delete deps.control;
  registerDelegationRoutes(app, deps);
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof DomainError)
      return reply.code(error.status).send({ code: error.code });
    if (error instanceof z.ZodError)
      return reply.code(400).send({ code: "invalid_request" });
    return reply.code(500).send({ code: "internal_error" });
  });
  async function grant(targetComputerIds = ["target"]) {
    return app.inject({
      method: "POST",
      url: "/api/agents/parent/delegation-grants",
      headers: { authorization: "Bearer user-token" },
      payload: { targetComputerIds },
    });
  }
  async function issue() {
    const response = await grant();
    assert.equal(response.statusCode, 200);
    assert.equal(response.json().installed, true);
    assert.equal("token" in response.json(), false);
    return installations.get("parent")!.grant;
  }
  function headers(token: string) {
    return {
      authorization: "Bearer machine-secret",
      "x-codoxear-delegation-grant": token,
    };
  }
  async function spawn(token: string, requestId = "request", options = {}) {
    return app.inject({
      method: "POST",
      url: base,
      headers: headers(token),
      payload: {
        requestId,
        targetComputerId: "target",
        name: "Child",
        backend: "codex",
        ...options,
      },
    });
  }
  return {
    app,
    store,
    grant,
    issue,
    headers,
    spawn,
    controls,
    installations,
    stats: () => ({ launches, reconciliations }),
    setOutcome: (value: DelegationOutcome) => {
      outcome = value;
    },
    revokeAuthority: () => {
      allowed = false;
    },
    rebind: () => {
      binding++;
    },
    expire: () => {
      clock += 900_001;
    },
    async close() {
      await app.close();
      store.close();
    },
  };
}

test("delegation requires both Computer authentication and a parent scoped grant; rejects foreign targets", async () => {
  const f = await fixture();
  try {
    assert.equal((await f.grant(["foreign"])).statusCode, 403);
    const token = await f.issue();
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: base,
          headers: { authorization: "Bearer machine-secret" },
          payload: {
            requestId: "r",
            targetComputerId: "target",
            backend: "codex",
            name: "Child",
          },
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (await f.spawn(token, "r", { targetComputerId: "unapproved" }))
        .statusCode,
      403,
    );
    assert.equal(
      (await f.spawn(token, "r", { hubId: "other" })).statusCode,
      400,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: base.replace("source", "other"),
          headers: f.headers(token),
        })
      ).statusCode,
      403,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: base.replace("parent", "other-parent"),
          headers: f.headers(token),
        })
      ).statusCode,
      403,
    );
    assert.equal(f.stats().launches, 0);
  } finally {
    await f.close();
  }
});

test("concurrent identical spawn retries reserve one child and dispatch once; conflicts refuse a second launch", async () => {
  let resolveLaunch!: (value: DelegationOutcome) => void;
  let started!: () => void;
  const entered = new Promise<void>((resolve) => {
    started = resolve;
  });
  let count = 0;
  const f = await fixture(":memory:", {
    async launch() {
      count++;
      started();
      return new Promise((resolve) => {
        resolveLaunch = resolve;
      });
    },
    async reconcile() {
      return { state: "unknown" };
    },
  });
  try {
    const token = await f.issue();
    const first = f.spawn(token);
    await entered;
    const second = await f.spawn(token);
    assert.equal(second.statusCode, 200);
    assert.equal(second.json().state, "unknown");
    resolveLaunch({ state: "ready", localId: "native" });
    const initial = await first;
    assert.equal(initial.json().childId, second.json().childId);
    assert.equal(initial.json().state, "ready");
    assert.equal(
      (await f.spawn(token, "request", { name: "Different" })).statusCode,
      409,
    );
    assert.equal(count, 1);
  } finally {
    await f.close();
  }
});

test("Hub restart preserves unknown receipt and reconciles without repeating create", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delegation-restart-"));
  const path = join(dir, "receipts.sqlite");
  let f = await fixture(path);
  try {
    const token = await f.issue();
    f.setOutcome({ state: "unknown" });
    const original = (await f.spawn(token)).json() as DelegationReceipt;
    assert.equal(original.state, "unknown");
    await f.close();
    f = await fixture(path);
    const retry = (await f.spawn(token)).json() as DelegationReceipt;
    assert.equal(retry.childId, original.childId);
    assert.equal(retry.state, "ready");
    assert.deepEqual(f.stats(), { launches: 0, reconciliations: 1 });
  } finally {
    await f.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("policy revocation, source transfer and expiry block retries and child controls", async () => {
  for (const change of ["revokeAuthority", "rebind", "expire"] as const) {
    const f = await fixture();
    try {
      const token = await f.issue();
      const child = (await f.spawn(token)).json().childId;
      f[change]();
      assert.equal((await f.spawn(token)).statusCode, 403);
      assert.equal(
        (
          await f.app.inject({
            method: "POST",
            url: `${base}/${child}/send`,
            headers: f.headers(token),
            payload: { text: "Continue" },
          })
        ).statusCode,
        403,
      );
      assert.equal(f.controls.length, 0);
      assert.equal(f.stats().launches, 1);
    } finally {
      await f.close();
    }
  }
});

test("list and controls only address durable children of the grant parent", async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    const child = (await f.spawn(token)).json().childId;
    const list = await f.app.inject({
      method: "GET",
      url: base,
      headers: f.headers(token),
    });
    assert.equal(list.json().children[0].childId, child);
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/unrelated/send`,
          headers: f.headers(token),
          payload: { text: "Secret" },
        })
      ).statusCode,
      404,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/${child}/send`,
          headers: f.headers(token),
          payload: { text: "Continue" },
        })
      ).statusCode,
      200,
    );
    assert.equal(
      (
        await f.app.inject({
          method: "POST",
          url: `${base}/${child}/interrupt`,
          headers: f.headers(token),
          payload: {},
        })
      ).statusCode,
      200,
    );
    assert.deepEqual(f.controls, [
      { childId: child, action: "send", text: "Continue" },
      { childId: child, action: "interrupt" },
    ]);
  } finally {
    await f.close();
  }
});

test("parent child limit is durable across principals; child depth is derived by Hub", async () => {
  const f = await fixture(":memory:", { maxChildren: 1, maxDepth: 1 });
  try {
    const token = await f.issue();
    const receipt = (await f.spawn(token)).json() as DelegationReceipt;
    assert.equal(receipt.depth, 1);
    assert.equal((await f.spawn(token, "second")).statusCode, 409);
    assert.equal((await f.spawn(token)).statusCode, 200);
    // A browser cannot provide a forged root depth for this child.
    const response = await f.app.inject({
      method: "POST",
      url: `/api/agents/${receipt.childId}/delegation-grants`,
      headers: { authorization: "Bearer user-token" },
      payload: { targetComputerIds: ["target"] },
    });
    assert.equal(response.statusCode, 409);
    assert.equal(f.stats().launches, 1);
  } finally {
    await f.close();
  }
});

test("receipt persistence stores no capability token or provider API key", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delegation-secrets-"));
  const path = join(dir, "receipts.sqlite");
  const f = await fixture(path);
  const token = await f.issue();
  try {
    await f.spawn(token, "secret-request", {
      launch: { provider_config: { api_key: "private-provider-key" } },
    });
  } finally {
    await f.close();
  }
  try {
    const bytes = (await readFile(path)).toString();
    assert.equal(bytes.includes(token), false);
    assert.equal(bytes.includes("private-provider-key"), false);
    assert.equal(bytes.includes("user-token"), false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite claims fence independent Hub processes and late results cannot erase ready state", async () => {
  const dir = await mkdtemp(join(tmpdir(), "delegation-claim-"));
  const first = new DelegationStore(join(dir, "receipts.sqlite"));
  const second = new DelegationStore(join(dir, "receipts.sqlite"));
  try {
    const input = {
      requestId: "request",
      targetComputerId: "target",
      name: "Child",
      backend: "codex" as const,
    };
    const receipt = first.reserve("actor-a", "parent", input, 1, 1, 1);
    assert.equal(
      second.reserve("actor-a", "parent", input, 2, 1, 1).childId,
      receipt.childId,
    );
    assert.equal(first.claim("actor-a", receipt, 2), true);
    assert.equal(second.claim("actor-a", receipt, 3), false);
    assert.equal(second.child("actor-b", "parent", receipt.childId), null);
    assert.throws(
      () => second.reserve("actor-b", "parent", input, 3, 1, 1),
      (error: unknown) =>
        error instanceof DomainError && error.code === "delegation_limit",
    );
    first.settle("actor-a", receipt, { state: "ready", localId: "native" }, 4);
    assert.equal(
      second.settle("actor-a", receipt, { state: "unknown" }, 5).state,
      "ready",
    );
    assert.equal(first.parentDepth(receipt.childId), 1);
  } finally {
    first.close();
    second.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("unconfirmed native launches and absent control capabilities refuse controls explicitly", async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    f.setOutcome({ state: "unknown" });
    const childId = (await f.spawn(token)).json().childId;
    const result = await f.app.inject({
      method: "POST",
      url: `${base}/${childId}/interrupt`,
      headers: f.headers(token),
      payload: {},
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().code, "child_not_ready");
    assert.equal(f.controls.length, 0);
  } finally {
    await f.close();
  }
  const noControl = await fixture(":memory:", {}, true);
  try {
    const token = await noControl.issue();
    const childId = (await noControl.spawn(token)).json().childId;
    const result = await noControl.app.inject({
      method: "POST",
      url: `${base}/${childId}/interrupt`,
      headers: noControl.headers(token),
      payload: {},
    });
    assert.equal(result.statusCode, 409);
    assert.equal(result.json().code, "capability_required");
  } finally {
    await noControl.close();
  }
});

test("private grant installation exposes metadata only; live digest and dormant authorization are distinct", async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    const url = "/api/agents/parent/delegation-grants";
    const headers = { authorization: "Bearer user-token" };
    const active = await f.app.inject({ method: "GET", url, headers });
    assert.equal(active.json().installed, true);
    assert.equal(active.json().authorized, true);
    assert.equal(active.body.includes(token), false);
    const installed = f.installations.get("parent")!;
    f.installations.set("parent", {
      ...installed,
      grant: "different-private-grant",
    });
    const mismatch = await f.app.inject({ method: "GET", url, headers });
    assert.equal(mismatch.json().installed, false);
    assert.equal(mismatch.json().authorized, true);
    f.installations.delete("parent");
    const dormant = await f.app.inject({ method: "GET", url, headers });
    assert.equal(dormant.json().installed, false);
    assert.equal(dormant.json().authorized, true);
    const disabled = await f.app.inject({ method: "DELETE", url, headers });
    assert.equal(disabled.json().authorized, false);
    assert.equal((await f.spawn(token)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test("inherited delegation remains downscoped, source-bound and root-expiring; scope replacement revokes descendants", async () => {
  const f = await fixture();
  try {
    const token = await f.issue();
    const rootGrant = f.store.grant(token, 1000)!;
    const response = await f.spawn(token, "pi-child", { backend: "pi" });
    const receipt = response.json() as DelegationReceipt;
    assert.equal(receipt.state, "ready");
    assert.equal(receipt.delegationState, "installed");
    const inheritedToken = f.installations.get(receipt.childId)!.grant;
    const inherited = f.store.grant(inheritedToken, 1000)!;
    assert.equal(inherited.parentId, receipt.childId);
    assert.equal(inherited.sourceComputerId, "target");
    assert.equal(inherited.identitySessionId, rootGrant.identitySessionId);
    assert.equal(inherited.expiresAt, rootGrant.expiresAt);
    assert.deepEqual(inherited.targetComputerIds, rootGrant.targetComputerIds);
    assert.equal(inherited.depth, receipt.depth);
    assert.equal(response.body.includes(inheritedToken), false);
    const childBase = `/connect/v1/computers/target/agents/${receipt.childId}/delegations`;
    const targets = await f.app.inject({
      method: "GET",
      url: childBase + "/targets",
      headers: f.headers(inheritedToken),
    });
    assert.deepEqual(
      targets.json().computers.map((c: { id: string }) => c.id),
      ["target"],
    );
    const wrongSource = await f.app.inject({
      method: "GET",
      url:
        childBase.replace("computers/target", "computers/source") + "/targets",
      headers: f.headers(inheritedToken),
    });
    assert.equal(wrongSource.statusCode, 403);
    const replacement = await f.grant(["second-target"]);
    assert.equal(replacement.statusCode, 200);
    assert.equal(f.store.grant(token, 1000), null);
    assert.equal(f.store.grant(inheritedToken, 1000), null);
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: childBase + "/targets",
          headers: f.headers(inheritedToken),
        })
      ).statusCode,
      403,
    );
  } finally {
    await f.close();
  }
});

test("revocation racing tool delivery cannot resurrect an installed grant or child authority", async () => {
  let entered!: () => void, release!: () => void;
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  let privateToken = "";
  const f = await fixture(":memory:", {
    async installGrant(_context, input) {
      privateToken = input.grant;
      entered();
      await new Promise<void>((resolve) => {
        release = resolve;
      });
    },
  });
  try {
    const enabling = f.grant();
    await started;
    const disabled = await f.app.inject({
      method: "DELETE",
      url: "/api/agents/parent/delegation-grants",
      headers: { authorization: "Bearer user-token" },
    });
    assert.equal(disabled.statusCode, 200);
    release();
    const response = await enabling;
    assert.equal(response.statusCode, 503);
    assert.equal(response.body.includes(privateToken), false);
    assert.equal(f.store.grant(privateToken, 1000), null);
    assert.equal((await f.spawn(privateToken)).statusCode, 403);
  } finally {
    await f.close();
  }
});

test("child launch stays ready after known tool refusal; scoped answer reads are bounded and explicit", async () => {
  const text = '\\"\n😀'.repeat(100_000);
  const f = await fixture(":memory:", {
    async installGrant(context, input) {
      if (context.parent.id !== "parent")
        throw new DomainError(
          409,
          "setup_required",
          "Child backend does not support a delegation tool",
        );
    },
    async readMessages() {
      return {
        messages: [
          { id: "old", role: "user", text: "Task", at: 1 },
          { id: "answer", role: "assistant", text, at: 2 },
        ],
      };
    },
  });
  try {
    const token = await f.issue();
    const receipt = (await f.spawn(token)).json() as DelegationReceipt;
    assert.equal(receipt.state, "ready");
    assert.equal(receipt.delegationState, "unavailable");
    const messages = await f.app.inject({
      method: "GET",
      url: `${base}/${receipt.childId}/messages`,
      headers: f.headers(token),
    });
    assert.equal(messages.statusCode, 200);
    assert.equal(messages.json().truncated, true);
    assert.ok(Buffer.byteLength(messages.body) <= 256 * 1024);
    assert.equal(messages.json().messages.at(-1).role, "assistant");
    assert.ok(messages.json().messages.at(-1).text.length < text.length);
    assert.equal((await f.spawn(token)).json().childId, receipt.childId);
    assert.equal(f.stats().launches, 1);
    assert.equal(
      (
        await f.app.inject({
          method: "GET",
          url: `${base}/unrelated/messages`,
          headers: f.headers(token),
        })
      ).statusCode,
      404,
    );
  } finally {
    await f.close();
  }
});
