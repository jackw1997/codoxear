import { randomBytes, randomUUID } from "node:crypto";
import {
  PAIRING_ALPHABET,
  PAIRING_LIFETIME_SECONDS,
  normalizePairingCode,
} from "../contracts/pairing.js";
import { classifyRoute } from "../protocol/routes.js";
import {
  WorkspaceOptions,
  type WorkspaceContext,
} from "../contracts/workspaces.js";
import { type Store } from "../persistence/store.js";
import { type Accounts } from "./accounts.js";
import { checkHubOrganization } from "./hub-organization.js";
import { type Tokens } from "./tokens.js";
import { AuthRequirement, type IdentitySession } from "./model.js";
import type {
  DelegationAuthorization,
  DelegationContext,
  DelegationParentContext,
} from "../contracts/delegation.js";
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
  hubRole,
  canManageHub,
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
    checkHubOrganization(
      s,
      hubId,
      session.context.method,
      session.context.tenant,
      true,
    );
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
          role: hubRole(s, session.userId, h),
          canManage: canManageHub(s, session.userId, h),
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
          workspaceGrants: this.actorWorkspaceGrants(
            state,
            session.userId,
            a.computerId,
          ),
          computerName:
            state.computers.find((c) => c.id === a.computerId)?.name ??
            "Computer",
          hubName: h.name,
          origin: h.origin!,
          access: agentAccess(state, session.userId, a).mode,
          actions: agentAccess(state, session.userId, a).actions,
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
        computer.ownerId === session.userId &&
          canCreate(s, session.userId, computer),
        "Computer-wide files and settings require an explicitly allowlisted Computer owner",
      );
      return {
        actorId: session.userId,
        actorIsOwner: true,
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
    if (isFile && route.action === "files.write")
      forbid(
        computerRole(s, session.userId, computer) === "operator",
        "Computer write allowlist access is required",
      );
    let workspace: WorkspaceContext | undefined;
    const workspaceId =
      new URL(path, "http://workspace.invalid").searchParams.get(
        "workspace_id",
      ) ?? "default";
    const currentGrant = s.identity.workspaceGrants.find(
      (g) =>
        g.computerId === computerId &&
        g.userId === session.userId &&
        g.workspaceId === workspaceId &&
        g.binding === computer.binding &&
        g.ownerRevision === computer.revision,
    );
    const activeGrant =
      !!computerRole(s, session.userId, computer) && currentGrant;
    const grantContext = (
      g: NonNullable<typeof currentGrant>,
    ): WorkspaceContext => ({
      id: g.workspaceId,
      access: g.access,
      paths: g.paths,
      git: g.git,
      uploads: g.uploads,
      transcode: g.transcode,
      binding: g.binding,
      ownerRevision: g.ownerRevision,
      grantRevision: g.grantRevision,
    });
    if (isFile && computer.ownerId !== session.userId) {
      const grant = activeGrant;
      forbid(
        !!computerRole(s, session.userId, computer) && !!grant,
        "Workspace access requires an active computer membership and an explicit owner grant",
      );
      const upload = /\/(inject_file|inject_image)(?:\?|$)/.test(path);
      const git = /\/git\//.test(path);
      const transcode = /\/file\/video_preview(?:\?|$)/.test(path);
      forbid(
        route.action !== "files.write" || upload || grant.access === "write",
        "Workspace access is read-only",
      );
      forbid(
        /^\/api\/sessions\/[^/]+\/file\/(read|write|blob|download|list|search|image-dimensions|inspect|inspect-batch|video_preview)(?:\?|$)/.test(
          path,
        ) ||
          (git && grant.git) ||
          (upload && grant.uploads),
        "This action requires a separate computer capability",
      );
      forbid(
        !git || grant.git,
        "Repository history requires an explicit full-repository grant",
      );
      forbid(
        !upload || grant.uploads,
        "Attachment uploads require a separate owner grant",
      );
      forbid(
        !transcode || grant.transcode,
        "Video processing requires a separate owner grant",
      );
      workspace = grantContext(grant);
    }
    if (
      !isFile &&
      computer.ownerId !== session.userId &&
      activeGrant &&
      /\/(send|attachments(?:\/[^?]+)?|pending_attachment\/clear)(?:\?|$)/.test(
        path,
      )
    )
      workspace = grantContext(activeGrant);
    if (isDelete)
      forbid(
        computer.ownerId === session.userId,
        "Only the computer owner can delete a local session",
      );
    return {
      ...decision,
      action: route.action,
      actorIsOwner: computer.ownerId === session.userId,
      ...(workspace ? { workspace } : {}),
    };
  }
  setWorkspaceAccess(
    session: IdentitySession,
    hubId: string,
    computerId: string,
    userId: string,
    access: "read" | "write" | null,
    options: unknown = {},
  ) {
    const grantOptions = WorkspaceOptions.parse(options);
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
        (g) =>
          !(
            g.computerId === computerId &&
            g.userId === userId &&
            g.workspaceId === grantOptions.workspaceId
          ),
      );
      if (access !== null)
        s.identity.workspaceGrants.push({
          computerId,
          userId,
          ...grantOptions,
          grantRevision: randomUUID().replaceAll("-", ""),
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
          (canManageHub(s, session.userId, h) ||
            computerRole(s, session.userId, c)),
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
        canManage: canManageHub(s, session.userId, h),
        canUse: computerRole(s, session.userId, c) !== null,
        canRead: computerRole(s, session.userId, c) !== null,
        canWrite: canCreate(s, session.userId, c),
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
      .map((a) => ({
        ...a,
        access: agentAccess(s, session.userId, a),
        workspaceGrants: this.actorWorkspaceGrants(
          s,
          session.userId,
          computerId,
        ),
      }))
      .filter((a) => a.access.actions.length);
  }
  private actorWorkspaceGrants(
    state: ReturnType<Store["read"]>,
    userId: string,
    computerId: string,
  ) {
    const computer = state.computers.find((c) => c.id === computerId);
    if (!computer || !computerRole(state, userId, computer)) return [];
    return state.identity.workspaceGrants
      .filter(
        (g) =>
          g.userId === userId &&
          g.computerId === computerId &&
          g.binding === computer.binding &&
          g.ownerRevision === computer.revision,
      )
      .map((g) => ({
        workspaceId: g.workspaceId,
        access: g.access,
        paths: g.paths,
        git: g.git,
        uploads: g.uploads,
        transcode: g.transcode,
        grantRevision: g.grantRevision,
      }));
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
  /** All delegated operations retain the initiating sign-in, not just userId.
   * A machine credential authenticates transport; it grants no creation rights.
   */
  delegationParent(
    session: IdentitySession,
    hubId: string,
    parentId: string,
  ): DelegationParentContext {
    const { agent: parent } = this.authorize(session, hubId, parentId, "send");
    const source = requireValue(
      this.store
        .read()
        .computers.find((c) => c.id === parent.computerId && c.hubId === hubId),
    );
    return {
      actorId: session.userId,
      identitySessionId: session.id,
      parent,
      sourceBinding: source.binding,
    };
  }
  delegationContext(
    session: IdentitySession,
    hubId: string,
    parentId: string,
    targetComputerId: string,
    action: "create" | "read" | "send" | "interrupt" = "create",
    childId?: string,
    richLaunch = false,
  ): DelegationContext {
    const { agent: parent } = this.authorize(session, hubId, parentId, "send");
    const state = this.store.read();
    const source = requireValue(
      state.computers.find(
        (c) => c.id === parent.computerId && c.hubId === hubId,
      ),
    );
    const target = requireValue(
      state.computers.find(
        (c) => c.id === targetComputerId && c.hubId === hubId,
      ),
    );
    forbid(
      parent.state === "ready" && !!parent.localId,
      "Delegation requires a confirmed parent session",
    );
    forbid(
      canCreate(state, session.userId, target),
      "Delegated target creation requires active Hub and Computer operator access",
    );
    if (richLaunch) this.computerOwner(session, hubId, targetComputerId);
    if (childId) {
      const child = this.authorize(
        session,
        hubId,
        childId,
        action === "create" ? "read" : action,
      ).agent;
      forbid(
        child.computerId === targetComputerId &&
          child.creatorId === session.userId,
        "Delegated child does not belong to this principal and target",
      );
    }
    return {
      actorId: session.userId,
      identitySessionId: session.id,
      parent,
      target: { id: target.id, hubId: target.hubId, name: target.name },
      sourceBinding: source.binding,
    };
  }
  authorizeDelegation(
    input: DelegationAuthorization & { hubId: string },
  ): DelegationContext {
    const session = this.accounts.sessionById(input.identitySessionId);
    forbid(
      session.userId === input.actorId,
      "Delegation sign-in principal changed",
    );
    const context = this.delegationContext(
      session,
      input.hubId,
      input.parentId,
      input.targetComputerId,
      input.action,
      input.childId,
      !!input.launch && Object.keys(input.launch).length > 0,
    );
    forbid(
      context.parent.computerId === input.sourceComputerId &&
        context.sourceBinding === input.sourceBinding,
      "Delegation source Computer binding changed",
    );
    return context;
  }
  childDelegationContext(input: {
    hubId: string;
    identitySessionId: string;
    actorId: string;
    parentId: string;
    sourceComputerId: string;
    sourceBinding: number;
    childId: string;
    targetComputerId: string;
  }): DelegationContext {
    const child = requireValue(
      this.store
        .read()
        .agents.find(
          (agent) => agent.id === input.childId && agent.hubId === input.hubId,
        ),
    );
    this.authorizeDelegation({
      ...input,
      targetComputerId: child.computerId,
      action: "read",
    });
    const session = this.accounts.sessionById(input.identitySessionId);
    return this.delegationContext(
      session,
      input.hubId,
      child.id,
      input.targetComputerId,
    );
  }
  reserveDelegatedAgent(
    input: Parameters<Authority["authorizeDelegation"]>[0] & {
      agentId: string;
      name: string;
      backend: "codex" | "pi" | "cc";
    },
  ) {
    forbid(
      input.action === "create" && !input.childId,
      "Delegated reservation requires creation authorization",
    );
    const context = this.authorizeDelegation(input);
    return this.store.change((state) => {
      const existing = state.agents.find((agent) => agent.id === input.agentId);
      if (existing) {
        forbid(
          existing.hubId === input.hubId &&
            existing.computerId === input.targetComputerId &&
            existing.creatorId === context.actorId &&
            existing.name === input.name &&
            existing.backend === input.backend,
          "Reserved delegated child conflicts with an existing Agent",
        );
        return existing;
      }
      return reserveAgent(
        state,
        context.actorId,
        input.targetComputerId,
        input.name,
        input.backend,
        input.agentId,
      );
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
      canManageHub(
        s,
        session.userId,
        requireValue(s.hubs.find((h) => h.id === c.hubId)),
      ),
      "Only Hub owners and admins can enroll Computers",
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
        ownerId: c.ownerId,
        issuerId: session.userId,
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
        canManageHub(
          s,
          p.issuerId ?? p.ownerId,
          requireValue(s.hubs.find((h) => h.id === p.hubId)),
        ),
        "Pairing issuer lost Hub administration rights",
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
  inspectTransferPairing(code: string) {
    const s = this.store.read(),
      { c, h, p } = this.transferPairing(s, code);
    return {
      hubUrl: h.origin,
      hubId: c.hubId,
      computerId: c.id,
      binding: c.binding,
      expiresAt: p.expiresAt,
    };
  }
  private transferPairing(s: ReturnType<Store["read"]>, code: string) {
    const p = requireValue(
      s.identity.pairings.find(
        (entry) => entry.codeHash === digest(normalizePairingCode(code)),
      ),
    );
    forbid(
      !p.used && p.expiresAt > this.now(),
      "Pairing code expired or already used",
    );
    const c = requireValue(
      s.computers.find(
        (entry) =>
          entry.id === p.computerId &&
          entry.hubId === p.hubId &&
          entry.binding === p.binding &&
          entry.ownerId === p.ownerId,
      ),
    );
    forbid(
      hubAccess(
        s,
        p.ownerId,
        requireValue(s.hubs.find((entry) => entry.id === p.hubId)),
      ),
      "Computer owner lost hub access",
    );
    const h = requireValue(
      s.identity.hubs.find((entry) => entry.hubId === c.hubId && entry.enabled),
    );
    forbid(
      canManageHub(
        s,
        p.issuerId ?? p.ownerId,
        requireValue(s.hubs.find((hub) => hub.id === p.hubId)),
      ),
      "Pairing issuer lost Hub administration rights",
    );
    return { p, c, h };
  }
  redeemTransfer(code: string, transferId: string, credential: string) {
    return this.store.change((s) => {
      const codeHash = digest(normalizePairingCode(code)),
        credentialHash = digest(credential);
      const receipt = s.identity.transferEnrollments.find(
        (entry) =>
          entry.codeHash === codeHash &&
          entry.transferId === transferId &&
          entry.credentialHash === credentialHash,
      );
      let c, h;
      if (receipt) {
        c = requireValue(
          s.computers.find(
            (entry) =>
              entry.id === receipt.computerId &&
              entry.hubId === receipt.hubId &&
              entry.binding === receipt.binding &&
              entry.credentialHash === credentialHash,
          ),
        );
        forbid(
          hubAccess(
            s,
            c.ownerId,
            requireValue(s.hubs.find((entry) => entry.id === c!.hubId)),
          ),
          "Computer owner lost hub access",
        );
        h = requireValue(
          s.identity.hubs.find(
            (entry) => entry.hubId === c!.hubId && entry.enabled,
          ),
        );
      } else {
        const validated = this.transferPairing(s, code);
        c = validated.c;
        h = validated.h;
        validated.p.used = true;
        // Admission replaces a destination Computer slot. Its former path
        // grants and queue permits must not authorize the moved local roots.
        c.binding++;
        c.revision++;
        c.credentialHash = credentialHash;
        s.identity.workspaceGrants = s.identity.workspaceGrants.filter(
          (entry) => entry.computerId !== c!.id,
        );
        s.identity.queuePermits = s.identity.queuePermits.filter(
          (entry) => entry.computerId !== c!.id,
        );
        s.identity.pairings = s.identity.pairings.filter(
          (entry) => entry.computerId !== c!.id,
        );
        s.identity.transferEnrollments = s.identity.transferEnrollments.filter(
          (entry) => entry.computerId !== c!.id,
        );
        s.identity.transferEnrollments.push({
          codeHash,
          transferId,
          credentialHash,
          computerId: c.id,
          hubId: c.hubId,
          binding: c.binding,
        });
        audit(s, c.ownerId, "computer.transfer.admit", c.id);
      }
      // The caller already holds this generated credential. Never return a
      // secret in an admission receipt, including an idempotent retry.
      return {
        version: 1 as const,
        hubUrl: h.origin,
        hubId: c.hubId,
        computerId: c.id,
        binding: c.binding,
        transferId,
      };
    });
  }
  detachDevice(
    hubId: string,
    computerId: string,
    credential: string,
    transferId: string,
  ) {
    return this.store.change((s) => {
      const c = requireValue(
        s.computers.find(
          (entry) => entry.id === computerId && entry.hubId === hubId,
        ),
      );
      const credentialHash = digest(credential);
      const receipt = s.identity.computerDetachReceipts.find(
        (entry) =>
          entry.computerId === computerId &&
          entry.hubId === hubId &&
          entry.transferId === transferId &&
          entry.credentialHash === credentialHash,
      );
      if (receipt) {
        forbid(
          c.binding === receipt.binding &&
            c.credentialHash === receipt.fenceHash,
          "Computer was rebound after this detachment",
        );
        return {
          detached: true as const,
          transferId,
          computerId,
          hubId,
          priorBinding: receipt.priorBinding,
          binding: receipt.binding,
        };
      }
      if (c.credentialHash !== credentialHash)
        throw new DomainError(
          401,
          "invalid_computer",
          "Computer binding rejected",
        );
      const priorBinding = c.binding;
      c.binding++;
      c.revision++;
      c.credentialHash = digest(secret());
      s.identity.pairings = s.identity.pairings.filter(
        (entry) => entry.computerId !== computerId,
      );
      s.identity.queuePermits = s.identity.queuePermits.filter(
        (entry) => entry.computerId !== computerId,
      );
      s.identity.workspaceGrants = s.identity.workspaceGrants.filter(
        (entry) => entry.computerId !== computerId,
      );
      s.agentGrants = s.agentGrants.filter(
        (entry) =>
          !s.agents.some(
            (agent) =>
              agent.id === entry.agentId && agent.computerId === computerId,
          ),
      );
      s.identity.computerDetachReceipts =
        s.identity.computerDetachReceipts.filter(
          (entry) => entry.computerId !== computerId,
        );
      s.identity.computerDetachReceipts.push({
        computerId,
        hubId,
        transferId,
        credentialHash,
        fenceHash: c.credentialHash,
        priorBinding,
        binding: c.binding,
      });
      audit(s, c.ownerId, "computer.transfer.detach", computerId);
      return {
        detached: true as const,
        transferId,
        computerId,
        hubId,
        priorBinding,
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
      canManageHub(this.store.read(), session.userId, target),
      "Only target Hub owners and admins can admit a computer",
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
      if (!canManageHub(state, session.userId, currentTarget)) {
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
            canManageHub(state, admission.issuerId, currentTarget) &&
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
