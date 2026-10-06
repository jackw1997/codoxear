import { z } from "zod";
import { SqliteDocument } from "../persistence/document.js";
import { Notification, NOTIFICATION_TTL } from "../protocol/notifications.js";
import { DomainError, Id } from "../contracts/model.js";
import { BrowserSubscription } from "../contracts/web-push.js";
import { createHash } from "node:crypto";
export const subscriptionTag = (token: string) => createHash("sha256").update(token).digest("hex");
export const Subscription = z.object({
  userId: Id,
  sessionId: Id,
  installationId: Id,
  computerId: Id,
  token: z.string().min(1).max(4096),
  scope: z.string().max(2000),
  provider: z.enum(["harmony", "web-push"]).optional(),
  browser: BrowserSubscription.optional(),
  clientId: Id.optional(),
  binding: z.number().int().positive().optional(),
});
export type Subscription = z.infer<typeof Subscription>;
type Event = Notification & {
  computerId: string;
  binding: number;
  agentId: string;
  receivedAt: number;
};
type Delivery = {
  eventKey: string;
  subscriptionKey: string;
  state: "pending" | "sent" | "dropped";
  attempts: number;
  next: number;
};
type State = {
  events: Event[];
  subscriptions: Array<Subscription & { createdAt: number }>;
  deliveries: Delivery[];
};
export interface PushProvider {
  readonly testMessage: boolean;
  readonly webPushPublicKey?: string;
  supports?(provider: "harmony" | "web-push"): boolean;
  send(
    subscription: Subscription,
    event: Notification & { computerId: string; hubId: string; agentId?: string; binding?: number },
  ): Promise<"sent" | "invalid-token">;
}
const subKey = (s: Subscription) =>
  JSON.stringify([s.userId, s.installationId, s.computerId]);
const eventKey = (e: Event) => JSON.stringify([e.computerId, e.binding, e.id]);
export class NotificationInbox {
  private state: SqliteDocument<State>;
  private active = false;
  constructor(
    path: string,
    readonly hubId: string,
    private authorize: (
      sessionId: string,
      agentId: string,
      computerId: string,
      binding: number,
    ) => Promise<void>,
    readonly provider?: PushProvider,
    private now: () => number = Date.now,
  ) {
    this.state = new SqliteDocument(path, hubId, () => ({
      events: [],
      subscriptions: [],
      deliveries: [],
    }));
  }
  subscribe(input: Subscription) {
    const subscription = Subscription.parse(input);
    if (subscription.provider === "web-push" && (!subscription.browser || !subscription.clientId || !subscription.binding))
      throw new DomainError(400, "invalid_subscription", "Browser subscription scope is required");
    this.state.change((s) => {
      const key = subKey(subscription),
        old = s.subscriptions.find((i) => subKey(i) === key);
      s.subscriptions = s.subscriptions.filter((i) => subKey(i) !== key);
      if (s.subscriptions.length >= 1000)
        throw new DomainError(
          429,
          "subscriptions_full",
          "Hub subscription limit reached",
        );
      s.subscriptions.push({
        ...subscription,
        createdAt: old?.createdAt ?? this.now(),
      });
    });
  }
  unsubscribe(userId: string, installationId: string, computerId: string) {
    this.state.change((s) => {
      s.subscriptions = s.subscriptions.filter(
        (i) =>
          !(
            i.userId === userId &&
            i.installationId === installationId &&
            i.computerId === computerId
          ),
      );
    });
  }
  unsubscribeSession(userId: string, sessionId: string) {
    this.state.change(s => { s.subscriptions = s.subscriptions.filter(i => i.userId !== userId || i.sessionId !== sessionId); });
  }
  async authorizeHint(userId: string, sessionId: string, installationId: string, computerId: string, agentId: string, binding: number, clientId: string, tag: string) {
    const current = () => this.state.read().subscriptions.find(s => s.userId === userId && s.sessionId === sessionId && s.installationId === installationId && s.computerId === computerId && s.provider === "web-push" && s.binding === binding && s.clientId === clientId);
    const subscription = current();
    if (!subscription || subscriptionTag(subscription.token) !== tag) throw new DomainError(403, "push_scope_lost", "Notification subscription is no longer active");
    await this.authorize(sessionId, agentId, computerId, binding);
    if (current()?.token !== subscription.token) throw new DomainError(403, "push_scope_lost", "Notification subscription changed");
    return { ok: true };
  }
  subscriptions(userId: string) {
    return this.state
      .read()
      .subscriptions.filter((s) => s.userId === userId)
      .map(({ installationId, computerId, createdAt, provider, clientId, binding }) => ({
        installationId,
        computerId,
        createdAt,
        provider: provider ?? "harmony",
        ...(clientId ? { clientId } : {}),
        ...(binding ? { binding } : {}),
      }));
  }
  receive(
    computerId: string,
    binding: number,
    agentId: string,
    input: Notification,
  ) {
    const event = Notification.parse(input);
    if (event.occurredAt > this.now() + 60000)
      throw new Error("Invalid notification timestamp");
    this.state.change((s) => {
      s.events = s.events.filter(
        (e) => e.occurredAt > this.now() - NOTIFICATION_TTL,
      );
      const keys = new Set(s.events.map(eventKey));
      s.deliveries = s.deliveries.filter((d) => keys.has(d.eventKey));
      const item = {
        ...event,
        computerId,
        binding,
        agentId,
        receivedAt: this.now(),
      };
      if (
        event.occurredAt <= this.now() - NOTIFICATION_TTL ||
        keys.has(eventKey(item))
      )
        return;
      if (s.events.length >= 10000) throw new Error("Notification inbox full");
      if (s.deliveries.length + s.subscriptions.length > 100000)
        throw new Error("Notification delivery journal full");
      s.events.push(item);
      for (const subscription of s.subscriptions.filter(
        (i) => i.computerId === computerId && (!i.binding || i.binding === binding) && i.createdAt <= event.occurredAt,
      ))
        s.deliveries.push({
          eventKey: eventKey(item),
          subscriptionKey: subKey(subscription),
          state: "pending",
          attempts: 0,
          next: this.now(),
        });
    });
  }
  async deliver() {
    if (this.active || !this.provider) return;
    this.active = true;
    try {
      for (const candidate of this.state
        .read()
        .deliveries.filter((d) => d.state === "pending" && d.next <= this.now())
        .slice(0, 100)) {
        const snapshot = this.state.read(),
          event = snapshot.events.find(
            (e) => eventKey(e) === candidate.eventKey,
          ),
          subscription = snapshot.subscriptions.find(
            (s) => subKey(s) === candidate.subscriptionKey,
          );
        let state: Delivery["state"] = "pending",
          dropSubscription = false;
        if (
          !event ||
          !subscription ||
          (subscription.binding !== undefined && subscription.binding !== event.binding) ||
          event.occurredAt <= this.now() - NOTIFICATION_TTL
        )
          state = "dropped";
        else
          try {
            await this.authorize(
              subscription.sessionId,
              event.agentId,
              event.computerId,
              event.binding,
            );
            const current = this.state
              .read()
              .subscriptions.find(
                (s) => subKey(s) === candidate.subscriptionKey,
              );
            if (
              !current ||
              current.token !== subscription.token ||
              current.sessionId !== subscription.sessionId
            )
              continue;
            const outcome = await this.provider.send(subscription, {
              id: event.id,
              localId: event.localId,
              kind: event.kind,
              occurredAt: event.occurredAt,
              computerId: event.computerId,
              hubId: this.hubId,
              agentId: event.agentId,
              binding: event.binding,
            });
            state = outcome === "sent" ? "sent" : "dropped";
            dropSubscription = outcome === "invalid-token";
          } catch (e) {
            if (e instanceof DomainError && [401, 403, 404].includes(e.status))
              state = "dropped";
          }
        this.state.change((s) => {
          const d = s.deliveries.find(
            (d) =>
              d.eventKey === candidate.eventKey &&
              d.subscriptionKey === candidate.subscriptionKey,
          );
          if (d) {
            d.state = state;
            d.attempts++;
            d.next =
              this.now() +
              Math.min(300000, 1000 * 2 ** Math.min(d.attempts, 8));
          }
          if (dropSubscription)
            s.subscriptions = s.subscriptions.filter(
              (s) =>
                subKey(s) !== candidate.subscriptionKey ||
                s.token !== subscription?.token,
            );
        });
      }
    } finally {
      this.active = false;
    }
  }
  counts() {
    const s = this.state.read();
    return {
      events: s.events.length,
      pending: s.deliveries.filter((d) => d.state === "pending").length,
      subscriptions: s.subscriptions.length,
    };
  }
  close() {
    this.state.close();
  }
}
