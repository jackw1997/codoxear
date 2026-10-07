import { agentShares, setAgentShare } from "../domain/agent-sharing.js";
import { InvitationRequest } from "../contracts/invitations.js";
import { browserWorkspace } from "../presentation/browser-workspace.js";
import { WorkspaceOptions } from "../contracts/workspaces.js";
import { Launch } from "../contracts/tunnel.js";
import { DelegationAuthorityRequest, DelegationChildContextRequest, DelegationReserveRequest } from "../contracts/delegation.js";
import { registerBrowserGateway } from "./browser-gateway.js";
import { readFile } from "node:fs/promises";
import { portal } from "./portal.js";
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
export interface IdentityOptions {
  routeObserver?: (route: RouteOptions) => void;
  authority: Authority;
  cookieName?: string;
  loginPath?: string;
  localHubId?: string;
  providers?: Provider[];
  secureCookies?: boolean;
  clients?: Array<{ id: string; redirectUris: string[] }>;
  codeDelivery?: Array<"email" | "phone">;
}
export async function createIdentityApp(options: IdentityOptions) {
  const cookieName = options.cookieName ?? "codoxear_identity";
  const flowCookie = cookieName + "_oauth";
  const loginPath = options.loginPath ?? "/";
  const { authority: a } = options,
    accounts = a.accounts,
    store = a.store,
    providers = options.providers ?? [],
    app = Fastify({ bodyLimit: 65536 });
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
    if (
      ["POST", "PUT", "DELETE"].includes(r.method) &&
      r.headers.origin &&
      new URL(r.headers.origin).origin !== a.tokens.issuer
    )
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
  app.get("/api/v1/auth/options", async () => ({
    providers: providers.map((p) => ({ id: p.id, method: p.method })),
    codes: options.codeDelivery ?? [],
    password: true,
  }));
  app.post("/api/v1/auth/password", async (r, reply) => {
    accounts.rateLimit("login:" + r.ip, 10, 60000);
    const b = z
      .object({
        email: z.email(),
        password: z.string().min(1).max(512),
        installationId: Id.default("web"),
      })
      .parse(r.body);
    return setSession(
      reply,
      accounts.password(b.email, b.password, b.installationId),
    );
  });
  app.post("/api/v1/auth/code", async (r) => {
    accounts.rateLimit("challenge:" + r.ip, 10, 60000);
    const b = z
      .object({
        method: z.enum(["email", "phone"]),
        target: z.string().max(254),
        link: z.boolean().default(false),
      })
      .parse(r.body);
    forbid(
      options.codeDelivery?.includes(b.method) ?? false,
      "This delivery provider is not configured",
    );
    if (b.link) accounts.session(r.cookies[cookieName] ?? "");
    return accounts.challenge(
      b.method,
      b.target,
      b.link ? r.cookies[cookieName] : undefined,
    );
  });
  app.post("/api/v1/auth/code/verify", async (r, reply) => {
    accounts.rateLimit("verify:" + r.ip, 30, 60000);
    const b = z
      .object({
        challengeId: Id,
        transaction: z.string().min(32).max(100),
        code: z.string().regex(/^\d{6}$/),
        installationId: Id.default("web"),
      })
      .parse(r.body);
    return setSession(
      reply,
      accounts.verifyChallenge(
        b.challengeId,
        b.transaction,
        b.code,
        b.installationId,
      ),
    );
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
    return store.change((s) => acceptInvite(s, current.userId, b.token));
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
    const verified = await p.exchange(
      q.code,
      flow.verifier,
      a.tokens.issuer + "/auth/" + connection + "/callback",
    );
    setSession(
      reply,
      accounts.finish(verified, "web", flow.linkSessionId ?? undefined),
    );
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
        resourceInHub(invitation.resource, invitation.resourceId, hubId);
        return store.change((state) => acceptInvite(state, s.userId, token));
      }
      case "members": {
        const p = resourceParams.parse(args),
          res = resourceInHub(p.kind, p.id, hubId);
        forbid(
          res.ownerId === s.userId,
          "Only resource owner can list members",
        );
        const state = store.read();
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
        .send(await readFile("dist/identity/appearance/" + asset)),
    );
  }
  app.get("/account.js", async (_r, reply) =>
    reply
      .type("text/javascript; charset=utf-8")
      .send(await readFile("dist/identity/account.js")),
  );
  app.get("/cache-design", async (_r, reply) =>
    reply
      .type("text/html; charset=utf-8")
      .send(await readFile("docs/cache-design.html", "utf8")),
  );
  app.get("/auth/start", async (_r, reply) => reply.redirect("/"));
  app.get("/", async (_r, reply) => reply.type("text/html").send(portal));
  return app;
}
