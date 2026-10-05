import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { emptyState, State } from "../src/contracts/model.js";
import {
  createHub,
  createComputer,
  reserveAgent,
  invite,
  acceptInvite,
  removeMember,
  transferOwner,
} from "../src/domain/commands.js";
import { setAgentShare, agentShares } from "../src/domain/agent-sharing.js";
import { agentAccess, canCreate } from "../src/domain/policy.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
function fixture() {
  const s = emptyState();
  for (const name of ["alice", "bob", "eve"])
    s.users.push({
      id: name,
      email: `${name}@example.test`,
      name,
      passwordHash: "unused",
      disabled: false,
    });
  const h = createHub(s, "alice", "Hub");
  const { computer: c } = createComputer(s, "alice", h.id, "Laptop", "alice");
  acceptInvite(
    s,
    "bob",
    invite(s, "alice", "hub", h.id, "bob@example.test", "viewer").token,
  );
  const a = reserveAgent(s, "alice", c.id, "Shared", "fixture");
  const other = reserveAgent(s, "alice", c.id, "Private", "fixture");
  return { s, h, c, a, other };
}
test("sharing is concrete, requires hub access and never grants creation or future agents", () => {
  const { s, h, c, a, other } = fixture();
  assert.throws(() => setAgentShare(s, "bob", a.id, "eve", "viewer"));
  assert.throws(() => setAgentShare(s, "alice", a.id, "eve", "viewer"));
  setAgentShare(s, "alice", a.id, "bob", "viewer");
  assert.deepEqual(agentAccess(s, "bob", a).actions, ["read"]);
  assert.equal(agentAccess(s, "bob", a).mode, "shared");
  assert.deepEqual(agentAccess(s, "bob", other).actions, []);
  assert.equal(canCreate(s, "bob", c), false);
  assert.throws(() => reserveAgent(s, "bob", c.id, "Forbidden", "pi"));
  setAgentShare(s, "alice", a.id, "bob", "operator");
  assert.deepEqual(agentAccess(s, "bob", a).actions, [
    "read",
    "send",
    "interrupt",
  ]);
  assert.deepEqual(
    agentAccess(s, "bob", reserveAgent(s, "alice", c.id, "Future", "fixture"))
      .actions,
    [],
  );
  removeMember(s, "alice", "hub", h.id, "bob");
  assert.equal(s.agentGrants.length, 0);
  assert.deepEqual(agentAccess(s, "bob", a).actions, []);
});
test("share role changes and explicit revocation do not inherit retention rights", () => {
  const { s, h, c, a } = fixture();
  h.policy = "retain";
  acceptInvite(
    s,
    "bob",
    invite(s, "alice", "computer", c.id, "bob@example.test", "operator").token,
  );
  removeMember(s, "alice", "computer", c.id, "bob");
  assert.deepEqual(agentAccess(s, "bob", a).actions, [
    "read",
    "send",
    "interrupt",
  ]);
  setAgentShare(s, "alice", a.id, "bob", "viewer");
  assert.deepEqual(agentAccess(s, "bob", a).actions, ["read"]);
  setAgentShare(s, "alice", a.id, "bob", null);
  assert.deepEqual(agentAccess(s, "bob", a).actions, []);
  assert.equal(
    s.priorGrants.some((g) => g.agentId === a.id),
    false,
  );
});
test("shares add to inherited computer membership and are fenced by ownership and binding", () => {
  const { s, c, a } = fixture();
  acceptInvite(
    s,
    "bob",
    invite(s, "alice", "computer", c.id, "bob@example.test", "viewer").token,
  );
  setAgentShare(s, "alice", a.id, "bob", "operator");
  assert.equal(agentAccess(s, "bob", a).mode, "shared");
  setAgentShare(s, "alice", a.id, "bob", null);
  assert.deepEqual(agentAccess(s, "bob", a).actions, ["read"]);
  setAgentShare(s, "alice", a.id, "bob", "operator");
  c.binding++;
  assert.deepEqual(agentAccess(s, "bob", a).actions, ["read"]);
  assert.equal(agentShares(s, "alice", a.id).members[0]?.role, null);
  setAgentShare(s, "alice", a.id, "bob", "operator");
  transferOwner(s, "alice", "computer", c.id, "bob");
  assert.throws(() => agentShares(s, "alice", a.id));
  assert.equal(agentShares(s, "bob", a.id).members[0]?.role, null);
});
test("legacy state loads with no shares; new explicit shares survive a schema reload", () => {
  const { s, a } = fixture();
  const old = JSON.parse(JSON.stringify(s));
  delete old.agentGrants;
  assert.deepEqual(State.parse(old).agentGrants, []);
  setAgentShare(s, "alice", a.id, "bob", "viewer");
  const loaded = State.parse(JSON.parse(JSON.stringify(s)));
  assert.deepEqual(agentAccess(loaded, "bob", loaded.agents[0]!).actions, [
    "read",
  ]);
});
