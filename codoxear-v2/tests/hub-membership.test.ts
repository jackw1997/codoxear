import test from "node:test";
import { existsSync } from "node:fs";
import assert from "node:assert/strict";
import { emptyState } from "../src/contracts/model.js";
import {
  createHub,
  createComputer,
  setComputerAccess,
  setHubMemberRole,
  removeMember,
  invite,
  reserveAgent,
} from "../src/domain/commands.js";
import {
  hubRole,
  canCreate,
  agentAccess,
  canManageHub,
} from "../src/domain/policy.js";
assert.ok(existsSync("/.dockerenv"), "Run behavioral tests in Docker");
function fixture() {
  const state = emptyState();
  for (const id of ["owner", "admin", "member", "other"])
    state.users.push({
      id,
      name: id,
      email: id + "@example.test",
      passwordHash: "test",
      disabled: false,
    });
  const hub = createHub(state, "owner", "Hub");
  for (const userId of ["admin", "member", "other"])
    state.memberships.push({
      resource: "hub",
      resourceId: hub.id,
      userId,
      role: "member",
    });
  setHubMemberRole(state, "owner", hub.id, "admin", "admin");
  const { computer } = createComputer(
    state,
    "admin",
    hub.id,
    "Computer",
    "owner",
  );
  return { state, hub, computer };
}
test("Hub administration never implicitly grants Computer execution", () => {
  const { state, hub, computer } = fixture();
  assert.equal(hubRole(state, "admin", hub), "admin");
  assert.equal(canManageHub(state, "admin", hub), true);
  for (const id of ["owner", "admin", "member"])
    assert.equal(canCreate(state, id, computer), false);
  assert.throws(() =>
    reserveAgent(state, "owner", computer.id, "agent", "fixture"),
  );
  setComputerAccess(state, "admin", computer.id, "owner", "write");
  assert.equal(canCreate(state, "owner", computer), true);
});
test("Computer allowlist caps sharing and retained permissions", () => {
  const { state, hub, computer } = fixture();
  setComputerAccess(state, "owner", computer.id, "owner", "write");
  const agent = reserveAgent(state, "owner", computer.id, "agent", "fixture");
  state.agentGrants.push({
    agentId: agent.id,
    userId: "member",
    role: "operator",
    binding: computer.binding,
    ownerRevision: computer.revision,
  });
  state.priorGrants.push({
    agentId: agent.id,
    userId: "member",
    computerId: computer.id,
    actions: ["read", "send", "interrupt"],
    lostAt: Date.now(),
  });
  hub.policy = "retain";
  assert.deepEqual(agentAccess(state, "member", agent).actions, []);
  setComputerAccess(state, "admin", computer.id, "member", "read");
  assert.deepEqual(agentAccess(state, "member", agent).actions, ["read"]);
  removeMember(state, "admin", "computer", computer.id, "member");
  assert.deepEqual(agentAccess(state, "member", agent).actions, []);
});
test("Admins cannot promote or kick admins; owner can demote; kick clears Computer grants", () => {
  const { state, hub, computer } = fixture();
  assert.throws(() =>
    setHubMemberRole(state, "admin", hub.id, "member", "admin"),
  );
  assert.throws(() => removeMember(state, "admin", "hub", hub.id, "owner"));
  assert.throws(() => removeMember(state, "admin", "hub", hub.id, "admin"));
  assert.throws(() =>
    invite(state, "admin", "hub", hub.id, "someone@example.test", "admin"),
  );
  setComputerAccess(state, "admin", computer.id, "member", "write");
  removeMember(state, "admin", "hub", hub.id, "member");
  assert.equal(hubRole(state, "member", hub), null);
  assert.equal(
    state.memberships.some(
      (m) => m.resource === "computer" && m.userId === "member",
    ),
    false,
  );
  setHubMemberRole(state, "owner", hub.id, "admin", "member");
  assert.equal(canManageHub(state, "admin", hub), false);
});
