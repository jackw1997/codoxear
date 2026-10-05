import { agentShares, setAgentShare } from "../domain/agent-sharing.js";
import { InvitationRequest } from "../contracts/invitations.js";
import Fastify, { type FastifyRequest } from "fastify";
import cookie from "@fastify/cookie";
import websocket from "@fastify/websocket";
import staticFiles from "@fastify/static";
import { z } from "zod";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import {
  Agent,
  DomainError,
  Id,
  Name,
  Policy,
  Role,
  forbid,
  requireValue,
  type Resource,
} from "../contracts/model.js";
import { Store } from "../persistence/store.js";
import {
  acceptInvite,
  createComputer,
  createHub,
  digest,
  id,
  invite,
  passwordMatches,
  removeMember,
  reserveAgent,
  resource,
  secret,
  setPolicy,
  transferOwner,
} from "../domain/commands.js";
import {
  agentAccess,
  canCreate,
  computerRole,
  effectivePolicy,
  hubAccess,
} from "../domain/policy.js";
import { Tunnels } from "../protocol/tunnels.js";
import { Message, MAX_FRAME_BYTES } from "../contracts/tunnel.js";

export interface AppOptions {
  store: Store;
  tunnels: Tunnels;
  webRoot?: string;
  development?: boolean;
  secureCookies?: boolean;
}
const Params = z.object({ id: Id });
const MembershipParams = z.object({
  kind: z.enum(["hub", "computer"]),
  id: Id,
});
const resourcePath = "/api/resources/:kind/:id";
export async function createApp(options: AppOptions) {
  const { store, tunnels } = options;
  const app = Fastify({ logger: false, bodyLimit: 256 * 1024 });
  await app.register(cookie);
  await app.register(websocket, { options: { maxPayload: MAX_FRAME_BYTES } });
  const loginAttempts = new Map<string, { count: number; until: number }>();
  function actor(request: FastifyRequest): string {
    const token = request.cookies["codoxear_v2"];
    if (!token)
      throw new DomainError(401, "unauthorized", "Sign in to continue");
    const s = store.read(),
      session = s.sessions.find(
        (x) => x.tokenHash === digest(token) && x.expiresAt > Date.now(),
      );
    if (
      !session ||
      !s.users.some((u) => u.id === session.userId && !u.disabled)
    )
      throw new DomainError(401, "unauthorized", "Session expired");
    return session.userId;
  }
  function demandAgent(
    request: FastifyRequest,
    action: "read" | "send" | "interrupt",
  ) {
    const userId = actor(request),
      { id: agentId } = Params.parse(request.params),
      s = store.read(),
      a = requireValue(s.agents.find((x) => x.id === agentId));
    const access = agentAccess(s, userId, a);
    forbid(access.actions.includes(action), access.reason);
    return { a, userId, access };
  }
  app.addHook("onRequest", async (request) => {
    if (["POST", "PUT", "PATCH", "DELETE"].includes(request.method)) {
      const origin = request.headers.origin;
      if (origin) {
        let parsed: URL;
        try {
          parsed = new URL(origin);
        } catch {
          throw new DomainError(403, "bad_origin", "Invalid origin");
        }
        if (parsed.host !== request.headers.host)
          throw new DomainError(
            403,
            "bad_origin",
            "Cross-origin mutation rejected",
          );
      }
    }
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("Cache-Control", "no-store");
    return payload;
  });
  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof z.ZodError)
      return reply.code(400).send({
        code: "invalid_request",
        error: "Invalid request",
        details: error.issues.map((x) => ({
          path: x.path,
          message: x.message,
        })),
      });
    if (error instanceof DomainError)
      return reply
        .code(error.status)
        .send({ code: error.code, error: error.message });
    app.log.error(error);
    return reply
      .code(500)
      .send({ code: "internal_error", error: "Operation failed" });
  });
  app.get("/health", async () => ({ ok: true, version: 1 }));
  app.get("/api/auth/options", async () => ({
    local: true,
    development: options.development ?? false,
    providers: [
      { id: "feishu", name: "Feishu", enabled: false },
      { id: "email", name: "Email code", enabled: false },
      { id: "phone", name: "Phone / SMS", enabled: false },
      { id: "wechat", name: "WeChat", enabled: false },
    ],
    notice:
      "Provider adapters require configuration and are not implemented in this first slice. Local accounts are provisioned by the operator.",
  }));
  app.post("/api/auth/login", async (request, reply) => {
    const body = z
      .object({
        email: z.email().transform((x) => x.toLowerCase()),
        password: z.string().min(1).max(512),
      })
      .parse(request.body);
    const key = request.ip,
      now = Date.now(),
      recent = loginAttempts.get(key);
    if (recent && recent.until > now && recent.count >= 10)
      throw new DomainError(
        429,
        "rate_limited",
        "Too many attempts; retry later",
      );
    const user = store
      .read()
      .users.find((u) => u.email === body.email && !u.disabled);
    if (!user || !passwordMatches(body.password, user.passwordHash)) {
      loginAttempts.set(key, {
        count: recent && recent.until > now ? recent.count + 1 : 1,
        until: now + 60_000,
      });
      throw new DomainError(
        401,
        "bad_credentials",
        "Email or password is incorrect",
      );
    }
    loginAttempts.delete(key);
    const token = secret();
    store.change((s) => {
      s.sessions = s.sessions.filter((x) => x.expiresAt > now);
      s.sessions.push({
        tokenHash: digest(token),
        userId: user.id,
        expiresAt: now + 12 * 3600000,
      });
    });
    reply.setCookie("codoxear_v2", token, {
      httpOnly: true,
      secure: options.secureCookies ?? true,
      sameSite: "strict",
      path: "/",
      maxAge: 12 * 3600,
    });
    return { user: { id: user.id, name: user.name, email: user.email } };
  });
  app.post("/api/auth/logout", async (request, reply) => {
    const token = request.cookies["codoxear_v2"];
    if (token)
      store.change((s) => {
        s.sessions = s.sessions.filter((x) => x.tokenHash !== digest(token));
      });
    reply.clearCookie("codoxear_v2", { path: "/" });
    return { ok: true };
  });
  app.get("/api/me", async (request) => {
    const userId = actor(request),
      user = requireValue(store.read().users.find((u) => u.id === userId));
    return { id: user.id, name: user.name, email: user.email };
  });
  app.get("/api/hubs", async (request) => {
    const userId = actor(request),
      s = store.read();
    return s.hubs
      .filter((h) => hubAccess(s, userId, h))
      .map((h) => ({
        ...h,
        ownerName: s.users.find((u) => u.id === h.ownerId)?.name,
      }));
  });
  app.post("/api/hubs", async (request) => {
    const userId = actor(request),
      body = z.object({ name: Name }).parse(request.body);
    return store.change((s) => createHub(s, userId, body.name));
  });
  app.get("/api/hubs/:id/computers", async (request) => {
    const userId = actor(request),
      { id: hubId } = Params.parse(request.params),
      s = store.read(),
      h = requireValue(s.hubs.find((x) => x.id === hubId));
    forbid(hubAccess(s, userId, h), "Hub access required");
    return s.computers
      .filter(
        (c) =>
          c.hubId === hubId &&
          (h.ownerId === userId ||
            !!computerRole(s, userId, c) ||
            s.agents.some(
              (a) =>
                a.computerId === c.id &&
                agentAccess(s, userId, a).actions.length,
            )),
      )
      .map((c) => ({
        id: c.id,
        hubId: c.hubId,
        ownerId: c.ownerId,
        name: c.name,
        policy: c.policy,
        online: tunnels.online(c.id),
        canCreate: canCreate(s, userId, c),
        membership: computerRole(s, userId, c),
        effectivePolicy: effectivePolicy(h, c),
        ownerName: s.users.find((u) => u.id === c.ownerId)?.name,
      }));
  });
  app.post("/api/hubs/:id/computers", async (request) => {
    const userId = actor(request),
      { id: hubId } = Params.parse(request.params),
      body = z
        .object({ name: Name, ownerId: Id.optional() })
        .parse(request.body);
    const value = store.change((s) =>
      createComputer(s, userId, hubId, body.name, body.ownerId ?? userId),
    );
    return {
      computer: {
        id: value.computer.id,
        hubId,
        ownerId: value.computer.ownerId,
        name: value.computer.name,
      },
      credential: value.computer.ownerId === userId ? value.credential : null,
    };
  });
  app.post("/api/computers/:id/credential", async (request) => {
    const userId = actor(request),
      { id: computerId } = Params.parse(request.params);
    const credential = secret();
    store.change((s) => {
      const c = requireValue(s.computers.find((x) => x.id === computerId));
      forbid(
        c.ownerId === userId,
        "Only the computer owner may obtain its credential",
      );
      forbid(
        hubAccess(
          s,
          userId,
          requireValue(s.hubs.find((h) => h.id === c.hubId)),
        ),
        "Hub access required",
      );
      c.credentialHash = digest(credential);
    });
    tunnels.disconnect(computerId, "Credential rotated");
    return { credential };
  });
  app.get(`${resourcePath}/members`, async (request) => {
    const userId = actor(request),
      { kind, id: resourceId } = MembershipParams.parse(request.params),
      s = store.read(),
      r = resource(s, kind, resourceId);
    forbid(r.ownerId === userId, "Only the owner can list members");
    return s.memberships
      .filter((m) => m.resource === kind && m.resourceId === resourceId)
      .map((m) => ({
        ...m,
        name: s.users.find((u) => u.id === m.userId)?.name,
        email: s.users.find((u) => u.id === m.userId)?.email,
      }));
  });
  app.get("/api/agents/:id/shares", async (r) =>
    agentShares(
      store.read(),
      actor(r),
      Id.parse((r.params as { id: string }).id),
    ),
  );
  app.put("/api/agents/:id/shares/:userId", async (r) => {
    const userId = actor(r),
      p = z.object({ id: Id, userId: Id }).parse(r.params);
    const body = z.object({ role: Role.nullable() }).strict().parse(r.body);
    return store.change((s) =>
      setAgentShare(s, userId, p.id, p.userId, body.role),
    );
  });
  app.post(`${resourcePath}/invitations`, async (request) => {
    const userId = actor(request),
      { kind, id: resourceId } = MembershipParams.parse(request.params),
      body = InvitationRequest.parse(request.body);
    const value = store.change((s) =>
      invite(
        s,
        userId,
        kind,
        resourceId,
        body.target ?? body.email!,
        body.role,
      ),
    );
    return {
      id: value.invitation.id,
      token: value.token,
      expiresAt: value.invitation.expiresAt,
    };
  });
  app.post("/api/invitations/accept", async (request) => {
    const userId = actor(request),
      { token } = z
        .object({ token: z.string().min(32).max(100) })
        .parse(request.body);
    const i = store.change((s) => acceptInvite(s, userId, token));
    return { resource: i.resource, resourceId: i.resourceId };
  });
  app.delete(`${resourcePath}/members/:memberId`, async (request) => {
    const userId = actor(request),
      p = MembershipParams.extend({ memberId: Id }).parse(request.params);
    store.change((s) => removeMember(s, userId, p.kind, p.id, p.memberId));
    return { ok: true };
  });
  app.put(`${resourcePath}/policy`, async (request) => {
    const userId = actor(request),
      p = MembershipParams.parse(request.params),
      body = z.object({ policy: Policy.nullable() }).parse(request.body);
    store.change((s) => setPolicy(s, userId, p.kind, p.id, body.policy));
    return { ok: true };
  });
  app.post(`${resourcePath}/owner`, async (request) => {
    const userId = actor(request),
      p = MembershipParams.parse(request.params),
      body = z.object({ ownerId: Id }).parse(request.body);
    store.change((s) => transferOwner(s, userId, p.kind, p.id, body.ownerId));
    return { ok: true };
  });
  app.get("/api/computers/:id/agents", async (request) => {
    const userId = actor(request),
      { id: computerId } = Params.parse(request.params),
      s = store.read();
    return s.agents
      .filter((a) => a.computerId === computerId)
      .map((a) => ({ ...a, access: agentAccess(s, userId, a) }))
      .filter((a) => a.access.actions.length > 0);
  });
  app.post("/api/computers/:id/agents", async (request) => {
    const userId = actor(request),
      { id: computerId } = Params.parse(request.params),
      body = z
        .object({ name: Name, backend: Agent.shape.backend })
        .parse(request.body);
    // Authorization precedes availability; an offline machine must not leak access.
    const a = store.change((s) => {
      const c = requireValue(s.computers.find((x) => x.id === computerId));
      forbid(
        canCreate(s, userId, c),
        "Creating an agent requires active hub AND computer operator access",
      );
      if (!tunnels.online(computerId))
        throw new DomainError(503, "not_dispatched", "Computer is offline");
      return reserveAgent(s, userId, computerId, body.name, body.backend);
    });
    try {
      const result = z.object({ localId: z.string().min(1).max(200) }).parse(
        await tunnels.request(computerId, {
          op: "create",
          agentId: a.id,
          name: a.name,
          backend: a.backend,
        }),
      );
      store.change((s) => {
        const stored = requireValue(s.agents.find((x) => x.id === a.id));
        stored.localId = result.localId;
        stored.state = "ready";
      });
      return { ...a, localId: result.localId, state: "ready" };
    } catch (error) {
      store.change((s) => {
        const stored = requireValue(s.agents.find((x) => x.id === a.id));
        stored.state =
          error instanceof DomainError && error.code === "not_dispatched"
            ? "failed"
            : "unknown";
      });
      throw error;
    }
  });
  app.get("/api/agents/:id/messages", async (request) => {
    const { a, access } = demandAgent(request, "read");
    if (!a.localId) return { messages: [], access, state: a.state };
    const result = await tunnels.request(a.computerId, {
      op: "messages",
      agentId: a.id,
      localId: a.localId,
    });
    demandAgent(request, "read");
    return {
      ...z.object({ messages: z.array(Message) }).parse(result),
      access,
      state: a.state,
    };
  });
  app.post("/api/agents/:id/send", async (request) => {
    const { a } = demandAgent(request, "send"),
      body = z
        .object({ text: z.string().trim().min(1).max(200_000) })
        .parse(request.body);
    if (!a.localId)
      throw new DomainError(409, "not_ready", "Agent is not ready");
    return tunnels.request(a.computerId, {
      op: "send",
      agentId: a.id,
      localId: a.localId,
      text: body.text,
    });
  });
  app.post("/api/agents/:id/interrupt", async (request) => {
    const { a } = demandAgent(request, "interrupt");
    if (!a.localId)
      throw new DomainError(409, "not_ready", "Agent is not ready");
    return tunnels.request(a.computerId, {
      op: "interrupt",
      agentId: a.id,
      localId: a.localId,
    });
  });
  app.get("/api/agents/:id/live", async (request, reply) => {
    const initial = demandAgent(request, "read");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let closed = false,
      busy = false,
      last = "";
    const write = (event: string, value: unknown) => {
      if (!closed) {
        if (reply.raw.writableLength > MAX_FRAME_BYTES) {
          reply.raw.destroy();
          return;
        }
        reply.raw.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
      }
    };
    const tick = async () => {
      if (closed || busy) return;
      busy = true;
      try {
        const { a, access } = demandAgent(request, "read");
        write("access", access);
        if (a.localId) {
          const value = z.object({ messages: z.array(Message) }).parse(
            await tunnels.request(a.computerId, {
              op: "messages",
              agentId: a.id,
              localId: a.localId,
            }),
          );
          demandAgent(request, "read");
          write("online", {});
          const next = JSON.stringify(value);
          if (next !== last) {
            last = next;
            write("snapshot", value);
          }
        }
      } catch (error) {
        if (
          error instanceof DomainError &&
          [401, 403, 404].includes(error.status)
        ) {
          write("access_lost", { error: error.message });
          reply.raw.end();
        } else
          write("offline", { error: "Computer unavailable; reconnecting" });
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => void tick(), 1000);
    reply.raw.on("close", () => {
      closed = true;
      clearInterval(timer);
    });
    write("access", initial.access);
    void tick();
  });
  app.get(
    "/connect/v1/computers/:id",
    {
      websocket: true,
      preValidation: async (request) => {
        const { id: computerId } = Params.parse(request.params),
          s = store.read(),
          computer = requireValue(s.computers.find((c) => c.id === computerId));
        const token = request.headers.authorization?.replace(/^Bearer /, "");
        if (
          !token ||
          digest(token) !== computer.credentialHash ||
          request.headers["x-codoxear-hub"] !== computer.hubId
        )
          throw new DomainError(
            401,
            "invalid_computer",
            "Computer attachment rejected",
          );
      },
    },
    (socket, request) => {
      tunnels.attach(Params.parse(request.params).id, socket);
    },
  );
  const root = resolve(options.webRoot ?? "dist/web");
  if (existsSync(root)) {
    await app.register(staticFiles, { root, prefix: "/" });
    app.setNotFoundHandler((request, reply) =>
      request.url.startsWith("/api/")
        ? reply.code(404).send({ error: "Unknown API route" })
        : reply.sendFile("index.html"),
    );
  }
  app.addHook("onClose", async () => {
    tunnels.close();
  });
  return app;
}
