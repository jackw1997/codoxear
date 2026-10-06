import {
  randomBytes,
  randomUUID,
  createHash,
  scryptSync,
  timingSafeEqual,
} from "node:crypto";
import {
  type Hub,
  type Agent,
  type Computer,
  type Policy,
  type Resource,
  type Role,
  type State,
  DomainError,
  forbid,
  requireValue,
} from "../contracts/model.js";
import { InvitationTarget } from "../contracts/invitations.js";
import { agentAccess, canCreate, hubAccess } from "./policy.js";

export const id = (): string => randomUUID();
export const secret = (): string => randomBytes(32).toString("base64url");
export const digest = (value: string): string =>
  createHash("sha256").update(value).digest("hex");
export function passwordHash(password: string): string {
  const salt = secret();
  return `${salt}:${scryptSync(password, salt, 64).toString("hex")}`;
}
export function passwordMatches(password: string, stored: string): boolean {
  const [salt, hash] = stored.split(":");
  if (!salt || !hash) return false;
  const expected = Buffer.from(hash, "hex"),
    actual = scryptSync(password, salt, 64);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}
export function audit(
  s: State,
  actorId: string,
  action: string,
  resourceId: string,
): void {
  s.audit.push({ id: id(), at: Date.now(), actorId, action, resourceId });
  if (s.audit.length > 10_000) s.audit.splice(0, s.audit.length - 10_000);
}
export function resource(s: State, kind: Resource, resourceId: string) {
  return requireValue(
    kind === "hub"
      ? s.hubs.find((h) => h.id === resourceId)
      : s.computers.find((c) => c.id === resourceId),
  );
}
export function createHub(s: State, actorId: string, name: string): Hub {
  forbid(
    s.users.some((u) => u.id === actorId && !u.disabled),
    "Active account required",
  );
  const hub: Hub = {
    id: id(),
    ownerId: actorId,
    name,
    policy: null,
    revision: 0,
  };
  s.hubs.push(hub);
  audit(s, actorId, "hub.create", hub.id);
  return hub;
}
export function createComputer(
  s: State,
  actorId: string,
  hubId: string,
  name: string,
  ownerId: string,
): { computer: Computer; credential: string } {
  const hub = requireValue(s.hubs.find((h) => h.id === hubId));
  forbid(hub.ownerId === actorId, "Only the hub owner can admit a computer");
  forbid(
    hubAccess(s, ownerId, hub),
    "The computer owner needs active hub access",
  );
  const credential = secret(),
    computer: Computer = {
      id: id(),
      hubId,
      ownerId,
      name,
      policy: null,
      credentialHash: digest(credential),
      binding: 1,
      revision: 0,
    };
  s.computers.push(computer);
  audit(s, actorId, "computer.create", computer.id);
  return { computer, credential };
}
export function setPolicy(
  s: State,
  actorId: string,
  kind: Resource,
  resourceId: string,
  policy: Policy | null,
) {
  const r = resource(s, kind, resourceId);
  forbid(
    r.ownerId === actorId,
    "Only this resource’s owner can change its policy",
  );
  r.policy = policy;
  audit(s, actorId, `${kind}.policy`, r.id);
  return r;
}
export function transferOwner(
  s: State,
  actorId: string,
  kind: Resource,
  resourceId: string,
  nextOwnerId: string,
) {
  const r = resource(s, kind, resourceId);
  forbid(
    r.ownerId === actorId,
    "Only the current owner can transfer ownership",
  );
  forbid(
    s.users.some((u) => u.id === nextOwnerId && !u.disabled),
    "The successor must be an active user",
  );
  forbid(
    nextOwnerId === actorId ||
      s.memberships.some(
        (m) =>
          m.resource === kind &&
          m.resourceId === resourceId &&
          m.userId === nextOwnerId,
      ),
    "The successor must already be a member",
  );
  if (kind === "computer") {
    const c = r as Computer;
    forbid(
      hubAccess(
        s,
        nextOwnerId,
        requireValue(s.hubs.find((h) => h.id === c.hubId)),
      ),
      "The successor needs hub access",
    );
  }
  if (nextOwnerId === actorId) return r;
  r.ownerId = nextOwnerId;
  r.revision++;
  s.memberships = s.memberships.filter(
    (m) =>
      !(
        m.resource === kind &&
        m.resourceId === r.id &&
        (m.userId === nextOwnerId || m.userId === actorId)
      ),
  );
  s.memberships.push({
    resource: kind,
    resourceId: r.id,
    userId: actorId,
    role: "operator",
  });
  audit(s, actorId, `${kind}.owner.transfer`, r.id);
  return r;
}
export function invite(
  s: State,
  actorId: string,
  kind: Resource,
  resourceId: string,
  destination: string | InvitationTarget,
  role: Role,
) {
  const r = resource(s, kind, resourceId);
  forbid(
    r.ownerId === actorId,
    "Only this resource’s owner can invite members",
  );
  const target = InvitationTarget.parse(
    typeof destination === "string"
      ? { method: "email", email: destination }
      : destination,
  );
  const token = secret(),
    invitation = {
      id: id(),
      tokenHash: digest(token),
      resource: kind,
      resourceId,
      issuerId: actorId,
      ownerRevision: r.revision,
      ...(target.method === "email" ? { email: target.email } : {}),
      target,
      role,
      expiresAt: Date.now() + 86400000,
      accepted: false,
    };
  s.invitations.push(invitation);
  audit(s, actorId, `${kind}.invite`, r.id);
  return { invitation, token };
}
export function acceptInvite(s: State, actorId: string, token: string) {
  const invitation = requireValue(
    s.invitations.find((i) => i.tokenHash === digest(token)),
    "Invitation not found",
  );
  const actor = requireValue(s.users.find((u) => u.id === actorId));
  const target = invitation.target ?? {
    method: "email" as const,
    email: invitation.email,
  };
  const matches =
    target.method === "email"
      ? actor.email.toLowerCase() === target.email ||
        s.identity.identities.some(
          (i) =>
            i.userId === actorId &&
            i.verifiedAt > 0 &&
            i.email?.toLowerCase() === target.email,
        )
      : s.identity.identities.some(
          (i) =>
            i.userId === actorId &&
            i.verifiedAt > 0 &&
            i.method === target.method &&
            (target.method === "phone"
              ? i.subject === target.phone
              : i.connection === target.connection &&
                i.subject === target.subject &&
                i.tenant === target.tenant),
        );
  forbid(
    !actor.disabled && matches,
    "This invitation belongs to a different verified identity",
  );
  if (invitation.accepted || invitation.expiresAt < Date.now())
    throw new DomainError(
      409,
      "invite_expired",
      "Invitation expired or already used",
    );
  const r = resource(s, invitation.resource, invitation.resourceId);
  forbid(
    r.ownerId === invitation.issuerId &&
      r.revision === invitation.ownerRevision,
    "Invitation owner changed; request a new invitation",
  );
  if (r.ownerId !== actorId) {
    s.memberships = s.memberships.filter(
      (m) =>
        !(
          m.resource === invitation.resource &&
          m.resourceId === r.id &&
          m.userId === actorId
        ),
    );
    s.memberships.push({
      resource: invitation.resource,
      resourceId: r.id,
      userId: actorId,
      role: invitation.role,
    });
  }
  invitation.accepted = true;
  audit(s, actorId, "invitation.accept", r.id);
  return invitation;
}
export function removeMember(
  s: State,
  actorId: string,
  kind: Resource,
  resourceId: string,
  memberId: string,
) {
  const r = resource(s, kind, resourceId);
  forbid(
    r.ownerId === actorId,
    "Only this resource’s owner can remove members",
  );
  forbid(
    memberId !== r.ownerId,
    "Transfer ownership before removing the owner",
  );
  const member = s.memberships.find(
    (m) =>
      m.resource === kind &&
      m.resourceId === resourceId &&
      m.userId === memberId,
  );
  if (!member) return;
  if (kind === "hub")
    s.agentGrants = s.agentGrants.filter(
      (g) =>
        !(
          g.userId === memberId &&
          s.agents.some((a) => a.id === g.agentId && a.hubId === resourceId)
        ),
    );
  s.identity.workspaceGrants = s.identity.workspaceGrants.filter(
    (g) =>
      !(
        g.userId === memberId &&
        (kind === "computer"
          ? g.computerId === resourceId
          : s.computers.some(
              (c) => c.id === g.computerId && c.hubId === resourceId,
            ))
      ),
  );
  if (kind === "computer") {
    s.priorGrants = s.priorGrants.filter(
      (g) => !(g.userId === memberId && g.computerId === resourceId),
    );
    for (const a of s.agents.filter((a) => a.computerId === resourceId)) {
      const d = agentAccess(s, memberId, a);
      if (d.actions.length)
        s.priorGrants.push({
          userId: memberId,
          computerId: resourceId,
          agentId: a.id,
          actions: [...d.actions],
          lostAt: Date.now(),
        });
    }
  }
  s.memberships = s.memberships.filter(
    (m) =>
      !(
        m.resource === kind &&
        m.resourceId === resourceId &&
        m.userId === memberId
      ),
  );
  audit(s, actorId, `${kind}.member.remove`, r.id);
}
export function reserveAgent(
  s: State,
  actorId: string,
  computerId: string,
  name: string,
  backend: Agent["backend"],
  reservedId?: string,
): Agent {
  const computer = requireValue(s.computers.find((c) => c.id === computerId));
  forbid(
    canCreate(s, actorId, computer),
    "Creating an agent requires active hub AND computer operator access",
  );
  const agent: Agent = {
    id: reservedId ?? id(),
    computerId,
    hubId: computer.hubId,
    creatorId: actorId,
    name,
    backend,
    localId: null,
    state: "starting",
    createdAt: Date.now(),
  };
  s.agents.push(agent);
  audit(s, actorId, "agent.create", agent.id);
  return agent;
}
