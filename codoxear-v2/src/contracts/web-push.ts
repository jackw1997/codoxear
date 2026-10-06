import { z } from "zod";
import { Id } from "./model.js";
import { Notification } from "../protocol/notifications.js";

const encoded = (length: number) => z.string().regex(/^[A-Za-z0-9_-]+$/).refine(value => {
  try { return Buffer.from(value, "base64url").length === length; } catch { return false; }
});
// Browser keys are capability secrets; only the installation identifier is public.
export const BrowserSubscription = z.object({
  endpoint: z.url().max(4096),
  expirationTime: z.number().nonnegative().nullable().optional(),
  keys: z.object({ p256dh: encoded(65), auth: encoded(16) }).strict(),
}).strict();
export type BrowserSubscription = z.infer<typeof BrowserSubscription>;
export const WebPushRegistration = z.object({
  provider: z.literal("web-push"), computerId: Id, installationId: Id,
  clientId: Id, subscription: BrowserSubscription,
}).strict();
export const PushHint = Notification.extend({
  version: z.literal(1), hubId: Id, userId: Id, clientId: Id,
  installationId: Id, computerId: Id, agentId: Id,
  binding: z.number().int().positive(),
  subscriptionTag: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();
export type PushHint = z.infer<typeof PushHint>;
