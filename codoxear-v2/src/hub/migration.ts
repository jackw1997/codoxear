import { State } from "../contracts/model.js";
import { IdentityState } from "../auth/model.js";
/** Non-destructive export: each result is a separate hub-owned database.
 * Old shared-authority sessions cannot become trusted local hub sessions. */
export function isolateHub(source: State, hubId: string): State {
  const s = structuredClone(source);
  s.hubs = s.hubs.filter((h) => h.id === hubId);
  if (s.hubs.length !== 1) throw new Error("Hub not found in source snapshot");
  s.computers = s.computers.filter((c) => c.hubId === hubId);
  const computers = new Set(s.computers.map((c) => c.id));
  s.agents = s.agents.filter((a) => a.hubId === hubId);
  const agents = new Set(s.agents.map((a) => a.id));
  const belongs = (kind: string, id: string) =>
    kind === "hub" ? id === hubId : computers.has(id);
  s.memberships = s.memberships.filter((m) =>
    belongs(m.resource, m.resourceId),
  );
  s.priorGrants = s.priorGrants.filter((g) => agents.has(g.agentId));
  s.agentGrants = s.agentGrants.filter((g) => agents.has(g.agentId));
  s.invitations = s.invitations.filter((i) =>
    belongs(i.resource, i.resourceId),
  );
  const users = new Set([
    s.hubs[0]!.ownerId,
    ...s.computers.map((c) => c.ownerId),
    ...s.agents.map((a) => a.creatorId),
    ...s.memberships.map((m) => m.userId),
    ...s.priorGrants.map((g) => g.userId),
    ...s.agentGrants.map((g) => g.userId),
  ]);
  s.users = s.users.filter((u) => users.has(u.id));
  s.identity = IdentityState.parse({
    identities: source.identity.identities.filter((i) => users.has(i.userId)),
    requirements: source.identity.requirements.filter((r) => r.hubId === hubId),
    workspaceGrants: source.identity.workspaceGrants.filter(
      (g) => computers.has(g.computerId) && users.has(g.userId),
    ),
  });
  s.sessions = [];
  s.audit = s.audit.filter(
    (e) =>
      users.has(e.actorId) &&
      (e.resourceId === hubId ||
        computers.has(e.resourceId) ||
        agents.has(e.resourceId)),
  );
  return State.parse(s);
}
