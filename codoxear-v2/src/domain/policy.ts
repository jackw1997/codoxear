import {
  type Action,
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
export function hubAccess(s: State, userId: string, hub: Hub): boolean {
  return (
    activeUser(s, userId) &&
    (hub.ownerId === userId ||
      s.memberships.some(
        (m) =>
          m.resource === "hub" &&
          m.resourceId === hub.id &&
          m.userId === userId,
      ))
  );
}
export function computerRole(
  s: State,
  userId: string,
  computer: Computer,
): Role | null {
  if (!activeUser(s, userId)) return null;
  if (computer.ownerId === userId) return "operator";
  return (
    s.memberships.find(
      (m) =>
        m.resource === "computer" &&
        m.resourceId === computer.id &&
        m.userId === userId,
    )?.role ?? null
  );
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
  const share = s.agentGrants.find(
    (g) =>
      g.agentId === agent.id &&
      g.userId === userId &&
      g.binding === computer.binding &&
      g.ownerRevision === computer.revision,
  );
  const effectiveRole =
    role === "operator" || share?.role === "operator"
      ? "operator"
      : (role ?? share?.role);
  if (effectiveRole)
    return {
      actions:
        effectiveRole === "operator" ? ["read", "send", "interrupt"] : ["read"],
      mode: role === effectiveRole ? "member" : "shared",
      source: role === effectiveRole ? "membership" : "agent",
      reason:
        role === effectiveRole
          ? role === "operator"
            ? "Computer operator"
            : "Computer viewer"
          : `Shared agent ${effectiveRole}`,
    };
  const prior = s.priorGrants.find(
    (g) =>
      g.userId === userId &&
      g.agentId === agent.id &&
      g.computerId === computer.id,
  );
  if (!prior) return denied("No access to this agent");
  const { policy, source } = effectivePolicy(hub, computer);
  const actions: Action[] =
    policy === "retain"
      ? [...prior.actions]
      : policy === "read_only"
        ? prior.actions.filter((a) => a === "read")
        : [];
  return {
    actions,
    mode:
      actions.length === 0
        ? "denied"
        : policy === "read_only"
          ? "read_only"
          : "retained",
    source,
    reason: `${source} rule: ${policy}`,
  };
}
