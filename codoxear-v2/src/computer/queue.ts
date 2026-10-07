import { DatabaseSync } from "node:sqlite";
import { chmodSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { DomainError } from "../contracts/model.js";
import {
  type HttpRequest,
  type HttpResponse,
} from "../protocol/http-frames.js";

type Item = {
  id: string;
  localId: string;
  text: string;
  actorId: string;
  permit: string;
  created_ts: number;
  state: "pending" | "dispatching" | "unknown";
  version: number;
};
export interface QueueRuntime {
  idle(localId: string, actorId?: string): Promise<boolean>;
  authorize(permit: string, localId: string): Promise<void>;
  send(localId: string, text: string, actorId?: string): Promise<void>;
  unified?: {
    sessions(): Promise<string[]>;
    control(
      localId: string,
      operation: string,
      body?: Record<string, unknown>,
    ): Promise<any>;
  };
}
/** Saved before acknowledgement. Authorization precedes a fresh idle check;
 * dispatch is saved before calling the runtime's atomic idle-only send. Only an
 * explicit queue_not_dispatched rejection can restore pending work. Any ambiguous
 * dispatch (including process death) requires review and is never replayed. */
export class ComputerQueue {
  private db: DatabaseSync;
  private draining = false;
  private pauses = new Map<string, string>();
  constructor(
    path: string,
    private scope: string,
    private runtime: QueueRuntime,
  ) {
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS queues(scope TEXT PRIMARY KEY, payload TEXT NOT NULL)",
    );
    this.db.prepare("INSERT OR IGNORE INTO queues VALUES(?, '[]')").run(scope);
    this.change((items) => {
      for (const item of items)
        if (item.state === "dispatching") item.state = "unknown";
    });
  }
  private read(): Item[] {
    return JSON.parse(
      (
        this.db
          .prepare("SELECT payload FROM queues WHERE scope=?")
          .get(this.scope) as { payload: string }
      ).payload,
    );
  }
  private change<T>(fn: (items: Item[]) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const items = this.read(),
        result = fn(items);
      this.db
        .prepare("UPDATE queues SET payload=? WHERE scope=?")
        .run(JSON.stringify(items), this.scope);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  list(localId: string) {
    return this.read()
      .filter((i) => i.localId === localId)
      .map(({ permit, localId: _, version, state, ...i }) => ({
        ...i,
        sending: state === "dispatching",
        commit_unknown: state === "unknown",
        ...(state === "pending"
          ? { pause_reason: this.pauses.get(i.id) ?? "Waiting to dispatch" }
          : {}),
      }));
  }
  enqueue(localId: string, text: string, actorId: string, permit: string) {
    z.string().trim().min(1).max(200000).parse(text);
    if (!actorId || !permit)
      throw new DomainError(
        403,
        "queue_authorization_required",
        "Queue authorization required",
      );
    const id = randomUUID();
    this.change((items) => {
      if (items.length >= 1000)
        throw new DomainError(429, "queue_full", "Computer queue is full");
      items.push({
        id,
        localId,
        text,
        actorId,
        permit,
        created_ts: Date.now() / 1000,
        state: "pending",
        version: 0,
      });
    });
    return id;
  }
  mutate(
    localId: string,
    action: string,
    body: unknown,
    actorId?: string,
    permit?: string,
  ) {
    const input = z
      .object({
        id: z.string(),
        text: z.string().trim().min(1).max(200000).optional(),
        to_index: z.number().int().nonnegative().optional(),
        allow_commit_unknown: z.boolean().optional(),
      })
      .parse(body);
    this.change((items) => {
      const index = items.findIndex(
          (i) => i.id === input.id && i.localId === localId,
        ),
        item = items[index];
      if (!item)
        throw new DomainError(
          404,
          "queue_item_missing",
          "Queue item no longer exists",
        );
      if (
        item.state === "dispatching" ||
        (item.state === "unknown" &&
          !(action === "delete" && input.allow_commit_unknown))
      )
        throw new DomainError(
          409,
          "commit_unknown",
          "Review the transcript before removing an uncertain queued send",
        );
      if (action === "delete") {
        items.splice(index, 1);
        this.pauses.delete(item.id);
      } else if (action === "update") {
        if (!input.text || !actorId || !permit)
          throw new DomainError(
            400,
            "invalid_queue_update",
            "Text and fresh queue authorization required",
          );
        Object.assign(item, {
          text: input.text,
          actorId,
          permit,
          version: item.version + 1,
        });
        this.pauses.delete(item.id);
      } else if (action === "move") {
        const same = items.filter((i) => i.localId === localId);
        if (same.some((i) => i.state !== "pending"))
          throw new DomainError(
            409,
            "queue_locked",
            "Resolve the in-flight queue item first",
          );
        if (input.to_index === undefined || input.to_index >= same.length)
          throw new DomainError(
            400,
            "invalid_position",
            "Invalid queue position",
          );
        same.splice(same.indexOf(item), 1);
        same.splice(input.to_index, 0, item);
        const others = items.filter((i) => i.localId !== localId);
        items.splice(0, items.length, ...others, ...same);
        item.version++;
      }
    });
  }
  private migrations = new Map<string, Promise<void>>();
  private async supportsUnified(localId: string) {
    if (!this.runtime.unified) return false;
    try { return (await this.runtime.unified.control(localId, "queue/capabilities"))?.unified === true; }
    catch { return false; }
  }
  private async migrate(localId: string) {
    if (!this.runtime.unified) return;
    const existing = this.migrations.get(localId);
    if (existing) return existing;
    const operation = (async () => {
      for (const item of this.read().filter(
        (entry) => entry.localId === localId,
      )) {
        await this.runtime.unified!.control(localId, "enqueue", {
          id: item.id,
          text: item.text,
          actorId: item.actorId,
          permit: item.permit,
          scope: this.scope,
          created_ts: item.created_ts,
          commit_unknown: item.state !== "pending",
        });
        // ACK means the same stable ID is durable in the broker. Remove the
        // historical journal entry before allowing broker dispatch.
        this.change((items) => {
          const index = items.findIndex((entry) => entry.id === item.id);
          if (index >= 0) items.splice(index, 1);
        });
      }
    })();
    this.migrations.set(localId, operation);
    try {
      await operation;
    } finally {
      this.migrations.delete(localId);
    }
  }
  async listAsync(localId: string): Promise<any[]> {
    if (!(await this.supportsUnified(localId))) return this.list(localId);
    await this.migrate(localId);
    return (
      await this.runtime.unified!.control(localId, "queue", {
        scope: this.scope,
      })
    ).items;
  }
  private async drainUnified() {
    const native = this.runtime.unified!;
    const supported = new Set<string>();
    for (const localId of await native.sessions()) {
      if (!(await this.supportsUnified(localId))) continue;
      supported.add(localId);
      try {
        await this.migrate(localId);
        const head = await native.control(localId, "queue/head", {
          scope: this.scope,
        });
        if (!head) continue;
        const pause = (reason: string) =>
          native.control(localId, "queue/pause", {
            scope: this.scope,
            id: head.id,
            version: head.version,
            reason,
          });
        if (!(await this.runtime.idle(localId, head.actorId))) {
          await pause("Waiting for the current turn or terminal input");
          continue;
        }
        try {
          await this.runtime.authorize(head.permit, localId);
        } catch (error) {
          await pause(
            error instanceof DomainError &&
              [401, 403, 404].includes(error.status)
              ? "Authorization expired or access removed; edit after signing in to authorize again"
              : "Waiting for hub authorization",
          );
          continue;
        }
        // The broker atomically checks native idle, ordering and edit version,
        // saves dispatching before paste, and retains unknown after any crash.
        await native.control(localId, "queue/dispatch", {
          scope: this.scope,
          id: head.id,
          version: head.version,
        });
      } catch {
        /* Offline/uncertain brokers retain their own durable barrier. */
      }
    }
    return supported;
  }
  async drain() {
    if (this.draining) return;
    this.draining = true;
    try {
      const unified = this.runtime.unified ? await this.drainUnified() : new Set<string>();
      for (const localId of new Set(this.read().map((i) => i.localId))) {
        if (unified.has(localId)) continue;
        const candidate = this.read().find((i) => i.localId === localId);
        if (!candidate || candidate.state !== "pending") continue;
        const pause = (reason: string) => {
          if (
            this.read().some(
              (i) => i.id === candidate.id && i.version === candidate.version,
            )
          )
            this.pauses.set(candidate.id, reason);
        };
        try {
          if (!(await this.runtime.idle(localId, candidate.actorId))) {
            pause("Waiting for the current turn or local queue");
            continue;
          }
        } catch {
          pause("Computer runtime unavailable");
          continue;
        }
        try {
          await this.runtime.authorize(candidate.permit, localId);
        } catch (error) {
          pause(
            error instanceof DomainError &&
              [401, 403, 404].includes(error.status)
              ? "Authorization expired or access removed; edit after signing in to authorize again"
              : "Waiting for hub authorization",
          );
          continue;
        } // No authorization while offline, revoked or expired: stays pending.
        // A terminal turn or local queue may have started while the hub answered.
        try {
          if (!(await this.runtime.idle(localId, candidate.actorId))) {
            pause("Waiting for the current turn or local queue");
            continue;
          }
        } catch {
          pause("Computer runtime unavailable");
          continue;
        }
        const committed = this.change((items) => {
          const first = items.find((i) => i.localId === localId);
          if (
            first?.id !== candidate.id ||
            first.version !== candidate.version ||
            first.state !== "pending"
          )
            return false;
          first.state = "dispatching";
          return true;
        });
        if (!committed) continue;
        this.pauses.delete(candidate.id);
        try {
          await this.runtime.send(localId, candidate.text, candidate.actorId);
          this.change((items) =>
            items.splice(
              items.findIndex((i) => i.id === candidate.id),
              1,
            ),
          );
        } catch (error) {
          this.change((items) => {
            const item = items.find((i) => i.id === candidate.id);
            if (item)
              item.state =
                error instanceof DomainError &&
                error.code === "queue_not_dispatched"
                  ? "pending"
                  : "unknown";
          });
          if (
            error instanceof DomainError &&
            error.code === "queue_not_dispatched"
          )
            pause(error.message);
        }
      }
    } finally {
      this.draining = false;
    }
  }
  async handle(request: HttpRequest): Promise<HttpResponse | undefined> {
    const match =
      /^\/api\/sessions\/([A-Za-z0-9_.:-]+)\/(enqueue|queue(?:\/(delete|update|move))?)$/.exec(
        request.path.split("?")[0]!,
      );
    if (!match) return;
    const localId = match[1]!;
    try {
      const unified = await this.supportsUnified(localId);
      if (unified) await this.migrate(localId);
      if (request.method === "POST") {
        let bytes = 0;
        const parts: Buffer[] = [];
        for await (const chunk of request.body) {
          bytes += chunk.byteLength;
          if (bytes > 1024 * 1024)
            throw new DomainError(
              413,
              "queue_body_too_large",
              "Queued request is too large",
            );
          parts.push(Buffer.from(chunk));
        }
        const body = JSON.parse(Buffer.concat(parts).toString());
        if (unified) {
          if (match[2] !== "enqueue" && !match[3])
            throw new DomainError(
              405,
              "invalid_method",
              "Unsupported queue operation",
            );
          await this.runtime.unified!.control(localId, match[2]!, {
            ...(match[2] === "enqueue"
              ? z.object({ text: z.string() }).parse(body)
              : z.object({ id: z.string().min(1).max(200), text: z.string().optional(),
                  to_index: z.number().int().nonnegative().optional(),
                  allow_commit_unknown: z.boolean().optional(), version: z.number().int().nonnegative().optional(),
                }).parse(body)),
            scope: this.scope,
            actorId: request.actorId ?? "",
            permit: request.queuePermit ?? "",
          });
        } else if (match[2] === "enqueue")
          this.enqueue(
            localId,
            z.object({ text: z.string() }).parse(body).text,
            request.actorId ?? "",
            request.queuePermit ?? "",
          );
        else if (match[3])
          this.mutate(
            localId,
            match[3],
            body,
            request.actorId,
            request.queuePermit,
          );
        else
          throw new DomainError(
            405,
            "invalid_method",
            "Unsupported queue operation",
          );
      } else if (
        !["GET", "HEAD"].includes(request.method) ||
        match[2] !== "queue"
      ) {
        throw new DomainError(
          405,
          "invalid_method",
          "Unsupported queue operation",
        );
      }
      const items = await this.listAsync(localId);
      return json(200, {
        ok: true,
        queued: true,
        items,
        queue: items.map((i) => i.text),
        queue_len: items.length,
      });
    } catch (e) {
      return json(e instanceof DomainError ? e.status : 400, {
        error: e instanceof Error ? e.message : "Invalid queue request",
        code: e instanceof DomainError ? e.code : "invalid_queue_request",
      });
    }
  }
  close() {
    this.db.close();
  }
}
function json(status: number, value: unknown): HttpResponse {
  const data = Buffer.from(JSON.stringify(value));
  return {
    status,
    headers: {
      "content-type": "application/json",
      "content-length": String(data.length),
    },
    body: {
      async *[Symbol.asyncIterator]() {
        yield data;
      },
    },
  };
}
