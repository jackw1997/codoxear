import { type State, DomainError, requireValue, forbid } from "../contracts/model.js";
import { digest, secret, id, audit } from "./commands.js";
import { canManageHub, hubAccess } from "./policy.js";

function hubValue(s: State, hubId: string) {
  const hub = requireValue(s.hubs.find(h => h.id === hubId));
  const origin = requireValue(s.identity.hubs.find(h => h.hubId === hubId && h.enabled), "Hub is not registered").origin;
  return { id: hub.id, name: hub.name, origin };
}
export function invitationLinkStatus(s: State, value: State["invitationLinks"][number], now = Date.now()) {
  if (value.revokedAt !== null) return "revoked" as const;
  if (value.acceptedAt !== null) return "accepted" as const;
  if (value.expiresAt <= now) return "expired" as const;
  const hub = s.hubs.find(h => h.id === value.hubId);
  if (!hub || hub.revision !== value.ownerRevision || !canManageHub(s, value.issuerId, hub)) return "authority_changed" as const;
  return "pending" as const;
}
function summary(s: State, value: State["invitationLinks"][number], now: number) {
  return { id: value.id, hub: hubValue(s, value.hubId), role: "member" as const, createdAt: value.createdAt,
    expiresAt: value.expiresAt, status: invitationLinkStatus(s, value, now) };
}
export function createInvitationLink(s: State, actorId: string, hubId: string, hours: number, now = Date.now()) {
  const hub = requireValue(s.hubs.find(h => h.id === hubId));
  forbid(canManageHub(s, actorId, hub), "Only Hub owners and admins can invite");
  if (!Number.isInteger(hours) || hours < 1 || hours > 168) throw new DomainError(400, "invalid_expiry", "Invitation lifetime must be 1 to 168 hours");
  if (s.invitationLinks.filter(v => v.hubId === hubId && invitationLinkStatus(s, v, now) === "pending").length >= 100)
    throw new DomainError(429, "invitation_limit", "Revoke an existing invitation before creating more links");
  if (s.invitationLinks.filter(v => v.hubId === hubId && v.issuerId === actorId && v.createdAt > now - 60000).length >= 10)
    throw new DomainError(429, "invitation_rate", "Wait before creating more invitation links");
  // Bound retained terminal metadata; pending links are never pruned.
  const old = s.invitationLinks.filter(v => v.hubId === hubId && invitationLinkStatus(s, v, now) !== "pending")
    .sort((a,b) => b.createdAt - a.createdAt).slice(900);
  const removed = new Set(old.map(v => v.id));
  s.invitationLinks = s.invitationLinks.filter(v => !removed.has(v.id));
  const token = secret();
  const value = { id: id(), tokenHash: digest(token), hubId, issuerId: actorId, ownerRevision: hub.revision,
    createdAt: now, expiresAt: now + hours * 3600000, acceptedAt: null, acceptedBy: null, revokedAt: null };
  s.invitationLinks.push(value);
  audit(s, actorId, "hub.invitation_link.create", value.id);
  return { ...summary(s, value, now), token };
}
export function inspectInvitationLink(s: State, token: string, hubId?: string, now = Date.now()) {
  const value = requireValue(s.invitationLinks.find(v => v.tokenHash === digest(token) && (!hubId || v.hubId === hubId)), "Invitation not found");
  return summary(s, value, now);
}
export function listInvitationLinks(s: State, actorId: string, hubId: string, now = Date.now()) {
  forbid(canManageHub(s, actorId, requireValue(s.hubs.find(h => h.id === hubId))), "Only Hub owners and admins can list invitations");
  return { invitations: s.invitationLinks.filter(v => v.hubId === hubId).sort((a,b) => b.createdAt-a.createdAt)
    .map(v => ({ ...summary(s, v, now), issuerId: v.issuerId })) };
}
export function revokeInvitationLink(s: State, actorId: string, hubId: string, invitationId: string, now = Date.now()) {
  forbid(canManageHub(s, actorId, requireValue(s.hubs.find(h => h.id === hubId))), "Only Hub owners and admins can revoke invitations");
  const value = requireValue(s.invitationLinks.find(v => v.hubId === hubId && v.id === invitationId));
  if (value.acceptedAt !== null) throw new DomainError(409, "invitation_used", "Invitation has already been used");
  value.revokedAt ??= now;
  audit(s, actorId, "hub.invitation_link.revoke", value.id);
  return { ok: true as const };
}
export function acceptInvitationLink(s: State, actorId: string, token: string, hubId?: string, now = Date.now()) {
  const value = requireValue(s.invitationLinks.find(v => v.tokenHash === digest(token) && (!hubId || v.hubId === hubId)), "Invitation not found");
  const hub = requireValue(s.hubs.find(h => h.id === value.hubId));
  const actor = requireValue(s.users.find(u => u.id === actorId));
  forbid(!actor.disabled, "Account is disabled");
  if (hubAccess(s, actorId, hub)) throw new DomainError(409, "already_member", "This account already belongs to the Hub");
  const status = invitationLinkStatus(s, value, now);
  if (status !== "pending") throw new DomainError(409, "invitation_" + status, "Invitation is " + status.replaceAll("_", " "));
  s.memberships.push({ resource: "hub", resourceId: hub.id, userId: actorId, role: "member" });
  value.acceptedAt = now; value.acceptedBy = actorId;
  audit(s, actorId, "hub.invitation_link.accept", value.id);
  return { ok: true as const, hub: hubValue(s, hub.id), role: "member" as const };
}
