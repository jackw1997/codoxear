import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, resolve, join, basename, extname } from "node:path";
import { Launch, type Operation } from "../../contracts/tunnel.js";
import { DomainError } from "../../contracts/model.js";
import type { Runtime, WorkspaceRuntime } from "../runtime.js";
import type { Notification } from "../../protocol/notifications.js";
import { WorkspaceRegistry } from "../native/workspace/registry.js";
import {
  ManagedSetupError,
  type ManagedFactory,
  type ManagedSession,
  type ManagedRecord,
  type ManagedBackend,
  type ManagedOpen,
} from "./driver.js";
import { OarFactory } from "./factory.js";
import { readLaunchDefaults } from "../native/launch-defaults.js";
import { readUnattendedPrompt } from "../native/workspace/unattended.js";
import { NativeSidebar } from "../native/workspace/sidebar.js";
import { openFile } from "../native/workspace/files.js";
import type { Attachment } from "../native/types.js";

type Unattended = {
  enabled: boolean; request: string; cooldown_minutes: number;
  remaining_injections: number; last_injection: number; commit_unknown: string | null;
};

type LaunchOptions = ReturnType<typeof Launch.parse>;
type Row = {
  id: string;
  agent: string;
  backend: ManagedBackend;
  name: string;
  cwd: string;
  native_id: string | null;
  model: string | null;
  effort: string | null;
  state: string;
  updated: number;
  created: number;
  reentry: number;
  stream: string | null;
  profile: string | null;
};
type Resident = {
  session: ManagedSession;
  stream: string;
  unsubscribe: () => void;
  unsubscribeExit: () => void;
  touched: number;
  count: number;
  bytes: number;
  closing: boolean;
  disposal?: Promise<void>;
  receipt: string | null;
  answer: string | null;
};
export interface ManagedRuntimeOptions {
  delegation?: import("../delegation/bridge.js").DelegationBridge;
  databasePath: string;
  home: string;
  workspace: string;
  stateHome?: string;
  factory?: ManagedFactory;
  permissionPolicy?: "locally-trusted";
  legacy?: WorkspaceRuntime;
  maxResident?: number;
  idleMs?: number;
  maxEvents?: number;
  maxEventBytes?: number;
  maxRecordBytes?: number;
  maxTranscriptBytes?: number;
  now?: () => number;
}

/** Computer-owned durable lifecycle. Native resume is conversation continuation,
 * never PID adoption or automatic replay of an uncertain prompt/tool operation. */
export class ManagedRuntime implements Runtime {
  readonly kind = "oar" as const;
  readonly home: string;
  readonly workspace: string;
  readonly stateHome: string;
  private readonly db: DatabaseSync;
  private readonly factory: ManagedFactory;
  private readonly residents = new Map<string, Resident>();
  private readonly launchMemory = new Map<string, LaunchOptions>();
  private readonly locks = new Map<string, Promise<unknown>>();
  private admission: Promise<unknown> = Promise.resolve();
  private readonly timer: ReturnType<typeof setInterval>;
  private closed = false;
  private closePromise: Promise<void> | undefined;
  private unattendedBlocker: (id: string) => boolean = () => false;
  private readonly sidebar: NativeSidebar;
  private readonly now: () => number;
  private readonly maxResident: number;
  private readonly idleMs: number;
  private readonly maxEvents: number;
  private readonly maxEventBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxTranscriptBytes: number;
  constructor(private readonly options: ManagedRuntimeOptions) {
    for (const path of [
      options.home,
      options.workspace,
      options.databasePath,
      options.stateHome ?? options.home,
    ])
      if (!isAbsolute(path))
        throw Error("Managed runtime paths must be absolute");
    this.home = options.home;
    this.workspace = resolve(options.workspace);
    this.stateHome = options.stateHome ?? options.home;
    this.now = options.now ?? Date.now;
    this.maxResident = positive(options.maxResident ?? 2, "maxResident");
    this.idleMs = positive(options.idleMs ?? 60_000, "idleMs");
    this.maxEvents = positive(options.maxEvents ?? 10_000, "maxEvents");
    this.maxEventBytes = positive(
      options.maxEventBytes ?? 16 * 1024 * 1024,
      "maxEventBytes",
    );
    this.maxRecordBytes = positive(
      options.maxRecordBytes ?? 1024 * 1024,
      "maxRecordBytes",
    );
    this.maxTranscriptBytes = positive(
      options.maxTranscriptBytes ?? 1024 * 1024,
      "maxTranscriptBytes",
    );
    mkdirSync(dirname(options.databasePath), { recursive: true, mode: 0o700 });
    const sidebarDirectory = join(this.stateHome, "managed-sidebar");
    mkdirSync(sidebarDirectory, { recursive: true, mode: 0o700 });
    this.sidebar = new NativeSidebar(sidebarDirectory);
    this.db = new DatabaseSync(options.databasePath);
    this.db.function("managed_casefold", { deterministic: true }, (value) =>
      String(value ?? "").toLowerCase(),
    );
    chmodSync(options.databasePath, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS managed_sessions(id TEXT PRIMARY KEY,agent TEXT UNIQUE,backend TEXT,name TEXT,cwd TEXT,native_id TEXT,model TEXT,effort TEXT,state TEXT,created INTEGER,updated INTEGER,reentry INTEGER,stream TEXT,profile TEXT);
      CREATE TABLE IF NOT EXISTS managed_streams(id TEXT PRIMARY KEY,local_id TEXT,created INTEGER,ended INTEGER,gap TEXT);
      CREATE TABLE IF NOT EXISTS managed_events(stream TEXT,seq INTEGER,native_id TEXT,body TEXT,bytes INTEGER,PRIMARY KEY(stream,seq));
      CREATE TABLE IF NOT EXISTS managed_messages(id TEXT PRIMARY KEY,local_id TEXT,role TEXT,text TEXT,at INTEGER,receipt TEXT);
      CREATE INDEX IF NOT EXISTS managed_message_order ON managed_messages(local_id,at);
      CREATE TABLE IF NOT EXISTS managed_receipts(id TEXT PRIMARY KEY,local_id TEXT,kind TEXT,state TEXT,result TEXT,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS managed_notifications(id TEXT PRIMARY KEY,local_id TEXT,kind TEXT,at INTEGER);
      CREATE TABLE IF NOT EXISTS managed_unattended(local_id TEXT PRIMARY KEY,settings TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS managed_read(local_id TEXT,actor_id TEXT,event_id TEXT,PRIMARY KEY(local_id,actor_id));
      CREATE TABLE IF NOT EXISTS managed_capabilities(local_id TEXT PRIMARY KEY,images INTEGER,steer INTEGER);
      CREATE TABLE IF NOT EXISTS managed_attachments(id TEXT PRIMARY KEY,local_id TEXT,actor_id TEXT,payload TEXT);
      UPDATE managed_sessions SET state='unknown' WHERE state IN ('opening','running');
      UPDATE managed_receipts SET state='unknown' WHERE state IN ('dispatching','accepted');`);
    this.factory = options.factory ?? new OarFactory();
    for (const entry of this.db.prepare("SELECT local_id,settings FROM managed_unattended").all() as { local_id: string; settings: string }[]) {
      const settings = JSON.parse(entry.settings) as Unattended;
      if (settings.commit_unknown) {
        settings.enabled = false;
        this.saveUnattended(entry.local_id, settings);
      }
    }
    this.timer = setInterval(
      () => {
        void this.quiesceIdle().catch(() => {});
        void this.runUnattended().catch(() => {});
      },
      Math.min(this.idleMs, 10_000),
    );
    this.timer.unref();
  }
  async supportsProviderLaunch(): Promise<boolean> {
    return true;
  }
  setQueueScope(scope: string) {
    this.options.legacy?.setQueueScope?.(scope);
  }
  setUnattendedBlocker(blocker: (localId: string) => boolean) {
    this.unattendedBlocker = blocker;
  }
  private unattended(id: string): Unattended {
    const row = this.db.prepare("SELECT settings FROM managed_unattended WHERE local_id=?").get(id) as { settings: string } | undefined;
    return row ? JSON.parse(row.settings) : {
      enabled: false, request: "", cooldown_minutes: 5, remaining_injections: 10,
      last_injection: 0, commit_unknown: null,
    };
  }
  private saveUnattended(id: string, settings: Unattended) {
    this.db.prepare("INSERT INTO managed_unattended VALUES(?,?) ON CONFLICT(local_id) DO UPDATE SET settings=excluded.settings").run(id, JSON.stringify(settings));
  }
  private attachments(id: string, actorId = "") {
    return (this.db.prepare("SELECT payload FROM managed_attachments WHERE local_id=? AND actor_id=? ORDER BY rowid").all(id, actorId) as { payload: string }[]).map((entry) => JSON.parse(entry.payload) as Attachment);
  }
  private attachmentState(id: string, actorId = "") {
    const attachments = this.attachments(id, actorId);
    return { attachments, staged_attachments: attachments, pending_attachment: attachments.length > 0, actor_attachments: true };
  }
  private async configureUnattended(id: string, body: Record<string, unknown>) {
    return this.serial(id, async () => {
      this.row(id);
      const current = this.unattended(id);
      if (body.review_attempt !== undefined) {
        if (!current.commit_unknown || body.review_attempt !== current.commit_unknown)
          throw new DomainError(409, "unattended_review_changed", "Reload unattended settings before reviewing this attempt");
        current.commit_unknown = null;
      }
      if (current.commit_unknown && body.enabled === true)
        throw new DomainError(409, "unattended_commit_unknown", "Check the transcript and review the previous unattended attempt before enabling again");
      const next = {
        ...current,
        enabled: body.enabled === undefined ? current.enabled : body.enabled === true,
        request: String(body.request ?? current.request),
        cooldown_minutes: Math.max(1, Math.trunc(Number(body.cooldown_minutes ?? current.cooldown_minutes))),
        remaining_injections: Math.max(0, Math.trunc(Number(body.remaining_injections ?? current.remaining_injections))),
      };
      if (!Number.isSafeInteger(next.cooldown_minutes) || !Number.isSafeInteger(next.remaining_injections) || next.request.length > 100_000)
        throw new DomainError(400, "invalid_unattended", "Unattended counts must be finite integers and the request at most 100000 characters");
      if (!next.remaining_injections) next.enabled = false;
      this.saveUnattended(id, next);
      return next;
    });
  }
  private unattendedReady(id: string, settings: Unattended) {
    if (!settings.enabled || !settings.remaining_injections || settings.commit_unknown || this.unattendedBlocker(id) || this.db.prepare("SELECT 1 FROM managed_attachments WHERE local_id=? LIMIT 1").get(id)) return false;
    if (!["idle", "archived"].includes(this.row(id).state)) return false;
    const last = this.db.prepare("SELECT role,receipt FROM managed_messages WHERE local_id=? ORDER BY at DESC,rowid DESC LIMIT 1").get(id) as { role: string; receipt: string } | undefined;
    if (last?.role !== "assistant") return false;
    const receipt = this.previousReceipt(last.receipt);
    if (receipt?.state !== "completed" || !receipt.result || JSON.parse(receipt.result).outcome?.kind !== "completed") return false;
    const cooldown = settings.cooldown_minutes * 60_000;
    return this.now() - receipt.updated >= cooldown && (!settings.last_injection || this.now() - settings.last_injection >= cooldown);
  }
  /** Existing unattended mode spends a durable bounded budget; it is not a
   * general execution scheduler. Ambiguous sends are never replayed. */
  async runUnattended() {
    if (this.closed) return;
    const rows = this.db.prepare("SELECT local_id FROM managed_unattended").all() as { local_id: string }[];
    for (const { local_id: id } of rows) {
      if (!this.unattendedReady(id, this.unattended(id))) continue;
      await this.serial(id, async () => {
        const prompt = await readUnattendedPrompt(this.stateHome);
        const settings = this.unattended(id);
        if (!this.unattendedReady(id, settings)) return;
        settings.commit_unknown = randomUUID();
        settings.last_injection = this.now();
        settings.remaining_injections--;
        if (!settings.remaining_injections) settings.enabled = false;
        this.saveUnattended(id, settings);
        try {
          await this.send(id, prompt + (settings.request ? "\n\n" + settings.request : ""), settings.commit_unknown);
          settings.commit_unknown = null;
        } catch {
          settings.enabled = false;
        }
        this.saveUnattended(id, settings);
      });
    }
  }
  private assertOpen() {
    if (this.closed)
      throw new DomainError(
        409,
        "runtime_offline",
        "Managed runtime is closed",
      );
  }
  private row(id: string): Row {
    const row = this.db
      .prepare("SELECT * FROM managed_sessions WHERE id=?")
      .get(id) as Row | undefined;
    if (!row)
      throw new DomainError(404, "not_found", "Unknown managed session");
    return row;
  }
  private serial<T>(id: string, action: () => Promise<T>): Promise<T> {
    this.assertOpen();
    const prior = this.locks.get(id) ?? Promise.resolve();
    const next = prior
      .catch(() => {})
      .then(() => {
        this.assertOpen();
        return action();
      });
    this.locks.set(id, next);
    void next
      .finally(() => {
        if (this.locks.get(id) === next) this.locks.delete(id);
      })
      .catch(() => {});
    return next;
  }
  private admit<T>(action: () => Promise<T>): Promise<T> {
    const next = this.admission.catch(() => {}).then(action);
    this.admission = next;
    return next;
  }
  private state(id: string, state: string) {
    this.db
      .prepare("UPDATE managed_sessions SET state=?,updated=? WHERE id=?")
      .run(state, this.now(), id);
  }
  private receipt(id: string, localId: string, kind: string) {
    this.db
      .prepare(
        "INSERT INTO managed_receipts VALUES(?,?,?,'dispatching',NULL,?,?)",
      )
      .run(id, localId, kind, this.now(), this.now());
  }
  private result(id: string, state: string, value: unknown) {
    this.db
      .prepare(
        "UPDATE managed_receipts SET state=?,result=?,updated=? WHERE id=?",
      )
      .run(state, JSON.stringify(value), this.now(), id);
  }
  private previousReceipt(id: string) {
    return this.db
      .prepare("SELECT * FROM managed_receipts WHERE id=?")
      .get(id) as
      | { local_id: string; kind: string; state: string; result: string | null; updated: number }
      | undefined;
  }
  private uncertain(): never {
    throw new DomainError(
      409,
      "runtime_uncertain",
      "Submission outcome is unknown. Inspect durable transcript/receipts before any explicit recovery; automatic replay is blocked.",
    );
  }
  async execute(operation: Operation): Promise<unknown> {
    return this.executeWithReceipt(operation, randomUUID());
  }
  /** Tunnel request id may be supplied for durable deduplication across reconnects. */
  async executeWithReceipt(
    operation: Operation,
    requestId: string,
  ): Promise<unknown> {
    this.assertOpen();
    if (
      operation.op === "delegation-install" ||
      operation.op === "delegation-status" ||
      operation.op === "delegation-revoke"
    ) {
      const parent = this.row(operation.localId);
      if (operation.op === "delegation-revoke")
        return this.options.delegation?.revoke(operation) ?? { revoked: true };
      if (operation.op === "delegation-status")
        return parent.backend === "pi" &&
          parent.agent === operation.parentId &&
          this.residents.has(operation.localId) &&
          !this.residents.get(operation.localId)!.closing
          ? (this.options.delegation?.status(operation) ?? { installed: false })
          : { installed: false };
      if (
        !this.options.delegation ||
        parent.backend !== "pi" ||
        parent.agent !== operation.parentId
      )
        throw new DomainError(
          409,
          "setup_required",
          "Delegation installation requires this Hub-owned managed Pi parent; existing terminal sessions need separately reviewed extension reload setup",
        );
      await this.open(operation.localId);
      return this.options.delegation.install(operation);
    }
    if (operation.op === "workspace")
      return new WorkspaceRegistry(this.stateHome, this.workspace).execute(
        operation,
      );
    if (operation.op === "discover") return this.discover();
    if (operation.op === "resume-candidates")
      return this.candidates(operation.backend, operation.cwd);
    if (operation.op === "launch-status")
      throw Error("Launch status belongs to the Computer launch journal");
    if (operation.op === "create")
      return this.serial("create", () => this.create(operation, requestId));
    const localId = operation.localId;
    if (localId.startsWith("broker-") && this.options.legacy)
      return this.options.legacy.execute(operation);
    if (operation.op === "messages") return this.messages(localId);
    if (operation.op === "interrupt") return this.interrupt(localId, requestId);
    return this.serial(localId, () =>
      this.send(localId, operation.text, requestId),
    );
  }
  private async create(
    operation: Extract<Operation, { op: "create" }>,
    requestId: string,
  ) {
    if (operation.backend === "fixture")
      throw new DomainError(
        400,
        "not_dispatched",
        "Fixture backend is disabled",
      );
    const launch = Launch.parse(operation.launch ?? {});
    const cwd = launch.cwd ?? this.workspace;
    if (!isAbsolute(cwd))
      throw new DomainError(
        400,
        "not_dispatched",
        "Working directory must be absolute",
      );
    if (launch.command || launch.worktree_branch)
      throw new DomainError(
        400,
        "not_dispatched",
        "Managed OAR sessions do not support custom commands or automatic worktree creation",
      );
    const oldReceipt = this.previousReceipt(requestId);
    if (oldReceipt) {
      if (
        oldReceipt.kind !== "create" ||
        this.row(oldReceipt.local_id).agent !== operation.agentId
      )
        throw new DomainError(
          409,
          "not_dispatched",
          "Request id belongs to a different operation",
        );
      if (oldReceipt.state === "ready" && oldReceipt.result)
        return JSON.parse(oldReceipt.result);
      if (oldReceipt.state === "unknown" || oldReceipt.state === "dispatching")
        this.uncertain();
      throw new DomainError(
        409,
        "setup_required",
        "Previous launch was refused. Correct setup and use a new request id.",
      );
    }
    const existing = this.db
      .prepare("SELECT * FROM managed_sessions WHERE agent=?")
      .get(operation.agentId) as Row | undefined;
    if (existing && existing.state !== "setup_required") {
      if (existing.state === "unknown") this.uncertain();
      return { localId: existing.id };
    }
    if (launch.resume_session_id) {
      const owner = this.db
        .prepare(
          "SELECT id FROM managed_sessions WHERE native_id=? AND backend=? AND id<>? LIMIT 1",
        )
        .get(launch.resume_session_id, operation.backend, existing?.id ?? "");
      if (owner)
        throw new DomainError(
          409,
          "not_dispatched",
          "This conversation already has a managed agent. Continue that saved agent instead of creating another controller",
        );
      const catalogue = this.options.legacy
        ? ((await this.options.legacy.execute({ op: "discover" })) as {
            sessions: Array<Record<string, unknown>>;
          })
        : undefined;
      const original = catalogue?.sessions.find(
        (row) =>
          row.thread_id === launch.resume_session_id &&
          row.agent_backend === operation.backend,
      );
      if (!original || original.readiness !== "exited")
        throw new DomainError(
          409,
          "not_dispatched",
          "Cold ownership of this native conversation is not proven. Continue the existing agent; running CLI/PID adoption is unsupported",
        );
    }
    const id = existing?.id ?? "managed-" + randomUUID().replaceAll("-", "");
    if (existing)
      this.db
        .prepare(
          "UPDATE managed_sessions SET state='opening',model=?,effort=?,reentry=?,updated=? WHERE id=?",
        )
        .run(
          launch.model ?? null,
          launch.reasoning_effort ?? null,
          sensitive(launch) ? 1 : 0,
          this.now(),
          id,
        );
    else
      this.db
        .prepare(
          "INSERT INTO managed_sessions VALUES(?,?,?,?,?,?,?,?,'opening',?,?,?,NULL,NULL)",
        )
        .run(
          id,
          operation.agentId,
          operation.backend,
          operation.name,
          resolve(cwd),
          launch.resume_session_id ?? null,
          launch.model ?? null,
          launch.reasoning_effort ?? null,
          this.now(),
          this.now(),
          sensitive(launch) ? 1 : 0,
        );
    this.launchMemory.set(id, launch);
    this.receipt(requestId, id, "create");
    try {
      await this.open(id);
      const value = { localId: id };
      this.result(requestId, "ready", value);
      return value;
    } catch (error) {
      this.launchMemory.delete(id);
      await this.options.delegation?.release(id);
      const setup =
        error instanceof ManagedSetupError ||
        (error instanceof DomainError &&
          ["setup_required", "not_dispatched"].includes(error.code));
      this.state(id, setup ? "setup_required" : "unknown");
      this.result(requestId, setup ? "rejected" : "unknown", {
        code: setup ? "setup_required" : "runtime_uncertain",
      });
      throw setup
        ? new DomainError(
            400,
            "setup_required",
            error instanceof Error ? error.message : "Runtime setup required",
          )
        : new DomainError(
            409,
            "runtime_uncertain",
            "Runtime launch outcome is unknown; inspect its receipt before retrying",
          );
    }
  }
  private async open(id: string): Promise<Resident> {
    const current = this.residents.get(id);
    if (current && !current.closing) return current;
    return this.admit(async () => {
      const again = this.residents.get(id);
      if (again && !again.closing) return again;
      const row = this.row(id);
      if (["unknown", "attention"].includes(row.state)) this.uncertain();
      const launch = this.launchMemory.get(id);
      if (row.reentry && !launch && !row.profile)
        throw new ManagedSetupError(
          "This session needs private launch configuration re-entry after Computer restart; saved secrets are not replayed.",
        );
      if (this.residents.size >= this.maxResident) {
        const idle = [...this.residents]
          .filter(
            ([key, value]) =>
              !value.closing &&
              !this.locks.has(key) &&
              this.row(key).state === "idle",
          )
          .sort((a, b) => a[1].touched - b[1].touched)[0];
        if (idle) await this.release(idle[0]);
        else
          throw new DomainError(
            409,
            "not_dispatched",
            "Managed runtime capacity is busy. Wait for an active session to finish.",
          );
      }
      const input: ManagedOpen = {
        ...(row.backend === "pi" && this.options.delegation
          ? { delegation: await this.options.delegation.prepare(id) }
          : {}),
        backend: row.backend,
        cwd: row.cwd,
        home: this.home,
        stateHome: this.stateHome,
        ...(row.profile ? { profile: row.profile } : {}),
        ...(row.model ? { model: row.model } : {}),
        ...(row.effort ? { effort: row.effort } : {}),
        ...(row.native_id ? { resume: row.native_id } : {}),
        ...(launch?.env_vars ? { env: launch.env_vars } : {}),
        ...(this.options.permissionPolicy
          ? { permissionPolicy: this.options.permissionPolicy }
          : {}),
        ...(launch ? { launch } : {}),
      };
      const session = await this.factory.open(input);
      this.db.prepare("INSERT INTO managed_capabilities VALUES(?,?,?) ON CONFLICT(local_id) DO UPDATE SET images=excluded.images,steer=excluded.steer").run(id, Number(session.capabilities?.images === true), Number(session.capabilities?.steer === true));
      if (this.closed) {
        await session.dispose();
        throw Error("Managed runtime closed during launch");
      }
      const stream = randomUUID();
      this.db
        .prepare("INSERT INTO managed_streams VALUES(?,?,?,NULL,NULL)")
        .run(stream, id, this.now());
      this.db
        .prepare(
          "UPDATE managed_sessions SET native_id=?,stream=?,profile=?,state='idle',updated=? WHERE id=?",
        )
        .run(
          session.id,
          stream,
          session.profile ?? row.profile,
          this.now(),
          id,
        );
      const resident: Resident = {
        session,
        stream,
        unsubscribe: () => {},
        unsubscribeExit: () => {},
        touched: this.now(),
        count: 0,
        bytes: 0,
        closing: false,
        receipt: null,
        answer: null,
      };
      this.residents.set(id, resident);
      resident.unsubscribeExit =
        session.onExit?.(() => {
          if (resident.closing) return;
          if (this.row(id).state === "running") {
            this.state(id, "unknown");
            if (resident.receipt)
              this.result(resident.receipt, "unknown", {
                reason: "Owned worker exited before native turn completion",
              });
          } else this.state(id, "archived");
          this.notify(id, "attention", stream + ":worker-exit");
          void this.release(id).catch(() => {});
        }) ?? (() => {});
      try {
        resident.unsubscribe = session.rawEvents(
          (record) => this.record(id, resident, record),
          { sessionId: session.id, afterSeq: -1 },
        );
      } catch (error) {
        await this.release(id);
        throw error;
      }
      return resident;
    });
  }
  private record(id: string, resident: Resident, record: ManagedRecord) {
    if (this.closed && !this.closePromise) return;
    try {
      const json = JSON.stringify(record);
      const bytes = Buffer.byteLength(json);
      resident.touched = this.now();
      resident.count++;
      resident.bytes += bytes;
      if (
        bytes > this.maxRecordBytes ||
        resident.count > this.maxEvents ||
        resident.bytes > this.maxEventBytes
      ) {
        this.limit(
          id,
          resident,
          "Record retention limit reached; the stream has an explicit evidence gap",
        );
        return;
      }
      this.db
        .prepare("INSERT OR IGNORE INTO managed_events VALUES(?,?,?,?,?)")
        .run(resident.stream, record.seq, record.sessionId, json, bytes);
      if (record.kind === "request" && record.direction === "toApp") {
        this.limit(
          id,
          resident,
          "Runtime interaction requires an unsupported approval/user-input reply",
        );
        return;
      }
      if (
        record.kind === "response" &&
        record.body.kind === "exited" &&
        !resident.closing
      ) {
        if (this.row(id).state === "running") this.state(id, "unknown");
        else this.state(id, "archived");
        this.notify(id, "attention", resident.stream + ":exit");
        void this.release(id).catch(() => {});
        return;
      }
      if (record.sessionId !== resident.session.id || record.agentPath.length)
        return;
      for (const event of record.body.events ?? []) {
        if (event.kind === "model" && typeof event.model === "string")
          this.db
            .prepare("UPDATE managed_sessions SET model=? WHERE id=?")
            .run(event.model, id);
        if (event.kind === "effort" && typeof event.effort === "string")
          this.db
            .prepare("UPDATE managed_sessions SET effort=? WHERE id=?")
            .run(event.effort, id);
        if (event.kind === "text_delta" && typeof event.text === "string") {
          resident.answer ??= randomUUID();
          const old = this.db
            .prepare(
              "SELECT length(CAST(text AS BLOB)) AS bytes FROM managed_messages WHERE id=?",
            )
            .get(resident.answer) as { bytes: number } | undefined;
          if (
            (old?.bytes ?? 0) + Buffer.byteLength(event.text) >
            this.maxTranscriptBytes
          ) {
            this.limit(
              id,
              resident,
              "Assistant response exceeded the bounded transcript limit",
            );
            return;
          }
          this.db
            .prepare(
              "INSERT INTO managed_messages VALUES(?,?,'assistant',?,?,?) ON CONFLICT(id) DO UPDATE SET text=text || excluded.text",
            )
            .run(resident.answer, id, event.text, this.now(), resident.receipt);
        }
        if (event.kind === "turn_ended") {
          const outcome = event.outcome as { kind?: string } | undefined;
          if (!["attention", "unknown"].includes(this.row(id).state))
            this.state(id, "idle");
          if (resident.receipt)
            this.result(resident.receipt, "completed", {
              outcome: outcome ?? null,
            });
          this.notify(
            id,
            outcome?.kind === "completed" ? "completion" : "attention",
            resident.stream + ":" + record.seq,
          );
          resident.receipt = null;
          resident.answer = null;
        }
      }
    } catch {
      // OAR swallows observer errors. Persist an explicit failure and stop the
      // owned session instead of continuing without durable submission evidence.
      this.limit(
        id,
        resident,
        "Durable recording failed; inspect this attempt before continuing",
      );
    }
  }
  private limit(id: string, resident: Resident, reason: string) {
    if (resident.closing) return;
    this.state(id, "attention");
    this.db
      .prepare("UPDATE managed_streams SET gap=? WHERE id=?")
      .run(reason, resident.stream);
    if (resident.receipt) this.result(resident.receipt, "unknown", { reason });
    this.notify(id, "attention", resident.stream + ":limit");
    // The default driver owns disposal; no approval is automatically answered.
    void this.release(id).catch(() => {});
  }
  private async send(id: string, text: string, requestId: string, actorId = "", workspace?: unknown) {
    if (!text.trim() || text.length > 200_000)
      throw new DomainError(
        400,
        "not_dispatched",
        "Input must contain between 1 and 200000 characters",
      );
    const row = this.row(id);
    const previous = this.previousReceipt(requestId);
    if (previous) {
      if (previous.local_id !== id || previous.kind !== "send")
        throw new DomainError(
          409,
          "not_dispatched",
          "Request id belongs to another operation",
        );
      if (["unknown", "dispatching"].includes(previous.state)) this.uncertain();
      if (["accepted", "completed"].includes(previous.state))
        return {
          ok: true,
          accepted: true,
          receiptId: requestId,
          state: previous.state,
        };
      throw new DomainError(
        409,
        "not_dispatched",
        "This input was rejected; submit a new request id after resolving the rejection",
      );
    }
    if (["unknown", "attention"].includes(row.state)) this.uncertain();
    if (row.state === "running")
      throw new DomainError(
        409,
        "not_dispatched",
        "Agent is busy; use the authorized remote queue",
      );
    if (Buffer.byteLength(text) > this.maxTranscriptBytes)
      throw new DomainError(
        400,
        "not_dispatched",
        "Input exceeds bounded transcript size",
      );
    const resident = await this.open(id);
    const attachments = this.attachments(id, actorId);
    if (attachments.some((attachment) => JSON.stringify(attachment.workspace) !== JSON.stringify(workspace)))
      throw new DomainError(403, "attachment_grant_changed", "Attachment access changed; remove it and upload again");
    const images = attachments.filter((attachment) => attachment.kind === "image");
    if (images.length && resident.session.capabilities?.images !== true)
      throw new DomainError(409, "images_unsupported", "This runtime does not accept native image attachments");
    const files = attachments.filter((attachment) => attachment.kind === "file");
    const input = text + files.map((file) => `\n\nAttached file ${JSON.stringify(file.display_name)}: ${JSON.stringify(file.path)}`).join("");
    if (Buffer.byteLength(input) > this.maxTranscriptBytes)
      throw new DomainError(400, "not_dispatched", "Input and attachment references exceed bounded transcript size");
    for (const attachment of attachments) {
      const handle = await openFile(attachment.path);
      try { if (!(await handle.stat()).isFile()) throw new DomainError(400, "invalid_attachment", "Attachment must be a regular file"); }
      finally { await handle.close(); }
    }
    this.receipt(requestId, id, "send");
    resident.receipt = requestId;
    resident.answer = null;
    this.state(id, "running");
    // Persist the submission before entering the runtime. Unknown attempts stay
    // visible and are never treated as evidence of model consumption.
    this.db
      .prepare("INSERT INTO managed_messages VALUES(?,?,'user',?,?,?)")
      .run(requestId, id, input, this.now(), requestId);
    try {
      const result = await resident.session.prompt(input, {
        inputId: requestId,
        ...(images.length ? { images: images.map((image) => ({ path: image.path, mediaType: image.content_type })) } : {}),
      });
      if (result.kind === "rejected") {
        this.result(requestId, "rejected", {
          code: result.code ?? "runtime_refused",
        });
        this.db
          .prepare("DELETE FROM managed_messages WHERE id=?")
          .run(requestId);
        if (!["attention", "unknown"].includes(this.row(id).state))
          this.state(id, "idle");
        resident.receipt = null;
        throw new DomainError(
          409,
          "not_dispatched",
          result.reason ?? "Runtime rejected the input",
        );
      }
      const receipt = this.previousReceipt(requestId);
      if (receipt?.state === "dispatching")
        this.result(requestId, "accepted", { accepted: true });
      for (const attachment of attachments)
        this.db.prepare("DELETE FROM managed_attachments WHERE id=?").run(attachment.id);
      return { ok: true, accepted: true, receiptId: requestId };
    } catch (error) {
      if (this.previousReceipt(requestId)?.state === "rejected") throw error;
      if (this.previousReceipt(requestId)?.state === "completed") {
        for (const attachment of attachments)
          this.db.prepare("DELETE FROM managed_attachments WHERE id=?").run(attachment.id);
        return {
          ok: true,
          accepted: true,
          receiptId: requestId,
          state: "completed",
        };
      }
      this.result(requestId, "unknown", { code: "runtime_uncertain" });
      this.state(id, "unknown");
      this.uncertain();
    }
  }
  private async interrupt(id: string, requestId: string) {
    this.row(id);
    const unattended = this.unattended(id);
    if (unattended.enabled) {
      unattended.enabled = false;
      this.saveUnattended(id, unattended);
    }
    const previous = this.previousReceipt(requestId);
    if (previous) {
      if (previous.local_id !== id || previous.kind !== "interrupt")
        throw new DomainError(
          409,
          "not_dispatched",
          "Request id belongs to another operation",
        );
      if (previous.state === "unknown" || previous.state === "dispatching")
        this.uncertain();
      return previous.result
        ? JSON.parse(previous.result)
        : { interrupted: false };
    }
    const resident = this.residents.get(id);
    if (!resident || resident.closing)
      return {
        interrupted: false,
        reason:
          "No owned active execution; saved conversations are not running processes",
      };
    this.receipt(requestId, id, "interrupt");
    try {
      const result = await resident.session.abort();
      const value = {
        interrupted: result.kind === "accepted",
        receiptId: requestId,
        ...(result.reason ? { reason: result.reason } : {}),
      };
      this.result(requestId, result.kind, value);
      return value;
    } catch {
      this.result(requestId, "unknown", { code: "runtime_uncertain" });
      this.uncertain();
    }
  }
  private async release(id: string) {
    const resident = this.residents.get(id);
    if (!resident) return;
    if (resident.closing) return resident.disposal;
    resident.closing = true;
    const disposal = (async () => {
    try {
      await resident.session.dispose();
    } finally {
      resident.unsubscribe();
      resident.unsubscribeExit();
      this.residents.delete(id);
      this.launchMemory.delete(id);
      await this.options.delegation?.release(id);
      this.db
        .prepare("UPDATE managed_streams SET ended=? WHERE id=?")
        .run(this.now(), resident.stream);
      if (this.row(id).state === "idle") this.state(id, "archived");
      // Pi (and print-mode CLIs) may not persist an empty conversation until
      // the first input. Never resume a nonexistent saved session after an
      // idle eviction. This discards no submitted input or native execution.
      const submitted = this.db
        .prepare(
          "SELECT 1 FROM managed_receipts WHERE local_id=? AND kind='send' AND state IN ('dispatching','accepted','completed','unknown') LIMIT 1",
        )
        .get(id);
      if (!submitted && this.row(id).state === "archived")
        this.db
          .prepare("UPDATE managed_sessions SET native_id=NULL WHERE id=?")
          .run(id);
    }
    })();
    resident.disposal = disposal;
    return disposal;
  }
  async quiesceIdle() {
    if (this.closed) return;
    for (const [id, resident] of this.residents) {
      if (
        this.row(id).state === "idle" &&
        this.now() - resident.touched >= this.idleMs
      )
        await this.serial(id, async () => {
          // Recheck after acquiring the session lock: a prompt may have been
          // admitted between the timer's observation and this callback.
          if (
            this.row(id).state === "idle" &&
            this.now() - resident.touched >= this.idleMs
          )
            await this.release(id);
        });
    }
  }
  private notify(
    id: string,
    kind: "completion" | "attention",
    identity: string,
  ) {
    const hash = createHash("sha256")
      .update(id + ":" + identity)
      .digest("hex");
    this.db
      .prepare("INSERT OR IGNORE INTO managed_notifications VALUES(?,?,?,?)")
      .run(hash, id, kind, this.now());
  }
  async completions(since: number): Promise<Notification[]> {
    this.assertOpen();
    const own = this.db
      .prepare(
        "SELECT id,local_id AS localId,kind,at AS occurredAt FROM managed_notifications WHERE at>=? ORDER BY at LIMIT 1000",
      )
      .all(since) as Notification[];
    return [...own, ...((await this.options.legacy?.completions(since)) ?? [])];
  }
  private messages(id: string) {
    this.row(id);
    const selected = this.db
      .prepare(
        `SELECT id,role,text,at,receipt FROM (
      SELECT id,role,text,at,receipt,rowid AS position,
      sum(length(CAST(text AS BLOB))+256) OVER (ORDER BY at DESC,rowid DESC) AS total_bytes
      FROM managed_messages WHERE local_id=?
      ) WHERE total_bytes<=? ORDER BY at,position`,
      )
      .all(id, this.maxTranscriptBytes);
    const count = this.db
      .prepare(
        "SELECT count(*) AS count FROM managed_messages WHERE local_id=?",
      )
      .get(id) as { count: number };
    return { messages: selected, truncated: selected.length !== count.count };
  }
  private catalogue() {
    const rows = this.db
      .prepare(
        "SELECT * FROM managed_sessions ORDER BY updated DESC LIMIT 1000",
      )
      .all() as Row[];
    const activeIds = new Set(rows.map((row) => row.id));
    return {
      sessions: rows.map((row) => this.metadata(row, activeIds)),
      new_session_defaults: readLaunchDefaults(this.home, this.workspace),
      recent_cwds: [...new Set(rows.map((row) => row.cwd))],
      tmux_available: false,
      runtime_driver: "oar",
    };
  }
  private async discover() {
    const own = this.catalogue();
    if (!this.options.legacy) return own;
    const native = (await this.options.legacy.execute({ op: "discover" })) as {
      sessions: Array<Record<string, unknown>>;
      new_session_defaults?: unknown;
      recent_cwds?: string[];
    };
    return {
      ...own,
      sessions: [...own.sessions, ...native.sessions],
      new_session_defaults:
        native.new_session_defaults ?? own.new_session_defaults,
      recent_cwds: [
        ...new Set([...own.recent_cwds, ...(native.recent_cwds ?? [])]),
      ],
    };
  }
  private metadata(row: Row, activeIds = new Set((this.db.prepare("SELECT id FROM managed_sessions").all() as { id: string }[]).map((entry) => entry.id))) {
    return {
      session_id: row.id,
      thread_id: row.native_id ?? row.id,
      // A saved managed transcript lives in SQLite, independently of a worker.
      // Catalogue/state snapshots must retain the same binding as tail/live.
      transcript_state: "bound",
      log_path: `managed:${row.id}`,
      agent_backend: row.backend,
      cwd: row.cwd,
      model: row.model,
      reasoning_effort: row.effort,
      start_ts: row.created / 1000,
      updated_ts: row.updated / 1000,
      busy: row.state === "running",
      readiness: ["unknown", "attention", "setup_required"].includes(row.state)
        ? "setup_required"
        : "ready",
      setup_message: ["unknown", "attention"].includes(row.state)
        ? "Execution outcome needs review; automatic replay is blocked"
        : null,
      resident: this.residents.has(row.id),
      launch_requires_reentry: !!row.reentry && !row.profile,
      owned: true,
      transport: "oar",
      queue_len: 0,
      runtime_state: row.state,
      stream_id: row.stream,
      commit_unknown_send: ["unknown", "attention"].includes(row.state),
      model_provider: null,
      lost: false,
      log_exists: !!row.stream,
      pending_attachment: !!this.db.prepare("SELECT 1 FROM managed_attachments WHERE local_id=? LIMIT 1").get(row.id),
      staged_attachments: [],
      files: [],
      draft_updated_ts: 0,
      thinking: 0,
      thinking_tokens: 0,
      tools: 0,
      system: 0,
      subagents_running: 0,
      subagent_details: [],
      unattended_enabled: this.unattended(row.id).enabled,
      slash_commands: [
        { name: "model", description: "Change the model while idle" },
        { name: "effort", description: "Change reasoning effort while idle" },
      ],
      pi_thinking_command: true,
      runtime_settings: true,
      supports_images: (this.db.prepare("SELECT images FROM managed_capabilities WHERE local_id=?").get(row.id) as { images: number } | undefined)?.images === 1,
      ...this.sidebar.project(row.id, row.name, row.updated / 1000,
        activeIds,
        this.now() / 1000),
    };
  }
  private async candidates(backend: string, cwd: string) {
    if (!isAbsolute(cwd))
      throw new DomainError(
        400,
        "not_dispatched",
        "Working directory must be absolute",
      );
    const rows = this.db
      .prepare(
        "SELECT * FROM managed_sessions WHERE backend=? AND cwd=? AND native_id IS NOT NULL ORDER BY updated DESC LIMIT 100",
      )
      .all(backend, resolve(cwd)) as Row[];
    const native = this.options.legacy
      ? ((await this.options.legacy.request(
          `/api/session_resume_candidates?agent_backend=${encodeURIComponent(backend)}&cwd=${encodeURIComponent(cwd)}`,
        )) as { sessions: Array<Record<string, unknown>> })
      : undefined;
    const sessions = rows.map((row) => ({
      session_id: row.native_id,
      cwd: row.cwd,
      updated_ts: row.updated / 1000,
      alias: row.name,
      agent_backend: row.backend,
    }));
    return {
      ok: true,
      cwd,
      sessions: [
        ...sessions,
        ...(native?.sessions ?? []).filter(
          (candidate) =>
            !sessions.some(
              (session) => session.session_id === candidate.session_id,
            ),
        ),
      ],
    };
  }
  async sendQueued(localId: string, text: string) {
    if (localId.startsWith("broker-") && this.options.legacy?.sendQueued)
      return this.options.legacy.sendQueued(localId, text);
    try {
      return await this.serial(localId, () =>
        this.send(localId, text, randomUUID()),
      );
    } catch (error) {
      if (error instanceof DomainError && error.code === "not_dispatched")
        throw new DomainError(
          error.status,
          "queue_not_dispatched",
          error.message,
        );
      throw error;
    }
  }
  async queueControl(
    localId: string,
    operation: string,
    body: Record<string, unknown> = {},
  ) {
    if (operation === "sessions")
      return (await this.discover()).sessions.map((row) => row.session_id);
    if (localId.startsWith("broker-") && this.options.legacy?.queueControl)
      return this.options.legacy.queueControl(localId, operation, body);
    if (operation === "state")
      return {
        ...this.metadata(this.row(localId)),
        queue: [],
        ...this.attachmentState(localId, typeof body.actorId === "string" ? body.actorId : ""),
      };
    if (operation === "send")
      return this.sendQueued(localId, String(body.text ?? ""));
    if (operation === "interrupt") return this.interrupt(localId, randomUUID());
    throw new DomainError(
      400,
      "not_dispatched",
      `Managed runtime does not support ${operation}`,
    );
  }
  async request(path: string, method = "GET", body?: unknown): Promise<any> {
    this.assertOpen();
    const url = new URL(path, "http://managed.invalid");
    if (url.pathname.startsWith("/api/sessions/broker-") && this.options.legacy)
      return this.options.legacy.request(path, method, body);
    if (url.pathname === "/api/sessions" && method === "GET")
      return this.discover();
    if (url.pathname === "/api/session_resume_candidates")
      return this.candidates(
        url.searchParams.get("agent_backend") ?? "codex",
        url.searchParams.get("cwd") ?? this.workspace,
      );
    if (url.pathname === "/api/sessions" && method === "POST") {
      const value = body as Record<string, unknown>;
      const operation = {
        op: "create" as const,
        agentId: randomUUID(),
        backend: value.agent_backend as ManagedBackend,
        name: typeof value.name === "string" ? value.name : "",
        launch: Launch.parse(value),
      };
      if (!["pi", "codex", "cc"].includes(operation.backend))
        throw new DomainError(
          400,
          "not_dispatched",
          "Choose a supported runtime",
        );
      const result = (await this.execute(operation)) as { localId: string };
      return { session_id: result.localId };
    }
    const match = /^\/api\/sessions\/(managed-[a-f0-9]{32})(?:\/(.*))?$/.exec(
      url.pathname,
    );
    const id = match?.[1];
    const operation = match?.[2];
    if (id) {
      const value = (body ?? {}) as Record<string, unknown>;
      const actor = typeof value.actorId === "string" ? value.actorId : "";
      if (operation === "attachments" && method === "GET") {
        this.row(id);
        return this.attachmentState(id, actor);
      }
      if (["inject_file", "inject_image", "attachments/delete", "attachments/clear", "pending_attachment/clear"].includes(operation ?? "") && method === "POST")
        return this.serial(id, async () => {
          this.row(id);
          if (operation === "attachments/delete")
            this.db.prepare("DELETE FROM managed_attachments WHERE local_id=? AND actor_id=? AND id=?").run(id, actor, String(value.id ?? ""));
          else if (operation === "attachments/clear" || operation === "pending_attachment/clear")
            this.db.prepare("DELETE FROM managed_attachments WHERE local_id=? AND actor_id=?").run(id, actor);
          else {
            if (typeof value.path !== "string" || !isAbsolute(value.path))
              throw new DomainError(400, "invalid_attachment", "Attachment requires an absolute uploaded file path");
            const file = await openFile(value.path);
            let size: number;
            try {
              const stat = await file.stat();
              if (!stat.isFile() || !stat.size || stat.size > 64 * 1024 * 1024)
                throw new DomainError(400, "invalid_attachment", "Attachment must be a nonempty regular file no larger than 64 MiB");
              size = stat.size;
            } finally { await file.close(); }
            const existing = this.attachments(id, actor);
            if (existing.length >= 20 || existing.reduce((total, entry) => total + entry.size, size) > 64 * 1024 * 1024)
              throw new DomainError(413, "attachment_limit", "Staged attachments are limited to 20 files and 64 MiB per person and conversation");
            const name = basename(String(value.filename ?? value.name ?? value.path)).slice(0, 150);
            const knownImageTypes: Record<string, string> = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
            const imageType = knownImageTypes[extname(name).toLowerCase()];
            const image = operation === "inject_image" || String(value.content_type ?? "").startsWith("image/") || !!imageType;
            if (image && (!imageType || (this.db.prepare("SELECT images FROM managed_capabilities WHERE local_id=?").get(id) as { images: number } | undefined)?.images !== 1))
              throw new DomainError(409, "images_unsupported", "This runtime accepts native image attachments only when advertised, using PNG, JPEG, GIF or WebP");
            const attachment: Attachment = {
              id: randomUUID(), ...(actor ? { actorId: actor } : {}),
              ...(value.workspace ? { workspace: value.workspace as NonNullable<Attachment["workspace"]> } : {}),
              path: value.path, name, filename: name, display_name: String(value.display_name ?? name),
              size, content_type: imageType ?? String(value.content_type ?? "application/octet-stream"),
              created_ts: this.now() / 1000, kind: image ? "image" : "file",
            };
            this.db.prepare("INSERT INTO managed_attachments VALUES(?,?,?,?)").run(attachment.id, id, actor, JSON.stringify(attachment));
            return { ok: true, attachment, ...this.attachmentState(id, actor) };
          }
          return { ok: true, ...this.attachmentState(id, actor) };
        });
      if (operation === "settings" && method === "POST")
        return this.serial(id, async () => {
          const before = this.row(id);
          if (!["idle", "archived"].includes(before.state))
            throw new DomainError(409, "not_dispatched", "Wait until the agent is idle and any uncertain outcome is reviewed before changing runtime settings");
          const field = typeof value.model === "string" ? "model" : typeof value.reasoning_effort === "string" ? "reasoning_effort" : null;
          const setting = field ? String(value[field]).trim() : "";
          if (!field || !setting || setting === "default" || (typeof value.model === "string" && typeof value.reasoning_effort === "string") || setting.length > 200 || /[\r\n\0]/.test(setting))
            throw new DomainError(400, "invalid_setting", "Choose a valid model or reasoning effort");
          const previousLaunch = this.launchMemory.get(id);
          // OAR's pinned adapters explicitly apply and read back model/effort
          // overrides on cold resume. Never replace a worker during a turn.
          await this.release(id);
          if (previousLaunch) this.launchMemory.set(id, previousLaunch);
          const column = field === "model" ? "model" : "effort";
          this.db.prepare(`UPDATE managed_sessions SET ${column}=? WHERE id=?`).run(setting, id);
          try {
            await this.open(id);
            if (["unknown", "attention"].includes(this.row(id).state))
              throw new DomainError(409, "setting_refused", "Runtime initialization requires review");
            return { ok: true, accepted: true, [field]: field === "model" ? this.row(id).model : this.row(id).effort };
          } catch {
            await this.release(id);
            const state = this.row(id).state;
            this.db.prepare("UPDATE managed_sessions SET model=?,effort=?,state=? WHERE id=?").run(before.model, before.effort, ["unknown", "attention"].includes(state) ? state : "archived", id);
            throw new DomainError(409, "setting_refused", "The runtime could not confirm this setting. The previous model and reasoning effort have been retained");
          }
        });
      if (["edit", "rename"].includes(operation ?? "") && method === "POST")
        return this.serial(id, async () => {
          this.row(id);
          const result = operation === "edit"
            ? this.sidebar.edit(id, value, new Set((await this.discover()).sessions.map((entry) => String(entry.session_id))))
            : typeof value.name === "string"
              ? this.sidebar.rename(id, value.name)
              : (() => { throw new DomainError(400, "invalid_sidebar", "name required"); })();
          this.db.prepare("UPDATE managed_sessions SET name=? WHERE id=?").run(result.alias ?? "", id);
          return result;
        });
      if ((operation === "delete" && method === "POST") || (!operation && method === "DELETE"))
        return this.serial(id, async () => {
          this.row(id);
          // Dispose only this owned worker before acknowledging deletion. Keep
          // native CLI histories and private provider profiles untouched.
          const settings = this.unattended(id);
          settings.enabled = false;
          this.saveUnattended(id, settings);
          await this.release(id);
          this.db.exec("BEGIN IMMEDIATE");
          try {
            this.db.prepare("DELETE FROM managed_events WHERE stream IN (SELECT id FROM managed_streams WHERE local_id=?)").run(id);
            for (const table of ["managed_streams", "managed_messages", "managed_receipts", "managed_notifications", "managed_unattended", "managed_read", "managed_capabilities", "managed_attachments"])
              this.db.prepare(`DELETE FROM ${table} WHERE local_id=?`).run(id);
            this.db.prepare("DELETE FROM managed_sessions WHERE id=?").run(id);
            this.db.exec("COMMIT");
          } catch (error) { this.db.exec("ROLLBACK"); throw error; }
          this.launchMemory.delete(id);
          return { ok: true, deleted: true };
        });
      if ((operation === "read" && method === "POST") || (operation === "unread" && method === "GET")) {
        this.row(id);
        const actor = typeof value.actorId === "string" ? value.actorId : "";
        const events = this.db.prepare("SELECT id FROM managed_messages WHERE local_id=? ORDER BY at,rowid").all(id) as { id: string }[];
        const latest = events.at(-1)?.id ?? null;
        const saved = this.db.prepare("SELECT event_id FROM managed_read WHERE local_id=? AND actor_id=?").get(id, actor) as { event_id: string | null } | undefined;
        if (operation === "read" || !saved) {
          const eventId = operation === "read" ? value.event_id ?? latest : latest;
          if (eventId !== null && !events.some((entry) => entry.id === eventId))
            throw new DomainError(400, "invalid_event_id", "Unknown transcript event");
          this.db.prepare("INSERT INTO managed_read VALUES(?,?,?) ON CONFLICT(local_id,actor_id) DO UPDATE SET event_id=excluded.event_id").run(id, actor, eventId as string | null);
          if (operation === "read") return { ok: true, event_id: eventId };
          return { count: 0, unread: 0, first_unread_event_id: null, last_unread_event_id: null };
        }
        const unread = events.slice(events.findIndex((entry) => entry.id === saved.event_id) + 1);
        return { count: unread.length, unread: unread.length, first_unread_event_id: unread[0]?.id ?? null, last_unread_event_id: unread.at(-1)?.id ?? null };
      }
      if (operation === "unattended" && method === "GET") {
        this.row(id);
        return this.unattended(id);
      }
      if (operation === "unattended" && method === "POST")
        return this.configureUnattended(id, value);
      if (operation === "diagnostics" && method === "GET") {
        const row = this.row(id);
        const evidence = this.db.prepare(
          "SELECT count(*) AS records, COALESCE(sum(bytes),0) AS bytes FROM managed_events WHERE stream IN (SELECT id FROM managed_streams WHERE local_id=?)",
        ).get(id) as { records: number; bytes: number };
        // Diagnostics inspect Computer-owned durable state. They must remain
        // available after worker eviction and never open or resume a driver.
        return {
          ...this.metadata(row),
          runtime: "oar",
          native_session_id: row.native_id,
          retained_records: evidence.records,
          retained_record_bytes: evidence.bytes,
        };
      }
      if (operation === "messages" || operation === "chat") {
        const result = this.messages(id);
        return {
          ...result,
          events: result.messages.map((message) => ({
            role: message.role,
            text: message.text,
            ts: Number(message.at) / 1000,
            message_id: message.id,
          })),
          session_id: id,
        };
      }
      if (operation === "search" || operation?.startsWith("messages/"))
        return this.transcript(id, operation, url);
      if (!operation || operation === "state")
        return this.queueControl(id, "state", value);
      if (operation === "send" && method === "POST") {
        const text = String(value.text ?? "");
        const setting = /^\/(model|effort|thinking)\s+([^\r\n]+)$/.exec(text.trim());
        if (setting)
          return this.request(`/api/sessions/${id}/settings`, "POST", {
            [setting[1] === "model" ? "model" : "reasoning_effort"]: setting[2],
          });
        return this.serial(id, () => this.send(id, text, typeof value.request_id === "string" ? value.request_id : randomUUID(), actor, value.workspace));
      }
      if (operation === "interrupt" && method === "POST")
        return this.interrupt(id, randomUUID());
      if (operation === "receipts")
        return {
          receipts: this.db
            .prepare(
              "SELECT id,kind,state,result,created,updated FROM managed_receipts WHERE local_id=? ORDER BY created DESC LIMIT 100",
            )
            .all(id),
        };
    }
    throw new DomainError(
      400,
      "not_dispatched",
      "This managed runtime operation is not supported; native terminal import/control is a separate driver",
    );
  }
  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    clearInterval(this.timer);
    this.closePromise = (async () => {
      await Promise.allSettled([...this.locks.values(), this.admission]);
      const releases: Promise<void>[] = [];
      for (const id of [...this.residents.keys()]) {
        if (this.row(id).state === "running") this.state(id, "unknown");
        releases.push(this.release(id));
      }
      const results = await Promise.allSettled(releases);
      this.launchMemory.clear();
      this.db.close();
      await this.options.legacy?.close();
      const failure = results.find((result) => result.status === "rejected");
      if (failure?.status === "rejected") throw failure.reason;
    })();
    return this.closePromise;
  }
  private transcript(id: string, action: string, url: URL) {
    const row = this.row(id);
    if (action === "messages/neighbor") return this.neighbor(row, url);
    if (
      !new Set([
        "messages/tail",
        "messages/history",
        "messages/window",
        "messages/live",
        "messages/export",
        "search",
      ]).has(action)
    )
      throw new DomainError(
        400,
        "not_dispatched",
        "Unsupported transcript operation",
      );
    const cursor =
      url.searchParams.get(action === "messages/live" ? "after" : "cursor") ??
      url.searchParams.get("before") ??
      "";
    if (cursor && !cursor.startsWith(id + ":"))
      throw new DomainError(
        409,
        "invalid_cursor",
        "Cursor belongs to another session",
      );
    const position = cursor ? Number(cursor.split(":").at(-1)) : null;
    if (position !== null && (!Number.isSafeInteger(position) || position < 0))
      throw new DomainError(400, "invalid_cursor", "Invalid transcript cursor");
    const limit = Math.max(
      1,
      Math.min(200, Number(url.searchParams.get("limit") ?? 80) || 80),
    );
    const search = action === "search";
    const query = url.searchParams.get("q") ?? url.searchParams.get("query") ?? "";
    const role = search ? url.searchParams.get("role") : null;
    if (role !== null && role !== "user" && role !== "assistant")
      throw new DomainError(400, "invalid_role", "Search role must be user or assistant");
    if (search && (query.length > 2000 || query.includes("\0")))
      throw new DomainError(400, "invalid_query", "Search query must be at most 2000 characters without NUL");
    if (search && url.searchParams.has("limit")) {
      const requested = Number(url.searchParams.get("limit"));
      if (!Number.isSafeInteger(requested) || requested < 1 || requested > 200)
        throw new DomainError(400, "invalid_limit", "Search limit must be an integer between 1 and 200");
    }
    const searchFilter = search
      ? `${role ? "AND role=? " : ""}${query === "*" ? "" : "AND instr(managed_casefold(text),?)>0"}`
      : "";
    const searchParameters = [
      ...(role ? [role] : []),
      ...(search && query !== "*" ? [query.toLowerCase()] : []),
    ];
    const searchTotal = search
      ? (this.db.prepare(`SELECT count(*) AS count FROM managed_messages WHERE local_id=? ${searchFilter}`).get(id, ...searchParameters) as { count: number }).count
      : 0;
    // Live cursors track durable OAR ingress, not only message count: a text
    // delta can update the same assistant message many times.
    const revision = this.db
      .prepare(
        "SELECT COALESCE(max(rowid),0) AS revision FROM managed_events WHERE stream IN (SELECT id FROM managed_streams WHERE local_id=?)",
      )
      .get(id) as { revision: number };
    let selected: Array<Record<string, unknown>> = [];
    if (action !== "messages/live" || position !== revision.revision) {
      if (action === "messages/window" && position === null)
        throw new DomainError(
          400,
          "invalid_cursor",
          "A history cursor is required",
        );
      const window = action === "messages/window" && position !== null;
      const before = Math.max(
        0,
        Math.min(100, Number(url.searchParams.get("before") ?? 30) || 0),
      );
      const after = Math.max(
        0,
        Math.min(100, Number(url.searchParams.get("after") ?? 30) || 0),
      );
      const condition = search
        ? `${searchFilter}${position !== null ? " AND rowid<?" : ""}`
        : window
        ? "AND rowid>=? AND rowid<=?"
        : action === "messages/history" && position !== null
          ? "AND rowid<?"
          : "";
      const parameters = search
        ? position !== null
          ? [id, ...searchParameters, position, limit]
          : [id, ...searchParameters, limit]
        : window
        ? [id, position! - before, position! + after, limit]
        : condition
          ? [id, position, limit]
          : [id, limit];
      // Read at most the response byte budget from SQLite before materializing.
      selected = this.db
        .prepare(
          `SELECT * FROM (
        SELECT id,role,text,at,rowid AS position, sum(length(CAST(text AS BLOB))+256) OVER (ORDER BY rowid DESC) AS bytes
        FROM managed_messages WHERE local_id=? ${condition}
      ) WHERE bytes<=${this.maxTranscriptBytes} ORDER BY position DESC LIMIT ?`,
        )
        .all(...parameters)
        .reverse();
    }
    const events = selected.map((message) => ({
      role: message.role,
      text: message.text,
      ts: Number(message.at) / 1000,
      message_id: message.id,
      history_cursor: `${id}:${message.position}`,
      ...(search ? { before_byte: `${id}:${message.position}` } : {}),
    }));
    const earliest = Number(selected[0]?.position ?? 0);
    const older = earliest
      ? !!this.db
          .prepare(
            `SELECT 1 FROM managed_messages WHERE local_id=? AND rowid<? ${searchFilter} LIMIT 1`,
          )
          .get(id, earliest, ...searchParameters)
      : false;
    const last = this.db
      .prepare(
        "SELECT state,result FROM managed_receipts WHERE local_id=? AND kind='send' ORDER BY created DESC,rowid DESC LIMIT 1",
      )
      .get(id) as { state: string; result: string | null } | undefined;
    const ended = last?.state === "completed";
    const outcome =
      ended && last.result
        ? (JSON.parse(last.result) as { outcome?: { kind?: string } }).outcome
        : undefined;
    return {
      events,
      ...(search ? { matches: events, total: searchTotal, match_count: searchTotal } : {}),
      event_count: events.length,
      transcript_state: "bound",
      thread_id: row.native_id ?? row.id,
      log_path: `managed:${id}`,
      meta_delta: { thinking: 0, thinking_tokens: 0, tool: 0, system: 0 },
      turn_start: row.state === "running",
      turn_end: ended,
      turn_aborted: outcome?.kind === "aborted",
      turn_boundaries: ended
        ? [outcome?.kind === "aborted" ? "aborted" : "end"]
        : [],
      live_cursor: `${id}:live:${revision.revision}`,
      history_cursor: older ? `${id}:${earliest}` : null,
      has_older: older,
      has_newer: action === "messages/history",
      jumped_window: action === "messages/window",
      busy: row.state === "running",
      queue_len: 0,
      truncated: action === "messages/export" && older,
    };
  }
  private neighbor(row: Row, url: URL) {
    const cursor = url.searchParams.get("cursor") ?? "";
    if (!cursor.startsWith(row.id + ":"))
      throw new DomainError(409, "invalid_cursor", "Cursor belongs to another session");
    const suffix = cursor.slice(row.id.length + 1);
    const position = Number(suffix);
    if (!/^\d+$/.test(suffix) || !Number.isSafeInteger(position))
      throw new DomainError(400, "invalid_cursor", "A valid history cursor is required");
    const direction = url.searchParams.get("direction");
    if (direction !== "previous" && direction !== "next")
      throw new DomainError(400, "invalid_direction", "Neighbor direction must be previous or next");
    const role = url.searchParams.get("role");
    if (role !== null && role !== "user" && role !== "assistant")
      throw new DomainError(400, "invalid_role", "Neighbor role must be user or assistant");
    const selected = this.db.prepare(`SELECT id,role,
      CASE WHEN length(CAST(text AS BLOB))+256<=${this.maxTranscriptBytes} THEN text ELSE NULL END AS text,
      at,rowid AS position FROM managed_messages WHERE local_id=? ${role ? "AND role=?" : ""}
      AND rowid${direction === "previous" ? "<" : ">"}? ORDER BY rowid ${direction === "previous" ? "DESC" : "ASC"} LIMIT 1`)
      .get(row.id, ...(role ? [role] : []), position) as { id: string; role: string; text: string | null; at: number; position: number } | undefined;
    if (selected?.text === null)
      throw new DomainError(413, "transcript_limit", "Neighbor message exceeds the bounded response size");
    return {
      neighbor: selected ? {
        role: selected.role, text: selected.text, ts: selected.at / 1000,
        message_id: selected.id, history_cursor: `${row.id}:${selected.position}`,
        before_byte: `${row.id}:${selected.position}`, same_log: true,
      } : null,
      transcript_state: "bound", thread_id: row.native_id ?? row.id,
      log_path: `managed:${row.id}`,
    };
  }
}
function positive(value: number, name: string) {
  if (!Number.isSafeInteger(value) || value < 1)
    throw Error(`${name} must be a positive integer`);
  return value;
}
function sensitive(launch: LaunchOptions) {
  return !!(
    launch.provider_config || Object.keys(launch.env_vars ?? {}).length
  );
}
