import {
  type State,
  type Role,
  requireValue,
  forbid,
} from "../contracts/model.js";
import { audit } from "./commands.js";
import { hubAccess, computerRole, agentAccess } from "./policy.js";

function ownedAgent(s: State, actorId: string, agentId: string) {
  const agent = requireValue(s.agents.find((a) => a.id === agentId));
  const computer = requireValue(
    s.computers.find(
      (c) => c.id === agent.computerId && c.hubId === agent.hubId,
    ),
  );
  const hub = requireValue(s.hubs.find((h) => h.id === agent.hubId));
  forbid(
    computer.ownerId === actorId && hubAccess(s, actorId, hub),
    "Only the computer owner can share this agent",
  );
  return { agent, computer, hub };
}

export function agentShares(s: State, actorId: string, agentId: string) {
  const { agent, computer, hub } = ownedAgent(s, actorId, agentId);
  return {
    members: s.users
      .filter((u) => u.id !== actorId && hubAccess(s, u.id, hub))
      .map((u) => ({
        userId: u.id,
        name: u.name,
        computerRole: computerRole(s, u.id, computer),
        access: agentAccess(s, u.id, agent),
        role:
          s.agentGrants.find(
            (g) =>
              g.agentId === agentId &&
              g.userId === u.id &&
              g.binding === computer.binding &&
              g.ownerRevision === computer.revision,
          )?.role ?? null,
      })),
  };
}

export function setAgentShare(
  s: State,
  actorId: string,
  agentId: string,
  userId: string,
  role: Role | null,
) {
  const { agent, computer, hub } = ownedAgent(s, actorId, agentId);
  forbid(userId !== actorId, "The computer owner already controls this agent");
  requireValue(s.users.find((u) => u.id === userId));
  if (role !== null)
    forbid(
      hubAccess(s, userId, hub),
      "Invite this person to the hub before sharing an agent",
    );
  s.agentGrants = s.agentGrants.filter(
    (g) => !(g.agentId === agentId && g.userId === userId),
  );
  // Explicit revocation overrides historical retention for this concrete agent.
  s.priorGrants = s.priorGrants.filter(
    (g) => !(g.agentId === agentId && g.userId === userId),
  );
  if (role !== null)
    s.agentGrants.push({
      agentId,
      userId,
      role,
      binding: computer.binding,
      ownerRevision: computer.revision,
    });
  audit(
    s,
    actorId,
    role === null ? "agent.share.revoke" : "agent.share.set",
    agentId,
  );
  return { ok: true, access: agentAccess(s, userId, agent) };
}
