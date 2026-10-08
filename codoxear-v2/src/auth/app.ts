import { canManageHub } from "../domain/policy.js";
import { agentShares, setAgentShare } from "../domain/agent-sharing.js";
import { InvitationRequest } from "../contracts/invitations.js";
import { InvitationLinkRequest, InvitationLinkToken } from "../contracts/invitations.js";
import { createInvitationLink, inspectInvitationLink, listInvitationLinks, revokeInvitationLink, acceptInvitationLink } from "../domain/invitation-links.js";
import { browserWorkspace } from "../presentation/browser-workspace.js";
import { WorkspaceOptions } from "../contracts/workspaces.js";
import { Launch } from "../contracts/tunnel.js";
import {
  DelegationAuthorityRequest,
  DelegationChildContextRequest,
  DelegationReserveRequest,
} from "../contracts/delegation.js";
import { registerBrowserGateway } from "./browser-gateway.js";
import {
  frontendAsset,
  frontendAssetsRoot,
} from "../presentation/frontend-assets.js";
import Fastify, {
  type FastifyRequest,
  type FastifyReply,
  type RouteOptions,
} from "fastify";
import cookie from "@fastify/cookie";
import { z } from "zod";
import * as oauth from "oauth4webapi";
import { createHash } from "node:crypto";
import { Accounts } from "./accounts.js";
import { registerAdminMembershipRoutes } from "./admin-membership-routes.js";
import { hubRole } from "../domain/policy.js";
import { configureHubOrganization, checkHubLoginMethod, checkHubOrganization, hubLoginMethods } from "./hub-organization.js";
import { HubLoginMethodsRequest } from "../contracts/hub-organization.js";
import { Authority } from "./authority.js";
import { type Provider } from "./providers.js";
import { AuthRequirement, type IdentitySession } from "./model.js";
import {
  Id,
  Name,
  Policy,
  Role,
  Agent,
  DomainError,
  forbid,
  requireValue,
} from "../contracts/model.js";
import {
  id,
  secret,
  digest,
  createHub,
  createComputer,
  invite,
  acceptInvite,
  removeMember,
  setPolicy,
  transferOwner,
  resource,
} from "../domain/commands.js";
import type { State } from "../contracts/model.js";
export interface IdentityOptions {
  routeObserver?: (route: RouteOptions) => void;
  frontendAssetsRoot?: string | undefined;
  authority: Authority;
  cookieName?: string;
  loginPath?: string;
  localHubId?: string;
  providers?: Provider[];
  secureCookies?: boolean;
  clients?: Array<{ id: string; redirectUris: string[] }>;
  codeDelivery?: Array<"email" | "phone">;
  setup?: { pending(): boolean; prepare(token: string): {id: string; expiresAt: number}; complete(state: State, session: IdentitySession, initializationId: string): void };

}
export async function createIdentityApp(options: IdentityOptions) {
  const assetsRoot = frontendAssetsRoot(options.frontendAssetsRoot);
  const cookieName = options.cookieName ?? "codoxear_identity";
  const flowCookie = cookieName + "_oauth";
  const initializationCookie = cookieName + "_initialize";
  const loginPath = options.loginPath ?? "/";
  const { authority: a } = options,
    accounts = a.accounts,
    store = a.store,
    providers = options.providers ?? [],
    app = Fastify({ bodyLimit: 65536 });
  if (new Set(providers.map((provider) => provider.id)).size !== providers.length)
    throw new Error("Provider connection IDs must be unique");
  if (options.localHubId) configureHubOrganization(store, options.localHubId, providers);
  if (options.routeObserver) app.addHook("onRoute", options.routeObserver);
  await app.register(cookie);
  app.setErrorHandler((e, _r, reply) =>
    e instanceof DomainError
      ? reply.code(e.status).send({ code: e.code, error: e.message })
      : e instanceof z.ZodError
        ? reply
            .code(400)
            .send({ code: "invalid_request", error: "Invalid request" })
        : reply.code(500).send({
            code: "internal_error",
            error: "Identity operation failed",
          }),
  );
  app.addHook("onRequest", async (r) => {
    if (["POST", "PUT", "DELETE"].includes(r.method) && r.headers.origin &&
      new URL(r.headers.origin).origin !== a.tokens.issuer)
      throw new DomainError(403, "bad_origin", "Cross-origin request rejected");
  });
  app.addHook("onSend", async (r, reply, value) => {
    reply
      .header(
        "Cache-Control",
        r.url.startsWith("/workspace/") && !r.url.startsWith("/workspace/api/")
          ? (reply.getHeader("Cache-Control") ?? "no-store")
          : "no-store",
      )
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    return value;
  });
  async function session(r: FastifyRequest) {
    const bearer = r.headers.authorization?.replace(/^Bearer /, "");
    if (bearer) {
      const c = await a.tokens.verify(
        bearer,
        a.tokens.issuer,
        "identity_access",
      );
      return accounts.sessionById(c.sessionId);
    }
    return accounts.session(r.cookies[cookieName] ?? "");
  }
  registerAdminMembershipRoutes(app, a, session);
  await browserWorkspace(
    app,
    {
      origin: a.tokens.issuer,
      async request<T>(
        path: string,
        body: unknown,
        sessionId?: string,
      ): Promise<T> {
        const s = accounts.sessionById(sessionId ?? "");
        if (path === "/api/v1/me/agents") return a.agentDirectory(s) as T;
        if (path === "/api/v1/hub-token")
          return (await a.hubToken(
            s,
            Id.parse((body as { hubId: string }).hubId),
          )) as T;
        throw new DomainError(
          404,
          "not_found",
          "Unsupported browser authority operation",
        );
      },
    },
    async (r) => {
      const s = await session(r);
      return { token: s.id, accountId: s.userId, scopeId: s.id };
    },
    assetsRoot,
  );
  app.get("/api/agent-directory", async (r) =>
    a.agentDirectory(await session(r)),
  );
  await registerBrowserGateway(app, a, session);
  function setSession(
    reply: FastifyReply,
    value: { credential: string; session: IdentitySession },
  ) {
    reply.setCookie(cookieName, value.credential, {
      path: "/",
      httpOnly: true,
      secure: options.secureCookies ?? true,
      sameSite: "lax",
      maxAge: 30 * 86400,
    });
    return { userId: value.session.userId };
  }
  async function hubCaller(r: FastifyRequest) {
    const hubId = Id.parse(r.headers["x-codoxear-hub"]);
    a.hubService(hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return {
      hubId,
      session: await a.principal(
        r.headers.authorization?.replace(/^Bearer /, "") ?? "",
        hubId,
      ),
    };
  }
  const resourceParams = z.object({
    kind: z.enum(["hub", "computer"]),
    id: Id,
  });
  function resourceInHub(kind: "hub" | "computer", rid: string, hubId: string) {
    const r = resource(store.read(), kind, rid);
    forbid(
      kind === "hub" ? rid === hubId : "hubId" in r && r.hubId === hubId,
      "Resource belongs to another hub",
    );
    return r;
  }
  app.get("/health", async () => ({
    ok: true,
    service: "identity",
    protocol: 1,
  }));
  app.get("/.well-known/jwks.json", async () => a.tokens.jwks);
  for (const path of ["/login", "/register"]) app.get(path, async (_r, reply) => {
    return reply.type("text/html").send(await frontendAsset(assetsRoot, "client", "hub-login.html"));
  });
  app.get("/hub-login.js", async (_r, reply) => {
    return reply.type("text/javascript").send(await frontendAsset(assetsRoot, "client", "hub-login.js"));
  });
  app.options("/*", async (_r, reply) => reply.code(403).send());
  app.get("/api/v1/auth/options", async () => ({
    providers: providers.map((p) => ({ id: p.id, method: p.method, ...(p.name ? { name: p.name } : {}) })),
    registration: { enabled: providers.length > 0, method: "provider" },
    setupRequired: options.setup?.pending() ?? false,
    organization: (() => {
      const organization = store.read().identity.hubOrganizations.find((value) => value.hubId === options.localHubId);
      return { feishuTenant: organization?.feishuTenant ?? null,
        tenantBindingRequired: !!organization?.feishuConnection && !organization.feishuTenant };
    })(),
    loginMethods: hubLoginMethods(store, options.localHubId, providers),
  }));
  app.get("/initialize", async (r, reply) => {
    accounts.rateLimit("initialize:" + r.ip, 10, 60000);
    const input = z.object({ token: z.string().min(32).max(256), continue: z.string().max(4096).optional() }).strict().parse(r.query);
    if (!options.setup) throw new DomainError(403, "initialization_rejected", "Initialization is unavailable");
    const initialized = options.setup.prepare(input.token);
    if (input.continue && (!input.continue.startsWith("/oauth/authorize?") || new URL(input.continue, a.tokens.issuer).origin !== a.tokens.issuer))
      throw new DomainError(400, "invalid_return", "Invalid sign-in continuation");
    reply.setCookie(initializationCookie, input.token, { path: "/auth/", httpOnly: true,
      secure: options.secureCookies ?? true, sameSite: "lax", maxAge: Math.max(0, Math.floor((initialized.expiresAt - Date.now()) / 1000)) });
    return reply.redirect(loginPath + "?" + new URLSearchParams({ initialize: "1", ...(input.continue ? { continue: input.continue } : {}) }));
  });
  for (const path of ["/api/v1/auth/logout", "/workspace/api/logout"])
    app.post(path, async (r, reply) => {
      const s = await session(r);
      store.change((state) => {
        requireValue(
          state.identity.sessions.find((x) => x.id === s.id),
        ).revoked = true;
      });
      reply.clearCookie(cookieName, { path: "/" });
      return { ok: true };
    });
  app.get("/api/v1/me", async (r) => {
    const s = await session(r),
      u = requireValue(store.read().users.find((x) => x.id === s.userId));
    return {
      id: u.id,
      name: u.name,
      email: u.email,
      context: s.context,
      hubRole: options.localHubId ? hubRole(store.read(), s.userId, requireValue(store.read().hubs.find((hub) => hub.id === options.localHubId))) : null,
      identities: store
        .read()
        .identity.identities.filter((x) => x.userId === s.userId)
        .map(({ id, connection, method, subject, tenant }) => ({
          id,
          connection,
          method,
          subject,
          tenant,
        })),
    };
  });
  app.delete("/api/v1/me/identities/:id", async (r) => {
    const identityId = Id.parse((r.params as { id: string }).id);
    accounts.unlink(r.cookies[cookieName] ?? "", identityId);
    return { ok: true };
  });
  app.get("/api/v1/me/agents", async (r) => a.agentDirectory(await session(r)));
  app.post("/api/v1/me/agents", async (r) =>
    a.agentDirectory(await session(r)),
  );
  app.get("/api/v1/me/hubs", async (r) => a.directory(await session(r)));
  app.get("/api/v1/me/computers", async (r) => {
    const user = await session(r);
    return a
      .directory(user)
      .filter((h) => h.access === "allowed")
      .flatMap((h) =>
        a.computers(user, h.id).map((c) => ({
          id: c.id,
          hubId: c.hubId,
          name: c.name,
          binding: c.binding,
          ownerId: c.ownerId,
          hubName: h.name,
        })),
      );
  });
  app.post("/api/v1/invitations/accept", async (r) => {
    const current = await session(r),
      b = z.object({ token: z.string().min(32).max(256) }).parse(r.body);
    const invitation = requireValue(store.read().invitations.find(value => value.tokenHash === digest(b.token)));
    if (invitation.resource === "hub") throw new DomainError(409, "hub_invitation_link_required", "Use a Member invitation link to join this Hub");
    return store.change((s) => acceptInvite(s, current.userId, b.token));
  });
  app.get("/api/invitation-links/:token", async (r) => {
    accounts.rateLimit("invite-preview:" + r.ip, 60, 60000);
    return inspectInvitationLink(store.read(), InvitationLinkToken.parse((r.params as {token: string}).token), options.localHubId);
  });
  app.post("/api/invitation-links/:token/accept", async (r) => {
    accounts.rateLimit("invite-accept:" + r.ip, 30, 60000);
    z.object({}).strict().parse(r.body ?? {});
    const current = await session(r);
    const token = InvitationLinkToken.parse((r.params as {token: string}).token);
    return store.change(state => {
      const link = inspectInvitationLink(state, token, options.localHubId);
      checkHubOrganization(state, link.hub.id, current.context.method, current.context.tenant, true);
      const requirement = state.identity.requirements.find(value => value.hubId === link.hub.id)?.rule;
      if (requirement) a.checkAuthentication(current, requirement);
      return acceptInvitationLink(state, current.userId, token, options.localHubId);
    });
  });
  app.post("/api/v1/hubs", async (r) => {
    forbid(!options.localHubId, "An independent hub cannot create other hubs");
    const s = await session(r),
      b = z.object({ name: Name }).parse(r.body);
    return store.change((state) => createHub(state, s.userId, b.name));
  });
  app.post("/api/v1/hubs/:id/computers", async (r) => {
    const current = await session(r),
      hubId = Id.parse((r.params as { id: string }).id);
    a.context(current, hubId);
    const input = z.object({ name: Name }).parse(r.body);
    const result = store.change((state) =>
      createComputer(state, current.userId, hubId, input.name, current.userId),
    );
    return {
      computer: { id: result.computer.id, name: result.computer.name, hubId },
      enrollment: {
        identityUrl: a.tokens.issuer,
        code: a.pairing(current, result.computer.id).code,
      },
    };
  });
  app.post("/api/v1/hubs/:id/register", async (r) => {
    forbid(!options.localHubId, "An independent hub owns its own origin");
    const s = await session(r),
      hubId = Id.parse((r.params as { id: string }).id),
      b = z.object({ origin: z.url() }).parse(r.body);
    return a.registerHub(s, hubId, b.origin);
  });
  app.put("/api/v1/hubs/:id/auth-requirement", async (r) => {
    const s = await session(r),
      hubId = Id.parse((r.params as { id: string }).id),
      h = a.context(s, hubId),
      b = z.object({ rule: AuthRequirement.nullable() }).parse(r.body);
    forbid(
      h.ownerId === s.userId,
      "Only the hub owner can change login requirements",
    );
    // Verify the proposed rule with this owner's fresh proof before it can lock the hub.
    if (b.rule) a.checkAuthentication(s, b.rule);
    store.change((state) => {
      state.identity.requirements = state.identity.requirements.filter(
        (x) => x.hubId !== hubId,
      );
      if (b.rule) state.identity.requirements.push({ hubId, rule: b.rule });
    });
    return { ok: true };
  });
  async function loginMethodOwner(r: FastifyRequest) {
    const current = await session(r), hubId = Id.parse((r.params as { id: string }).id);
    forbid(options.localHubId === hubId, "Login account types belong to this independent Hub");
    const hub = a.context(current, hubId);
    forbid(hub.ownerId === current.userId, "Only the Hub owner can change allowed account types");
    return { current, hubId };
  }
  app.get("/api/v1/hubs/:id/login-methods", async (r) => {
    const { hubId } = await loginMethodOwner(r);
    return hubLoginMethods(store, hubId, providers);
  });
  app.put("/api/v1/hubs/:id/login-methods", async (r) => {
    const { current, hubId } = await loginMethodOwner(r), input = HubLoginMethodsRequest.parse(r.body);
    const { availableMethods } = hubLoginMethods(store, hubId, providers);
    if (input.allowedMethods.some((method) => !availableMethods.includes(method as Provider["method"])))
      throw new DomainError(400, "unsupported_login_method", "Choose only account types configured on this Hub");
    if (!input.allowedMethods.includes(current.context.method))
      throw new DomainError(409, "owner_login_method_required", "Sign in as the owner through a remaining account type before disabling this one");
    store.change((state) => {
      const organization = requireValue(state.identity.hubOrganizations.find((value) => value.hubId === hubId));
      organization.allowedMethods = [...input.allowedMethods].sort();
    });
    return hubLoginMethods(store, hubId, providers);
  });
  app.post("/api/v1/hub-token", async (r) => {
    const s = await session(r),
      { hubId } = z.object({ hubId: Id }).parse(r.body);
    return a.hubToken(s, hubId);
  });
  app.post("/api/v1/pairing/redeem", async (r) => {
    accounts.rateLimit("pair:" + r.ip, 30, 60000);
    return a.redeem(
      z.object({ code: z.string().trim().min(8).max(100) }).parse(r.body).code,
    );
  });
  app.post("/api/v1/pairing/inspect-transfer", async (r) => {
    accounts.rateLimit("pair-transfer:" + r.ip, 30, 60000);
    return a.inspectTransferPairing(
      z.object({ code: z.string().trim().min(8).max(100) }).parse(r.body).code,
    );
  });
  app.post("/api/v1/pairing/redeem-transfer", async (r) => {
    accounts.rateLimit("pair-transfer:" + r.ip, 30, 60000);
    const b = z
      .object({
        code: z.string().trim().min(8).max(100),
        transferId: Id,
        credential: z
          .string()
          .min(32)
          .max(200)
          .regex(/^[A-Za-z0-9_-]+$/),
      })
      .parse(r.body);
    return a.redeemTransfer(b.code, b.transferId, b.credential);
  });
  app.post("/api/v1/hubs/:id/admissions", async (r) => {
    const s = await session(r),
      hubId = Id.parse((r.params as { id: string }).id),
      b = z.object({ computerId: Id }).parse(r.body);
    return a.admitComputer(s, hubId, b.computerId);
  });
  app.post("/api/v1/computers/:id/transfer", async (r) => {
    const s = await session(r),
      computerId = Id.parse((r.params as { id: string }).id),
      b = z
        .object({
          targetHubId: Id,
          exposeHistory: z.boolean(),
          admissionToken: z.string().optional(),
        })
        .parse(r.body);
    return a.transferComputer(
      s,
      computerId,
      b.targetHubId,
      b.exposeHistory,
      b.admissionToken,
    );
  });
  app.get("/auth/:connection/start", async (r, reply) => {
    const connection = Id.parse(
        (r.params as { connection: string }).connection,
      ),
      p = requireValue(
        providers.find((x) => x.id === connection),
        "Provider not configured",
      ),
      query = z
        .object({
          link: z.enum(["0", "1"]).optional(),
          continue: z.string().max(4096).optional(),
        })
        .parse(r.query);
    if (options.localHubId) checkHubLoginMethod(store.read(), options.localHubId, p.method);
    if (
      query.continue &&
      (!query.continue.startsWith("/oauth/authorize?") ||
        new URL(query.continue, a.tokens.issuer).origin !== a.tokens.issuer)
    )
      throw new DomainError(
        400,
        "invalid_return",
        "Invalid sign-in continuation",
      );
    const initialization = r.cookies[initializationCookie] ? options.setup?.prepare(r.cookies[initializationCookie]!) : undefined;
    if (initialization && query.link === "1")
      throw new DomainError(400, "initialization_rejected", "Initialize with a provider sign-in, without linking accounts");
    const linking = query.link === "1" ? await session(r) : null;
    if (linking && Date.now() - linking.context.authenticatedAt > 300000)
      throw new DomainError(
        401,
        "reauthentication_required",
        "Sign in again before linking",
      );
    const state = secret(),
      browser = secret(),
      verifier = oauth.generateRandomCodeVerifier();
    store.change((s) => {
      s.identity.flows = s.identity.flows.filter(
        (x) => x.expiresAt > Date.now(),
      );
      s.identity.flows.push({
        id: id(),
        stateHash: digest(state),
        browserHash: digest(browser),
        connection,
        verifier,
        expiresAt: Date.now() + 600000,
        used: false,
        linkUserId: linking?.userId ?? null,
        linkSessionId: linking?.id ?? null,
        continuePath: query.continue,
        ...(initialization ? { initializationId: initialization.id } : {}),
      });
    });
    reply.setCookie(flowCookie, browser, {
      httpOnly: true,
      secure: options.secureCookies ?? true,
      sameSite: "lax",
      path: "/auth/",
      maxAge: 600,
    });
    return reply.redirect(
      await p.authorize(
        state,
        verifier,
        a.tokens.issuer + "/auth/" + connection + "/callback",
      ),
    );
  });
  app.get("/auth/:connection/callback", async (r, reply) => {
    const connection = Id.parse(
        (r.params as { connection: string }).connection,
      ),
      q = z
        .object({
          state: z.string(),
          code: z.string().optional(),
          error: z.string().optional(),
          iss: z.string().max(2048).optional(),
        })
        .parse(r.query);
    const flow = store.change((s) => {
      const f = s.identity.flows.find(
        (x) =>
          x.connection === connection &&
          x.stateHash === digest(q.state) &&
          x.browserHash === digest(r.cookies[flowCookie] ?? "") &&
          !x.used &&
          x.expiresAt > Date.now(),
      );
      if (!f) return null;
      f.used = true;
      return { ...f };
    });
    if (!flow)
      throw new DomainError(
        401,
        "invalid_state",
        "OAuth transaction expired or does not belong to this browser",
      );
    reply.clearCookie(flowCookie, { path: "/auth/" });
    if (q.error || !q.code)
      return reply.redirect(loginPath + "?login=cancelled");
    const p = requireValue(providers.find((x) => x.id === connection));
    if (options.localHubId) checkHubLoginMethod(store.read(), options.localHubId, p.method);
    const verified = await p.exchange(
      q.code,
      flow.verifier,
      a.tokens.issuer + "/auth/" + connection + "/callback",
      q.iss,
    );
    setSession(
      reply,
      accounts.finish(verified, "web", flow.linkSessionId ?? undefined, flow.initializationId ? (state, session) => {
        if (!options.setup) throw new DomainError(403, "initialization_rejected", "Initialization is unavailable");
        options.setup.complete(state, session, flow.initializationId!);
      } : undefined),
    );
    if (flow.initializationId) reply.clearCookie(initializationCookie, { path: "/auth/" });
    return reply.redirect(flow.continuePath ?? loginPath);
  });
  // Identity authorization endpoint for native clients and each registered hub's BFF.
  app.get("/oauth/authorize", async (r, reply) => {
    const q = z
      .object({
        client_id: Id,
        redirect_uri: z.url(),
        state: z.string().min(16).max(256),
        code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
        code_challenge_method: z.literal("S256"),
        response_type: z.literal("code"),
      })
      .parse(r.query);
    const registered = store
      .read()
      .identity.hubs.find((x) => x.hubId === q.client_id && x.enabled);
    const allowed = registered
      ? q.redirect_uri === registered.origin + "/auth/callback"
      : options.clients?.some(
          (c) =>
            c.id === q.client_id && c.redirectUris.includes(q.redirect_uri),
        );
    forbid(!!allowed, "Unregistered authorization callback");
    let s: IdentitySession;
    try {
      s = await session(r);
    } catch {
      return reply.redirect(
        loginPath + "?continue=" + encodeURIComponent(r.url),
      );
    }
    if (registered) {
      try {
        a.context(s, registered.hubId);
      } catch (e) {
        if (e instanceof DomainError && e.code === "reauthentication_required")
          return reply.redirect(
            loginPath + "?reauth=1&continue=" + encodeURIComponent(r.url),
          );
        throw e;
      }
    }
    const code = secret();
    store.change((state) => {
      state.identity.codes = state.identity.codes.filter(
        (x) => x.expiresAt > Date.now(),
      );
      state.identity.codes.push({
        hash: digest(code),
        sessionId: s.id,
        clientId: q.client_id,
        redirectUri: q.redirect_uri,
        challenge: q.code_challenge,
        expiresAt: Date.now() + 60000,
        used: false,
      });
    });
    const redirect = new URL(q.redirect_uri);
    redirect.searchParams.set("code", code);
    redirect.searchParams.set("state", q.state);
    redirect.searchParams.set("iss", a.tokens.issuer);
    return reply.redirect(redirect.href);
  });
  app.post("/oauth/token", async (r) => {
    const b = z
      .discriminatedUnion("grant_type", [
        z.object({
          grant_type: z.literal("authorization_code"),
          code: z.string(),
          client_id: Id,
          redirect_uri: z.url(),
          code_verifier: z.string().min(43).max(128),
          installation_id: Id.optional(),
        }),
        z.object({
          grant_type: z.literal("refresh_token"),
          refresh_token: z.string().min(32),
        }),
      ])
      .parse(r.body);
    let s: IdentitySession, refreshToken: string;
    if (b.grant_type === "refresh_token") {
      const value = accounts.rotateRefresh(b.refresh_token);
      s = value.session;
      refreshToken = value.refreshToken;
    } else {
      const code = store.change((state) => {
        const c = state.identity.codes.find((x) => x.hash === digest(b.code));
        if (
          !c ||
          c.used ||
          c.expiresAt <= Date.now() ||
          c.clientId !== b.client_id ||
          c.redirectUri !== b.redirect_uri ||
          c.challenge !==
            createHash("sha256").update(b.code_verifier).digest("base64url")
        )
          return null;
        c.used = true;
        return { ...c };
      });
      if (!code)
        throw new DomainError(
          401,
          "invalid_grant",
          "Authorization code or PKCE verifier rejected",
        );
      s = accounts.forkSession(
        code.sessionId,
        b.installation_id ?? b.client_id,
      );
      refreshToken = accounts.issueRefresh(s.id);
    }
    return {
      access_token: await a.tokens.issue(s, a.tokens.issuer, "identity_access"),
      refresh_token: refreshToken,
      token_type: "Bearer",
      expires_in: 300,
    };
  });
  app.post("/oauth/revoke", async (r) => {
    accounts.rateLimit("revoke:" + r.ip, 30, 60000);
    const b = z.object({ token: z.string().min(32).max(256) }).parse(r.body);
    accounts.revokeRefresh(b.token);
    return { ok: true };
  });
  app.post("/internal/device", async (r) => {
    const b = z
      .object({ hubId: Id, computerId: Id, credential: z.string() })
      .parse(r.body);
    a.hubService(b.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.device(b.hubId, b.computerId, b.credential);
  });
  app.post("/internal/computer-detach", async (r) => {
    const b = z
      .object({
        hubId: Id,
        computerId: Id,
        credential: z.string(),
        transferId: Id,
      })
      .parse(r.body);
    a.hubService(b.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.detachDevice(b.hubId, b.computerId, b.credential, b.transferId);
  });
  app.post("/internal/notification-target", async (r) => {
    const b = z
      .object({
        hubId: Id,
        computerId: Id,
        credential: z.string(),
        localId: z.string().min(1).max(200),
      })
      .parse(r.body);
    a.hubService(b.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.notificationTarget(b.hubId, b.computerId, b.credential, b.localId);
  });
  app.post("/internal/notification-authorize", async (r) => {
    const b = z
      .object({
        hubId: Id,
        sessionId: Id,
        agentId: Id,
        computerId: Id,
        binding: z.number().int().nonnegative(),
      })
      .parse(r.body);
    a.hubService(b.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.authorizeNotification(
      b.hubId,
      b.sessionId,
      b.agentId,
      b.computerId,
      b.binding,
    );
  });
  app.post("/internal/download-authorize", async (r) => {
    const b = z
      .object({
        hubId: Id,
        sessionId: Id,
        computerId: Id,
        agentId: Id,
        binding: z.number().int().positive(),
        path: z.string().min(1).max(8000),
      })
      .strict()
      .parse(r.body);
    a.hubService(b.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    const session = a.accounts.sessionById(b.sessionId);
    const current = a.authorize(session, b.hubId, b.agentId, "read");
    const computer = a
      .computers(session, b.hubId)
      .find((c) => c.id === b.computerId);
    forbid(
      current.agent.computerId === b.computerId &&
        current.agent.localId !== null &&
        b.path.startsWith(
          `/api/sessions/${current.agent.localId}/file/download?`,
        ) &&
        computer?.binding === b.binding,
      "Download identity or Computer binding changed",
    );
    return a.relay(session, b.hubId, b.computerId, "GET", b.path);
  });
  app.post("/internal/queue-authorize", async (r) => {
    const b = z
      .object({
        hubId: Id,
        computerId: Id,
        credential: z.string(),
        permit: z.string(),
        localId: z.string(),
      })
      .parse(r.body);
    a.hubService(b.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.authorizeQueue(
      b.hubId,
      b.computerId,
      b.credential,
      b.permit,
      b.localId,
    );
  });
  app.post("/internal/delegation-authorize", async (r) => {
    const input = DelegationAuthorityRequest.parse(r.body);
    a.hubService(input.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.authorizeDelegation(input);
  });
  app.post("/internal/delegation-child-context", async (r) => {
    const input = DelegationChildContextRequest.parse(r.body);
    a.hubService(input.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.childDelegationContext(input);
  });
  app.post("/internal/delegation-reserve", async (r) => {
    const input = DelegationReserveRequest.parse(r.body);
    a.hubService(input.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    return a.reserveDelegatedAgent(input);
  });
  app.post("/internal/call", async (r) => {
    const caller = await hubCaller(r),
      { hubId } = caller,
      s = caller.session,
      b = z
        .object({
          op: z.string(),
          args: z.record(z.string(), z.unknown()).default({}),
        })
        .parse(r.body),
      args = b.args;
    switch (b.op) {
      case "invitation-link-create": {
        const input = InvitationLinkRequest.extend({ hubId: Id }).parse(args);
        forbid(input.hubId === hubId, "Resource belongs to another hub");
        return store.change(state => createInvitationLink(state, s.userId, hubId, input.expiresInHours));
      }
      case "invitation-link-list": {
        const input = z.object({hubId: Id}).strict().parse(args);
        forbid(input.hubId === hubId, "Resource belongs to another hub");
        return listInvitationLinks(store.read(), s.userId, hubId);
      }
      case "invitation-link-revoke": {
        const input = z.object({hubId: Id, invitationId: Id}).strict().parse(args);
        forbid(input.hubId === hubId, "Resource belongs to another hub");
        return store.change(state => revokeInvitationLink(state, s.userId, hubId, input.invitationId));
      }
      case "delegation-parent": {
        const input = z.object({ parentId: Id }).strict().parse(args);
        return a.delegationParent(s, hubId, input.parentId);
      }
      case "delegation-context": {
        const input = z
          .object({ parentId: Id, targetComputerId: Id })
          .strict()
          .parse(args);
        return a.delegationContext(
          s,
          hubId,
          input.parentId,
          input.targetComputerId,
        );
      }
      case "notification-session":
        return { id: s.userId, sessionId: s.id };
      case "notification-subject": {
        const computerId = Id.parse(args.computerId);
        const computer = a.computers(s, hubId).find((c) => c.id === computerId);
        forbid(!!computer, "Computer access required");
        return {
          userId: s.userId,
          sessionId: s.id,
          binding: computer!.binding,
        };
      }
      case "queue-permit": {
        const input = z
          .object({ computerId: Id, path: z.string() })
          .parse(args);
        return a.queuePermit(s, hubId, input.computerId, input.path);
      }
      case "relay": {
        const input = z
          .object({ computerId: Id, method: z.string(), path: z.string() })
          .parse(args);
        return a.relay(s, hubId, input.computerId, input.method, input.path);
      }
      case "me": {
        const user = requireValue(
          store.read().users.find((u) => u.id === s.userId),
        );
        return { id: user.id, name: user.name, email: user.email };
      }
      case "hub":
        return a.context(s, hubId);
      case "computers":
        return a.computers(s, hubId);
      case "computer-owner":
        return a.computerOwner(s, hubId, Id.parse(args.computerId));
      case "import-agent":
        return a.importAgent(
          s,
          hubId,
          Id.parse(args.computerId),
          z.string().min(1).max(200).parse(args.localId),
          Name.parse(args.name),
          Agent.shape.backend.parse(args.backend),
        );
      case "agents":
        return a.agents(s, hubId, Id.parse(args.computerId));
      case "authorize":
        return a.authorize(
          s,
          hubId,
          Id.parse(args.agentId),
          z.enum(["read", "send", "interrupt"]).parse(args.action),
        );
      case "create-agent":
        return a.createAgent(
          s,
          hubId,
          Id.parse(args.computerId),
          Name.parse(args.name),
          Agent.shape.backend.parse(args.backend),
        );
      case "forget-deleted-agent":
        return a.forgetDeletedAgent(
          s,
          hubId,
          Id.parse(args.computerId),
          z
            .string()
            .regex(/^[A-Za-z0-9_.:-]{1,200}$/)
            .parse(args.localId),
        );
      case "create-computer": {
        const input = z
          .object({ name: Name, ownerId: Id.optional() })
          .parse(args);
        const result = store.change((state) =>
          createComputer(
            state,
            s.userId,
            hubId,
            input.name,
            input.ownerId ?? s.userId,
          ),
        );
        return {
          computer: {
            id: result.computer.id,
            name: result.computer.name,
            hubId,
            ownerId: result.computer.ownerId,
          },
          pairing:
            result.computer.ownerId === s.userId
              ? a.pairing(s, result.computer.id)
              : null,
        };
      }
      case "pair": {
        const computerId = Id.parse(args.computerId);
        resourceInHub("computer", computerId, hubId);
        return a.pairing(s, computerId);
      }
      case "accept": {
        const token = z.string().parse(args.token);
        const invitation = requireValue(
          store.read().invitations.find((x) => x.tokenHash === digest(token)),
        );
        if (invitation.resource === "hub") throw new DomainError(409, "hub_invitation_link_required", "Use a Member invitation link to join this Hub");
        resourceInHub(invitation.resource, invitation.resourceId, hubId);
        return store.change((state) => acceptInvite(state, s.userId, token));
      }
      case "members": {
        const p = resourceParams.parse(args),
          res = resourceInHub(p.kind, p.id, hubId);
        const state = store.read();
        forbid(
          canManageHub(state,s.userId,requireValue(state.hubs.find(h=>h.id === hubId))),
          "Only Hub owners and admins can list members",
        );
        return state.memberships
          .filter((m) => m.resource === p.kind && m.resourceId === p.id)
          .map((m) => ({
            ...m,
            name: state.users.find((u) => u.id === m.userId)?.name,
            email: state.users.find((u) => u.id === m.userId)?.email,
            workspaceAccess:
              p.kind === "computer"
                ? (state.identity.workspaceGrants.find(
                    (g) =>
                      g.computerId === p.id &&
                      g.userId === m.userId &&
                      g.ownerRevision === res.revision &&
                      "binding" in res &&
                      g.binding === res.binding,
                  )?.access ?? null)
                : null,
            workspaceGrants:
              p.kind === "computer"
                ? state.identity.workspaceGrants.filter(
                    (g) =>
                      g.computerId === p.id &&
                      g.userId === m.userId &&
                      g.ownerRevision === res.revision &&
                      "binding" in res &&
                      g.binding === res.binding,
                  )
                : [],
          }));
      }
      case "agent-shares": {
        const agentId = Id.parse(args.agentId);
        const agent = requireValue(
          store
            .read()
            .agents.find((a) => a.id === agentId && a.hubId === hubId),
        );
        return agentShares(store.read(), s.userId, agent.id);
      }
      case "agent-share": {
        const input = z
          .object({ agentId: Id, userId: Id, role: Role.nullable() })
          .strict()
          .parse(args);
        requireValue(
          store
            .read()
            .agents.find((a) => a.id === input.agentId && a.hubId === hubId),
        );
        return store.change((state) =>
          setAgentShare(
            state,
            s.userId,
            input.agentId,
            input.userId,
            input.role,
          ),
        );
      }
      case "workspace-access": {
        const input = z
          .object({
            computerId: Id,
            userId: Id,
            access: z.enum(["read", "write"]).nullable(),
            ...WorkspaceOptions.shape,
          })
          .parse(args);
        return a.setWorkspaceAccess(
          s,
          hubId,
          input.computerId,
          input.userId,
          input.access,
          input,
        );
      }
      case "invite": {
        const p = resourceParams.parse(args);
        if (p.kind === "hub") throw new DomainError(409, "hub_invitation_link_required", "Create a shareable Member invitation link for this Hub");
        const {
          kind: _kind,
          id: _id,
          ...body
        } = args as Record<string, unknown>;
        const destination = InvitationRequest.parse(body);
        resourceInHub(p.kind, p.id, hubId);
        const value = store.change((state) =>
          invite(
            state,
            s.userId,
            p.kind,
            p.id,
            destination.target ?? destination.email!,
            destination.role,
          ),
        );
        return { token: value.token, id: value.invitation.id };
      }
      case "remove": {
        const p = resourceParams.extend({ memberId: Id }).parse(args);
        resourceInHub(p.kind, p.id, hubId);
        store.change((state) =>
          removeMember(state, s.userId, p.kind, p.id, p.memberId),
        );
        return { ok: true };
      }
      case "policy": {
        const p = resourceParams
          .extend({ policy: Policy.nullable() })
          .parse(args);
        resourceInHub(p.kind, p.id, hubId);
        store.change((state) =>
          setPolicy(state, s.userId, p.kind, p.id, p.policy),
        );
        return { ok: true };
      }
      case "owner": {
        const p = resourceParams.extend({ ownerId: Id }).parse(args);
        resourceInHub(p.kind, p.id, hubId);
        return store.change((state) =>
          transferOwner(state, s.userId, p.kind, p.id, p.ownerId),
        );
      }
      default:
        throw new DomainError(
          400,
          "unknown_operation",
          "Unknown authority operation",
        );
    }
  });
  app.post("/internal/agent-result", async (r) => {
    const b = z
      .object({
        hubId: Id,
        agentId: Id,
        state: Agent.shape.state,
        localId: z.string().nullable(),
      })
      .parse(r.body);
    a.hubService(b.hubId, (r.headers["x-hub-credential"] as string) ?? "");
    store.change((state) => {
      const agent = requireValue(
        state.agents.find((x) => x.id === b.agentId && x.hubId === b.hubId),
      );
      // A delayed failed/unknown reply must not erase a recovered receipt.
      if (agent.state === "ready") {
        forbid(
          b.state !== "ready" || agent.localId === b.localId,
          "Agent launch result conflicts with an existing receipt",
        );
        return;
      }
      forbid(
        (b.state === "ready") === !!b.localId,
        "A ready launch requires its local session identity",
      );
      if (b.localId)
        forbid(
          !state.agents.some(
            (other) =>
              other.id !== agent.id &&
              other.hubId === agent.hubId &&
              other.computerId === agent.computerId &&
              other.localId === b.localId,
          ),
          "Local session is already published; open the existing agent",
        );
      agent.state = b.state;
      agent.localId = b.localId;
    });
    return { ok: true };
  });
  for (const asset of [
    "app.css",
    "app_theme.js",
    "shell.css",
    "connections.css",
    "favicon.svg",
    "themes/clay.css",
    "themes/slate.css",
    "themes/paper.css",
  ]) {
    app.get("/appearance/" + asset, async (_r, reply) =>
      reply
        .type(
          asset.endsWith(".css")
            ? "text/css"
            : asset.endsWith(".svg")
              ? "image/svg+xml"
              : "text/javascript",
        )
        .send(
          await frontendAsset(assetsRoot, "identity", "appearance/" + asset),
        ),
    );
  }
  app.get("/account.js", async (_r, reply) =>
    reply
      .type("text/javascript; charset=utf-8")
      .send(await frontendAsset(assetsRoot, "identity", "account.js")),
  );
  app.get("/cache-design", async (_r, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(await frontendAsset(assetsRoot, "identity", "cache-design.html")),
  );
  app.get("/auth/start", async (_r, reply) => reply.redirect("/"));
  app.get("/", async (_r, reply) => {
    return reply
      .type("text/html")
      .send(await frontendAsset(assetsRoot, "identity", "index.html"));
  });
  return app;
}
