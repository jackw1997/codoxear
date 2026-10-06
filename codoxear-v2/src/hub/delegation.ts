import type { FastifyInstance, FastifyRequest } from "fastify";
import { DatabaseSync } from "node:sqlite";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { z } from "zod";
import { DomainError, Id } from "../contracts/model.js";
import { Message } from "../contracts/tunnel.js";
import {
  DelegationGrantRequest,
  DelegationSpawn,
  DelegationSend,
  type DelegationReceipt,
  type DelegationGrant,
  type DelegationContext,
  type DelegationParentContext,
} from "../contracts/delegation.js";

export type {
  DelegationGrant,
  DelegationContext,
} from "../contracts/delegation.js";
export type DelegationOutcome =
  | { state: "ready"; localId: string }
  | { state: "failed"; error: string }
  | { state: "unknown" };
export interface DelegationDependencies {
  hubId: string;
  store: DelegationStore;
  /** Must authenticate the browser user and authorize parent send AND target creation. */
  authorizeUser(
    request: FastifyRequest,
    parentId: string,
    targetComputerId: string,
  ): Promise<DelegationContext>;
  authorizeParent?(
    request: FastifyRequest,
    parentId: string,
  ): Promise<DelegationParentContext>;
  authenticateComputer(
    request: FastifyRequest,
    computerId: string,
  ): Promise<{ computerId: string; hubId: string; binding: number }>;
  /** Live policy check by recorded principal, not ambient machine creation rights.
   * For every action revalidate source binding, parent control and target creation
   * authority; additionally authorize the requested child action for controls.
   */
  authorizeGrant(
    grant: DelegationGrant,
    targetComputerId: string,
    action: "create" | "read" | "send" | "interrupt",
    childId?: string,
  ): Promise<DelegationContext>;
  /** Admit target resources, create authority Agent with THIS reserved agentId,
   * dispatch once, and persist native launch receipt keyed by that agentId.
   * A timeout after dispatch must return unknown, never failed/not_dispatched.
   */
  launch(
    context: DelegationContext,
    args: DelegationSpawn & {
      agentId: string;
      depth: number;
      delegationRequired: boolean;
    },
  ): Promise<DelegationOutcome>;
  /** Lookup only: NEVER creates an Agent or reissues a launch. */
  reconcile(
    context: DelegationContext,
    receipt: DelegationReceipt,
  ): Promise<DelegationOutcome>;
  control?(
    context: DelegationContext,
    receipt: DelegationReceipt,
    input: { action: "send" | "interrupt"; text?: string },
  ): Promise<unknown>;
  readMessages?(
    context: DelegationContext,
    receipt: DelegationReceipt,
  ): Promise<unknown>;
  now?: () => number;
  installGrant?(
    context: DelegationContext,
    input: {
      parentId: string;
      localId: string;
      grant: string;
      expiresAt: number;
    },
  ): Promise<void>;
  childContext?(
    grant: DelegationGrant,
    childId: string,
    targetComputerId: string,
  ): Promise<DelegationContext>;
  checkInstallation?(
    context: DelegationParentContext,
  ): Promise<{
    installed: boolean;
    expiresAt?: number | undefined;
    grantDigest?: string | undefined;
  }>;
  revokeInstallation?(context: DelegationParentContext): Promise<void>;
  maxDepth?: number;
  maxChildren?: number;
}

const hash = (value: string) =>
  createHash("sha256").update(value).digest("hex");
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return `{${Object.keys(obj)
      .sort()
      .filter((k) => obj[k] !== undefined)
      .map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}
interface StoredReceipt extends DelegationReceipt {
  actorId: string;
  payloadHash: string;
  delegationAttemptAt?: number;
}

/** Only hashed capabilities and launch payload digests are stored: provider secrets
 * never enter this database. The user's browser token never goes to a Computer.
 * The host must give each Hub its own store.
 */
export class DelegationStore {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS delegation_grants(hash TEXT PRIMARY KEY, payload TEXT NOT NULL);
      CREATE INDEX IF NOT EXISTS delegation_grant_scope ON delegation_grants(json_extract(payload,'$.actorId'),json_extract(payload,'$.parentId'),json_extract(payload,'$.expiresAt'));
      CREATE TABLE IF NOT EXISTS delegation_receipts(
        actor_id TEXT NOT NULL,parent_id TEXT NOT NULL,request_id TEXT NOT NULL,
        child_id TEXT NOT NULL UNIQUE,payload TEXT NOT NULL,
        PRIMARY KEY(actor_id,parent_id,request_id));`);
  }
  issue(
    grant: DelegationGrant,
    parentGrant?: DelegationGrant,
    replace = false,
  ): string {
    const token = randomBytes(32).toString("base64url");
    this.db.exec("BEGIN IMMEDIATE");
    try {
      if (replace) this.eraseLineage(grant.actorId, grant.parentId);
      if (parentGrant) {
        const row = this.db
          .prepare(
            "SELECT payload FROM delegation_grants WHERE json_extract(payload,'$.id')=?",
          )
          .get(parentGrant.id) as { payload: string } | undefined;
        if (
          !row ||
          (JSON.parse(row.payload) as DelegationGrant).expiresAt <
            grant.expiresAt
        )
          throw new DomainError(
            403,
            "delegation_grant_invalid",
            "Parent delegation has been revoked or shortened",
          );
      }
      this.db
        .prepare("INSERT INTO delegation_grants VALUES(?,?)")
        .run(hash(token), JSON.stringify(grant));
      this.db.exec("COMMIT");
      return token;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  grant(token: string, now = Date.now()): DelegationGrant | null {
    const row = this.db
      .prepare("SELECT payload FROM delegation_grants WHERE hash=?")
      .get(hash(token)) as { payload: string } | undefined;
    if (!row) return null;
    const grant = JSON.parse(row.payload) as DelegationGrant;
    return grant.expiresAt > now ? grant : null;
  }
  revoke(token: string) {
    this.db
      .prepare("DELETE FROM delegation_grants WHERE hash=?")
      .run(hash(token));
  }
  reserve(
    actorId: string,
    parentId: string,
    input: DelegationSpawn,
    now = Date.now(),
    depth = 1,
    maxChildren = 32,
  ): DelegationReceipt {
    const payloadHash = hash(canonical(input));
    const receipt: StoredReceipt = {
      actorId,
      parentId,
      payloadHash,
      requestId: input.requestId,
      childId: randomUUID(),
      targetComputerId: input.targetComputerId,
      depth,
      state: "reserved",
      localId: null,
      createdAt: now,
      updatedAt: now,
    };
    this.db.exec("BEGIN IMMEDIATE");
    try {
      let stored = this.getStored(actorId, parentId, input.requestId);
      if (!stored) {
        const count = this.db
          .prepare(
            "SELECT COUNT(*) AS n FROM delegation_receipts WHERE parent_id=?",
          )
          .get(parentId) as { n: number };
        if (count.n >= maxChildren)
          throw new DomainError(
            409,
            "delegation_limit",
            "Parent has reached its delegated child limit",
          );
        this.db
          .prepare("INSERT INTO delegation_receipts VALUES(?,?,?,?,?)")
          .run(
            actorId,
            parentId,
            input.requestId,
            receipt.childId,
            JSON.stringify(receipt),
          );
        stored = receipt;
      }
      if (stored.payloadHash !== payloadHash)
        throw new DomainError(
          409,
          "request_conflict",
          "Delegation requestId was already used for a different request",
        );
      this.db.exec("COMMIT");
      return publicReceipt(stored);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  parentDepth(parentId: string): number {
    const row = this.db
      .prepare("SELECT payload FROM delegation_receipts WHERE child_id=?")
      .get(parentId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as StoredReceipt).depth : 0;
  }
  private getStored(
    actorId: string,
    parentId: string,
    requestId: string,
  ): StoredReceipt | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM delegation_receipts WHERE actor_id=? AND parent_id=? AND request_id=?",
      )
      .get(actorId, parentId, requestId) as { payload: string } | undefined;
    return row ? (JSON.parse(row.payload) as StoredReceipt) : null;
  }
  child(
    actorId: string,
    parentId: string,
    childId: string,
  ): DelegationReceipt | null {
    const row = this.db
      .prepare(
        "SELECT payload FROM delegation_receipts WHERE actor_id=? AND parent_id=? AND child_id=?",
      )
      .get(actorId, parentId, childId) as { payload: string } | undefined;
    return row ? publicReceipt(JSON.parse(row.payload) as StoredReceipt) : null;
  }
  list(actorId: string, parentId: string): DelegationReceipt[] {
    return (
      this.db
        .prepare(
          "SELECT payload FROM delegation_receipts WHERE actor_id=? AND parent_id=? ORDER BY rowid",
        )
        .all(actorId, parentId) as { payload: string }[]
    ).map((row) => publicReceipt(JSON.parse(row.payload) as StoredReceipt));
  }
  /** CAS under SQLite's write lock: only one process can claim a reserved launch. */
  claim(
    actorId: string,
    receipt: DelegationReceipt,
    now = Date.now(),
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.getStored(
        actorId,
        receipt.parentId,
        receipt.requestId,
      );
      if (!stored || stored.state !== "reserved") {
        this.db.exec("COMMIT");
        return false;
      }
      stored.state = "dispatching";
      stored.updatedAt = now;
      this.write(stored);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  settle(
    actorId: string,
    receipt: DelegationReceipt,
    outcome: DelegationOutcome,
    now = Date.now(),
  ): DelegationReceipt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.getStored(
        actorId,
        receipt.parentId,
        receipt.requestId,
      );
      if (!stored)
        throw new DomainError(404, "not_found", "Delegated child not found");
      // Late reconciliation must not erase a terminal launch result.
      if (stored.state !== "ready" && stored.state !== "failed") {
        stored.state = outcome.state;
        stored.updatedAt = now;
        stored.localId = outcome.state === "ready" ? outcome.localId : null;
        if (outcome.state === "failed")
          stored.error = outcome.error.slice(0, 1000);
        this.write(stored);
      }
      this.db.exec("COMMIT");
      return publicReceipt(stored);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  markInstalled(token: string, now = Date.now()) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const grant = this.grant(token, now);
      if (!grant)
        throw new DomainError(
          403,
          "delegation_grant_invalid",
          "Delegation expired or was revoked before tool confirmation",
        );
      grant.installedAt = now;
      const changed = this.db
        .prepare("UPDATE delegation_grants SET payload=? WHERE hash=?")
        .run(JSON.stringify(grant), hash(token));
      if (changed.changes !== 1)
        throw new DomainError(
          403,
          "delegation_grant_invalid",
          "Delegation was revoked during tool confirmation",
        );
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  currentGrant(
    actorId: string,
    parentId: string,
    now = Date.now(),
  ): (DelegationGrant & { tokenHash: string }) | null {
    const row = this.db
      .prepare(
        "SELECT hash,payload FROM delegation_grants WHERE json_extract(payload,'$.actorId')=? AND json_extract(payload,'$.parentId')=? AND json_extract(payload,'$.expiresAt')>? AND json_extract(payload,'$.installedAt') IS NOT NULL ORDER BY rowid DESC LIMIT 1",
      )
      .get(actorId, parentId, now) as
      { hash: string; payload: string } | undefined;
    return row
      ? { ...(JSON.parse(row.payload) as DelegationGrant), tokenHash: row.hash }
      : null;
  }
  revokeLineage(actorId: string, parentId: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      this.eraseLineage(actorId, parentId);
      this.db.exec("COMMIT");
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private eraseLineage(actorId: string, parentId: string) {
    // Fixed batches bound memory independently of the Hub's grant history.
    for (;;) {
      const rows = this.db
        .prepare(
          "SELECT hash,payload FROM delegation_grants WHERE json_extract(payload,'$.actorId')=? AND (json_extract(payload,'$.parentId')=? OR EXISTS(SELECT 1 FROM json_each(payload,'$.ancestorParentIds') WHERE value=?)) LIMIT 64",
        )
        .all(actorId, parentId, parentId) as {
        hash: string;
        payload: string;
      }[];
      if (!rows.length) return;
      for (const row of rows) {
        const grant = JSON.parse(row.payload) as DelegationGrant;
        this.db
          .prepare("DELETE FROM delegation_grants WHERE hash=?")
          .run(row.hash);
        const receipt = this.db
          .prepare(
            "SELECT payload FROM delegation_receipts WHERE actor_id=? AND child_id=?",
          )
          .get(actorId, grant.parentId) as { payload: string } | undefined;
        if (receipt) {
          const stored = JSON.parse(receipt.payload) as StoredReceipt;
          stored.delegationState = "unavailable";
          stored.delegationError = "Inherited delegation grant was revoked";
          this.write(stored);
        }
      }
    }
  }
  claimInstallation(
    actorId: string,
    receipt: DelegationReceipt,
    now = Date.now(),
  ): boolean {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.getStored(
        actorId,
        receipt.parentId,
        receipt.requestId,
      );
      if (
        !stored ||
        stored.state !== "ready" ||
        stored.delegationState === "installed" ||
        (stored.delegationState === "pending" &&
          (stored.delegationAttemptAt ?? now) > now - 45_000)
      ) {
        this.db.exec("COMMIT");
        return false;
      }
      stored.delegationState = "pending";
      stored.delegationAttemptAt = now;
      this.write(stored);
      this.db.exec("COMMIT");
      return true;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  installation(
    actorId: string,
    receipt: DelegationReceipt,
    state: "installed" | "unavailable" | "unknown",
    error?: string,
    now = Date.now(),
  ): DelegationReceipt {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const stored = this.getStored(
        actorId,
        receipt.parentId,
        receipt.requestId,
      );
      if (!stored)
        throw new DomainError(404, "not_found", "Delegated child not found");
      stored.delegationState = state;
      stored.updatedAt = now;
      if (error) stored.delegationError = error.slice(0, 1000);
      else delete stored.delegationError;
      this.write(stored);
      this.db.exec("COMMIT");
      return publicReceipt(stored);
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  private write(receipt: StoredReceipt) {
    this.db
      .prepare(
        "UPDATE delegation_receipts SET payload=? WHERE actor_id=? AND parent_id=? AND request_id=?",
      )
      .run(
        JSON.stringify(receipt),
        receipt.actorId,
        receipt.parentId,
        receipt.requestId,
      );
  }
  close() {
    this.db.close();
  }
}
function publicReceipt(receipt: StoredReceipt): DelegationReceipt {
  const {
    actorId: _actor,
    payloadHash: _hash,
    delegationAttemptAt: _attempt,
    ...value
  } = receipt;
  return value;
}
/** Return newest conversation entries within the source client's response cap.
 * Clipping is explicit and applies to JSON bytes, including escaped text.
 */
function boundedMessages(value: unknown) {
  const source = z
    .object({ messages: z.array(Message), truncated: z.boolean().optional() })
    .parse(value);
  const messages = source.messages;
  const selected: z.infer<typeof Message>[] = [];
  let budget = 256 * 1024 - 128;
  let truncated = source.truncated === true || messages.length > 512;
  for (
    let index = messages.length - 1;
    index >= 0 && selected.length < 512;
    index--
  ) {
    const native = messages[index]!;
    const message = { ...native, id: native.id.slice(0, 200) };
    if (message.id !== native.id) truncated = true;
    let bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
    if (bytes > budget) {
      let low = 0,
        high = message.text.length;
      while (low < high) {
        const mid = Math.ceil((low + high) / 2);
        if (
          Buffer.byteLength(
            JSON.stringify({ ...message, text: message.text.slice(0, mid) }),
          ) +
            1 <=
          budget
        )
          low = mid;
        else high = mid - 1;
      }
      message.text = message.text.slice(0, low);
      bytes = Buffer.byteLength(JSON.stringify(message)) + 1;
      truncated = true;
      if (bytes > budget) break;
      selected.push(message);
      budget -= bytes;
      break;
    }
    selected.push(message);
    budget -= bytes;
    if (index > 0 && budget < 512) {
      truncated = true;
      break;
    }
  }
  return { messages: selected.reverse(), truncated };
}
function sameHub(
  ctx: DelegationContext,
  hubId: string,
  parentId: string,
  targetId: string,
) {
  if (
    ctx.parent.id !== parentId ||
    ctx.parent.hubId !== hubId ||
    ctx.target.hubId !== hubId ||
    ctx.target.id !== targetId
  )
    throw new DomainError(
      403,
      "delegation_scope",
      "Delegation requires an authorized parent and target in this Hub",
    );
}

export function registerDelegationRoutes(
  app: FastifyInstance,
  deps: DelegationDependencies,
) {
  const now = deps.now ?? Date.now;
  const maxDepth = z
    .number()
    .int()
    .min(1)
    .max(16)
    .parse(deps.maxDepth ?? 4);
  const maxChildren = z
    .number()
    .int()
    .min(1)
    .max(128)
    .parse(deps.maxChildren ?? 32);
  app.post("/api/agents/:id/delegation-grants", async (request) => {
    const parentId = Id.parse((request.params as { id: string }).id);
    const input = DelegationGrantRequest.parse(request.body);
    const depth = deps.store.parentDepth(parentId);
    const targets = [...new Set(input.targetComputerIds)];
    let grant: DelegationGrant | undefined;
    let installContext: DelegationContext | undefined;
    for (const targetId of targets) {
      const ctx = await deps.authorizeUser(request, parentId, targetId);
      sameHub(ctx, deps.hubId, parentId, targetId);
      if (
        grant &&
        (grant.actorId !== ctx.actorId ||
          grant.identitySessionId !== ctx.identitySessionId ||
          grant.sourceComputerId !== ctx.parent.computerId ||
          grant.sourceBinding !== ctx.sourceBinding)
      )
        throw new DomainError(
          403,
          "delegation_scope",
          "Delegation authorization changed while issuing the grant",
        );
      grant = {
        id: randomUUID(),
        actorId: ctx.actorId,
        identitySessionId: ctx.identitySessionId,
        parentId,
        hubId: deps.hubId,
        depth,
        ancestorParentIds: [parentId],
        sourceComputerId: ctx.parent.computerId,
        sourceBinding: ctx.sourceBinding,
        targetComputerIds: targets,
        expiresAt: now() + input.ttlSeconds * 1000,
      };
      installContext = ctx;
    }
    if (depth >= maxDepth)
      throw new DomainError(
        409,
        "delegation_limit",
        "Parent has reached the maximum delegation depth",
      );
    if (!deps.installGrant || !installContext?.parent.localId)
      throw new DomainError(
        409,
        "capability_required",
        "The parent Computer cannot install a delegation tool for this session",
      );
    const token = deps.store.issue(grant!, undefined, true);
    try {
      await deps.installGrant(installContext, {
        parentId,
        localId: installContext.parent.localId,
        grant: token,
        expiresAt: grant!.expiresAt,
      });
      deps.store.markInstalled(token, now());
    } catch (error) {
      deps.store.revoke(token);
      if (
        error instanceof DomainError &&
        ["capability_required", "setup_required", "not_dispatched"].includes(
          error.code,
        )
      )
        throw new DomainError(
          error.status,
          error.code,
          error.message.split(token).join("[redacted]"),
        );
      throw new DomainError(
        503,
        "delegation_install_unknown",
        "Tool installation was not confirmed; its delegation grant has been revoked",
      );
    }
    return {
      installed: true,
      authorized: true,
      expiresAt: grant!.expiresAt,
      parentId,
      sourceComputerId: grant!.sourceComputerId,
      targetComputerIds: targets,
    };
  });
  async function userParent(request: FastifyRequest) {
    if (!deps.authorizeParent)
      throw new DomainError(
        409,
        "capability_required",
        "Delegation management is unavailable on this Hub",
      );
    const parentId = Id.parse((request.params as { id: string }).id);
    const context = await deps.authorizeParent(request, parentId);
    if (context.parent.id !== parentId || context.parent.hubId !== deps.hubId)
      throw new DomainError(
        403,
        "delegation_scope",
        "Parent belongs to another Hub",
      );
    return context;
  }
  app.get("/api/agents/:id/delegation-grants", async (request) => {
    const parent = await userParent(request);
    const grant = deps.store.currentGrant(
      parent.actorId,
      parent.parent.id,
      now(),
    );
    if (!grant) return { installed: false, authorized: false };
    let installed = false;
    let authorized = false;
    let authorizationUnknown = false;
    let connectionUnknown = false;
    const allowedTargets: string[] = [];
    for (const target of grant.targetComputerIds) {
      try {
        await authorize(grant, target, "create");
        allowedTargets.push(target);
      } catch (error) {
        if (!(error instanceof DomainError) || error.status >= 500)
          authorizationUnknown = true;
      }
    }
    authorized =
      allowedTargets.length > 0 &&
      grant.sourceBinding === parent.sourceBinding &&
      grant.sourceComputerId === parent.parent.computerId;
    try {
      if (authorized && deps.checkInstallation) {
        const current = await deps.checkInstallation(parent);
        installed =
          current.installed &&
          current.expiresAt === grant.expiresAt &&
          current.grantDigest === grant.tokenHash;
      }
    } catch {
      connectionUnknown = true;
    }
    return {
      installed,
      authorized,
      authorizationUnknown,
      connectionUnknown,
      expiresAt: grant.expiresAt,
      targetComputerIds: allowedTargets,
      parentId: grant.parentId,
      sourceComputerId: grant.sourceComputerId,
      confirmedAt: grant.installedAt,
    };
  });
  app.delete("/api/agents/:id/delegation-grants", async (request) => {
    const parent = await userParent(request);
    deps.store.revokeLineage(parent.actorId, parent.parent.id);
    // Hash revocation is authoritative even if the Computer is offline.
    await deps.revokeInstallation?.(parent).catch(() => {});
    return { installed: false, authorized: false, revoked: true };
  });

  const base = "/connect/v1/computers/:computerId/agents/:parentId/delegations";
  async function authenticate(
    request: FastifyRequest,
  ): Promise<DelegationGrant> {
    const params = z
      .object({ computerId: Id, parentId: Id })
      .parse(request.params);
    const machine = await deps.authenticateComputer(request, params.computerId);
    const value = request.headers["x-codoxear-delegation-grant"];
    const grant =
      typeof value === "string" && value.length <= 200
        ? deps.store.grant(value, now())
        : null;
    if (
      !grant ||
      grant.hubId !== deps.hubId ||
      machine.hubId !== deps.hubId ||
      machine.computerId !== params.computerId ||
      grant.sourceComputerId !== machine.computerId ||
      grant.sourceBinding !== machine.binding ||
      grant.parentId !== params.parentId
    )
      throw new DomainError(
        403,
        "delegation_grant_invalid",
        "A current parent-scoped delegation grant is required",
      );
    return grant;
  }
  async function authorize(
    grant: DelegationGrant,
    targetId: string,
    action: "create" | "read" | "send" | "interrupt",
    childId?: string,
  ) {
    if (!grant.targetComputerIds.includes(targetId))
      throw new DomainError(
        403,
        "delegation_scope",
        "Target Computer is outside this delegation grant",
      );
    const ctx = await deps.authorizeGrant(grant, targetId, action, childId);
    sameHub(ctx, deps.hubId, grant.parentId, targetId);
    if (
      ctx.actorId !== grant.actorId ||
      ctx.identitySessionId !== grant.identitySessionId ||
      ctx.parent.computerId !== grant.sourceComputerId ||
      ctx.sourceBinding !== grant.sourceBinding
    )
      throw new DomainError(
        403,
        "delegation_scope",
        "Delegation principal or source binding changed",
      );
    return ctx;
  }
  async function child(
    request: FastifyRequest,
    action: "read" | "send" | "interrupt",
  ) {
    const grant = await authenticate(request);
    const childId = Id.parse((request.params as { childId: string }).childId);
    const receipt = deps.store.child(grant.actorId, grant.parentId, childId);
    if (!receipt)
      throw new DomainError(404, "not_found", "Delegated child not found");
    const ctx = await authorize(
      grant,
      receipt.targetComputerId,
      action,
      childId,
    );
    return { grant, receipt, ctx };
  }
  async function inherit(
    grant: DelegationGrant,
    receipt: DelegationReceipt,
  ): Promise<DelegationReceipt> {
    if (receipt.state !== "ready" || !receipt.localId) return receipt;
    if (!deps.store.claimInstallation(grant.actorId, receipt, now()))
      return deps.store.child(
        grant.actorId,
        receipt.parentId,
        receipt.childId,
      )!;
    if (receipt.depth >= maxDepth || !deps.installGrant || !deps.childContext)
      return deps.store.installation(
        grant.actorId,
        receipt,
        "unavailable",
        receipt.depth >= maxDepth
          ? "Maximum delegation depth reached"
          : "Child delegation tool installation is unavailable",
        now(),
      );
    let token: string | undefined;
    try {
      if (grant.expiresAt <= now())
        throw new DomainError(
          403,
          "delegation_grant_invalid",
          "Parent delegation expired",
        );
      await authorize(grant, receipt.targetComputerId, "read", receipt.childId);
      const targets: string[] = [];
      let installContext: DelegationContext | undefined;
      for (const targetId of grant.targetComputerIds) {
        try {
          const context = await deps.childContext(
            grant,
            receipt.childId,
            targetId,
          );
          sameHub(context, deps.hubId, receipt.childId, targetId);
          if (
            context.actorId !== grant.actorId ||
            context.identitySessionId !== grant.identitySessionId ||
            context.parent.computerId !== receipt.targetComputerId ||
            context.parent.localId !== receipt.localId
          )
            throw new DomainError(
              403,
              "delegation_scope",
              "Inherited delegation source does not match the confirmed child",
            );
          targets.push(targetId);
          installContext = context;
        } catch (error) {
          if (error instanceof DomainError && [403, 404].includes(error.status))
            continue;
          throw error;
        }
      }
      if (!installContext || !targets.length)
        return deps.store.installation(
          grant.actorId,
          receipt,
          "unavailable",
          "No inherited targets retain creation permission",
          now(),
        );
      const inherited: DelegationGrant = {
        id: randomUUID(),
        actorId: grant.actorId,
        identitySessionId: grant.identitySessionId,
        parentId: receipt.childId,
        hubId: deps.hubId,
        sourceComputerId: receipt.targetComputerId,
        sourceBinding: installContext.sourceBinding,
        targetComputerIds: targets,
        depth: receipt.depth,
        expiresAt: grant.expiresAt,
        ancestorParentIds: [
          ...(grant.ancestorParentIds ?? [grant.parentId]),
          receipt.childId,
        ],
      };
      // The parent grant existence test and child grant insertion share one
      // transaction, fencing a revoke that races an already-created child.
      token = deps.store.issue(inherited, grant);
      await deps.installGrant(installContext, {
        parentId: receipt.childId,
        localId: receipt.localId,
        grant: token,
        expiresAt: inherited.expiresAt,
      });
      deps.store.markInstalled(token, now());
      return deps.store.installation(
        grant.actorId,
        receipt,
        "installed",
        undefined,
        now(),
      );
    } catch (error) {
      if (token) deps.store.revoke(token);
      const detail =
        error instanceof DomainError
          ? error.message
          : "Child tool installation was not confirmed";
      const state =
        error instanceof DomainError &&
        ["capability_required", "setup_required"].includes(error.code)
          ? "unavailable"
          : "unknown";
      return deps.store.installation(
        grant.actorId,
        receipt,
        state,
        token ? detail.split(token).join("[redacted]") : detail,
        now(),
      );
    }
  }
  async function reconcile(
    grant: DelegationGrant,
    ctx: DelegationContext,
    receipt: DelegationReceipt,
  ) {
    if (receipt.state === "dispatching" || receipt.state === "unknown") {
      let outcome: DelegationOutcome;
      try {
        outcome = await deps.reconcile(ctx, receipt);
      } catch {
        outcome = { state: "unknown" };
      }
      return inherit(
        grant,
        deps.store.settle(grant.actorId, receipt, outcome, now()),
      );
    }
    return inherit(grant, receipt);
  }
  app.post(base, async (request) => {
    const grant = await authenticate(request);
    const input = DelegationSpawn.parse(request.body);
    const ctx = await authorize(grant, input.targetComputerId, "create");
    if (grant.depth >= maxDepth)
      throw new DomainError(
        409,
        "delegation_limit",
        "Parent has reached the maximum delegation depth",
      );
    let receipt = deps.store.reserve(
      grant.actorId,
      grant.parentId,
      input,
      now(),
      grant.depth + 1,
      maxChildren,
    );
    if (!deps.store.claim(grant.actorId, receipt, now())) {
      receipt = deps.store.child(
        grant.actorId,
        grant.parentId,
        receipt.childId,
      )!;
      return reconcile(grant, ctx, receipt);
    }
    // The durable dispatch marker precedes authority creation and remote dispatch.
    // A crash on either side leaves uncertainty: a retry can only inspect receipts.
    let outcome: DelegationOutcome;
    try {
      outcome = await deps.launch(ctx, {
        ...input,
        agentId: receipt.childId,
        depth: receipt.depth,
        delegationRequired: input.backend === "pi" && receipt.depth < maxDepth,
      });
    } catch {
      outcome = { state: "unknown" };
    }
    receipt = deps.store.settle(grant.actorId, receipt, outcome, now());
    return inherit(grant, receipt);
  });
  app.get(base + "/targets", async (request) => {
    const grant = await authenticate(request);
    const computers: Array<{ id: string; name: string }> = [];
    for (const targetId of grant.targetComputerIds) {
      try {
        const context = await authorize(grant, targetId, "create");
        computers.push({
          id: context.target.id,
          name: context.target.name ?? context.target.id,
        });
      } catch (error) {
        if (
          !(error instanceof DomainError) ||
          ![403, 404].includes(error.status)
        )
          throw error;
      }
    }
    return { computers };
  });
  app.get(base, async (request) => {
    const grant = await authenticate(request);
    const receipts = deps.store
      .list(grant.actorId, grant.parentId)
      .filter((receipt) =>
        grant.targetComputerIds.includes(receipt.targetComputerId),
      );
    // Recheck even an empty list; an expired parent authority is not a list grant.
    if (!receipts.length)
      await authorize(grant, grant.targetComputerIds[0]!, "read");
    for (const receipt of receipts)
      await authorize(grant, receipt.targetComputerId, "read", receipt.childId);
    return { children: receipts };
  });
  app.get(base + "/:childId", async (request) => {
    const { grant, ctx, receipt } = await child(request, "read");
    return reconcile(grant, ctx, receipt);
  });
  app.get(base + "/:childId/messages", async (request) => {
    const { grant, ctx, receipt } = await child(request, "read");
    if (!deps.readMessages)
      throw new DomainError(
        409,
        "capability_required",
        "Delegated conversation reading is unavailable",
      );
    if (receipt.state !== "ready" || !receipt.localId)
      return { messages: [], truncated: false };
    const result = await deps.readMessages(ctx, receipt);
    await authorize(grant, receipt.targetComputerId, "read", receipt.childId);
    return boundedMessages(result);
  });
  for (const action of ["send", "interrupt"] as const) {
    app.post(base + "/:childId/" + action, async (request) => {
      let text: string | undefined;
      if (action === "send") text = DelegationSend.parse(request.body).text;
      else
        z.object({})
          .strict()
          .parse(request.body ?? {});
      const { ctx, receipt } = await child(request, action);
      if (!deps.control)
        throw new DomainError(
          409,
          "capability_required",
          "Delegated child controls are unavailable on this Hub",
        );
      if (receipt.state !== "ready" || !receipt.localId)
        throw new DomainError(
          409,
          "child_not_ready",
          "Delegated child has no confirmed native launch",
        );
      return deps.control(ctx, receipt, {
        action,
        ...(text === undefined ? {} : { text }),
      });
    });
  }
}
