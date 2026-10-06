import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import { DomainError, Id } from "../contracts/model.js";
import { WebPushRegistration } from "../contracts/web-push.js";
import type { NotificationInbox } from "./notifications.js";
import { CompositePushProvider, WebPushProvider } from "./web-push.js";

export function registerPushRoutes(app: FastifyInstance, inbox: NotificationInbox | undefined, call: <T>(r: FastifyRequest, op: string, args?: Record<string, unknown>) => Promise<T>, origin: string, hubId: string) {
  const subject = (r: FastifyRequest, computerId: string) => call<{ userId: string; sessionId: string; binding: number }>(r, "notification-subject", { computerId });
  app.get("/api/v1/push/subscriptions", async r => {
    const me = await call<{id: string}>(r, "me");
    return { configured: !!inbox?.provider, vapid_public_key: inbox?.provider?.webPushPublicKey ?? "", subscriptions: inbox?.subscriptions(me.id) ?? [] };
  });
  app.post("/api/v1/push/subscriptions", async r => {
    const harmony = z.object({ computerId: Id, installationId: Id, provider: z.literal("harmony"), token: z.string().min(1).max(4096) }).strict();
    const input = z.union([WebPushRegistration, harmony]).parse(r.body), scope = await subject(r, input.computerId);
    if (!inbox?.provider || (inbox.provider.supports && !inbox.provider.supports(input.provider))) throw new DomainError(503, "push_unavailable", "Push provider is not configured");
    const common = { ...scope, computerId: input.computerId, installationId: input.installationId, scope: JSON.stringify(["relay-v1", origin, scope.userId, hubId, input.computerId]), provider: input.provider };
    if (input.provider === "web-push") {
      const provider = inbox.provider instanceof CompositePushProvider ? inbox.provider.webPush : inbox.provider instanceof WebPushProvider ? inbox.provider : undefined;
      if (!provider) throw new DomainError(503, "push_unavailable", "Browser push is not configured");
      const browser = provider.validate(input.subscription);
      inbox.subscribe({ ...common, clientId: input.clientId, browser, token: JSON.stringify(browser) });
    } else inbox.subscribe({ ...common, token: input.token });
    return { ok: true, registered: true };
  });
  app.delete<{Params: {installationId: string; computerId: string}}>("/api/v1/push/subscriptions/:installationId/:computerId", async r => {
    const me = await call<{id: string}>(r, "me");
    inbox?.unsubscribe(me.id, Id.parse(r.params.installationId), Id.parse(r.params.computerId));
    return { ok: true };
  });
  app.post("/api/v1/push/authorize", async r => {
    const input = z.object({ computerId: Id, installationId: Id, clientId: Id, agentId: Id, binding: z.number().int().positive(), subscriptionTag: z.string().regex(/^[a-f0-9]{64}$/) }).strict().parse(r.body);
    const current = await subject(r, input.computerId);
    if (!inbox || current.binding !== input.binding) throw new DomainError(403, "push_scope_lost", "Notification binding changed");
    return inbox.authorizeHint(current.userId, current.sessionId, input.installationId, input.computerId, input.agentId, input.binding, input.clientId, input.subscriptionTag);
  });
  app.delete("/api/v1/push/subscriptions", async r => {
    const me = await call<{ id: string; sessionId: string }>(r, "notification-session");
    inbox?.unsubscribeSession(me.id, me.sessionId);
    return { ok: true };
  });
}
