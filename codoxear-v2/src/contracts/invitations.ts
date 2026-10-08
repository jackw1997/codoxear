import { z } from "zod";

const Email = z.string().trim().toLowerCase().pipe(z.email());
export const InvitationTarget = z.discriminatedUnion("method", [
  z.object({ method: z.literal("email"), email: Email }).strict(),
  z
    .object({
      method: z.literal("phone"),
      phone: z
        .string()
        .trim()
        .regex(/^\+[1-9][0-9]{7,14}$/),
    })
    .strict(),
  ...(["google", "feishu", "wechat", "oidc"] as const).map((method) =>
    z
      .object({
        method: z.literal(method),
        connection: z.string().trim().min(1).max(200),
        subject: z.string().trim().min(1).max(300),
        tenant: z.string().trim().min(1).max(200).nullable().default(null),
      })
      .strict(),
  ),
]);
export type InvitationTarget = z.infer<typeof InvitationTarget>;
const Role = z.enum(["member", "admin", "viewer", "operator"]);
export const InvitationRequest = z.union([
  z.object({ email: Email, target: z.never().optional(), role: Role }).strict(),
  z
    .object({
      email: z.never().optional(),
      target: InvitationTarget,
      role: Role,
    })
    .strict(),
]);

export const InvitationLinkRequest = z.object({
  expiresInHours: z.number().int().min(1).max(168).default(24),
}).strict();
export const InvitationLinkToken = z.string().regex(/^[A-Za-z0-9_-]{43}$/);
export const InvitationLinkStatus = z.enum(["pending", "accepted", "expired", "revoked", "authority_changed"]);
const LinkId = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const InvitationLinkHub = z.object({ id: LinkId, name: z.string(), origin: z.url() }).strict();
export const InvitationLinkSummary = z.object({
  id: LinkId, hub: InvitationLinkHub, role: z.literal("member"),
  createdAt: z.number().nonnegative(), expiresAt: z.number().nonnegative(), status: InvitationLinkStatus,
}).strict();
export const InvitationLinkCreated = InvitationLinkSummary.extend({ token: InvitationLinkToken }).strict();
export const InvitationLinkList = z.object({ invitations: z.array(InvitationLinkSummary.extend({ issuerId: LinkId }).strict()) }).strict();
export const InvitationLinkAccepted = z.object({ ok: z.literal(true), hub: InvitationLinkHub, role: z.literal("member") }).strict();
