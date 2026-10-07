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
