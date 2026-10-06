import webpush from "web-push";
import { z } from "zod";
import { createECDH } from "node:crypto";
import { DomainError } from "../contracts/model.js";
import { BrowserSubscription, PushHint } from "../contracts/web-push.js";
import type { PushProvider, Subscription } from "./notifications.js";
import { subscriptionTag } from "./notifications.js";
import { NOTIFICATION_TTL } from "../protocol/notifications.js";

export const VapidConfig = z.object({ subject: z.string().refine(value => /^(https:\/\/|mailto:)/.test(value)), publicKey: z.string().regex(/^[A-Za-z0-9_-]{87}$/), privateKey: z.string().regex(/^[A-Za-z0-9_-]{43}$/) }).strict();
export type VapidConfig = z.infer<typeof VapidConfig>;
const browserPushHosts = new Set(["fcm.googleapis.com", "updates.push.services.mozilla.com", "web.push.apple.com"]);
export class WebPushProvider implements PushProvider {
  readonly testMessage = false;
  readonly webPushPublicKey: string;
  private config: VapidConfig;
  constructor(config: VapidConfig, private transport: typeof fetch = fetch, private trustedOrigins: ReadonlySet<string> = new Set()) {
    this.config = VapidConfig.parse(config);
    const key = createECDH("prime256v1"); key.setPrivateKey(Buffer.from(this.config.privateKey, "base64url"));
    if (key.getPublicKey().toString("base64url") !== this.config.publicKey) throw new Error("VAPID key pair does not match");
    this.webPushPublicKey = this.config.publicKey;
  }
  supports(provider: "harmony" | "web-push") { return provider === "web-push"; }
  validate(input: unknown) {
    const subscription = BrowserSubscription.parse(input), endpoint = new URL(subscription.endpoint);
    // Fixed browser-provider hosts prevent a registration from turning the Hub into an SSRF proxy.
    if (endpoint.username || endpoint.password || endpoint.hash || (!this.trustedOrigins.has(endpoint.origin) && (endpoint.protocol !== "https:" || (endpoint.port && endpoint.port !== "443") || !browserPushHosts.has(endpoint.hostname))))
      throw new DomainError(400, "push_endpoint_rejected", "Unsupported browser push endpoint");
    if (subscription.expirationTime && subscription.expirationTime <= Date.now()) throw new DomainError(400, "push_expired", "Browser push subscription expired");
    const key = createECDH("prime256v1"); key.generateKeys();
    try { key.computeSecret(Buffer.from(subscription.keys.p256dh, "base64url")); } catch { throw new DomainError(400, "push_key_rejected", "Invalid browser push key"); }
    return subscription;
  }
  async send(subscription: Subscription, event: Parameters<PushProvider["send"]>[1]) {
    const browser = this.validate(subscription.browser);
    const hint = PushHint.parse({ ...event, version: 1, userId: subscription.userId, clientId: subscription.clientId, installationId: subscription.installationId, subscriptionTag: subscriptionTag(subscription.token) });
    const ttl = Math.max(0, Math.floor((event.occurredAt + NOTIFICATION_TTL - Date.now()) / 1000));
    if (!ttl) return "invalid-token" as const;
    const details = webpush.generateRequestDetails({ endpoint: browser.endpoint, keys: browser.keys }, JSON.stringify(hint), { vapidDetails: this.config, contentEncoding: "aes128gcm", TTL: ttl, urgency: event.kind === "attention" ? "high" : "normal" });
    const response = await this.transport(details.endpoint, { method: "POST", headers: details.headers, body: new Uint8Array(details.body), signal: AbortSignal.timeout(10000), redirect: "error", credentials: "omit" });
    await response.body?.cancel();
    if ([404, 410].includes(response.status)) return "invalid-token" as const;
    if (!response.ok) throw new Error("Browser push provider unavailable");
    return "sent" as const;
  }
}
export class CompositePushProvider implements PushProvider {
  readonly testMessage: boolean;
  readonly webPushPublicKey?: string;
  constructor(readonly webPush: WebPushProvider | undefined, readonly harmony: PushProvider | undefined) {
    this.testMessage = harmony?.testMessage ?? false;
    if (webPush) this.webPushPublicKey = webPush.webPushPublicKey;
  }
  supports(provider: "harmony" | "web-push") { return provider === "web-push" ? !!this.webPush : !!this.harmony; }
  send(subscription: Subscription, event: Parameters<PushProvider["send"]>[1]) {
    const provider = subscription.provider === "web-push" ? this.webPush : this.harmony;
    if (!provider) throw new Error("Push provider is not configured");
    return provider.send(subscription, event);
  }
}
