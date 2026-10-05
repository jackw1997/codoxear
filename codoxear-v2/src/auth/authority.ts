import { randomBytes } from "node:crypto";
import {
  PAIRING_ALPHABET,
  PAIRING_LIFETIME_SECONDS,
  normalizePairingCode,
} from "../contracts/pairing.js";
import { classifyRoute } from "../protocol/routes.js";
import { type Store } from "../persistence/store.js";
import { type Accounts } from "./accounts.js";
import { type Tokens } from "./tokens.js";
import { AuthRequirement, type IdentitySession } from "./model.js";
import {
  DomainError,
  forbid,
  requireValue,
  type Resource,
  type Policy,
  type Role,
} from "../contracts/model.js";
import {
  agentAccess,
  hubAccess,
  computerRole,
  canCreate,
  effectivePolicy,
} from "../domain/policy.js";
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
  reserveAgent,
  audit,
} from "../domain/commands.js";
export class Authority {
  constructor(
    readonly store: Store,
    readonly accounts: Accounts,
    readonly tokens: Tokens,
    private readonly now: () => number = Date.now,
  ) {}
  context(session: IdentitySession, hubId: string) {
    const s = this.store.read(),
      h = requireValue(s.hubs.find((x) => x.id === hubId));
    forbid(hubAccess(s, session.userId, h), "Hub access required");
    const req = s.identity.requirements.find((x) => x.hubId === hubId)?.rule;
    if (req) this.checkAuthentication(session, req);
    return h;
  }
  checkAuthentication(session: IdentitySession, req: AuthRequirement) {
    const identity = this.store
      .read()
      .identity.identities.find((x) => x.id === session.context.identityId);
    if (
      session.context.method !== req.method ||
      (req.connection && identity?.connection !== req.connection) ||
      (req.tenant && session.context.tenant !== req.tenant) ||
      Date.now() - session.context.authenticatedAt > req.maxAgeSeconds * 1000
    )
      throw new DomainError(
        401,
        "reauthentication_required",
        `Fresh ${req.method} sign-in matching the required connection and tenant is required for this hub`,
      );
  }
  directory(session: IdentitySession) {
    const s = this.store.read();
    return s.hubs
      .filter((h) => hubAccess(s, session.userId, h))
      .map((h) => {
        const registration = s.identity.hubs.find(
          (x) => x.hubId === h.id && x.enabled,
        );
        let access = "allowed";
        try {
          this.context(session, h.id);
        } catch (e) {
          if (
            e instanceof DomainError &&
            e.code === "reauthentication_required"
          )
            access = "reauthentication_required";
          else throw e;
        }
        return {
          ...h,
          origin: registration?.origin ?? null,
          access,
          loginRequirement:
            s.identity.requirements.find((r) => r.hubId === h.id)?.rule ?? null,
        };
      });
  }
  agentDirectory(session: IdentitySession) {
    const state = this.store.read();
    const hubs = this.directory(session).filter(
      (h) => h.access === "allowed" && h.origin,
    );
    const placements = hubs.flatMap((h) =>
      this.computers(session, h.id)
        .filter((c) => c.canCreate)
        .map((c) => ({
          computerId: c.id,
          computerName: c.name,
          hubId: h.id,
          hubName: h.name,
          origin: h.origin!,
        })),
    );
    const agents = hubs.flatMap((h) =>
      state.agents
        .filter((a) => a.hubId === h.id)
        .filter((a) =>
          agentAccess(state, session.userId, a).actions.includes("read"),
        )
        .map((a) => ({
          ...a,
          computerName:
            state.computers.find((c) => c.id === a.computerId)?.name ??
            "Computer",
          hubName: h.name,
          origin: h.origin!,
          access: agentAccess(state, session.userId, a).mode,
        })),
    );
    return {
      agents: agents.sort((a, b) => b.createdAt - a.createdAt),
      placements,
    };
  }
  async hubToken(session: IdentitySession, hubId: string) {
    this.context(session, hubId);
    const h = requireValue(
      this.store
        .read()
        .identity.hubs.find((x) => x.hubId === hubId && x.enabled),
      "Hub is not registered",
    );
    return {
      accessToken: await this.tokens.issue(session, hubId),
      expiresIn: 300,
      hubId,
      origin: h.origin,
    };
  }
  async principal(token: string, hubId: string) {
    const claims = await this.tokens.verify(token, hubId),
      session = this.accounts.sessionById(claims.sessionId);
    forbid(session.userId === claims.userId, "Session identity mismatch");
    this.context(session, hubId);
    return session;
  }
  registerHub(session: IdentitySession, hubId: string, origin: string) {
    const h = this.context(session, hubId);
    forbid(
      h.ownerId === session.userId,
      "Only the hub owner can register its origin",
    );
    const url = new URL(origin);
    if (
      url.origin !== origin ||
      (url.protocol !== "https:" &&
        !(
          url.protocol === "http:" &&
          ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)
        ))
    )
      throw new DomainError(
        400,
        "invalid_origin",
        "Use an exact HTTPS origin (loopback HTTP is allowed for local tests)",
      );
    const credential = secret();
    this.store.change((s) => {
      s.identity.hubs = s.identity.hubs.filter((x) => x.hubId !== hubId);
      s.identity.hubs.push({
        hubId,
        origin,
        credentialHash: digest(credential),
        enabled: true,
      });
      audit(s, session.userId, "hub.register", hubId);
    });
    return { hubId, origin, credential };
  }
  hubService(hubId: string, credential: string) {
    const h = this.store
      .read()
      .identity.hubs.find(
        (x) =>
          x.hubId === hubId &&
          x.enabled &&
          x.credentialHash === digest(credential),
      );
    if (!h)
      throw new DomainError(
        401,
        "invalid_hub",
        "Hub service credential rejected",
      );
    return h;
  }
  relay(
    session: IdentitySession,
    hubId: string,
    computerId: string,
    method: string,
    path: string,
  ) {
    this.context(session, hubId);
    const route = classifyRoute(method, path),
      s = this.store.read(),
      computer = requireValue(
        s.computers.find((x) => x.id === computerId && x.hubId === hubId),
      );
    if (route.action === "computer.admin") {
      forbid(
        computer.ownerId === session.userId,
        "Computer-wide files and settings require the computer owner",
      );
      return {
        actorId: session.userId,
        action: route.action,
        revision: s.revision,
        leaseExpiresAt: Date.now(),
      };
    }
    const agent = requireValue(
      s.agents.find(
        (x) =>
          x.computerId === computerId &&
          x.hubId === hubId &&
          x.localId === route.localId,
      ),
    );
    const isFile = route.action.startsWith("files.");
    const isDelete = route.action === "session.delete";
    const decision = this.authorize(
      session,
      hubId,
      agent.id,
      isFile
        ? "read"
        : isDelete
          ? "send"
          : (route.action as "read" | "send" | "interrupt"),
    );
    let workspace: { id: "default"; access: "read" | "write" } | undefined;
    if (isFile && computer.ownerId !== session.userId) {
      const grant = s.identity.workspaceGrants.find(
        (g) =>
          g.computerId === computerId &&
          g.userId === session.userId &&
          g.binding === computer.binding &&
          g.ownerRevision === computer.revision,
      );
      forbid(
        !!computerRole(s, session.userId, computer) && !!grant,
        "Workspace access requires an active computer membership and an explicit owner grant",
      );
      forbid(
        route.action !== "files.write" || grant.access === "write",
        "Workspace access is read-only",
      );
      forbid(
        /^\/api\/sessions\/[^/]+\/file\/(read|write|blob|download|list|search|image-dimensions|inspect|inspect-batch)(?:\?|$)/.test(
          path,
        ),
        "This action requires a separate computer capability",
      );
      workspace = { id: "default", access: grant.access };
    }
    if (isDelete)
      forbid(
        computer.ownerId === session.userId,
        "Only the computer owner can delete a local session",
      );
    return {
      ...decision,
      action: route.action,
      ...(workspace ? { workspace } : {}),
    };
  }
  setWorkspaceAccess(
    session: IdentitySession,
    hubId: string,
    computerId: string,
    userId: string,
    access: "read" | "write" | null,
  ) {
    this.computerOwner(session, hubId, computerId);
    this.store.change((s) => {
      const computer = requireValue(
        s.computers.find((c) => c.id === computerId),
      );
      if (access !== null) {
        forbid(
          userId !== computer.ownerId &&
            !!computerRole(s, userId, computer) &&
            hubAccess(
              s,
              userId,
              requireValue(s.hubs.find((h) => h.id === hubId)),
            ),
          "The recipient must be an active hub and computer member",
        );
      }
      s.identity.workspaceGrants = s.identity.workspaceGrants.filter(
        (g) => !(g.computerId === computerId && g.userId === userId),
      );
      if (access !== null)
        s.identity.workspaceGrants.push({
          computerId,
          userId,
          workspaceId: "default",
          access,
          binding: computer.binding,
          ownerRevision: computer.revision,
        });
      audit(s, session.userId, "workspace." + (access ?? "revoke"), computerId);
    });
    return { ok: true };
  }
  forgetDeletedAgent(
    session: IdentitySession,
    hubId: string,
    computerId: string,
    localId: string,
  ) {
    this.relay(
      session,
      hubId,
      computerId,
      "POST",
      `/api/sessions/${localId}/delete`,
    );
    this.store.change((s) => {
      const agent = requireValue(
        s.agents.find(
          (a) =>
            a.hubId === hubId &&
            a.computerId === computerId &&
            a.localId === localId,
        ),
      );
      s.agentGrants = s.agentGrants.filter((g) => g.agentId !== agent.id);
      s.agents = s.agents.filter((a) => a.id !== agent.id);
      s.priorGrants = s.priorGrants.filter((g) => g.agentId !== agent.id);
      s.identity.queuePermits = s.identity.queuePermits.filter(
        (p) =>
          !(
            p.hubId === hubId &&
            p.computerId === computerId &&
            p.localId === localId
          ),
      );
      audit(s, session.userId, "agent.delete", agent.id);
    });
    return { ok: true };
  }
  queuePermit(
    session: IdentitySession,
    hubId: string,
    computerId: string,
    path: string,
  ) {
    const route = classifyRoute("POST", path);
    forbid(
      /\/(enqueue|queue\/update)$/.test(path),
      "Queue permit route required",
    );
    this.relay(session, hubId, computerId, "POST", path);
    const token = secret();
    this.store.change((s) => {
      const computer = requireValue(
        s.computers.find((c) => c.id === computerId && c.hubId === hubId),
      );
      s.identity.queuePermits = s.identity.queuePermits.filter(
        (p) => p.expiresAt > Date.now(),
      );
      s.identity.queuePermits.push({
        tokenHash: digest(token),
        sessionId: session.id,
        hubId,
        computerId,
        localId: route.localId!,
        binding: computer.binding,
        expiresAt: Math.min(session.expiresAt, Date.now() + 86400000),
      });
    });
    return { actorId: session.userId, queuePermit: token };
  }
  authorizeQueue(
    hubId: string,
    computerId: string,
    credential: string,
    permit: string,
    localId: string,
  ) {
    const device = this.device(hubId, computerId, credential);
    const grant = requireValue(
      this.store
        .read()
        .identity.queuePermits.find((p) => p.tokenHash === digest(permit)),
      "Queue authorization is no longer available",
    );
    forbid(
      grant.hubId === hubId &&
        grant.computerId === computerId &&
        grant.localId === localId &&
        grant.binding === device.binding &&
        grant.expiresAt > Date.now(),
      "Queue authorization expired or belongs to another attachment",
    );
    const session = this.accounts.sessionById(grant.sessionId);
    return this.relay(
      session,
      hubId,
      computerId,
      "POST",
      `/api/sessions/${encodeURIComponent(localId)}/send`,
    );
  }
  notificationTarget(
    hubId: string,
    computerId: string,
    credential: string,
    localId: string,
  ) {
    const device = this.device(hubId, computerId, credential);
    const agent = this.store
      .read()
      .agents.find(
        (a) =>
          a.hubId === hubId &&
          a.computerId === computerId &&
          a.localId === localId,
      );
    return { ...device, agentId: agent?.id ?? null };
  }
  authorizeNotification(
    hubId: string,
    sessionId: string,
    agentId: string,
    computerId: string,
    binding: number,
  ) {
    const computer = requireValue(
      this.store
        .read()
        .computers.find(
          (c) =>
            c.id === computerId && c.hubId === hubId && c.binding === binding,
        ),
    );
    const session = this.accounts.sessionById(sessionId),
      result = this.authorize(session, hubId, agentId, "read");
    forbid(
      result.agent.computerId === computer.id,
      "Notification target mismatch",
    );
    return { ok: true };
  }
  computers(session: IdentitySession, hubId: string) {
    const h = this.context(session, hubId),
      s = this.store.read();
    return s.computers
      .filter(
        (c) =>
          c.hubId === hubId &&
          (c.ownerId === session.userId ||
            h.ownerId === session.userId ||
            computerRole(s, session.userId, c) ||
            s.agents.some(
              (a) =>
                a.computerId === c.id &&
                agentAccess(s, session.userId, a).actions.length,
            )),
      )
      .map((c) => ({
        id: c.id,
        name: c.name,
        hubId: c.hubId,
        ownerId: c.ownerId,
        ownerName: s.users.find((u) => u.id === c.ownerId)?.name,
        policy: c.policy,
        binding: c.binding,
        canCreate: canCreate(s, session.userId, c),
        membership: computerRole(s, session.userId, c),
        effectivePolicy: effectivePolicy(h, c),
      }));
  }
  agents(session: IdentitySession, hubId: string, computerId: string) {
    this.context(session, hubId);
    const s = this.store.read(),
      computer = requireValue(
        s.computers.find((x) => x.id === computerId && x.hubId === hubId),
      );
    return s.agents
      .filter((a) => a.computerId === computer.id && a.hubId === hubId)
      .map((a) => ({ ...a, access: agentAccess(s, session.userId, a) }))
      .filter((a) => a.access.actions.length);
  }
  authorize(
    session: IdentitySession,
    hubId: string,
    agentId: string,
    action: "read" | "send" | "interrupt",
  ) {
    this.context(session, hubId);
    const s = this.store.read(),
      agent = requireValue(
        s.agents.find((x) => x.id === agentId && x.hubId === hubId),
      );
    const access = agentAccess(s, session.userId, agent);
    forbid(access.actions.includes(action), access.reason);
    return {
      agent,
      access,
      actorId: session.userId,
      revision: s.revision,
      leaseExpiresAt: Date.now(),
    };
  }
  createAgent(
    session: IdentitySession,
    hubId: string,
    computerId: string,
    name: string,
    backend: "codex" | "pi" | "cc" | "fixture",
  ) {
    this.context(session, hubId);
    return this.store.change((s) => {
      requireValue(
        s.computers.find((x) => x.id === computerId && x.hubId === hubId),
      );
      return reserveAgent(s, session.userId, computerId, name, backend);
    });
  }
  computerOwner(session: IdentitySession, hubId: string, computerId: string) {
    this.context(session, hubId);
    const computer = requireValue(
      this.store
        .read()
        .computers.find((c) => c.id === computerId && c.hubId === hubId),
    );
    forbid(
      computer.ownerId === session.userId,
      "Only the computer owner can publish local sessions",
    );
    return computer;
  }
  importAgent(
    session: IdentitySession,
    hubId: string,
    computerId: string,
    localId: string,
    name: string,
    backend: "codex" | "pi" | "cc" | "fixture",
  ) {
    this.computerOwner(session, hubId, computerId);
    return this.store.change((s) => {
      const existing = s.agents.find(
        (a) => a.computerId === computerId && a.localId === localId,
      );
      if (existing) return existing;
      const agent = reserveAgent(s, session.userId, computerId, name, backend);
      agent.localId = localId;
      agent.state = "ready";
      audit(s, session.userId, "agent.import", agent.id);
      return agent;
    });
  }
  pairing(session: IdentitySession, computerId: string) {
    const s = this.store.read(),
      c = requireValue(s.computers.find((x) => x.id === computerId));
    this.context(session, c.hubId);
    forbid(
      c.ownerId === session.userId,
      "Only the computer owner can enroll it",
    );
    return this.store.change((state) => {
      const now = this.now();
      state.identity.pairings = state.identity.pairings.filter(
        (x) => x.computerId !== computerId && x.expiresAt > now,
      );
      let code: string;
      do {
        code = [...randomBytes(8)]
          .map((byte) => PAIRING_ALPHABET[byte % 32])
          .join("");
      } while (
        state.identity.pairings.some((p) => p.codeHash === digest(code))
      );
      const expiresAt = now + PAIRING_LIFETIME_SECONDS * 1000;
      state.identity.pairings.push({
        codeHash: digest(code),
        computerId,
        hubId: c.hubId,
        ownerId: session.userId,
        binding: c.binding,
        expiresAt,
        used: false,
      });
      return {
        code,
        computerId,
        hubId: c.hubId,
        expiresIn: PAIRING_LIFETIME_SECONDS,
        expiresAt,
      };
    });
  }
  redeem(code: string) {
    const credential = secret();
    return this.store.change((s) => {
      const p = requireValue(
        s.identity.pairings.find(
          (x) => x.codeHash === digest(normalizePairingCode(code)),
        ),
      );
      forbid(
        !p.used && p.expiresAt > this.now(),
        "Pairing code expired or already used",
      );
      const c = requireValue(
        s.computers.find(
          (x) =>
            x.id === p.computerId &&
            x.hubId === p.hubId &&
            x.binding === p.binding &&
            x.ownerId === p.ownerId,
        ),
      );
      forbid(
        hubAccess(
          s,
          p.ownerId,
          requireValue(s.hubs.find((x) => x.id === p.hubId)),
        ),
        "Computer owner lost hub access",
      );
      const h = requireValue(
        s.identity.hubs.find((x) => x.hubId === c.hubId && x.enabled),
      );
      p.used = true;
      c.credentialHash = digest(credential);
      audit(s, p.ownerId, "computer.enroll", c.id);
      return {
        version: 1,
        hubUrl: h.origin,
        hubId: c.hubId,
        computerId: c.id,
        credential,
        binding: c.binding,
      };
    });
  }
  device(hubId: string, computerId: string, credential: string) {
    const s = this.store.read(),
      c = s.computers.find(
        (x) =>
          x.id === computerId &&
          x.hubId === hubId &&
          x.credentialHash === digest(credential),
      );
    if (!c)
      throw new DomainError(
        401,
        "invalid_computer",
        "Computer binding rejected",
      );
    return { computerId: c.id, hubId: c.hubId, binding: c.binding };
  }
  admitComputer(
    session: IdentitySession,
    targetHubId: string,
    computerId: string,
  ) {
    const target = this.context(session, targetHubId);
    forbid(
      target.ownerId === session.userId,
      "Only the target hub owner can admit a computer",
    );
    const state = this.store.read(),
      computer = requireValue(state.computers.find((c) => c.id === computerId));
    forbid(
      computer.hubId !== targetHubId,
      "Computer already belongs to this hub",
    );
    forbid(
      hubAccess(state, computer.ownerId, target),
      "Invite the computer owner to this hub first",
    );
    const token = secret();
    this.store.change((s) => {
      s.identity.admissions = s.identity.admissions.filter(
        (a) =>
          a.expiresAt > Date.now() &&
          !(a.computerId === computerId && a.targetHubId === targetHubId),
      );
      s.identity.admissions.push({
        tokenHash: digest(token),
        computerId,
        computerOwnerId: computer.ownerId,
        targetHubId,
        issuerId: session.userId,
        ownerRevision: target.revision,
        binding: computer.binding,
        expiresAt: Date.now() + 300000,
      });
      audit(s, session.userId, "computer.admission.issue", computerId);
    });
    return { token, computerId, targetHubId, expiresIn: 300 };
  }
  transferComputer(
    session: IdentitySession,
    computerId: string,
    targetHubId: string,
    exposeHistory: boolean,
    admissionToken?: string,
  ) {
    const s = this.store.read(),
      c = requireValue(s.computers.find((x) => x.id === computerId));
    forbid(
      c.ownerId === session.userId,
      "Only the computer owner can transfer it",
    );
    const target = this.context(session, targetHubId);
    forbid(c.hubId !== targetHubId, "Computer is already bound to this hub");
    return this.store.change((state) => {
      const computer = requireValue(
        state.computers.find((x) => x.id === computerId),
      );
      const oldHubId = computer.hubId;
      const currentTarget = requireValue(
        state.hubs.find((h) => h.id === targetHubId),
      );
      if (currentTarget.ownerId !== session.userId) {
        const admission = state.identity.admissions.find(
          (a) =>
            a.tokenHash === digest(admissionToken ?? "") &&
            a.computerId === computerId &&
            a.targetHubId === targetHubId,
        );
        forbid(
          !!admission &&
            admission.expiresAt > Date.now() &&
            admission.computerOwnerId === computer.ownerId &&
            admission.binding === computer.binding &&
            admission.issuerId === currentTarget.ownerId &&
            admission.ownerRevision === currentTarget.revision,
          "Target hub owner must issue a current admission for this computer",
        );
      }
      state.identity.admissions = state.identity.admissions.filter(
        (a) => a.computerId !== computerId,
      );
      computer.hubId = targetHubId;
      computer.binding++;
      computer.credentialHash = digest(secret());
      computer.revision++;
      state.memberships = state.memberships.filter(
        (x) => !(x.resource === "computer" && x.resourceId === computerId),
      );
      state.agentGrants = state.agentGrants.filter(
        (g) =>
          !state.agents.some(
            (a) => a.id === g.agentId && a.computerId === computerId,
          ),
      );
      state.priorGrants = state.priorGrants.filter(
        (x) => x.computerId !== computerId,
      );
      state.identity.pairings = state.identity.pairings.filter(
        (x) => x.computerId !== computerId,
      );
      if (exposeHistory) {
        for (const agent of state.agents.filter(
          (x) => x.computerId === computerId,
        ))
          agent.hubId = targetHubId;
      } else
        state.agents = state.agents.filter((x) => x.computerId !== computerId);
      audit(state, session.userId, "computer.binding.transfer", computerId);
      return {
        computerId,
        oldHubId,
        hubId: targetHubId,
        binding: computer.binding,
      };
    });
  }
}
