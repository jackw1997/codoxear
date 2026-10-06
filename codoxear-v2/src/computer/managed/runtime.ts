import { DatabaseSync } from "node:sqlite";
import { randomUUID, createHash } from "node:crypto";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
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
  private readonly now: () => number;
  private readonly maxResident: number;
  private readonly idleMs: number;
  private readonly maxEvents: number;
  private readonly maxEventBytes: number;
  private readonly maxRecordBytes: number;
  private readonly maxTranscriptBytes: number;
  constructor(private readonly options: ManagedRuntimeOptions) {
    for (const path of [options.home, options.workspace, options.databasePath])
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
    this.db = new DatabaseSync(options.databasePath);
    chmodSync(options.databasePath, 0o600);
    this.db.exec(`PRAGMA journal_mode=DELETE; PRAGMA synchronous=FULL;
      CREATE TABLE IF NOT EXISTS managed_sessions(id TEXT PRIMARY KEY,agent TEXT UNIQUE,backend TEXT,name TEXT,cwd TEXT,native_id TEXT,model TEXT,effort TEXT,state TEXT,created INTEGER,updated INTEGER,reentry INTEGER,stream TEXT,profile TEXT);
      CREATE TABLE IF NOT EXISTS managed_streams(id TEXT PRIMARY KEY,local_id TEXT,created INTEGER,ended INTEGER,gap TEXT);
      CREATE TABLE IF NOT EXISTS managed_events(stream TEXT,seq INTEGER,native_id TEXT,body TEXT,bytes INTEGER,PRIMARY KEY(stream,seq));
      CREATE TABLE IF NOT EXISTS managed_messages(id TEXT PRIMARY KEY,local_id TEXT,role TEXT,text TEXT,at INTEGER,receipt TEXT);
      CREATE INDEX IF NOT EXISTS managed_message_order ON managed_messages(local_id,at);
      CREATE TABLE IF NOT EXISTS managed_receipts(id TEXT PRIMARY KEY,local_id TEXT,kind TEXT,state TEXT,result TEXT,created INTEGER,updated INTEGER);
      CREATE TABLE IF NOT EXISTS managed_notifications(id TEXT PRIMARY KEY,local_id TEXT,kind TEXT,at INTEGER);
      UPDATE managed_sessions SET state='unknown' WHERE state IN ('opening','running');
      UPDATE managed_receipts SET state='unknown' WHERE state IN ('dispatching','accepted');`);
    this.factory = options.factory ?? new OarFactory();
    this.timer = setInterval(
      () => {
        void this.quiesceIdle().catch(() => {});
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
      | { local_id: string; kind: string; state: string; result: string | null }
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
  private async send(id: string, text: string, requestId: string) {
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
    this.receipt(requestId, id, "send");
    resident.receipt = requestId;
    resident.answer = null;
    this.state(id, "running");
    // Persist the submission before entering the runtime. Unknown attempts stay
    // visible and are never treated as evidence of model consumption.
    this.db
      .prepare("INSERT INTO managed_messages VALUES(?,?,'user',?,?,?)")
      .run(requestId, id, text, this.now(), requestId);
    try {
      const result = await resident.session.prompt(text, {
        inputId: requestId,
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
      return { ok: true, accepted: true, receiptId: requestId };
    } catch (error) {
      if (this.previousReceipt(requestId)?.state === "rejected") throw error;
      if (this.previousReceipt(requestId)?.state === "completed")
        return {
          ok: true,
          accepted: true,
          receiptId: requestId,
          state: "completed",
        };
      this.result(requestId, "unknown", { code: "runtime_uncertain" });
      this.state(id, "unknown");
      this.uncertain();
    }
  }
  private async interrupt(id: string, requestId: string) {
    this.row(id);
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
    if (!resident || resident.closing) return;
    resident.closing = true;
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
    return {
      sessions: rows.map((row) => this.metadata(row)),
      new_session_defaults: {
        default_backend: "pi",
        provider_launch: true,
        backends: {
          pi: {
            model: null,
            models: [],
            provider_choices: ["__custom_api__"],
            reasoning_efforts: [
              "off",
              "minimal",
              "low",
              "medium",
              "high",
              "xhigh",
              "max",
            ],
            supports_fast: false,
          },
          codex: {
            model: null,
            models: [],
            provider_choices: ["__custom_api__"],
            reasoning_efforts: ["low", "medium", "high", "xhigh"],
            supports_fast: false,
          },
          cc: {
            model: null,
            models: [],
            provider_choices: ["__custom_api__"],
            reasoning_efforts: ["low", "medium", "high", "max"],
            supports_fast: false,
          },
        },
      },
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
  private metadata(row: Row) {
    return {
      session_id: row.id,
      thread_id: row.native_id,
      agent_backend: row.backend,
      alias: row.name,
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
      pending_attachment: false,
      staged_attachments: [],
      files: [],
      draft_updated_ts: 0,
      thinking: 0,
      thinking_tokens: 0,
      tools: 0,
      system: 0,
      subagents_running: 0,
      subagent_details: [],
      unattended_enabled: false,
      slash_commands: [],
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
        attachments: [],
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
      if (operation?.startsWith("messages/"))
        return this.transcript(id, operation, url);
      if (!operation || operation === "state")
        return this.queueControl(id, "state");
      if (operation === "send" && method === "POST")
        return this.sendQueued(id, String(value.text ?? ""));
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
    if (
      !new Set([
        "messages/tail",
        "messages/history",
        "messages/window",
        "messages/live",
        "messages/export",
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
      const condition = window
        ? "AND rowid>=? AND rowid<=?"
        : action === "messages/history" && position !== null
          ? "AND rowid<?"
          : "";
      const parameters = window
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
    }));
    const earliest = Number(selected[0]?.position ?? 0);
    const older = earliest
      ? !!this.db
          .prepare(
            "SELECT 1 FROM managed_messages WHERE local_id=? AND rowid<? LIMIT 1",
          )
          .get(id, earliest)
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
      event_count: events.length,
      transcript_state: "bound",
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
