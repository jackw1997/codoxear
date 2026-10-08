import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { DelegationClient } from "../src/computer/delegation/client.js";
import {
  registerDelegationTool,
  type DelegationTool,
} from "../src/computer/delegation/pi-extension.js";
import { DomainError } from "../src/contracts/model.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const credential = "machine-credential-private-".repeat(2);
const grant = "g".repeat(43);
const receipt = {
  requestId: "request",
  parentId: "parent",
  childId: "child",
  targetComputerId: "target",
  depth: 1,
  state: "ready",
  localId: "native-child",
  createdAt: 1,
  updatedAt: 2,
};
function attachment(hubUrl: string) {
  return {
    version: 1 as const,
    hubUrl,
    hubId: "hub",
    computerId: "source",
    credential,
    runtime: "fixture" as const,
  };
}

test("delegation HTTP client fixes source/parent route and sends capabilities only as headers", async () => {
  const calls: Array<{
    method: string;
    path: string;
    headers: Record<string, unknown>;
    body: unknown;
  }> = [];
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = Buffer.concat(chunks).toString();
    calls.push({
      method: request.method!,
      path: request.url!,
      headers: request.headers,
      body: body ? JSON.parse(body) : null,
    });
    response.setHeader("Content-Type", "application/json");
    response.end(
      JSON.stringify(
        request.method === "GET" && request.url?.endsWith("delegations")
          ? { children: [receipt] }
          : request.url?.endsWith("send") || request.url?.endsWith("interrupt")
            ? { internal: credential, token: grant }
            : receipt,
      ),
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const client = new DelegationClient(
      attachment(`http://127.0.0.1:${address.port}`),
      "parent",
      grant,
    );
    assert.equal(
      (
        await client.spawn({
          requestId: "request",
          targetComputerId: "target",
          backend: "pi",
          name: "Child",
        })
      ).childId,
      "child",
    );
    assert.equal((await client.list()).children.length, 1);
    assert.equal((await client.status("child")).state, "ready");
    assert.deepEqual(await client.send("child", "Continue"), {
      accepted: true,
    });
    assert.deepEqual(await client.interrupt("child"), { accepted: true });
    assert.equal(calls.length, 5);
    for (const call of calls) {
      assert.ok(
        call.path.startsWith(
          "/connect/v1/computers/source/agents/parent/delegations",
        ),
      );
      assert.equal(call.headers.authorization, `Bearer ${credential}`);
      assert.equal(call.headers["x-codoxear-delegation-grant"], grant);
      assert.equal(JSON.stringify(call.body).includes(credential), false);
      assert.equal(JSON.stringify(call.body).includes(grant), false);
    }
    await assert.rejects(client.status("../foreign"));
    assert.equal(calls.length, 5);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("untrusted origins, redirects and oversized responses are refused without retry or credential disclosure", async () => {
  for (const origin of [
    "http://remote.example.test",
    "https://user:password@example.test",
    "https://example.test/path",
    "https://example.test?token=secret",
  ])
    assert.throws(
      () => new DelegationClient(attachment(origin), "parent", grant),
    );
  let calls = 0;
  const redirectClient = new DelegationClient(
    attachment("https://hub.example.test"),
    "parent",
    grant,
    async (_input, init) => {
      calls++;
      assert.equal(init?.redirect, "error");
      assert.ok(init?.signal);
      return new Response("", {
        status: 302,
        headers: { Location: "https://foreign.example.test" },
      });
    },
  );
  await assert.rejects(
    redirectClient.list(),
    (error: unknown) =>
      error instanceof DomainError && error.code === "delegation_redirect",
  );
  assert.equal(calls, 1);
  const largeClient = new DelegationClient(
    attachment("https://hub.example.test"),
    "parent",
    grant,
    async () => new Response(new Uint8Array(256 * 1024 + 1)),
  );
  await assert.rejects(
    largeClient.list(),
    (error: unknown) =>
      error instanceof DomainError &&
      error.code === "delegation_response_limit",
  );
  const unsafeClient = new DelegationClient(
    attachment("https://hub.example.test"),
    "parent",
    grant,
    async () => {
      throw new Error(`Fetch headers ${credential} ${grant}`);
    },
  );
  await assert.rejects(
    unsafeClient.spawn({
      requestId: "request",
      targetComputerId: "target",
      name: "Child",
      backend: "pi",
    }),
    (error: unknown) => {
      assert.ok(error instanceof DomainError);
      assert.equal(error.code, "delegation_transport");
      assert.equal(error.message.includes(credential), false);
      assert.equal(error.message.includes(grant), false);
      assert.match(error.message, /outcome may be unknown/);
      return true;
    },
  );
});

test("Pi installer exposes bounded delegation arguments, never transport credentials", async () => {
  let tool: DelegationTool | undefined;
  let calls = 0;
  const client = new DelegationClient(
    attachment("https://hub.example.test"),
    "parent",
    grant,
    async () => {
      calls++;
      return new Response(
        JSON.stringify({
          code: "forbidden",
          error: `Denied ${credential} ${grant}`,
        }),
        { status: 403 },
      );
    },
  );
  registerDelegationTool(
    {
      registerTool(value) {
        tool = value;
      },
    },
    client,
  );
  assert.ok(tool);
  assert.equal(tool.name, "codoxear_delegate");
  const schema = JSON.stringify(tool.parameters);
  for (const secret of [credential, grant, "hubUrl", "credential", "api_key"])
    assert.equal(schema.includes(secret), false);
  const denied = await tool.execute("call", {
    action: "spawn",
    requestId: "request",
    targetComputerId: "target",
    name: "Child",
    backend: "pi",
  });
  assert.equal(calls, 1);
  assert.equal(JSON.stringify(denied).includes(credential), false);
  assert.equal(JSON.stringify(denied).includes(grant), false);
  const invalid = await tool.execute("call", {
    action: "spawn",
    requestId: "request",
    targetComputerId: "target",
    name: "Child",
    backend: "pi",
    hubUrl: "https://foreign.example.test",
  });
  assert.equal(invalid.details.code, "invalid_request");
  assert.equal(calls, 1);
});
