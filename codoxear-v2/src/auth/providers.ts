import * as oauth from "oauth4webapi";
import { z } from "zod";
import { type VerifiedIdentity } from "./accounts.js";
import { DomainError, Id } from "../contracts/model.js";
const Remote = z
  .url()
  .refine(
    (x) => new URL(x).protocol === "https:",
    "Provider endpoints must use HTTPS",
  );
const Credentials = {
  id: Id,
  name: z.string().trim().min(1).max(120).optional(),
  clientId: z.string().trim().min(1),
  clientSecret: z
    .string()
    .min(1)
    .refine((value) => value.trim().length > 0),
};
export const ProviderConfig = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("google"), ...Credentials }).strict(),
  z.object({ kind: z.literal("feishu"), ...Credentials,
    tenant: z.string().trim().min(1).max(200).optional(),
  }).strict(),
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;
export const HubProviders = z.array(ProviderConfig).superRefine((providers, context) => {
  if (providers.filter((provider) => provider.kind === "feishu").length > 1)
    context.addIssue({ code: "custom", message: "A Hub supports at most one Feishu app" });
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
    context.addIssue({ code: "custom", message: "Provider connection IDs must be unique" });
});
export interface Provider {
  readonly id: string;
  readonly method: "google" | "feishu";
  readonly name?: string;
  readonly tenant?: string;
  authorize(
    state: string,
    verifier: string,
    redirectUri: string,
  ): Promise<string>;
  exchange(
    code: string,
    verifier: string,
    redirectUri: string,
    authorizationIssuer?: string,
  ): Promise<VerifiedIdentity>;
}
export interface ProviderOptions {
  /** Transport injection for isolated verification; production uses native HTTPS fetch. */
  fetch?: typeof fetch;
}
const denied = () =>
  new DomainError(
    401,
    "provider_rejected",
    "Provider authorization was rejected",
  );
class ProviderResponseError extends Error {
  constructor(readonly status: number, readonly providerCode?: number) {
    super("Provider response rejected");
  }
}
async function guarded<T>(
  operation: () => Promise<T>,
  diagnostic?: () => { provider: string; connection: string; stage: string },
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    // Provider payloads and transport errors can contain codes, tokens, or secrets.
    // Log only fields constructed here, never provider text, URLs or exception objects.
    if (diagnostic) console.warn(JSON.stringify({
      event: "provider_exchange_failed", ...diagnostic(),
      reason: error instanceof ProviderResponseError ? "provider_response"
        : error instanceof z.ZodError || error instanceof SyntaxError ? "invalid_response"
        : error instanceof DomainError ? "identity_rejected" : "transport_error",
      ...(error instanceof ProviderResponseError
        ? { httpStatus: error.status, providerCode: error.providerCode } : {}),
    }));
    throw denied();
  }
}
async function feishuJson(url: string, options: RequestInit, transport: typeof fetch) {
  const response = await transport(url, {
    ...options, redirect: "error", signal: AbortSignal.timeout(15000),
  });
  const value: unknown = await response.json();
  const code = value && typeof value === "object" && "code" in value
    && typeof value.code === "number" && Number.isSafeInteger(value.code) ? value.code : undefined;
  if (!response.ok || (code !== undefined && code !== 0))
    throw new ProviderResponseError(response.status, code);
  return value;
}
async function json(
  url: string,
  options: RequestInit = {},
  transport: typeof fetch = fetch,
) {
  const response = await transport(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw denied();
  return response.json();
}
export function provider(
  input: ProviderConfig,
  options: ProviderOptions = {},
): Provider {
  const config = ProviderConfig.parse(input),
    transport = options.fetch ?? fetch;
  const http = {
    [oauth.customFetch]: (
      url: string,
      init: oauth.CustomFetchOptions<
        "GET" | "POST",
        URLSearchParams | undefined
      >,
    ) =>
      transport(url, {
        method: init.method,
        headers: init.headers,
        redirect: "error",
        ...(init.body ? { body: init.body } : {}),
        ...(init.signal ? { signal: init.signal } : {}),
      }),
    signal: () => AbortSignal.timeout(15000),
  };
  if (config.kind === "google") {
    const issuer = new URL("https://accounts.google.com");
    let discovered: oauth.AuthorizationServer | undefined;
    const metadata = async () => {
      if (!discovered) {
        const as = await oauth.processDiscoveryResponse(
          issuer,
          await oauth.discoveryRequest(issuer, http),
        );
        Remote.parse(as.authorization_endpoint);
        Remote.parse(as.token_endpoint);
        Remote.parse(as.jwks_uri);
        discovered = as;
      }
      return discovered;
    };
    const client: oauth.Client = {
      client_id: config.clientId,
      id_token_signed_response_alg: "RS256",
    };
    return {
      id: config.id,
      ...(config.name ? { name: config.name } : {}),
      method: "google",
      authorize(state, verifier, redirectUri) {
        return guarded(async () => {
          const as = await metadata(),
            url = new URL(as.authorization_endpoint!);
          url.search = new URLSearchParams({
            client_id: config.clientId,
            redirect_uri: redirectUri,
            response_type: "code",
            scope: "openid profile email",
            prompt: "select_account",
            state,
            nonce: await oauth.calculatePKCECodeChallenge(
              "google-nonce:" + verifier,
            ),
            code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
            code_challenge_method: "S256",
          }).toString();
          return url.href;
        });
      },
      exchange(code, verifier, redirectUri, authorizationIssuer) {
        return guarded(async () => {
          const as = await metadata();
          // Browser-bound state was verified and consumed by the auth application.
          // Validate Google's callback issuer before handing branded parameters to OAuth.
          const callback = oauth.validateAuthResponse(
            as,
            client,
            new URLSearchParams({
              code,
              ...(authorizationIssuer ? { iss: authorizationIssuer } : {}),
            }),
            oauth.expectNoState,
          );
          const response = await oauth.authorizationCodeGrantRequest(
            as,
            client,
            oauth.ClientSecretPost(config.clientSecret),
            callback,
            redirectUri,
            verifier,
            http,
          );
          const token = await oauth.processAuthorizationCodeResponse(
            as,
            client,
            response,
            {
              requireIdToken: true,
              expectedNonce: await oauth.calculatePKCECodeChallenge(
                "google-nonce:" + verifier,
              ),
            },
          );
          // Processing verifies issuer, audience, expiry, and nonce, but not the JWS signature.
          await oauth.validateApplicationLevelSignature(as, response, http);
          const claims = oauth.getValidatedIdTokenClaims(token);
          if (!claims || !claims.sub) throw denied();
          return {
            connection: config.id,
            method: "google",
            subject: claims.sub,
            tenant: null,
            email:
              claims.email_verified === true && typeof claims.email === "string"
                ? claims.email
                : null,
            name:
              typeof claims.name === "string" && claims.name.trim()
                ? claims.name
                : "Google member",
          };
        });
      },
    };
  }
  return {
    id: config.id,
    ...(config.name ? { name: config.name } : {}),
    method: "feishu",
    ...(config.tenant ? { tenant: config.tenant } : {}),
    authorize(state, verifier, redirectUri) {
      return guarded(async () => {
        const url = new URL(
          "https://accounts.feishu.cn/open-apis/authen/v1/authorize",
        );
        url.search = new URLSearchParams({
          client_id: config.clientId,
          response_type: "code",
          redirect_uri: redirectUri,
          state,
          code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        }).toString();
        return url.href;
      });
    },
    exchange(code, verifier, redirectUri) {
      let stage = "token";
      return guarded(async () => {
        const token = z
          .object({
            // Accept OAuth success with or without the legacy code envelope.
            code: z.literal(0).optional(),
            error: z.never().optional(),
            access_token: z.string().min(1),
          })
          .parse(
            await feishuJson(
              // v3 rejects valid S256 proofs with 20049 for affected Feishu apps.
              // Keep PKCE and use its v2 exchange directly; never retry a used code.
              "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
              {
                method: "POST",
                headers: {
                  "Content-Type": "application/json; charset=utf-8",
                },
                body: JSON.stringify({
                  grant_type: "authorization_code",
                  client_id: config.clientId,
                  client_secret: config.clientSecret,
                  code,
                  redirect_uri: redirectUri,
                  code_verifier: verifier,
                }),
              },
              transport,
            ),
          );
        stage = "user_info";
        const info = z
          .object({
            code: z.literal(0),
            data: z.object({
              open_id: z.string().min(1),
              tenant_key: z.string().min(1),
              name: z.string().optional(),
            }),
          })
          .parse(
            await feishuJson(
              "https://open.feishu.cn/open-apis/authen/v1/user_info",
              {
                headers: { Authorization: "Bearer " + token.access_token },
              },
              transport,
            ),
          );
        if (config.tenant && config.tenant !== info.data.tenant_key) throw denied();
        return {
          connection: config.id,
          method: "feishu",
          subject: info.data.open_id,
          tenant: info.data.tenant_key,
          // Feishu contacts are administrator-imported, not proof of email ownership.
          email: null,
          name: info.data.name?.trim() ? info.data.name : "Feishu member",
        };
      }, () => ({ provider: config.kind, connection: config.id, stage }));
    },
  };
}
// Deployment-owned delivery gateway: credentials stay on the identity server.
// The gateway integrates the operator's chosen email/SMS vendor and must not log codes.
export function deliveryGateway(endpoint: string, bearer: string) {
  Remote.parse(endpoint);
  return {
    async send(method: "email" | "phone", target: string, code: string) {
      await json(endpoint, {
        method: "POST",
        headers: {
          Authorization: "Bearer " + bearer,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({ method, target, code, expiresInSeconds: 300 }),
      });
    },
  };
}
