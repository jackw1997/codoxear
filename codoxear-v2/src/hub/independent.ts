import type { FastifyInstance } from "fastify";
import { AuthorityClient } from "./authority-client.js";
import { Authority } from "../auth/authority.js";
import { Accounts } from "../auth/accounts.js";
import { Tokens, signingKey } from "../auth/tokens.js";
import { createIdentityApp, type IdentityOptions } from "../auth/app.js";
import { Store } from "../persistence/store.js";
import { digest, secret } from "../domain/commands.js";

/** All policy and identity operations execute in this hub's process and database.
 * The HTTP-shaped adapter reuses the checked command dispatcher without a
 * network identity service. No authority credential leaves this process. */
export async function independentAuthority(options: {
  origin: string;
  hubId: string;
  store: Store;
  signingKey?: string;
  otpKey?: string;
  setup?: IdentityOptions["setup"];
  delivery?: ConstructorParameters<typeof Accounts>[2] | undefined;
  providers?: IdentityOptions["providers"];
  clients?: IdentityOptions["clients"];
  codeDelivery?: IdentityOptions["codeDelivery"];
  secureCookies?: boolean;
  routeObserver?: IdentityOptions["routeObserver"];
  frontendAssetsRoot?: string | undefined;
}): Promise<{
  client: AuthorityClient;
  identity: FastifyInstance;
  authority: Authority;
}> {
  const { store, hubId, origin } = options;
  const hubs = store.read().hubs;
  if (hubs.length !== 1 || hubs[0]!.id !== hubId)
    throw new Error(
      "An independent hub database must contain exactly its own hub",
    );
  const credential = secret();
  store.change((s) => {
    s.identity.hubs = [
      { hubId, origin, credentialHash: digest(credential), enabled: true },
    ];
  });
  const accounts = new Accounts(
    store,
    options.otpKey ?? secret(),
    options.delivery ?? {
      async send() {
        throw new Error("Email/SMS delivery is not configured on this hub");
      },
    },
  );
  const authority = new Authority(
    store,
    accounts,
    new Tokens(origin, await signingKey(options.signingKey)),
  );
  const identity = await createIdentityApp({
    authority,
    ...(options.setup ? { setup: options.setup } : {}),
    frontendAssetsRoot: options.frontendAssetsRoot,
    localHubId: hubId,
    cookieName: "codoxear_identity_" + hubId,
    loginPath: "/login",
    providers: options.providers ?? [],
    clients: options.clients ?? [],
    codeDelivery: options.codeDelivery ?? [],
    secureCookies: options.secureCookies ?? true,
    ...(options.routeObserver ? { routeObserver: options.routeObserver } : {}),
  });
  const transport: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    if (url.origin !== origin)
      throw new Error("Local hub authority cannot contact another origin");
    const method = url.pathname === "/api/v1/me" ? "GET" : "POST";
    const headers = Object.fromEntries(new Headers(init?.headers));
    if (method === "GET") delete headers["content-type"];
    const res = await identity.inject({
      method,
      url: url.pathname + url.search,
      headers,
      ...(method === "POST" ? { payload: init?.body as string } : {}),
    });
    return new Response(res.body, {
      status: res.statusCode,
      headers: res.headers as Record<string, string>,
    });
  };
  return {
    identity,
    authority,
    client: new AuthorityClient(origin, hubId, credential, transport),
  };
}
