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
  type MembershipRole,
  type State,
  DomainError,
  forbid,
  requireValue,
} from "../contracts/model.js";
import { InvitationTarget } from "../contracts/invitations.js";
import {
  canCreate,
  hubAccess,
  hubRole,
  canManageHub,
} from "./policy.js";

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
  forbid(
    canManageHub(s, actorId, hub),
    "Only Hub owners and admins can admit a computer",
  );
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
  if (kind === "hub") {
    s.memberships = s.memberships.filter(
      (m) =>
        !(
          m.resource === "hub" &&
          m.resourceId === r.id &&
          (m.userId === nextOwnerId || m.userId === actorId)
        ),
    );
    s.memberships.push({
      resource: "hub",
      resourceId: r.id,
      userId: actorId,
      role: "member",
    });
  }
  audit(s, actorId, `${kind}.owner.transfer`, r.id);
  return r;
}
export function invite(
  s: State,
  actorId: string,
  kind: Resource,
  resourceId: string,
  destination: string | InvitationTarget,
  role: MembershipRole,
) {
  const r = resource(s, kind, resourceId);
  const hub =
    kind === "hub"
      ? (r as Hub)
      : requireValue(s.hubs.find((h) => h.id === (r as Computer).hubId));
  const issuerRole = hubRole(s, actorId, hub);
  forbid(
    issuerRole === "owner" || issuerRole === "admin",
    "Only Hub owners and admins can invite",
  );
  forbid(
    kind === "hub"
      ? role === "member" || (role === "admin" && issuerRole === "owner")
      : role === "viewer" || role === "operator",
    "Invalid membership role or insufficient authority",
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
              : // Google and Feishu grants bind provider identities, never contact email.
                i.connection === target.connection &&
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
  const hub =
    invitation.resource === "hub"
      ? (r as Hub)
      : requireValue(s.hubs.find((h) => h.id === (r as Computer).hubId));
  const issuerRole = hubRole(s, invitation.issuerId, hub);
  forbid(
    r.revision === invitation.ownerRevision &&
      (issuerRole === "owner" || issuerRole === "admin") &&
      (invitation.role !== "admin" || issuerRole === "owner"),
    "Invitation authority changed; request a new invitation",
  );
  if (invitation.resource === "computer")
    forbid(
      hubAccess(s, actorId, hub),
      "Join the Hub before accepting Computer access",
    );
  const existing = s.memberships.find(
    (m) =>
      m.resource === invitation.resource &&
      m.resourceId === r.id &&
      m.userId === actorId,
  );
  forbid(
    !(
      invitation.resource === "hub" &&
      existing?.role === "admin" &&
      issuerRole !== "owner"
    ),
    "Admins cannot change another admin",
  );
  if (!(invitation.resource === "hub" && hub.ownerId === actorId)) {
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
  const hub =
    kind === "hub"
      ? (r as Hub)
      : requireValue(s.hubs.find((h) => h.id === (r as Computer).hubId));
  const actorRole = hubRole(s, actorId, hub);
  forbid(
    actorRole === "owner" || actorRole === "admin",
    "Only Hub owners and admins can remove members",
  );
  forbid(
    kind !== "hub" || memberId !== hub.ownerId,
    "Transfer ownership before removing the Hub owner",
  );
  forbid(
    kind !== "hub" ||
      actorRole === "owner" ||
      hubRole(s, memberId, hub) !== "admin",
    "Admins cannot remove admins",
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
  }
  s.memberships = s.memberships.filter(
    (m) =>
      !(
        m.resource === kind &&
        m.resourceId === resourceId &&
        m.userId === memberId
      ),
  );
  if (kind === "hub") {
    const computerIds = new Set(
      s.computers.filter((c) => c.hubId === resourceId).map((c) => c.id),
    );
    s.memberships = s.memberships.filter(
      (m) =>
        !(
          m.resource === "computer" &&
          computerIds.has(m.resourceId) &&
          m.userId === memberId
        ),
    );
    s.priorGrants = s.priorGrants.filter(
      (g) => !(g.userId === memberId && computerIds.has(g.computerId)),
    );
    s.invitations = s.invitations.filter(
      (i) =>
        !(
          i.issuerId === memberId &&
          (i.resource === "hub"
            ? i.resourceId === resourceId
            : computerIds.has(i.resourceId))
        ),
    );
  }
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

export function setHubMemberRole(
  s: State,
  actorId: string,
  hubId: string,
  userId: string,
  role: "admin" | "member",
) {
  const hub = requireValue(s.hubs.find((h) => h.id === hubId));
  forbid(
    hubRole(s, actorId, hub) === "owner",
    "Only the Hub owner can change admin roles",
  );
  forbid(userId !== hub.ownerId, "The owner role cannot be changed");
  const member = requireValue(
    s.memberships.find(
      (m) =>
        m.resource === "hub" && m.resourceId === hubId && m.userId === userId,
    ),
  );
  member.role = role;
  audit(s, actorId, "hub.member.role", hubId);
  return member;
}
export function setComputerAccess(
  s: State,
  actorId: string,
  computerId: string,
  userId: string,
  access: "read" | "write",
) {
  const computer = requireValue(s.computers.find((c) => c.id === computerId));
  const hub = requireValue(s.hubs.find((h) => h.id === computer.hubId));
  forbid(
    canManageHub(s, actorId, hub),
    "Only Hub owners and admins can manage Computer allowlists",
  );
  forbid(hubAccess(s, userId, hub), "The user must be an active Hub member");
  s.memberships = s.memberships.filter(
    (m) =>
      !(
        m.resource === "computer" &&
        m.resourceId === computerId &&
        m.userId === userId
      ),
  );
  const entry = {
    resource: "computer" as const,
    resourceId: computerId,
    userId,
    role: access === "write" ? ("operator" as const) : ("viewer" as const),
  };
  s.memberships.push(entry);
  audit(s, actorId, "computer.allowlist.set", computerId);
  return entry;
}
