import { InvitationRequest } from "../contracts/invitations.js";
import { browserWorkspace } from "./browser-workspace.js";
import { workspaceAsset } from "./workspace.js";
import { Readable } from "node:stream";
import {
  type Bytes,
  type WorkspaceContext,
  emptyBody,
} from "../protocol/http-frames.js";
import { filterHeaders } from "../protocol/routes.js";
import Fastify, {
  type FastifyRequest,
  type FastifyInstance,
  type RouteOptions,
} from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { z } from "zod";
import { resolve } from "node:path";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { WebSocket } from "ws";
import { AuthorityClient } from "./authority-client.js";
import { HubSessions } from "./sessions.js";
import { NotificationInbox } from "./notifications.js";
import { DelegationStore, registerDelegationRoutes } from "./delegation.js";
import type {
  DelegationAuthorization,
  DelegationContext,
} from "../contracts/delegation.js";
import { registerPushRoutes } from "./web-push-routes.js";
import { registerDownloads } from "./downloads.js";
import { Tunnels } from "../protocol/tunnels.js";
import { secret, digest } from "../domain/commands.js";
import {
  DomainError,
  Id,
  Name,
  Agent,
  type Agent as AgentType,
  type Decision,
} from "../contracts/model.js";
import {
  Message,
  MAX_FRAME_BYTES,
  Launch,
  LaunchReceipt,
  LaunchResult,
} from "../contracts/tunnel.js";
export interface HubOptions {
  routeObserver?: (route: RouteOptions) => void;
  origin: string;
  localIdentity?: FastifyInstance | undefined;
  clientOrigins?: string[];
  authority: AuthorityClient;
  sessions: HubSessions;
  tunnels: Tunnels;
  secureCookies?: boolean;
  development?: boolean;
  webRoot?: string;
  notifications?: NotificationInbox;
  delegations?: DelegationStore;
}
export async function createHubApp(o: HubOptions) {
  const { authority: a, sessions, tunnels } = o,
    cookieName = "codoxear_hub_" + a.hubId,
    flowCookie = "codoxear_hub_flow_" + a.hubId,
    app = Fastify({ bodyLimit: 256 * 1024 });
  if (o.routeObserver) app.addHook("onRoute", o.routeObserver);
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  const refreshing = new Map<string, Promise<string>>();
  async function token(r: FastifyRequest): Promise<string> {
    const bearer = r.headers.authorization;
    if (bearer?.startsWith("Bearer ")) {
      if (!o.localIdentity) return bearer.slice(7);
      try {
        await a.call(bearer.slice(7), "me");
        return bearer.slice(7);
      } catch (error) {
        if (!(error instanceof DomainError) || error.code !== "invalid_token")
          throw error;
      }
      const grant = await a.request<{ accessToken: string }>(
        "/api/v1/hub-token",
        { hubId: a.hubId },
        bearer.slice(7),
      );
      return grant.accessToken;
    }
    const cookie = r.cookies[cookieName] ?? "",
      s = sessions.get(cookie);
    if (!s)
      throw new DomainError(
        401,
        "unauthorized",
        "Sign in through your account",
      );
    if (s.tokenExpiresAt > Date.now() + 30000) return s.hubToken;
    let flight = refreshing.get(cookie);
    if (!flight) {
      flight = (async () => {
        const refreshed = await a.request<{
          access_token: string;
          refresh_token: string;
          expires_in: number;
        }>("/oauth/token", {
          grant_type: "refresh_token",
          refresh_token: s.refreshToken,
        });
        s.identityToken = refreshed.access_token;
        s.refreshToken = refreshed.refresh_token;
        // Persist rotation before requesting a hub token. A policy denial must not reuse an old refresh token.
        sessions.update(cookie, s);
        const hub = await a.request<{ accessToken: string; expiresIn: number }>(
          "/api/v1/hub-token",
          { hubId: a.hubId },
          s.identityToken,
        );
        s.hubToken = hub.accessToken;
        s.tokenExpiresAt = Date.now() + hub.expiresIn * 1000;
        sessions.update(cookie, s);
        return s.hubToken;
      })();
      refreshing.set(cookie, flight);
      void flight.finally(() => refreshing.delete(cookie)).catch(() => {});
    }
    return flight;
  }
  const call = async <T>(
    r: FastifyRequest,
    op: string,
    args: Record<string, unknown> = {},
  ) => a.call<T>(await token(r), op, args);
  function registerHubDelegation() {
    if (!o.delegations) return;
    const scope = (
      context: DelegationContext,
      action: DelegationAuthorization["action"],
      childId?: string,
    ): DelegationAuthorization => ({
      actorId: context.actorId,
      identitySessionId: context.identitySessionId,
      parentId: context.parent.id,
      sourceComputerId: context.parent.computerId,
      sourceBinding: context.sourceBinding,
      targetComputerId: context.target.id,
      action,
      ...(childId ? { childId } : {}),
    });
    registerDelegationRoutes(app, {
      hubId: a.hubId,
      store: o.delegations,
      authorizeUser: async (r, parentId, targetId) =>
        a.delegationContext(await token(r), parentId, targetId),
      authorizeParent: async (r, parentId) =>
        a.delegationParent(await token(r), parentId),
      childContext: (grant, childId, targetId) =>
        a.childDelegationContext(grant, childId, targetId),
      async installGrant(context, input) {
        if (!tunnels.supports(context.parent.computerId, "delegation-tools"))
          throw new DomainError(
            409,
            "capability_required",
            "The parent Computer requires delegation-tools support; existing Pi sessions may need explicit extension setup and /reload",
          );
        await a.authorizeDelegation(scope(context, "create"));
        const result = z
          .object({
            installed: z.literal(true),
            parentId: Id,
            localId: z.string().min(1).max(200),
            expiresAt: z.number().int().positive(),
            grantDigest: z.string().regex(/^[a-f0-9]{64}$/),
          })
          .parse(
            await tunnels.request(context.parent.computerId, {
              op: "delegation-install",
              ...input,
            }),
          );
        if (
          result.parentId !== input.parentId ||
          result.localId !== input.localId ||
          result.expiresAt !== input.expiresAt ||
          result.grantDigest !==
            createHash("sha256").update(input.grant).digest("hex")
        )
          throw new DomainError(
            409,
            "delegation_install_mismatch",
            "Computer confirmed another delegation installation",
          );
        await a.authorizeDelegation(scope(context, "create"));
      },
      async checkInstallation(context) {
        if (
          !context.parent.localId ||
          !tunnels.supports(context.parent.computerId, "delegation-tools")
        )
          return { installed: false };
        return z
          .object({
            installed: z.boolean(),
            expiresAt: z.number().int().positive().optional(),
            grantDigest: z
              .string()
              .regex(/^[a-f0-9]{64}$/)
              .optional(),
          })
          .parse(
            await tunnels.request(context.parent.computerId, {
              op: "delegation-status",
              parentId: context.parent.id,
              localId: context.parent.localId,
            }),
          );
      },
      async revokeInstallation(context) {
        if (
          context.parent.localId &&
          tunnels.supports(context.parent.computerId, "delegation-tools")
        )
          await tunnels.request(context.parent.computerId, {
            op: "delegation-revoke",
            parentId: context.parent.id,
            localId: context.parent.localId,
          });
      },
      authenticateComputer: async (r, computerId) =>
        a.device(
          computerId,
          r.headers.authorization?.replace(/^Bearer /, "") ?? "",
        ),
      authorizeGrant: async (grant, targetComputerId, action, childId) =>
        a.authorizeDelegation({
          actorId: grant.actorId,
          identitySessionId: grant.identitySessionId,
          parentId: grant.parentId,
          sourceComputerId: grant.sourceComputerId,
          sourceBinding: grant.sourceBinding,
          targetComputerId,
          action,
          ...(childId ? { childId } : {}),
        }),
      async launch(context, args) {
        // Every pre-dispatch rejection is explicit. No default launch fallback.
        if (!tunnels.online(context.target.id))
          return {
            state: "failed",
            error: "Target Computer is offline; launch was not dispatched",
          };
        if (!tunnels.supports(context.target.id, "managed-runtime"))
          return {
            state: "failed",
            error:
              "Delegation requires the target Computer managed-runtime capability and bounded admission; native delegation is unavailable",
          };
        if (!tunnels.supports(context.target.id, "launch-receipts"))
          return {
            state: "failed",
            error:
              "Target Computer requires durable launch-receipts capability",
          };
        if (
          args.delegationRequired &&
          !tunnels.supports(context.target.id, "delegation-tools")
        )
          return {
            state: "failed",
            error:
              "Target Computer requires delegation-tools support for inherited child delegation; launch was not dispatched",
          };
        if (
          args.launch &&
          Object.keys(args.launch).length &&
          !tunnels.supports(context.target.id, "launch-options")
        )
          return {
            state: "failed",
            error: "Target Computer requires launch-options capability",
          };
        if (
          (args.launch?.provider_config ||
            args.launch?.env_vars ||
            args.launch?.command) &&
          !tunnels.supports(context.target.id, "provider-launch")
        )
          return {
            state: "failed",
            error: "Target Computer requires provider-launch capability",
          };
        let agent: AgentType;
        try {
          // Recheck sign-in, source binding, parent control, target creation and
          // owner-only local paths/config in the durable reservation command.
          agent = await a.reserveDelegation(scope(context, "create"), args);
        } catch (error) {
          return {
            state: "failed",
            error:
              error instanceof DomainError
                ? error.message
                : "Target creation authorization unavailable; launch was not dispatched",
          };
        }
        try {
          await a.authorizeDelegation({
            ...scope(context, "create"),
            ...(args.launch ? { launch: args.launch } : {}),
          });
        } catch (error) {
          await a.agentResult(agent.id, "failed", null).catch(() => {});
          return {
            state: "failed",
            error:
              error instanceof DomainError
                ? error.message
                : "Delegation authorization unavailable; launch was not dispatched",
          };
        }
        try {
          const result = LaunchResult.parse(
            await tunnels.request(agent.computerId, {
              op: "create",
              agentId: agent.id,
              backend: agent.backend,
              name: agent.name,
              ...(args.launch ? { launch: args.launch } : {}),
            }),
          );
          await a.agentResult(agent.id, "ready", result.localId);
          return { state: "ready", localId: result.localId };
        } catch (error) {
          const failed =
            error instanceof DomainError && error.code === "not_dispatched";
          await a
            .agentResult(agent.id, failed ? "failed" : "unknown", null)
            .catch(() => {});
          return failed
            ? { state: "failed", error: error.message }
            : { state: "unknown" };
        }
      },
      async reconcile(context, receipt) {
        if (!tunnels.supports(receipt.targetComputerId, "launch-receipts"))
          return { state: "unknown" };
        const native = LaunchReceipt.parse(
          await tunnels.request(receipt.targetComputerId, {
            op: "launch-status",
            agentId: receipt.childId,
          }),
        );
        // Receipt reads cannot create or recover unfinished execution.
        await a.authorizeDelegation(scope(context, "read", receipt.childId));
        if (native.state !== "ready") return { state: "unknown" };
        await a.agentResult(receipt.childId, "ready", native.result.localId);
        return { state: "ready", localId: native.result.localId };
      },
      async control(context, receipt, input) {
        await a.authorizeDelegation(
          scope(context, input.action, receipt.childId),
        );
        const localId = receipt.localId!;
        return tunnels.request(
          receipt.targetComputerId,
          input.action === "send"
            ? {
                op: "send",
                agentId: receipt.childId,
                localId,
                text: input.text!,
              }
            : { op: "interrupt", agentId: receipt.childId, localId },
        );
      },
      async readMessages(context, receipt) {
        await a.authorizeDelegation(scope(context, "read", receipt.childId));
        const result = await tunnels.request(receipt.targetComputerId, {
          op: "messages",
          agentId: receipt.childId,
          localId: receipt.localId!,
        });
        await a.authorizeDelegation(scope(context, "read", receipt.childId));
        return result;
      },
    });
  }
  async function access(
    r: FastifyRequest,
    action: "read" | "send" | "interrupt",
  ) {
    return call<{ agent: AgentType; access: Decision; actorId: string }>(
      r,
      "authorize",
      { agentId: Id.parse((r.params as { id: string }).id), action },
    );
  }
  app.setErrorHandler((e, _r, reply) =>
    e instanceof DomainError
      ? reply.code(e.status).send({ code: e.code, error: e.message })
      : e instanceof z.ZodError
        ? reply
            .code(400)
            .send({ code: "invalid_request", error: "Invalid request" })
        : reply
            .code(500)
            .send({ code: "internal_error", error: "Hub operation failed" }),
  );
  app.addHook("onRequest", async (r, reply) => {
    const origin = r.headers.origin;
    const allowed =
      origin === o.origin || !!o.clientOrigins?.includes(origin ?? "");
    // A no-referrer client produces an opaque Origin on a cross-origin form.
    // This route authenticates only a one-use body capability, never cookies.
    const downloadForm =
      r.method === "POST" &&
      r.url === "/api/v1/downloads/consume" &&
      origin === "null";
    if (origin && allowed && o.localIdentity) {
      reply
        .header("Access-Control-Allow-Origin", origin)
        .header("Vary", "Origin")
        .header(
          "Access-Control-Expose-Headers",
          "Content-Disposition, Content-Range, Accept-Ranges, ETag",
        )
        .header(
          "Access-Control-Allow-Methods",
          "GET, HEAD, POST, PUT, PATCH, DELETE, OPTIONS",
        )
        .header(
          "Access-Control-Allow-Headers",
          "Authorization, Content-Type, Range, If-None-Match, If-Match, X-Codoxear-Request-Id, Cache-Control, Last-Event-ID",
        );
    }
    if (r.method === "OPTIONS" && o.localIdentity) {
      if (!allowed)
        throw new DomainError(
          403,
          "bad_origin",
          "Client origin is not allowed by this hub",
        );
      return reply.code(204).send();
    }
    if (
      ["POST", "PUT", "PATCH", "DELETE"].includes(r.method) &&
      r.headers.origin &&
      !(
        downloadForm ||
        r.headers.origin === o.origin ||
        (o.localIdentity &&
          allowed &&
          (!!r.headers.authorization ||
            r.url === "/api/v1/downloads/consume" ||
            /^\/oauth\/(token|revoke)$/.test(r.url)))
      )
    )
      throw new DomainError(
        403,
        "bad_origin",
        "Cross-origin mutation rejected",
      );
  });
  app.addHook("onSend", async (r, reply, p) => {
    reply
      .header(
        "Cache-Control",
        r.url.startsWith("/workspace/") && !r.url.startsWith("/workspace/api/")
          ? (reply.getHeader("Cache-Control") ?? "no-store")
          : "no-store",
      )
      .header("Referrer-Policy", "no-referrer")
      .header("X-Content-Type-Options", "nosniff");
    return p;
  });
  registerHubDelegation();
  app.get("/health", async () => ({
    ok: true,
    service: "hub",
    hubId: a.hubId,
  }));
  app.get("/api/v1/meta", async () => ({
    hubId: a.hubId,
    issuer: a.origin,
    independent: !!o.localIdentity,
    protocol: { major: 1, minor: 0 },
    capabilities: ["agents", "invites", "retention", "rpc", "http-streams"],
  }));
  app.get("/api/auth/options", async () => ({
    central: !o.localIdentity,
    independent: !!o.localIdentity,
    identityUrl: a.origin,
    loginUrl: "/auth/start",
    development: o.development ?? false,
  }));
  app.get("/auth/start", async (r, reply) => {
    const state = secret(),
      browser = secret(),
      verifier = secret();
    const query = z
      .object({
        agent: Id.optional(),
        settings: z.literal("1").optional(),
        computer: Id.optional(),
        new: z.literal("1").optional(),
        name: Name.optional(),
        backend: Agent.shape.backend.optional(),
      })
      .parse(r.query);
    const destination = new URLSearchParams(
      Object.entries(query).filter(
        (entry): entry is [string, string] => entry[1] !== undefined,
      ),
    ).toString();
    sessions.flow(state, {
      destination:
        query.settings && query.agent
          ? "/?settings=" + query.agent
          : destination
            ? "/?" + destination
            : "/",
      browserHash: digest(browser),
      verifier,
      expiresAt: Date.now() + 300000,
    });
    reply.setCookie(flowCookie, browser, {
      httpOnly: true,
      secure: o.secureCookies ?? true,
      sameSite: "lax",
      path: "/auth/",
      maxAge: 300,
    });
    const target = new URL("/oauth/authorize", a.origin);
    target.search = new URLSearchParams({
      client_id: a.hubId,
      redirect_uri: o.origin + "/auth/callback",
      response_type: "code",
      state,
      code_challenge: createHash("sha256").update(verifier).digest("base64url"),
      code_challenge_method: "S256",
    }).toString();
    return reply.redirect(target.href);
  });
  app.get("/auth/callback", async (r, reply) => {
    const q = z.object({ state: z.string(), code: z.string() }).parse(r.query),
      flow = sessions.consume(q.state, r.cookies[flowCookie] ?? "");
    if (!flow)
      throw new DomainError(
        401,
        "invalid_state",
        "Login transaction expired or belongs to another browser",
      );
    const auth = await a.request<{
      access_token: string;
      refresh_token: string;
    }>("/oauth/token", {
      grant_type: "authorization_code",
      code: q.code,
      client_id: a.hubId,
      redirect_uri: o.origin + "/auth/callback",
      code_verifier: flow.verifier,
    });
    const scoped = await a.request<{ accessToken: string; expiresIn: number }>(
      "/api/v1/hub-token",
      { hubId: a.hubId },
      auth.access_token,
    );
    const c = sessions.create({
      identityToken: auth.access_token,
      refreshToken: auth.refresh_token,
      hubToken: scoped.accessToken,
      tokenExpiresAt: Date.now() + scoped.expiresIn * 1000,
      expiresAt: Date.now() + 30 * 86400000,
    });
    reply.clearCookie(flowCookie, { path: "/auth/" });
    reply.setCookie(cookieName, c, {
      httpOnly: true,
      secure: o.secureCookies ?? true,
      sameSite: "strict",
      path: "/",
      maxAge: 30 * 86400,
    });
    return reply.redirect(flow.destination ?? "/");
  });
  for (const path of [
    "/api/auth/logout",
    "/workspace/api/logout",
    "/api/v1/computers/:computerId/api/logout",
  ])
    app.post(path, async (r, reply) => {
      const c = r.cookies[cookieName] ?? "",
        s = sessions.get(c);
      if (s)
        try {
          await a.request("/api/v1/auth/logout", {}, s.identityToken);
        } finally {
          sessions.delete(c);
        }
      reply.clearCookie(cookieName, { path: "/" });
      return { ok: true };
    });
  app.get("/api/agent-directory", async (r) => {
    if (o.localIdentity && r.headers.authorization?.startsWith("Bearer "))
      return a.request(
        "/api/v1/me/agents",
        {},
        r.headers.authorization.slice(7),
      );
    await call(r, "me");
    const browser = sessions.get(r.cookies[cookieName] ?? "");
    if (!browser)
      throw new DomainError(
        401,
        "unauthorized",
        "Browser account session required",
      );
    return a.request("/api/v1/me/agents", {}, browser.identityToken);
  });
  app.get("/api/me", async (r) => call(r, "me"));
  app.get("/api/agents/:id/shares", async (r) =>
    call(r, "agent-shares", {
      agentId: Id.parse((r.params as { id: string }).id),
    }),
  );
  app.put("/api/agents/:id/shares/:userId", async (r) => {
    const p = z.object({ id: Id, userId: Id }).parse(r.params);
    const b = z
      .object({ role: z.enum(["viewer", "operator"]).nullable() })
      .strict()
      .parse(r.body);
    return call(r, "agent-share", {
      agentId: p.id,
      userId: p.userId,
      role: b.role,
    });
  });
  app.get("/api/agents/:id/access", async (r) => access(r, "read"));
  await browserWorkspace(app, a, async (r) => {
    if (o.localIdentity && r.headers.authorization?.startsWith("Bearer ")) {
      const raw = r.headers.authorization.slice(7);
      const me = await a.request<{ id: string }>("/api/v1/me", undefined, raw);
      return { token: raw, accountId: me.id, scopeId: digest(raw) };
    }
    const me = await call<{ id: string }>(r, "me");
    const browser = sessions.get(r.cookies[cookieName] ?? "");
    if (!browser)
      throw new DomainError(
        401,
        "unauthorized",
        "Browser account session required",
      );
    return {
      token: browser.identityToken,
      accountId: me.id,
      scopeId: digest(r.cookies[cookieName]!),
    };
  });
  registerPushRoutes(app, o.notifications, call, a.origin, a.hubId);
  await registerDownloads(app, {
    origin: o.origin,
    call,
    tunnels,
    authorize: (ticket) =>
      a.request("/internal/download-authorize", {
        hubId: a.hubId,
        sessionId: ticket.sessionId,
        computerId: ticket.computerId,
        agentId: ticket.agentId,
        binding: ticket.binding,
        path: ticket.path,
      }),
  });
  app.get("/api/hubs", async (r) => [await call(r, "hub")]);
  async function computers(r: FastifyRequest) {
    const list = await call<Array<{ id: string }>>(r, "computers");
    return list.map((c) => ({ ...c, online: tunnels.online(c.id) }));
  }
  app.get("/api/v1/computers", computers);
  app.get("/api/hubs/:id/computers", async (r) => {
    if ((r.params as { id: string }).id !== a.hubId)
      throw new DomainError(404, "not_found", "Unknown hub");
    return computers(r);
  });
  app.post("/api/hubs/:id/computers", async (r) => {
    if ((r.params as { id: string }).id !== a.hubId)
      throw new DomainError(404, "not_found", "Unknown hub");
    const value = await call<{
      computer: unknown;
      pairing: { code: string } | null;
    }>(
      r,
      "create-computer",
      z.object({ name: Name, ownerId: Id.optional() }).parse(r.body),
    );
    return { ...value, identityUrl: a.origin };
  });
  app.post("/api/computers/:id/pairing", async (r) =>
    call(r, "pair", { computerId: Id.parse((r.params as { id: string }).id) }),
  );
  app.get("/api/computers/:id/agents", async (r) =>
    call(r, "agents", {
      computerId: Id.parse((r.params as { id: string }).id),
    }),
  );
  const LocalCatalog = z
    .object({
      sessions: z.array(
        z
          .object({
            session_id: z.string(),
            agent_backend: Agent.shape.backend,
            alias: z.string().optional(),
          })
          .passthrough(),
      ),
      new_session_defaults: z.unknown().optional(),
      recent_cwds: z.array(z.string()).optional(),
      tmux_available: z.boolean().optional(),
    })
    .passthrough();
  app.get("/api/computers/:id/launch-defaults", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    await call(r, "computer-owner", { computerId });
    const catalog = LocalCatalog.parse(
      await tunnels.request(computerId, { op: "discover" }),
    );
    await call(r, "computer-owner", { computerId });
    return {
      new_session_defaults: catalog.new_session_defaults,
      recent_cwds: catalog.recent_cwds ?? [],
      tmux_available: false,
    };
  });
  app.get("/api/computers/:id/resume-candidates", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    const query = z
      .object({
        backend: z.enum(["codex", "pi", "cc"]),
        cwd: z.string().min(1).max(4096),
      })
      .parse(r.query);
    await call(r, "computer-owner", { computerId });
    if (!tunnels.supports(computerId, "resume-candidates"))
      throw new DomainError(
        409,
        "capability_required",
        "Update or reconnect the Computer to list saved sessions",
      );
    const result = await tunnels.request(computerId, {
      op: "resume-candidates",
      ...query,
    });
    await call(r, "computer-owner", { computerId });
    return z
      .object({
        sessions: z.array(
          z.object({
            session_id: z.string().min(1).max(200),
            alias: z.string().optional(),
            first_user_message: z.string().optional(),
          }),
        ),
      })
      .parse(result);
  });
  app.get("/api/computers/:id/discovered", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    await call(r, "computer-owner", { computerId });
    const catalog = LocalCatalog.parse(
      await tunnels.request(computerId, { op: "discover" }),
    );
    await call(r, "computer-owner", { computerId });
    const published = await call<AgentType[]>(r, "agents", { computerId });
    if (
      !catalog.sessions.length &&
      Number(catalog.unsupported_session_count ?? 0) > 0
    )
      throw new DomainError(
        409,
        "runtime_upgrade_required",
        "Local sessions use older runtime identities. They remain available in direct mode; resume them with an updated broker before importing them here.",
      );
    return catalog.sessions.filter(
      (s) => !published.some((a) => a.localId === s.session_id),
    );
  });
  app.post("/api/computers/:id/import", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id),
      b = z
        .object({ localId: z.string().min(1).max(200), name: Name })
        .parse(r.body);
    await call(r, "computer-owner", { computerId });
    const catalog = LocalCatalog.parse(
        await tunnels.request(computerId, { op: "discover" }),
      ),
      found = catalog.sessions.find((s) => s.session_id === b.localId);
    if (!found)
      throw new DomainError(404, "not_found", "Local session no longer exists");
    return call(r, "import-agent", {
      computerId,
      ...b,
      backend: found.agent_backend,
    });
  });
  // Native and transitional workspace clients use the same namespaced local API shape.
  app.get("/api/v1/computers/:computerId/api/me", async (r) => {
    const computerId = Id.parse(
      (r.params as { computerId: string }).computerId,
    );
    await call(r, "agents", { computerId });
    return {
      ok: true,
      user: await call(r, "me"),
      hub_id: a.hubId,
      computer_id: computerId,
    };
  });
  app.get("/api/v1/computers/:computerId/api/sessions", async (r) => {
    const computerId = Id.parse(
        (r.params as { computerId: string }).computerId,
      ),
      authorized = await call<Array<AgentType & { access: Decision }>>(
        r,
        "agents",
        { computerId },
      );
    if (!authorized.length)
      return {
        sessions: [],
        new_session_defaults: {},
        recent_cwds: [],
        tmux_available: false,
      };
    const me = await call<{ id: string }>(r, "me");
    const catalog = LocalCatalog.parse(
        await tunnels.request(computerId, { op: "discover", actorId: me.id }),
      ),
      current = await call<Array<AgentType & { access: Decision }>>(
        r,
        "agents",
        { computerId },
      );
    return {
      ...catalog,
      sessions: catalog.sessions
        .filter(
          (s) =>
            authorized.some((a) => a.localId === s.session_id) &&
            current.some((a) => a.localId === s.session_id),
        )
        .map((s) => ({
          ...s,
          alias:
            s.alias || current.find((a) => a.localId === s.session_id)?.name,
          remote_access: current.find((a) => a.localId === s.session_id)
            ?.access,
        })),
      recent_cwds: [],
      tmux_available: false,
    };
  });
  app.get(
    "/api/v1/computers/:computerId/api/notifications/subscription",
    async (r) => {
      const computerId = Id.parse(
        (r.params as { computerId: string }).computerId,
      );
      await call(r, "notification-subject", { computerId });
      return {
        ok: true,
        subscriptions: [],
        vapid_public_key: "",
        web_push_configured: false,
      };
    },
  );
  app.get("/api/v1/computers/:computerId/api/notifications/feed", async (r) => {
    const computerId = Id.parse(
        (r.params as { computerId: string }).computerId,
      ),
      query = z
        .object({ since: z.coerce.number().finite().nonnegative().default(0) })
        .parse(r.query),
      allowed = await call<AgentType[]>(r, "agents", { computerId });
    if (!allowed.length) return { ok: true, items: [] };
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 10000);
    try {
      const response = await tunnels.http(
        computerId,
        {
          method: "GET",
          path: "/api/notifications/feed?since=" + query.since,
          headers: {},
        },
        emptyBody,
        controller.signal,
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 1024 * 1024)
          throw new DomainError(
            502,
            "notification_feed_limit",
            "Notification feed exceeds limit",
          );
        chunks.push(Buffer.from(chunk));
      }
      if (response.status !== 200)
        throw new DomainError(
          502,
          "notification_feed_unavailable",
          "Computer notification feed unavailable",
        );
      const data = z
        .object({
          items: z.array(
            z.object({
              message_id: z.string(),
              session_id: z.string(),
              session_display_name: z.string(),
              notification_text: z.string(),
              updated_ts: z.number().finite(),
            }),
          ),
        })
        .parse(JSON.parse(Buffer.concat(chunks).toString()));
      const current = await call<AgentType[]>(r, "agents", { computerId });
      return {
        ok: true,
        items: data.items.filter(
          (i) =>
            allowed.some((a) => a.localId === i.session_id) &&
            current.some((a) => a.localId === i.session_id),
        ),
      };
    } finally {
      clearTimeout(timer);
      controller.abort();
    }
  });
  app.get(
    "/api/v1/computers/:computerId/api/notifications/harmony",
    async (r) => {
      const computerId = Id.parse(
        (r.params as { computerId: string }).computerId,
      );
      const computers = await call<Array<{ id: string }>>(r, "computers");
      if (!computers.some((c) => c.id === computerId))
        throw new DomainError(403, "forbidden", "Computer access required");
      return {
        ok: true,
        configured: !!o.notifications?.provider,
        test_message: o.notifications?.provider?.testMessage ?? false,
        reason: o.notifications?.provider
          ? ""
          : "Background push delivery is not configured on this hub. Foreground access remains available.",
      };
    },
  );
  app.post(
    "/api/v1/computers/:computerId/api/notifications/harmony",
    async (r) => {
      const computerId = Id.parse(
        (r.params as { computerId: string }).computerId,
      );
      const b = z
        .object({
          device_id: Id,
          token: z.string().max(4096).default(""),
          enabled: z.boolean(),
          server: z.string().max(2000).optional(),
        })
        .parse(r.body);
      const subject = await call<{ userId: string; sessionId: string }>(
        r,
        "notification-subject",
        { computerId },
      );
      if (!b.enabled) {
        o.notifications?.unsubscribe(subject.userId, b.device_id, computerId);
        return { ok: true, registered: false };
      }
      if (!o.notifications?.provider)
        throw new DomainError(
          503,
          "push_unavailable",
          "Background push is not configured on this hub",
        );
      o.notifications.subscribe({
        ...subject,
        computerId,
        installationId: b.device_id,
        token: b.token,
        scope: JSON.stringify([
          "relay-v1",
          a.origin,
          subject.userId,
          a.hubId,
          computerId,
        ]),
      });
      return { ok: true, registered: true };
    },
  );
  async function createRemoteAgent(
    r: FastifyRequest,
    computerId: string,
    b: { name: string; backend: AgentType["backend"] },
    launch?: z.infer<typeof Launch>,
  ) {
    const available = await call<Array<{ id: string; canCreate: boolean }>>(
      r,
      "computers",
    );
    if (!available.some((c) => c.id === computerId && c.canCreate))
      throw new DomainError(
        403,
        "forbidden",
        "Hub and computer creation access required",
      );
    if (!tunnels.online(computerId))
      throw new DomainError(503, "not_dispatched", "Computer offline");
    const agent = await call<AgentType>(r, "create-agent", {
      computerId,
      ...b,
    });
    try {
      const result = LaunchResult.parse(
        await tunnels.request(computerId, {
          op: "create",
          agentId: agent.id,
          backend: agent.backend,
          name: agent.name,
          ...(launch ? { launch } : {}),
        }),
      );
      await a.agentResult(agent.id, "ready", result.localId);
      return {
        ...agent,
        localId: result.localId,
        state: "ready",
        brokerPid: result.brokerPid,
      };
    } catch (error) {
      await a
        .agentResult(
          agent.id,
          error instanceof DomainError && error.code === "not_dispatched"
            ? "failed"
            : "unknown",
          null,
        )
        .catch(() => {});
      throw error;
    }
  }
  app.post("/api/computers/:id/agents", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    const { launch, ...selection } = z
      .object({
        name: Name,
        backend: Agent.shape.backend,
        launch: Launch.strict().optional(),
      })
      .strict()
      .parse(r.body);
    if (launch && Object.keys(launch).length) {
      // These choices reveal/use local config and paths, just like the rich
      // session endpoint. Preserve its owner and capability boundary.
      await call(r, "computer-owner", { computerId });
      if (!tunnels.supports(computerId, "launch-options"))
        throw new DomainError(
          409,
          "capability_required",
          "Update or reconnect the Computer to use launch options",
        );
    }
    if (
      (launch?.provider_config || launch?.env_vars || launch?.command) &&
      !tunnels.supports(computerId, "provider-launch")
    )
      throw new DomainError(
        409,
        "capability_required",
        "Update or reconnect the Computer to configure a provider",
      );
    return createRemoteAgent(r, computerId, selection, launch);
  });
  app.post("/api/agents/:id/reconcile", async (r) => {
    const { agent } = await access(r, "read");
    if (agent.state === "ready")
      return { state: "ready", localId: agent.localId };
    if (!tunnels.supports(agent.computerId, "launch-receipts"))
      throw new DomainError(
        409,
        "capability_required",
        "Reconnect an updated Computer to check launch results",
      );
    const receipt = LaunchReceipt.parse(
      await tunnels.request(agent.computerId, {
        op: "launch-status",
        agentId: agent.id,
      }),
    );
    await access(r, "read");
    if (receipt.state === "unknown") return { state: "unknown" };
    await a.agentResult(agent.id, "ready", receipt.result.localId);
    return { state: "ready", ...receipt.result };
  });
  app.post("/api/v1/computers/:computerId/api/sessions", async (r) => {
    const computerId = Id.parse(
      (r.params as { computerId: string }).computerId,
    );
    // Rich launch options include workspace paths and existing local history.
    // They require the computer owner in addition to normal creation rights.
    await call(r, "computer-owner", { computerId });
    if (!tunnels.supports(computerId, "launch-options"))
      throw new DomainError(
        409,
        "capability_required",
        "Update or reconnect the Computer to use launch options",
      );
    const { agent_backend, name, ...launch } = Launch.extend({
      agent_backend: Agent.shape.backend,
      name: Name.optional(),
    })
      .strict()
      .parse(r.body);
    if (
      (launch?.provider_config || launch?.env_vars || launch?.command) &&
      !tunnels.supports(computerId, "provider-launch")
    )
      throw new DomainError(
        409,
        "capability_required",
        "Update or reconnect the Computer to configure a provider",
      );
    if (
      agent_backend === "pi" &&
      launch.model_provider &&
      (!launch.model || launch.model === "default")
    ) {
      const catalog = LocalCatalog.parse(
        await tunnels.request(computerId, { op: "discover" }),
      );
      const defaults = z
        .object({
          backends: z.object({
            pi: z
              .object({
                model: z.string().nullable().optional(),
                provider_choice: z.string().nullable().optional(),
                model_provider: z.string().nullable().optional(),
              })
              .passthrough(),
          }),
        })
        .safeParse(catalog.new_session_defaults);
      const configured = defaults.success
        ? defaults.data.backends.pi
        : undefined;
      if (
        configured &&
        launch.model_provider ===
          (configured.provider_choice ?? configured.model_provider)
      ) {
        if (configured.model && configured.model !== "default")
          launch.model = configured.model;
        else delete launch.model_provider; // Use this Computer's configured default pair.
      } else
        throw new DomainError(
          400,
          "model_required",
          "Choose a model for this provider on the selected Computer",
        );
    }
    const agent = await createRemoteAgent(
      r,
      computerId,
      { backend: agent_backend, name: name ?? "New session" },
      launch,
    );
    return {
      ok: true,
      session_id: agent.localId,
      agent_id: agent.id,
      broker_pid: agent.brokerPid,
    };
  });
  app.get("/api/agents/:id/messages", async (r) => {
    const { agent } = await access(r, "read");
    if (!agent.localId) return { messages: [], state: agent.state };
    const result = await tunnels.request(agent.computerId, {
      op: "messages",
      agentId: agent.id,
      localId: agent.localId,
    });
    await access(r, "read");
    return result;
  });
  app.post(
    "/api/v1/computers/:computerId/api/sessions/:localId/delete",
    async (r) => {
      const { computerId, localId } = z
        .object({
          computerId: Id,
          localId: z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/),
        })
        .parse(r.params);
      const path = `/api/sessions/${localId}/delete`;
      const decision = await call<{ actorId: string }>(r, "relay", {
        computerId,
        method: "POST",
        path,
      });
      const response = await tunnels.http(
        computerId,
        {
          method: "POST",
          path,
          headers: {
            "content-type": "application/json",
            "content-length": "2",
          },
          actorId: decision.actorId,
        },
        (async function* () {
          yield Buffer.from("{}");
        })(),
        AbortSignal.timeout(30000),
      );
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of response.body) {
        size += chunk.byteLength;
        if (size > 65536)
          throw new DomainError(
            502,
            "outcome_unknown",
            "Deletion response was too large; inspect local sessions before retrying",
          );
        chunks.push(Buffer.from(chunk));
      }
      if (response.status !== 200)
        throw new DomainError(
          response.status >= 500 ? 502 : response.status,
          "delete_unconfirmed",
          "Computer did not confirm deletion; the hub entry has been retained",
        );
      let confirmation: unknown;
      try {
        confirmation = JSON.parse(Buffer.concat(chunks).toString());
      } catch {
        throw new DomainError(
          502,
          "outcome_unknown",
          "Deletion outcome is unknown; the hub entry has been retained",
        );
      }
      if (!z.object({ ok: z.literal(true) }).safeParse(confirmation).success)
        throw new DomainError(
          502,
          "outcome_unknown",
          "Deletion outcome is unknown; the hub entry has been retained",
        );
      return call(r, "forget-deleted-agent", { computerId, localId });
    },
  );
  for (const action of ["send", "interrupt"] as const)
    app.post("/api/agents/:id/" + action, async (r) => {
      const { agent } = await access(r, action);
      if (!agent.localId)
        throw new DomainError(409, "not_ready", "Agent is not ready");
      return tunnels.request(
        agent.computerId,
        action === "send"
          ? {
              op: "send",
              agentId: agent.id,
              localId: agent.localId,
              text: z
                .object({ text: z.string().trim().min(1).max(200000) })
                .parse(r.body).text,
            }
          : { op: "interrupt", agentId: agent.id, localId: agent.localId },
      );
    });
  const live = new Set<() => void>();
  app.get("/api/agents/:id/live", async (r, reply) => {
    await access(r, "read");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "X-Accel-Buffering": "no",
    });
    let busy = false,
      closed = false,
      last = "";
    const write = (event: string, value: unknown) => {
      if (closed) return;
      if (reply.raw.writableLength > MAX_FRAME_BYTES) {
        reply.raw.destroy();
        return;
      }
      reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
    };
    const end = () => {
      closed = true;
      clearInterval(timer);
      reply.raw.end();
      live.delete(end);
    };
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const { agent, access: decision } = await access(r, "read");
        write("access", decision);
        if (agent.localId) {
          const data = z.object({ messages: z.array(Message) }).parse(
            await tunnels.request(agent.computerId, {
              op: "messages",
              agentId: agent.id,
              localId: agent.localId,
            }),
          );
          await access(r, "read");
          write("online", {});
          const current = JSON.stringify(data);
          if (current !== last) {
            last = current;
            write("snapshot", data);
          }
        }
      } catch (e) {
        if (
          e instanceof DomainError &&
          ([401, 403, 404].includes(e.status) ||
            e.code === "policy_unavailable")
        ) {
          write("access_lost", { code: e.code, error: e.message });
          end();
        } else write("offline", { error: "Computer unavailable" });
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    live.add(end);
    reply.raw.on("close", end);
    void tick();
  });
  const base = "/api/resources/:kind/:id";
  const params = z.object({ kind: z.enum(["hub", "computer"]), id: Id });
  app.get(base + "/members", async (r) =>
    call(r, "members", params.parse(r.params)),
  );
  app.post(base + "/invitations", async (r) =>
    call(r, "invite", {
      ...params.parse(r.params),
      ...InvitationRequest.parse(r.body),
    }),
  );
  app.post("/api/invitations/accept", async (r) =>
    call(r, "accept", z.object({ token: z.string() }).parse(r.body)),
  );
  app.delete(base + "/members/:memberId", async (r) =>
    call(r, "remove", params.extend({ memberId: Id }).parse(r.params)),
  );
  app.put(base + "/policy", async (r) =>
    call(r, "policy", {
      ...params.parse(r.params),
      ...z
        .object({ policy: z.enum(["retain", "read_only", "none"]).nullable() })
        .parse(r.body),
    }),
  );
  app.post(base + "/owner", async (r) =>
    call(r, "owner", {
      ...params.parse(r.params),
      ...z.object({ ownerId: Id }).parse(r.body),
    }),
  );
  app.put("/api/computers/:id/workspace-access/:userId", async (r) => {
    const p = z.object({ id: Id, userId: Id }).parse(r.params);
    const body = z
      .object({
        access: z.enum(["read", "write"]).nullable(),
        workspaceId: Id.optional(),
        paths: z.array(z.string().min(1).max(2000)).min(1).max(100).optional(),
        git: z.boolean().optional(),
        uploads: z.boolean().optional(),
        transcode: z.boolean().optional(),
      })
      .strict()
      .parse(r.body);
    if (body.access !== null && !tunnels.supports(p.id, "workspace-files"))
      throw new DomainError(
        409,
        "capability_required",
        "Connect an updated Computer to manage workspace access",
      );
    if (body.access !== null) {
      const extended =
        (body.workspaceId && body.workspaceId !== "default") ||
        body.paths?.some((path) => path !== ".") ||
        body.git ||
        body.uploads ||
        body.transcode;
      if (extended && !tunnels.supports(p.id, "workspace-capabilities-v2"))
        throw new DomainError(
          409,
          "capability_required",
          "Update this Computer to grant workspace paths and processing capabilities",
        );
      await call(r, "computer-owner", { computerId: p.id });
      const workspace = (await tunnels.request(p.id, { op: "workspace" })) as {
        id?: string;
        roots?: Array<{ id: string }>;
      };
      const roots = workspace.roots ?? [{ id: workspace.id ?? "default" }];
      if (!roots.some((root) => root.id === (body.workspaceId ?? "default")))
        throw new DomainError(
          404,
          "workspace_missing",
          "Choose an approved workspace on this Computer",
        );
      await call(r, "computer-owner", { computerId: p.id });
    }
    return call(r, "workspace-access", {
      computerId: p.id,
      userId: p.userId,
      ...body,
    });
  });
  app.get("/api/computers/:id/workspace", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    await call(r, "computer-owner", { computerId });
    const result = await tunnels.request(computerId, { op: "workspace" });
    await call(r, "computer-owner", { computerId });
    return result;
  });
  app.put("/api/computers/:id/workspace", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    const body = z
      .object({
        id: Id.optional(),
        name: Name.optional(),
        path: z.string().min(1).max(4000).optional(),
        remove: z.boolean().optional(),
      })
      .strict()
      .parse(r.body);
    await call(r, "computer-owner", { computerId });
    if (!tunnels.supports(computerId, "workspace-capabilities-v2"))
      throw new DomainError(
        409,
        "capability_required",
        "Update this Computer to manage approved workspace roots",
      );
    const result = await tunnels.request(computerId, {
      op: "workspace",
      ...body,
    });
    await call(r, "computer-owner", { computerId });
    return result;
  });
  app.post("/connect/v1/computers/:id/detach", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    const { transferId } = z.object({ transferId: Id }).parse(r.body);
    const receipt = await a.request("/internal/computer-detach", {
      hubId: a.hubId,
      computerId,
      transferId,
      credential: r.headers.authorization?.replace(/^Bearer /, "") ?? "",
    });
    tunnels.disconnect(
      computerId,
      "Computer detached for independent-Hub transfer",
    );
    return receipt;
  });
  app.post("/connect/v1/computers/:id/authorize-queue", async (r) => {
    const computerId = Id.parse((r.params as { id: string }).id);
    const b = z
      .object({ permit: z.string().max(200), localId: z.string().max(200) })
      .parse(r.body);
    return a.request("/internal/queue-authorize", {
      ...b,
      computerId,
      hubId: a.hubId,
      credential: r.headers.authorization?.replace(/^Bearer /, "") ?? "",
    });
  });
  app.get(
    "/connect/v1/computers/:id",
    {
      websocket: true,
      preValidation: async (r) => {
        const computerId = Id.parse((r.params as { id: string }).id);
        if (
          r.headers["x-codoxear-protocol"] &&
          r.headers["x-codoxear-protocol"] !== "1"
        )
          throw new DomainError(
            426,
            "protocol_upgrade_required",
            "Unsupported tunnel major version",
          );
        if (r.headers["x-codoxear-hub"] !== a.hubId)
          throw new DomainError(401, "invalid_computer", "Wrong hub");
        await a.device(
          computerId,
          r.headers.authorization?.replace(/^Bearer /, "") ?? "",
        );
      },
    },
    (socket, r) => {
      const computerId = (r.params as { id: string }).id,
        credential = r.headers.authorization!.slice(7);
      tunnels.attach(
        computerId,
        socket,
        o.notifications
          ? async (event) => {
              const target = await a.request<{
                agentId: string | null;
                binding: number;
              }>("/internal/notification-target", {
                hubId: a.hubId,
                computerId,
                credential,
                localId: event.localId,
              });
              if (target.agentId)
                o.notifications!.receive(
                  computerId,
                  target.binding,
                  target.agentId,
                  event,
                );
            }
          : undefined,
      );
      let checking = false;
      const timer = setInterval(() => {
        if (checking) return;
        checking = true;
        void a
          .device(computerId, credential)
          .catch(() => socket.close(1008, "Binding or policy unavailable"))
          .finally(() => {
            checking = false;
          });
      }, 1000);
      socket.once("close", () => clearInterval(timer));
    },
  );
  await app.register(async (scoped) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser("*", (_request, payload, done) =>
      done(null, payload),
    );
    scoped.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      url: "/api/v1/computers/:computerId/api/*",
      handler: async (r, reply) => {
        const computerId = Id.parse(
            (r.params as { computerId: string }).computerId,
          ),
          prefix = "/api/v1/computers/" + computerId;
        if (!r.url.startsWith(prefix + "/api/"))
          throw new DomainError(
            400,
            "invalid_route",
            "Non-canonical namespace",
          );
        const path = r.url.slice(prefix.length),
          controller = new AbortController();
        let ended = false,
          checking: Promise<unknown> | undefined;
        const check = () =>
          (checking ??= call(r, "relay", {
            computerId,
            method: r.method,
            path,
          }).finally(() => {
            checking = undefined;
          }));
        const decision = (await check()) as {
          actorId: string;
          actorIsOwner?: boolean;
          workspace?: WorkspaceContext;
        };
        const grant = JSON.stringify(decision.workspace ?? null);
        const recheck = async () => {
          const current = (await check()) as typeof decision;
          if (
            current.actorId !== decision.actorId ||
            current.actorIsOwner !== decision.actorIsOwner ||
            JSON.stringify(current.workspace ?? null) !== grant
          )
            throw new DomainError(
              403,
              "workspace_access_changed",
              "Workspace access changed during the operation",
            );
        };
        if (
          decision.workspace &&
          !tunnels.supports(computerId, "workspace-files")
        )
          throw new DomainError(
            409,
            "capability_required",
            "This Computer does not support delegated workspace files",
          );
        if (
          /\/draft(?:\?|$)/.test(path) &&
          !tunnels.supports(computerId, "personal-drafts")
        )
          throw new DomainError(
            409,
            "capability_required",
            "Update the Computer to use personal drafts",
          );
        if (
          r.method === "POST" &&
          /\/(enqueue|queue\/(update|delete|move))$/.test(path) &&
          !tunnels.supports(computerId, "authorized-queue")
        )
          throw new DomainError(
            409,
            "capability_required",
            "This Computer does not support authorized remote queues",
          );
        const queueContext =
          r.method === "POST" && /\/(enqueue|queue\/update)$/.test(path)
            ? await call<{ actorId: string; queuePermit: string }>(
                r,
                "queue-permit",
                { computerId, path },
              )
            : {};
        const timer = setInterval(
          () => void recheck().catch((e) => controller.abort(e)),
          1000,
        );
        const cleanup = () => {
          if (ended) return;
          ended = true;
          clearInterval(timer);
          controller.abort();
        };
        r.raw.once("aborted", cleanup);
        reply.raw.once("close", cleanup);
        try {
          const response = await tunnels.http(
            computerId,
            {
              method: r.method as "GET",
              path,
              headers: filterHeaders(r.headers, "request"),
              actorId: decision.actorId,
              ...(decision.actorIsOwner === undefined
                ? {}
                : { actorIsOwner: decision.actorIsOwner }),
              ...(decision.workspace ? { workspace: decision.workspace } : {}),
              ...queueContext,
            },
            (r.body as Bytes | undefined) ?? emptyBody,
            controller.signal,
          );
          await recheck();
          reply
            .code(response.status)
            .header("Content-Security-Policy", "sandbox; default-src 'none'");
          const headers = filterHeaders(response.headers, "response");
          const hls = (headers["content-type"] ?? "").includes("mpegurl");
          if (hls) delete headers["content-length"];
          for (const [key, value] of Object.entries(headers))
            reply.header(key, value);
          async function* output() {
            try {
              if (hls) {
                const buffers: Buffer[] = [];
                let bytes = 0;
                for await (const chunk of response.body) {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  bytes += chunk.length;
                  if (bytes > 1024 * 1024)
                    throw new Error("Playlist too large");
                  buffers.push(Buffer.from(chunk));
                }
                const original = Buffer.concat(buffers).toString("utf8");
                yield Buffer.from(
                  original.replace(
                    /(^|["'])\/api\//gm,
                    "$1" + prefix + "/api/",
                  ),
                );
              } else
                for await (const chunk of response.body) {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  yield chunk;
                }
            } finally {
              cleanup();
            }
          }
          return reply.send(Readable.from(output()));
        } catch (e) {
          cleanup();
          throw e;
        }
      },
    });
  });
  app.get("/api/v1/computers/:computerId/", async (r, reply) => {
    const computerId = Id.parse(
      (r.params as { computerId: string }).computerId,
    );
    const computers = await call<Array<{ id: string }>>(r, "computers");
    if (!computers.some((c) => c.id === computerId))
      throw new DomainError(403, "forbidden", "Computer access required");
    const me = await call<{ id: string }>(r, "me"),
      asset = await workspaceAsset("dist/workspace", "", {
        issuer: a.origin,
        accountId: me.id,
        hubId: a.hubId,
        computerId,
      });
    return reply.type(asset.type).send(asset.body);
  });
  app.get("/api/v1/computers/:computerId/*", async (r, reply) => {
    const p = r.params as { computerId: string; "*": string },
      computerId = Id.parse(p.computerId);
    if (p["*"].startsWith("api/"))
      throw new DomainError(403, "route_denied", "Unsupported remote API");
    const me = await call<{ id: string }>(r, "me"),
      asset = await workspaceAsset("dist/workspace", p["*"], {
        issuer: a.origin,
        accountId: me.id,
        hubId: a.hubId,
        computerId,
      });
    return reply.type(asset.type).send(asset.body);
  });
  if (o.localIdentity) {
    for (const url of [
      "/api/v1/auth/*",
      "/api/v1/me",
      "/api/v1/me/*",
      "/api/v1/hub-token",
      "/api/v1/invitations/accept",
      "/api/v1/hubs",
      "/api/v1/hubs/*",
      "/api/v1/pairing/redeem",
      "/api/v1/pairing/inspect-transfer",
      "/api/v1/pairing/redeem-transfer",
      "/api/v1/computers/:id/transfer",
      "/oauth/*",
      "/auth/:connection/start",
      "/auth/:connection/callback",
      "/.well-known/jwks.json",
      "/account.js",
      "/appearance/*",
    ]) {
      app.route({
        method: ["GET", "POST", "PUT", "DELETE"],
        url,
        handler: async (r, reply) => {
          const headers = { ...r.headers };
          delete headers["content-length"];
          delete headers["host"];
          delete headers["origin"];
          const res = await o.localIdentity!.inject({
            method: r.method as "GET",
            url: r.url,
            headers,
            payload: r.body as any,
            remoteAddress: r.ip,
          });
          if (
            r.method === "POST" &&
            url === "/api/v1/pairing/redeem-transfer" &&
            res.statusCode === 200
          ) {
            // Admission rotates the destination credential/binding. Its old
            // live transport must stop accepting work before the new owner
            // connects the retained Computer, without terminating local CLIs.
            const admitted = z.object({ computerId: Id }).parse(res.json());
            tunnels.disconnect(
              admitted.computerId,
              "Computer transfer admitted",
            );
          }
          reply.code(res.statusCode);
          for (const [k, v] of Object.entries(res.headers))
            if (
              v !== undefined &&
              !["content-length", "connection", "transfer-encoding"].includes(k)
            )
              reply.header(k, v);
          return reply.send(res.rawPayload);
        },
      });
    }
    app.get("/login", async (r, reply) => {
      return reply
        .header("Cache-Control", "no-store")
        .type("text/html")
        .header(
          "Content-Security-Policy",
          "default-src 'self'; script-src 'self'; style-src 'self'; frame-ancestors 'none'; base-uri 'none'",
        )
        .send(
          '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codoxear login</title><link rel="stylesheet" href="/appearance/app.css"><link rel="stylesheet" href="/appearance/connections.css"></head><body><main class="connectionLoginWrap"><section class="connectionLogin" id="hubLogin" aria-label="Hub sign-in"><h1>Codoxear login</h1><p class="connectionHint" role="status">Loading sign-in…</p></section></main><script src="/hub-login.js" type="module"></script></body></html>',
        );
    });
  }
  if (o.localIdentity)
    app.get("/hub-login.js", async (_r, reply) =>
      reply
        .header("Cache-Control", "no-cache")
        .type("text/javascript")
        .send(await readFile("dist/client/hub-login.js")),
    );
  const webRoot = resolve(o.webRoot ?? "dist/web");
  if (existsSync(webRoot)) await app.register(staticFiles, { root: webRoot });
  app.addHook("preClose", async () => {
    for (const close of live) close();
    tunnels.close();
  });
  return app;
}
