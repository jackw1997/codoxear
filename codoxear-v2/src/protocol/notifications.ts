import { z } from "zod";
import { Id } from "../contracts/model.js";
export const Notification = z
  .object({
    id: z.string().regex(/^[a-f0-9]{64}$/),
    localId: z.string().min(1).max(200),
    kind: z.enum(["completion", "attention"]),
    occurredAt: z.number().nonnegative(),
  })
  .strict();
export type Notification = z.infer<typeof Notification>;
export const NotificationFrame = z.object({
  type: z.literal("notification"),
  epoch: Id,
  event: Notification,
});
export const NotificationAck = z.object({
  type: z.literal("notification.ack"),
  epoch: Id,
  id: Notification.shape.id,
});
export const NOTIFICATION_TTL = 24 * 3600000;
