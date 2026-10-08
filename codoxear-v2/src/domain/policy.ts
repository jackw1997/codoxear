import {
  type Agent,
  type Computer,
  type Decision,
  type Hub,
  type Role,
  type State,
} from "../contracts/model.js";

export function activeUser(s: State, userId: string): boolean {
  return s.users.some((u) => u.id === userId && !u.disabled);
}
export type HubRole = "owner" | "admin" | "member";
export function hubRole(s: State, userId: string, hub: Hub): HubRole | null {
  if (!activeUser(s, userId)) return null;
  if (hub.ownerId === userId) return "owner";
  const membership = s.memberships.find(
    (m) =>
      m.resource === "hub" && m.resourceId === hub.id && m.userId === userId,
  );
  return membership ? (membership.role === "admin" ? "admin" : "member") : null;
}
export function canManageHub(s: State, userId: string, hub: Hub): boolean {
  const role = hubRole(s, userId, hub);
  return role === "owner" || role === "admin";
}
export function hubAccess(s: State, userId: string, hub: Hub): boolean {
  return hubRole(s, userId, hub) !== null;
}
export function computerRole(
  s: State,
  userId: string,
  computer: Computer,
): Role | null {
  if (!activeUser(s, userId)) return null;
  const role = s.memberships.find(
    (m) =>
      m.resource === "computer" &&
      m.resourceId === computer.id &&
      m.userId === userId,
  )?.role;
  return role === "viewer" || role === "operator" ? role : null;
}
export function canCreate(
  s: State,
  userId: string,
  computer: Computer,
): boolean {
  const hub = s.hubs.find((h) => h.id === computer.hubId);
  return (
    !!hub &&
    hubAccess(s, userId, hub) &&
    computerRole(s, userId, computer) === "operator"
  );
}
export function effectivePolicy(
  hub: Hub,
  computer: Computer,
): {
  policy: "retain" | "read_only" | "none";
  source: "hub" | "computer" | "default";
} {
  if (hub.policy !== null) return { policy: hub.policy, source: "hub" };
  if (computer.policy !== null)
    return { policy: computer.policy, source: "computer" };
  return { policy: "none", source: "default" };
}
export function agentAccess(s: State, userId: string, agent: Agent): Decision {
  const denied = (reason: string): Decision => ({
    actions: [],
    mode: "denied",
    source: "membership",
    reason,
  });
  const hub = s.hubs.find((h) => h.id === agent.hubId);
  const computer = s.computers.find((c) => c.id === agent.computerId);
  if (
    !hub ||
    !computer ||
    computer.hubId !== hub.id ||
    !hubAccess(s, userId, hub)
  )
    return denied("Active hub access is required");
  const role = computerRole(s, userId, computer);
  if (!role) return denied("An explicit Computer allowlist entry is required");
  return {
    actions: role === "operator" ? ["read", "send", "interrupt"] : ["read"],
    mode: "member",
    source: "membership",
    reason:
      role === "operator"
        ? "Computer write allowlist"
        : "Computer read allowlist",
  };
}
