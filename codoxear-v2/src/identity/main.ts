import { resolve, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Store } from "../persistence/store.js";
import { Accounts } from "../auth/accounts.js";
import { Tokens, signingKey } from "../auth/tokens.js";
import { Authority } from "../auth/authority.js";
import { createIdentityApp } from "../auth/app.js";
import { ProviderConfig, provider, deliveryGateway } from "../auth/providers.js";
import { id, passwordHash } from "../domain/commands.js";
const file = process.env.CODOXEAR_IDENTITY_CONFIG;
if (!file)
  throw new Error(
    "Set CODOXEAR_IDENTITY_CONFIG to a private JSON configuration file",
  );
const config = z
  .object({
    issuer: z.url(),
    database: z.string(),
    signingKey: z.string(),
    otpKey: z.string().min(32),
    listenHost: z.string().default("127.0.0.1"),
    listenPort: z.number().default(17420),
    secureCookies: z.boolean().default(true),
    providers: z.array(ProviderConfig).default([]),
    delivery: z
      .object({
        endpoint: z.url(),
        credential: z.string(),
        methods: z.array(z.enum(["email", "phone"])),
      })
      .optional(),
    clients: z
      .array(z.object({ id: z.string(), redirectUris: z.array(z.url()) }))
      .default([]),
  })
  .parse(JSON.parse(await readFile(resolve(file), "utf8")));
const store = new Store(resolve(config.database));
if (!store.read().users.length) {
  const email = process.env.CODOXEAR_BOOTSTRAP_EMAIL,
    password = process.env.CODOXEAR_BOOTSTRAP_PASSWORD;
  if (!email || !password || password.length < 12)
    throw new Error(
      "First start requires bootstrap email and a password of at least 12 characters",
    );
  store.change((s) =>
    s.users.push({
      id: id(),
      name: process.env.CODOXEAR_BOOTSTRAP_NAME ?? "Owner",
      email: z.email().parse(email.toLowerCase()),
      passwordHash: passwordHash(password),
      disabled: false,
    }),
  );
}
const delivery = config.delivery
  ? deliveryGateway(config.delivery.endpoint, config.delivery.credential)
  : {
      async send() {
        throw new Error("Delivery not configured");
      },
    };
const accounts = new Accounts(store, config.otpKey, delivery),
  tokens = new Tokens(
    config.issuer,
    await signingKey(resolve(config.signingKey)),
  ),
  authority = new Authority(store, accounts, tokens);
const app = await createIdentityApp({
  authority,
  providers: config.providers.map(provider),
  secureCookies: config.secureCookies,
  clients: config.clients,
  codeDelivery: config.delivery?.methods ?? [],
});
await app.listen({ host: config.listenHost, port: config.listenPort });
console.log("Codoxear identity service ready");
let stopping = false;
const stop = () => {
  if (stopping) return;
  stopping = true;
  void app.close().then(() => store.close());
};
process.on("SIGINT", stop);
process.on("SIGTERM", stop);
