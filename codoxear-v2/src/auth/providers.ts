import * as oauth from "oauth4webapi";
import { z } from "zod";
import { type VerifiedIdentity } from "./accounts.js";
import { DomainError } from "../contracts/model.js";
const Remote = z
  .url()
  .refine(
    (x) => new URL(x).protocol === "https:",
    "Provider endpoints must use HTTPS",
  );
export const ProviderConfig = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("feishu"),
    id: z.string(),
    clientId: z.string(),
    clientSecret: z.string(),
  }),
  z.object({
    kind: z.literal("wechat"),
    id: z.string(),
    clientId: z.string(),
    clientSecret: z.string(),
    surface: z.enum(["website", "public-account", "native"]).default("website"),
  }),
  z.object({
    kind: z.literal("oidc"),
    id: z.string(),
    clientId: z.string(),
    clientSecret: z.string(),
    issuer: Remote,
    scope: z.string().default("openid profile email"),
  }),
]);
export type ProviderConfig = z.infer<typeof ProviderConfig>;
export interface Provider {
  readonly id: string;
  readonly method: "feishu" | "wechat" | "oidc";
  authorize(
    state: string,
    verifier: string,
    redirectUri: string,
  ): Promise<string>;
  exchange(
    code: string,
    verifier: string,
    redirectUri: string,
  ): Promise<VerifiedIdentity>;
}
const denied = () =>
  new DomainError(
    401,
    "provider_rejected",
    "Provider authorization was rejected",
  );
async function json(url: string, options: RequestInit = {}) {
  const response = await fetch(url, {
    ...options,
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  if (!response.ok) throw denied();
  return response.json();
}
export function provider(config: ProviderConfig): Provider {
  if (config.kind === "oidc") {
    let discovered: oauth.AuthorizationServer | undefined;
    const metadata = async () =>
      (discovered ??= await oauth.processDiscoveryResponse(
        new URL(config.issuer),
        await oauth.discoveryRequest(new URL(config.issuer)),
      ));
    const client: oauth.Client = { client_id: config.clientId };
    return {
      id: config.id,
      method: "oidc",
      async authorize(state, verifier, redirectUri) {
        const as = await metadata(),
          url = new URL(as.authorization_endpoint!);
        url.search = new URLSearchParams({
          client_id: config.clientId,
          redirect_uri: redirectUri,
          response_type: "code",
          scope: config.scope,
          state,
          nonce: verifier,
          code_challenge: await oauth.calculatePKCECodeChallenge(verifier),
          code_challenge_method: "S256",
        }).toString();
        return url.href;
      },
      async exchange(code, verifier, redirectUri) {
        const as = await metadata(),
          response = await oauth.authorizationCodeGrantRequest(
            as,
            client,
            oauth.ClientSecretPost(config.clientSecret),
            new URLSearchParams({ code }),
            redirectUri,
            verifier,
          );
        const token = await oauth.processAuthorizationCodeResponse(
          as,
          client,
          response,
          { requireIdToken: true, expectedNonce: verifier },
        );
        const claims = oauth.getValidatedIdTokenClaims(token);
        if (!claims) throw denied();
        return {
          connection: config.id,
          method: "oidc",
          subject: claims.sub,
          tenant: null,
          email:
            claims.email_verified === true && typeof claims.email === "string"
              ? claims.email
              : null,
          name: typeof claims.name === "string" ? claims.name : "Member",
        };
      },
    };
  }
  if (config.kind === "feishu")
    return {
      id: config.id,
      method: "feishu",
      async authorize(state, verifier, redirectUri) {
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
      },
      async exchange(code, verifier, redirectUri) {
        const token = z
          .object({
            code: z.number().optional(),
            access_token: z.string().optional(),
          })
          .parse(
            await json(
              "https://open.feishu.cn/open-apis/authen/v2/oauth/token",
              {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  grant_type: "authorization_code",
                  client_id: config.clientId,
                  client_secret: config.clientSecret,
                  code,
                  redirect_uri: redirectUri,
                  code_verifier: verifier,
                }),
              },
            ),
          );
        if ((token.code ?? 0) !== 0 || !token.access_token) throw denied();
        const info = z
          .object({
            code: z.literal(0),
            data: z.object({
              open_id: z.string().min(1),
              tenant_key: z.string().optional(),
              name: z.string().optional(),
            }),
          })
          .parse(
            await json("https://open.feishu.cn/open-apis/authen/v1/user_info", {
              headers: { Authorization: "Bearer " + token.access_token },
            }),
          );
        return {
          connection: config.id,
          method: "feishu",
          subject: info.data.open_id,
          tenant: info.data.tenant_key ?? null,
          email: null,
          name: info.data.name ?? "Feishu member",
        };
      },
    };
  return {
    id: config.id,
    method: "wechat",
    async authorize(state, _verifier, redirectUri) {
      if (config.surface === "native")
        throw new DomainError(
          409,
          "native_sdk_required",
          "This WeChat connection requires its native SDK authorization surface",
        );
      const url = new URL(
        config.surface === "website"
          ? "https://open.weixin.qq.com/connect/qrconnect"
          : "https://open.weixin.qq.com/connect/oauth2/authorize",
      );
      url.search = new URLSearchParams({
        appid: config.clientId,
        redirect_uri: redirectUri,
        response_type: "code",
        scope:
          config.surface === "website" ? "snsapi_login" : "snsapi_userinfo",
        state,
      }).toString();
      url.hash = "wechat_redirect";
      return url.href;
    },
    async exchange(code, _verifier, _redirectUri) {
      const url = new URL("https://api.weixin.qq.com/sns/oauth2/access_token");
      url.search = new URLSearchParams({
        appid: config.clientId,
        secret: config.clientSecret,
        code,
        grant_type: "authorization_code",
      }).toString();
      const token = z
        .object({ access_token: z.string().min(1), openid: z.string().min(1) })
        .parse(await json(url.href));
      const userInfo = new URL("https://api.weixin.qq.com/sns/userinfo");
      userInfo.search = new URLSearchParams({
        access_token: token.access_token,
        openid: token.openid,
        lang: "en",
      }).toString();
      const info = z
        .object({ openid: z.string(), nickname: z.string().optional() })
        .parse(await json(userInfo.href));
      if (info.openid !== token.openid) throw denied();
      return {
        connection: config.id,
        method: "wechat",
        subject: token.openid,
        tenant: null,
        email: null,
        name: info.nickname ?? "WeChat member",
      };
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
