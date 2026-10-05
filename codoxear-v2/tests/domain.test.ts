import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emptyState, type Policy } from "../src/contracts/model.js";
import {
  createHub,
  createComputer,
  reserveAgent,
  invite,
  acceptInvite,
  removeMember,
  transferOwner,
  setPolicy,
} from "../src/domain/commands.js";
import { agentAccess, canCreate } from "../src/domain/policy.js";
import { Store } from "../src/persistence/store.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Run behavioral tests in Docker");
function fixture() {
  const s = emptyState();
  for (const name of ["alice", "bob", "eve"])
    s.users.push({
      id: name,
      email: name + "@example.test",
      name,
      passwordHash: "test",
      disabled: false,
    });
  const h = createHub(s, "alice", "Hub"),
    { computer: c } = createComputer(s, "alice", h.id, "Computer", "alice");
  return { s, h, c };
}
function joinResource(
  f: ReturnType<typeof fixture>,
  kind: "hub" | "computer",
  role: "viewer" | "operator" = "operator",
) {
  const { token } = invite(
    f.s,
    "alice",
    kind,
    kind === "hub" ? f.h.id : f.c.id,
    "bob@example.test",
    role,
  );
  acceptInvite(f.s, "bob", token);
}
for (const hub of [null, "retain", "read_only", "none"] as const)
  for (const computer of [null, "retain", "read_only", "none"] as const)
    for (const role of ["viewer", "operator"] as const) {
      test(`revocation hub=${hub} computer=${computer} role=${role}`, () => {
        const f = fixture();
        joinResource(f, "hub");
        joinResource(f, "computer", role);
        const a = reserveAgent(f.s, "alice", f.c.id, "Existing", "fixture");
        f.h.policy = hub;
        f.c.policy = computer;
        removeMember(f.s, "alice", "computer", f.c.id, "bob");
        const policy: Policy = hub ?? computer ?? "none";
        assert.deepEqual(
          agentAccess(f.s, "bob", a).actions,
          policy === "none"
            ? []
            : policy === "read_only" || role === "viewer"
              ? ["read"]
              : ["read", "send", "interrupt"],
        );
        assert.equal(canCreate(f.s, "bob", f.c), false);
        const future = reserveAgent(f.s, "alice", f.c.id, "Future", "fixture");
        assert.deepEqual(agentAccess(f.s, "bob", future).actions, []);
        removeMember(f.s, "alice", "hub", f.h.id, "bob");
        assert.deepEqual(agentAccess(f.s, "bob", a).actions, []);
      });
    }
test("creation requires both memberships; hub owner cannot control another owner’s computer", () => {
  const f = fixture();
  joinResource(f, "computer");
  assert.equal(canCreate(f.s, "bob", f.c), false);
  joinResource(f, "hub");
  assert.equal(canCreate(f.s, "bob", f.c), true);
  transferOwner(f.s, "alice", "computer", f.c.id, "bob");
  removeMember(f.s, "bob", "computer", f.c.id, "alice");
  assert.equal(canCreate(f.s, "alice", f.c), false);
  assert.throws(() => setPolicy(f.s, "alice", "computer", f.c.id, "retain"));
  assert.equal(f.c.ownerId, "bob");
  assert.throws(() => removeMember(f.s, "bob", "computer", f.c.id, "bob"));
});
test("invitations are recipient-bound, single-use and invalid after ownership transfer", () => {
  const f = fixture();
  const first = invite(
    f.s,
    "alice",
    "hub",
    f.h.id,
    "bob@example.test",
    "operator",
  );
  assert.throws(() => acceptInvite(f.s, "eve", first.token));
  acceptInvite(f.s, "bob", first.token);
  assert.throws(() => acceptInvite(f.s, "bob", first.token));
  const pending = invite(
    f.s,
    "alice",
    "hub",
    f.h.id,
    "eve@example.test",
    "viewer",
  );
  transferOwner(f.s, "alice", "hub", f.h.id, "bob");
  assert.throws(() => acceptInvite(f.s, "eve", pending.token));
  assert.equal(f.h.ownerId, "bob");
});
test("transaction rollback and reopen preserve ownership", () => {
  const dir = mkdtempSync(join(tmpdir(), "catalog-")),
    path = join(dir, "state.sqlite");
  let store = new Store(path);
  store.change((s) => Object.assign(s, fixture().s));
  assert.throws(() =>
    store.change((s) => {
      s.hubs[0]!.ownerId = "missing";
    }),
  );
  assert.equal(store.read().hubs[0]!.ownerId, "alice");
  store.close();
  store = new Store(path);
  assert.equal(store.read().computers.length, 1);
  store.close();
  rmSync(dir, { recursive: true });
});
test("typed computer API persists one attachment, hides credential, and excludes simultaneous service mutation", async () => {
  const dir = mkdtempSync(join(tmpdir(), "computer-")),
    api = createComputerApi(dir);
  const config = {
    version: 1 as const,
    hubUrl: "http://127.0.0.1:19432",
    hubId: "h",
    computerId: "c",
    credential: "x".repeat(40),
    runtime: "fixture" as const,
  };
  await api.attach(config);
  assert.equal((await api.status()).attached, true);
  assert.equal(
    JSON.stringify(await api.status()).includes(config.credential),
    false,
  );
  await assert.rejects(api.attach({ ...config, hubId: "second" }));
  await assert.rejects(
    api.attach({ ...config, hubUrl: "http://example.test" }),
  );
  const service = api.service();
  await service.start();
  await assert.rejects(api.detach());
  await service.stop();
  await api.detach();
  assert.equal((await api.status()).attached, false);
  rmSync(dir, { recursive: true });
});
