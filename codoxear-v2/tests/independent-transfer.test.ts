import { createAllowedComputer } from "../scripts/testing/authorized-fixtures.js";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/persistence/store.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import {
  createHub,
  passwordHash,
  digest,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
import { readAttachment } from "../src/computer/config.js";
assert.ok(
  existsSync("/.dockerenv"),
  "Independent transfer behavior runs in Docker",
);
async function fixture(origin: string, userId: string) {
  const store = new Store(":memory:");
  const created = store.change((state) => {
    state.users.push({
      id: userId,
      email: userId + "@example.test",
      name: userId,
      passwordHash: passwordHash("test-password"),
      disabled: false,
    });
    return createAllowedComputer(
      state,
      userId,
      createHub(state, userId, userId + " Hub").id,
      "Transfer Computer",
      userId,
    );
  });
  const local = await independentAuthority({
    origin,
    hubId: created.computer.hubId,
    store,
    otpKey: "transfer-fixture-key".repeat(3),
    secureCookies: false,
  });
  const sessions = new HubSessions(":memory:"),
    tunnels = new Tunnels();
  const app = await createHubApp({
    origin,
    authority: local.client,
    localIdentity: local.identity,
    sessions,
    tunnels,
    webRoot: "/no-assets",
    secureCookies: false,
  });
  const session = local.authority.accounts.password(
    userId + "@example.test",
    "test-password",
    "transfer-test",
  ).session;
  return {
    store,
    created,
    local,
    session,
    app,
    tunnels,
    async close() {
      tunnels.close();
      await app.close();
      await local.identity.close();
      sessions.close();
      store.close();
    },
  };
}
async function transferFixture() {
  const source = await fixture("https://source.example.test", "alice"),
    target = await fixture("https://target.example.test", "bob"),
    home = await mkdtemp(join(tmpdir(), "independent-transfer-")),
    api = createComputerApi(home);
  const initial = {
    version: 1 as const,
    hubUrl: "https://source.example.test",
    hubId: source.created.computer.hubId,
    computerId: source.created.computer.id,
    credential: source.created.credential,
    binding: 1,
    runtime: "native" as const,
    nativeHome: "/retained/native/home",
    nativeStateHome: "/retained/private/state",
    workspacePath: "/retained/workspace",
  };
  await api.attach(initial);
  const pairing = target.local.authority.pairing(
    target.session,
    target.created.computer.id,
  );
  const calls: string[] = [];
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    calls.push(url.origin + url.pathname);
    const app = url.origin === initial.hubUrl ? source.app : target.app;
    const response = await app.inject({
      method: "POST",
      url: url.pathname,
      headers: Object.fromEntries(new Headers(init?.headers)),
      payload: String(init?.body ?? "{}"),
    });
    return new Response(response.body, {
      status: response.statusCode,
      headers: response.headers as Record<string, string>,
    });
  };
  return {
    source,
    target,
    home,
    api,
    initial,
    pairing,
    calls,
    transport,
    input: { hub: "https://target.example.test", code: pairing.code },
    async close() {
      await source.close();
      await target.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
for (const boundary of ["detach", "redeem-transfer"])
  test(`independent transfer retries a lost ${boundary} reply without dual binding or repeated admission`, async () => {
    const f = await transferFixture();
    let lost = false;
    const transport: typeof fetch = async (input, init) => {
      const response = await f.transport(input, init);
      if (!lost && new URL(String(input)).pathname.endsWith("/" + boundary)) {
        lost = true;
        throw Error("reply lost after authoritative commit");
      }
      return response;
    };
    try {
      await assert.rejects(f.api.transfer(f.input, transport), /reply lost/);
      const pending = (await f.api.status()).pendingTransfer;
      assert.ok(pending);
      assert.ok(!JSON.stringify(pending).includes(f.initial.credential));
      assert.throws(
        () =>
          f.source.local.authority.device(
            f.initial.hubId,
            f.initial.computerId,
            f.initial.credential,
          ),
        (error: any) => error.status === 401,
      );
      assert.equal(f.source.store.read().computers[0]!.binding, 2);
      const saved = JSON.parse(
        readFileSync(join(f.home, "transfer.json"), "utf8"),
      );
      if (boundary === "detach") {
        assert.equal(saved.detached, undefined);
        assert.notEqual(
          f.target.store.read().computers[0]!.credentialHash,
          digest(saved.credential),
        );
      } else {
        assert.equal(saved.detached.detached, true);
        assert.equal(saved.admitted, undefined);
        assert.equal(
          f.target.store.read().computers[0]!.credentialHash,
          digest(saved.credential),
        );
      }
      const completed = await f.api.transfer(f.input, transport);
      const attached = await readAttachment(f.home);
      assert.equal(attached!.hubId, f.target.created.computer.hubId);
      assert.equal(attached!.computerId, f.target.created.computer.id);
      assert.equal(attached!.nativeHome, f.initial.nativeHome);
      assert.equal(attached!.nativeStateHome, f.initial.nativeStateHome);
      assert.equal(attached!.workspacePath, f.initial.workspacePath);
      f.target.local.authority.device(
        attached!.hubId,
        attached!.computerId,
        attached!.credential,
      );
      assert.ok(!JSON.stringify(completed).includes(attached!.credential));
      assert.ok(!JSON.stringify(completed).includes(f.initial.credential));
      assert.equal(
        f.source.store
          .read()
          .audit.filter((event) => event.action === "computer.transfer.detach")
          .length,
        1,
      );
      assert.equal(
        f.target.store
          .read()
          .audit.filter((event) => event.action === "computer.transfer.admit")
          .length,
        1,
      );
      assert.equal(
        f.source.store.read().identity.computerDetachReceipts.length,
        1,
      );
      assert.equal(
        f.target.store.read().identity.transferEnrollments.length,
        1,
      );
      assert.equal(existsSync(join(f.home, "transfer.json")), false);
      const priorCalls = f.calls.length;
      assert.deepEqual(await f.api.transfer(f.input, transport), completed);
      assert.equal(f.calls.length, priorCalls);
      // A stale credential can recover its exact recorded receipt only, never
      // revoke a later enrollment or authorize execution with another nonce.
      await assert.rejects(
        f.source.app
          .inject({
            method: "POST",
            url: `/connect/v1/computers/${f.initial.computerId}/detach`,
            headers: { authorization: "Bearer " + f.initial.credential },
            payload: { transferId: "different-transfer" },
          })
          .then((response) => {
            assert.equal(response.statusCode, 401);
            throw Error("rejected");
          }),
        /rejected/,
      );
      assert.throws(() =>
        f.target.local.authority.redeemTransfer(
          f.pairing.code,
          "other-transfer",
          "different-secret".repeat(4),
        ),
      );
      const sourcePairing = f.source.local.authority.pairing(
        f.source.session,
        f.initial.computerId,
      );
      f.source.local.authority.redeem(sourcePairing.code);
      assert.throws(() =>
        f.source.local.authority.detachDevice(
          f.initial.hubId,
          f.initial.computerId,
          f.initial.credential,
          saved.transferId,
        ),
      );
    } finally {
      await f.close();
    }
  });
test("destination admission validation fails before revoking source, and service lock blocks a transfer", async () => {
  const f = await transferFixture();
  try {
    await assert.rejects(
      f.api.transfer({ ...f.input, code: "INVALID8" }, f.transport),
    );
    f.source.local.authority.device(
      f.initial.hubId,
      f.initial.computerId,
      f.initial.credential,
    );
    assert.equal(f.source.store.read().computers[0]!.binding, 1);
    assert.ok(!f.calls.some((call) => call.endsWith("/detach")));
    assert.equal(existsSync(join(f.home, "transfer.json")), false);
    // The lock check itself is exercised through the public API while this
    // exact process owns the documented Computer service lock.
    const { acquireLock } = await import("../src/computer/config.js");
    const unlock = await acquireLock(f.home);
    try {
      await assert.rejects(
        f.api.transfer(f.input, f.transport),
        /already running/,
      );
    } finally {
      await unlock();
    }
    const lostDetach: typeof fetch = async (input, init) => {
      const response = await f.transport(input, init);
      if (new URL(String(input)).pathname.endsWith("/detach"))
        throw Error("Lost detachment receipt");
      return response;
    };
    await assert.rejects(
      f.api.transfer(f.input, lostDetach),
      /Lost detachment/,
    );
    const service = f.api.service();
    await assert.rejects(service.start(), /saved Computer transfer/i);
    const completed = await f.api.transfer(f.input, f.transport);
    assert.ok(completed);
  } finally {
    await f.close();
  }
});
test("a lost source receipt remains recoverable after destination admission renewal", async () => {
  const f = await transferFixture();
  try {
    const lost: typeof fetch = async (input, init) => {
      const response = await f.transport(input, init);
      if (new URL(String(input)).pathname.endsWith("/detach"))
        throw Error("lost source receipt");
      return response;
    };
    await assert.rejects(f.api.transfer(f.input, lost), /lost source receipt/);
    const renewed = f.target.local.authority.pairing(
      f.target.session,
      f.target.created.computer.id,
    );
    await assert.rejects(
      f.api.transfer(f.input, f.transport),
      /saved transfer/,
    );
    assert.equal(
      (await f.api.status()).pendingTransfer!.phase,
      "source-detached",
    );
    assert.equal(f.source.store.read().computers[0]!.binding, 2);
    assert.equal(
      f.target.store
        .read()
        .audit.filter((event) => event.action === "computer.transfer.admit")
        .length,
      0,
    );
    await f.api.transfer({ ...f.input, code: renewed.code }, f.transport);
    assert.equal(
      f.source.store
        .read()
        .audit.filter((event) => event.action === "computer.transfer.detach")
        .length,
      1,
    );
    assert.equal(
      f.target.store
        .read()
        .audit.filter((event) => event.action === "computer.transfer.admit")
        .length,
      1,
    );
  } finally {
    await f.close();
  }
});
