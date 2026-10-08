import test from "node:test";
import assert from "node:assert/strict";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { DelegationBridge } from "../src/computer/delegation/bridge.js";
assert.ok(
  existsSync("/.dockerenv"),
  "Delegation bridge behavioral verification runs only in Docker",
);
const localId = "managed-" + "a".repeat(32),
  credential = "private-machine-credential-".repeat(3),
  grant = "g".repeat(43);
async function fixture() {
  const home = mkdtempSync(join(tmpdir(), "delegation-bridge-"));
  const calls: Array<{ path: string; headers: Headers; body: any }> = [];
  const bridge = new DelegationBridge(
    home,
    {
      version: 1,
      hubUrl: "https://hub.example.test",
      hubId: "hub",
      computerId: "source",
      binding: 1,
      credential,
      runtime: "oar",
      oarPermissionPolicy: "locally-trusted",
    },
    async (input, init) => {
      const path = new URL(String(input)).pathname;
      calls.push({
        path,
        headers: new Headers(init?.headers),
        body: init?.body ? JSON.parse(String(init.body)) : null,
      });
      if (path.endsWith("targets"))
        return new Response(
          JSON.stringify({
            computers: [{ id: "target", name: "Target", credential }],
          }),
        );
      return new Response(
        JSON.stringify({
          requestId: "request",
          parentId: "parent",
          childId: "child",
          targetComputerId: "target",
          depth: 1,
          state: "ready",
          localId: "native-child",
          createdAt: 1,
          updatedAt: 2,
          error: credential + grant,
          credential,
          grant,
        }),
      );
    },
  );
  await bridge.start();
  const endpoint = await bridge.prepare(localId);
  const descriptor = JSON.parse(readFileSync(endpoint.descriptor, "utf8")) as {
    socket: string;
    localId: string;
    capability: string;
  };
  const loaded = () =>
    writeFileSync(
      endpoint.descriptor + ".loaded.json",
      JSON.stringify({ localId, capability: descriptor.capability }),
      { mode: 0o600 },
    );
  const call = (request: unknown, capability = descriptor.capability) =>
    new Promise<any>((resolve, reject) => {
      const socket = connect(descriptor.socket);
      let buffer = "";
      socket.setEncoding("utf8");
      socket.on("error", reject);
      socket.on("connect", () =>
        socket.write(JSON.stringify({ localId, capability, request }) + "\n"),
      );
      socket.on("data", (chunk) => {
        buffer += chunk;
        const end = buffer.indexOf("\n");
        if (end >= 0) {
          socket.destroy();
          resolve(JSON.parse(buffer.slice(0, end)));
        }
      });
    });
  return {
    bridge,
    calls,
    home,
    descriptor,
    endpoint,
    loaded,
    call,
    async close() {
      await bridge.close();
      rmSync(home, { recursive: true, force: true });
    },
  };
}
test("private delegation bridge verifies exact tool registration and rejects forged capabilities/expired grants", async () => {
  const f = await fixture();
  try {
    await assert.rejects(
      f.bridge.install({
        parentId: "parent",
        localId,
        grant,
        expiresAt: Date.now() + 60000,
      }),
      /confirmed loading/,
    );
    f.loaded();
    await f.bridge.install({
      parentId: "parent",
      localId,
      grant,
      expiresAt: Date.now() + 60000,
    });
    assert.equal(
      (await f.call({ action: "targets" }, "0".repeat(64))).ok,
      false,
    );
    assert.equal(f.calls.length, 0);
    const result = await f.call({ action: "targets" });
    assert.deepEqual(result.value, {
      computers: [{ id: "target", name: "Target" }],
    });
    assert.equal(
      f.calls[0]!.headers.get("Authorization"),
      `Bearer ${credential}`,
    );
    assert.equal(f.calls[0]!.headers.get("X-Codoxear-Delegation-Grant"), grant);
    assert.equal(JSON.stringify(result).includes(credential), false);
    f.bridge.revoke({ parentId: "parent", localId });
    assert.equal((await f.call({ action: "targets" })).ok, false);
    assert.deepEqual(await f.bridge.status({ parentId: "parent", localId }), {
      installed: false,
    });
    await assert.rejects(
      f.bridge.install({
        parentId: "parent",
        localId,
        grant,
        expiresAt: Date.now() - 1,
      }),
      /expired/,
    );
  } finally {
    await f.close();
  }
});
test("spawn preserves runtime/model/effort/cwd but rejects secret launch fields and reflected Hub credentials", async () => {
  const f = await fixture();
  try {
    f.loaded();
    await f.bridge.install({
      parentId: "parent",
      localId,
      grant,
      expiresAt: Date.now() + 60000,
    });
    const launch = {
      model: "gpt-6-astra",
      reasoning_effort: "high",
      cwd: "/work/project",
    };
    const result = await f.call({
      action: "spawn",
      requestId: "request",
      targetComputerId: "target",
      backend: "codex",
      name: "Review",
      launch,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(f.calls[0]!.body.launch, launch);
    assert.equal(f.calls[0]!.body.backend, "codex");
    assert.equal(JSON.stringify(result).includes(credential), false);
    assert.equal(JSON.stringify(result).includes(grant), false);
    const invalid = await f.call({
      action: "spawn",
      requestId: "request",
      targetComputerId: "target",
      backend: "codex",
      launch: { provider_config: { api_key: "secret" } },
    });
    assert.equal(invalid.ok, false);
    assert.equal(f.calls.length, 1);
    await f.bridge.release(localId);
    assert.deepEqual(await f.bridge.status({ parentId: "parent", localId }), {
      installed: false,
    });
    assert.equal(existsSync(f.endpoint.descriptor), false);
  } finally {
    await f.close();
  }
});
