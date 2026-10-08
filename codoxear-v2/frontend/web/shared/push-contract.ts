import { z } from "zod";
/** Public push wire payload; contains no backend or Node-specific subscription code. */
const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/);
export const PushHint = z.object({
  id: z.string().regex(/^[a-f0-9]{64}$/),
  localId: z.string().min(1).max(200),
  kind: z.enum(["completion", "attention"]),
  occurredAt: z.number().nonnegative(),
  version: z.literal(1), hubId: Id, userId: Id, clientId: Id,
  installationId: Id, computerId: Id, agentId: Id,
  binding: z.number().int().positive(),
  subscriptionTag: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PushHint = z.infer<typeof PushHint>;
export const NOTIFICATION_TTL = 24 * 3600000;
