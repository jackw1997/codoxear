import { independentAuthority } from "./independent.js";
import { Store } from "../persistence/store.js";
import { id, passwordHash, createHub } from "../domain/commands.js";
import {
  ProviderConfig,
  provider,
  deliveryGateway,
} from "../auth/providers.js";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { z } from "zod";
import { Id } from "../contracts/model.js";
import { AuthorityClient } from "./authority-client.js";
import { HubSessions } from "./sessions.js";
import { DelegationStore } from "./delegation.js";
import { Tunnels } from "../protocol/tunnels.js";
import { createHubApp } from "./app.js";
import { NotificationInbox } from "./notifications.js";
import { HarmonyAccount, HarmonyPushProvider } from "./harmony-push.js";
import {
  CompositePushProvider,
  VapidConfig,
  WebPushProvider,
} from "./web-push.js";
const file = process.env.CODOXEAR_HUB_CONFIG;
if (!file)
  throw new Error(
    "Set CODOXEAR_HUB_CONFIG to a private JSON configuration file",
  );
const config = z
  .object({
    origin: z.url(),
    identityUrl: z.url().optional(),
    independent: z.boolean().default(true),
    catalog: z.string().optional(),
    signingKey: z.string().optional(),
    otpKey: z.string().min(32).optional(),
    name: z.string().default("My hub"),
    clientOrigins: z.array(z.url()).default([]),
    clients: z
      .array(z.object({ id: Id, redirectUris: z.array(z.url()) }))
      .default([]),
    providers: z.array(ProviderConfig).default([]),
    delivery: z
      .object({
        endpoint: z.url(),
        credential: z.string(),
        methods: z.array(z.enum(["email", "phone"])),
      })
      .optional(),
    hubId: Id,
    credential: z.string().min(32).optional(),
    database: z.string(),
    listenHost: z.string().default("127.0.0.1"),
    listenPort: z.number().default(17430),
    secureCookies: z.boolean().default(true),
    frontendAssetsRoot: z.string().optional(),
    development: z.boolean().default(false),
    harmonyServiceAccount: z.string().optional(),
    vapid: z.string().optional(),
    harmonyTestMessage: z.boolean().default(false),
  })
  .parse(JSON.parse(await readFile(resolve(file), "utf8")));
if (config.development && !existsSync("/.dockerenv"))
  throw new Error("Synthetic development mode is only allowed inside Docker");
let catalog: Store | undefined;
let local: Awaited<ReturnType<typeof independentAuthority>> | undefined;
if (config.independent) {
  if (!config.otpKey)
    throw new Error("Independent hub requires its own otpKey");
  catalog = new Store(resolve(config.catalog ?? config.database + ".catalog"));
  if (!catalog.read().hubs.length) {
    const email = process.env.CODOXEAR_BOOTSTRAP_EMAIL,
      password = process.env.CODOXEAR_BOOTSTRAP_PASSWORD;
    if (!email || !password || password.length < 12)
      throw new Error(
        "First hub start requires bootstrap email and password (12+ characters)",
      );
    catalog.change((s) => {
      const ownerId = id();
      s.users.push({
        id: ownerId,
        email: z.email().parse(email),
        name: "Owner",
        passwordHash: passwordHash(password),
        disabled: false,
      });
      const hub = createHub(s, ownerId, config.name);
      hub.id = config.hubId;
    });
  }
  local = await independentAuthority({
    origin: config.origin,
    hubId: config.hubId,
    store: catalog,
    signingKey: resolve(config.signingKey ?? config.database + ".key.json"),
    otpKey: config.otpKey,
    providers: config.providers.map(provider),
    clients: config.clients,
    codeDelivery: config.delivery?.methods,
    delivery: config.delivery
      ? deliveryGateway(config.delivery.endpoint, config.delivery.credential)
      : undefined,
    frontendAssetsRoot: config.frontendAssetsRoot,
    secureCookies: config.secureCookies,
  });
}
if (!local && (!config.identityUrl || !config.credential))
  throw new Error("Legacy hub requires explicit identityUrl and credential");
const authority =
  local?.client ??
  new AuthorityClient(config.identityUrl!, config.hubId, config.credential!);
const harmonyProvider = config.harmonyServiceAccount
  ? new HarmonyPushProvider(
      HarmonyAccount.parse(
        JSON.parse(
          await readFile(resolve(config.harmonyServiceAccount), "utf8"),
        ),
      ),
      config.harmonyTestMessage,
    )
  : undefined;
await harmonyProvider?.ready();
const browserProvider = config.vapid
  ? new WebPushProvider(
      VapidConfig.parse(
        JSON.parse(await readFile(resolve(config.vapid), "utf8")),
      ),
    )
  : undefined;
const pushProvider =
  browserProvider || harmonyProvider
    ? new CompositePushProvider(browserProvider, harmonyProvider)
    : undefined;
const notifications = new NotificationInbox(
  resolve(config.database) + ".notifications",
  config.hubId,
  async (sessionId, agentId, computerId, binding) => {
    await authority.request("/internal/notification-authorize", {
      hubId: config.hubId,
      sessionId,
      agentId,
      computerId,
      binding,
    });
  },
  pushProvider,
);
const delegations = new DelegationStore(
  resolve(config.database) + ".delegations",
);
const sessions = new HubSessions(resolve(config.database)),
  app = await createHubApp({
    origin: config.origin,
    authority,
    localIdentity: local?.identity,
    clientOrigins: config.clientOrigins,
    sessions,
    notifications,
    delegations,
    tunnels: new Tunnels(),
    frontendAssetsRoot: config.frontendAssetsRoot,
    secureCookies: config.secureCookies,
    development: config.development,
  });
await app.listen({ host: config.listenHost, port: config.listenPort });
console.log("Codoxear hub ready");
let stopping = false,
  delivery: Promise<void> | undefined;
const timer = setInterval(() => {
  if (delivery) return;
  delivery = notifications
    .deliver()
    .catch(() => {})
    .finally(() => {
      delivery = undefined;
    });
}, 1000);
const stop = () => {
  if (stopping) return;
  stopping = true;
  clearInterval(timer);
  void (async () => {
    await app.close();
    await delivery;
    notifications.close();
    sessions.close();
    delegations.close();
    await local?.identity.close();
    catalog?.close();
  })();
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
