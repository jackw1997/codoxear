import { resolve, dirname, join } from "node:path";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import { Store } from "../persistence/store.js";
import { Accounts } from "../auth/accounts.js";
import { Tokens, signingKey } from "../auth/tokens.js";
import { Authority } from "../auth/authority.js";
import { createIdentityApp } from "../auth/app.js";
import {
  ProviderConfig,
  provider,
} from "../auth/providers.js";
import { secret } from "../domain/commands.js";
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
    listenHost: z.string().default("127.0.0.1"),
    listenPort: z.number().default(17420),
    secureCookies: z.boolean().default(true),
    frontendAssetsRoot: z.string().optional(),
    providers: z.array(ProviderConfig).default([]),
    clients: z
      .array(z.object({ id: z.string(), redirectUris: z.array(z.url()) }))
      .default([]),
  })
  .parse(JSON.parse(await readFile(resolve(file), "utf8")));
const store = new Store(resolve(config.database));
// Accounts are created only by verified Google/Feishu sign-in.
const accounts = new Accounts(store, secret(), { async send() { throw new Error("Code login is disabled"); } }),
  tokens = new Tokens(
    config.issuer,
    await signingKey(resolve(config.signingKey)),
  ),
  authority = new Authority(store, accounts, tokens);
const app = await createIdentityApp({
  authority,
  frontendAssetsRoot: config.frontendAssetsRoot,
  providers: config.providers.map((p) => provider(p)),
  secureCookies: config.secureCookies,
  clients: config.clients,

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
