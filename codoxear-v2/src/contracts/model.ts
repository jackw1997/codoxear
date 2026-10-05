import { z } from "zod";
import { InvitationTarget } from "./invitations.js";
import { IdentityState } from "./identity.js";

export const Policy = z.enum(["retain", "read_only", "none"]);
export type Policy = z.infer<typeof Policy>;
export const Role = z.enum(["viewer", "operator"]);
export type Role = z.infer<typeof Role>;
export const Action = z.enum(["read", "send", "interrupt"]);
export type Action = z.infer<typeof Action>;
export const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const Name = z.string().trim().min(1).max(120);
export const User = z.object({
  id: Id,
  email: z.email(),
  name: Name,
  passwordHash: z.string(),
  disabled: z.boolean(),
});
export const Hub = z.object({
  id: Id,
  ownerId: Id,
  name: Name,
  policy: Policy.nullable(),
  revision: z.number().int().nonnegative(),
});
export const Computer = z.object({
  id: Id,
  hubId: Id,
  ownerId: Id,
  name: Name,
  policy: Policy.nullable(),
  credentialHash: z.string(),
  binding: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
});
export const Membership = z.object({
  resource: z.enum(["hub", "computer"]),
  resourceId: Id,
  userId: Id,
  role: Role,
});
export const Agent = z.object({
  id: Id,
  computerId: Id,
  hubId: Id,
  creatorId: Id,
  name: Name,
  backend: z.enum(["codex", "pi", "cc", "fixture"]),
  localId: z.string().nullable(),
  state: z.enum(["starting", "ready", "unknown", "failed"]),
  createdAt: z.number(),
});
export const PriorGrant = z.object({
  userId: Id,
  computerId: Id,
  agentId: Id,
  actions: z.array(Action),
  lostAt: z.number(),
});
export const AgentGrant = z.object({
  agentId: Id,
  userId: Id,
  role: Role,
  binding: z.number().int().positive(),
  ownerRevision: z.number().int().nonnegative(),
});
export const Invitation = z
  .object({
    id: Id,
    tokenHash: z.string(),
    resource: z.enum(["hub", "computer"]),
    resourceId: Id,
    issuerId: Id,
    ownerRevision: z.number(),
    email: z.email().optional(),
    target: InvitationTarget.optional(),
    role: Role,
    expiresAt: z.number(),
    accepted: z.boolean(),
  })
  .refine((value) => Boolean(value.email || value.target), {
    message: "Invitation needs a recipient",
  });
export const Session = z.object({
  tokenHash: z.string(),
  userId: Id,
  expiresAt: z.number(),
});
export const AuditEvent = z.object({
  id: Id,
  at: z.number(),
  actorId: Id,
  action: z.string(),
  resourceId: Id,
});
export const State = z.object({
  schema: z.literal(1),
  identity: IdentityState.default(() => IdentityState.parse({})),
  revision: z.number().int().nonnegative(),
  users: z.array(User),
  hubs: z.array(Hub),
  computers: z.array(Computer),
  memberships: z.array(Membership),
  agents: z.array(Agent),
  agentGrants: z.array(AgentGrant).default([]),
  priorGrants: z.array(PriorGrant),
  invitations: z.array(Invitation),
  sessions: z.array(Session),
  audit: z.array(AuditEvent),
});
export type State = z.infer<typeof State>;
export type User = z.infer<typeof User>;
export type Hub = z.infer<typeof Hub>;
export type Computer = z.infer<typeof Computer>;
export type Agent = z.infer<typeof Agent>;
export type Invitation = z.infer<typeof Invitation>;
export type Resource = "hub" | "computer";
export type Decision = {
  actions: Action[];
  mode: "member" | "shared" | "retained" | "read_only" | "denied";
  source: "hub" | "computer" | "default" | "membership" | "agent";
  reason: string;
};
export const emptyState = (): State => ({
  schema: 1,
  identity: IdentityState.parse({}),
  revision: 0,
  users: [],
  hubs: [],
  computers: [],
  memberships: [],
  agents: [],
  agentGrants: [],
  priorGrants: [],
  invitations: [],
  sessions: [],
  audit: [],
});

export class DomainError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export function requireValue<T>(
  value: T | undefined,
  message = "Resource not found",
): T {
  if (value === undefined) throw new DomainError(404, "not_found", message);
  return value;
}
export function forbid(condition: boolean, reason: string): asserts condition {
  if (!condition) throw new DomainError(403, "forbidden", reason);
}
