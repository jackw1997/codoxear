import { z } from "zod";
import { createHash } from "node:crypto";
import { SignJWT, importPKCS8 } from "jose";
import { type PushProvider, type Subscription } from "./notifications.js";
import { type Notification } from "../protocol/notifications.js";
// Same PushKit service-account contract as the established Python adapter.
export const HarmonyAccount = z.object({
  project_id: z.string().regex(/^[A-Za-z0-9_-]+$/),
  key_id: z.string().min(1),
  private_key: z.string().min(1),
  sub_account: z.string().min(1),
  token_uri: z.url().refine((u) => new URL(u).protocol === "https:"),
});
export class HarmonyPushProvider implements PushProvider {
  private key: Promise<CryptoKey>;
  constructor(
    private account: z.infer<typeof HarmonyAccount>,
    readonly testMessage = false,
    private transport: typeof fetch = fetch,
  ) {
    HarmonyAccount.parse(account);
    this.key = importPKCS8(account.private_key, "PS256");
  }
  async ready() {
    await this.key;
  }
  async send(
    subscription: Subscription,
    event: Notification & { computerId: string; hubId: string },
  ): Promise<"sent" | "invalid-token"> {
    const jwt = await new SignJWT({})
      .setProtectedHeader({
        alg: "PS256",
        typ: "JWT",
        kid: this.account.key_id,
      })
      .setIssuer(this.account.sub_account)
      .setAudience(this.account.token_uri)
      .setIssuedAt()
      .setExpirationTime("5m")
      .sign(await this.key);
    const result = await this.transport(
      "https://push-api.cloud.huawei.com/v3/" +
        this.account.project_id +
        "/messages:send",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: "Bearer " + jwt,
          "push-type": "0",
        },
        redirect: "error",
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          payload: {
            notification: {
              category: "WORK",
              title: "Codoxear",
              body:
                event.kind === "completion"
                  ? "An agent finished a response."
                  : "An agent needs attention.",
              appMessageId: createHash("sha256")
                .update(JSON.stringify([subscription.scope, event.id]))
                .digest("hex"),
              clickAction: {
                actionType: 0,
                data: {
                  "codoxear.session": event.localId,
                  "codoxear.server": subscription.scope,
                  "codoxear.event": event.id,
                  "codoxear.hub": event.hubId,
                  "codoxear.computer": event.computerId,
                },
              },
            },
          },
          target: { token: [subscription.token] },
          pushOptions: { ttl: 300, testMessage: this.testMessage },
        }),
      },
    );
    if (!result.ok) throw new Error("Push provider request failed");
    const body = z.object({ code: z.string() }).parse(await result.json());
    if (body.code === "80300007") return "invalid-token";
    if (body.code !== "80000000")
      throw new Error("Push provider rejected notification");
    return "sent";
  }
}
