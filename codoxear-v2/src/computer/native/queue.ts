import { randomUUID } from "node:crypto";
import { DomainError } from "../../contracts/model.js";

export type QueuedPrompt = {
  id: string;
  text: string;
  created_ts: number;
  version: number;
  state: "pending" | "dispatching" | "unknown";
  origin: "local" | "remote";
  actorId?: string;
  permit?: string;
  scope?: string;
  pause_reason?: string;
};
/** The broker is the sole ordering and dispatch writer. Persisting dispatching
 * precedes paste, so a crash can only leave an explicitly blocked uncertainty. */
export class BrokerQueue {
  readonly items: QueuedPrompt[];
  constructor(
    saved: unknown,
    private persist: () => void,
  ) {
    this.items = Array.isArray(saved)
      ? saved.map((item) => ({
          ...item,
          created_ts:
            item.created_ts ??
            (typeof item.at === "number" ? item.at / 1000 : Date.now() / 1000),
          origin: item.origin ?? "local",
          version: item.version ?? 0,
          state:
            item.state === "dispatching"
              ? "unknown"
              : (item.state ?? "pending"),
        }))
      : [];
  }
  list(scope?: string) {
    return this.items.map((item) => {
      const { permit: _, scope: binding, state, ...publicItem } = item;
      // A retained old-binding head still blocks dispatch; its contents belong
      // to the Computer owner, not a newly connected Hub.
      if (scope !== undefined && item.origin === "remote" && binding !== scope)
        return {
          id: item.id,
          text: "Retained queue item from a previous Hub binding. Review locally.",
          origin: item.origin,
          version: item.version,
          created_ts: item.created_ts,
          sending: state === "dispatching",
          commit_unknown: state === "unknown",
          pause_reason: "Previous Hub binding; review in the local terminal",
        };
      return {
        ...publicItem,
        sending: state === "dispatching",
        commit_unknown: state === "unknown",
        ...(state === "pending"
          ? { pause_reason: item.pause_reason ?? "Waiting to dispatch" }
          : {}),
      };
    });
  }
  enqueue(body: Record<string, unknown>, scope?: string) {
    const text = this.text(body.text);
    if (scope !== undefined && (!body.actorId || !body.permit))
      throw new DomainError(
        403,
        "queue_authorization_required",
        "Queue authorization required",
      );
    // Stable IDs make migration retryable without adding a second item.
    const id = typeof body.id === "string" ? body.id : randomUUID();
    const old = this.items.find((item) => item.id === id);
    if (old) return old.id;
    if (this.items.length >= 1000)
      throw new DomainError(429, "queue_full", "Queue is full");
    const before = structuredClone(this.items);
    for (const item of this.items) item.version++;
    this.items.push({
      id,
      text,
      created_ts: Number(body.created_ts) || Date.now() / 1000,
      version: 0,
      state: body.commit_unknown === true ? "unknown" : "pending",
      origin: scope === undefined ? "local" : "remote",
      ...(scope === undefined
        ? {}
        : {
            scope,
            actorId: String(body.actorId),
            permit: String(body.permit),
          }),
    });
    this.save(before);
    return id;
  }
  mutate(action: string, body: Record<string, unknown>, scope?: string) {
    const index = this.items.findIndex((item) => item.id === body.id),
      item = this.items[index];
    if (!item)
      throw new DomainError(
        404,
        "queue_item_missing",
        "Queue item no longer exists",
      );
    if (scope !== undefined && item.origin === "remote" && item.scope !== scope)
      throw new DomainError(
        403,
        "queue_binding_changed",
        "Review retained work in the local terminal",
      );
    if (body.version !== undefined && body.version !== item.version)
      throw new DomainError(
        409,
        "queue_changed",
        "Queue item changed; refresh before editing",
      );
    if (
      item.state !== "pending" &&
      !(
        item.state === "unknown" &&
        action === "delete" &&
        body.allow_commit_unknown === true
      )
    )
      throw new DomainError(
        409,
        "commit_unknown",
        "Review the transcript before removing an uncertain queued send",
      );
    const before = structuredClone(this.items);
    if (action === "delete") {
      this.items.splice(index, 1);
      for (const entry of this.items) entry.version++;
    } else if (action === "update") {
      const text = this.text(body.text);
      if (scope !== undefined && (!body.actorId || !body.permit))
        throw new DomainError(
          403,
          "queue_authorization_required",
          "Fresh queue authorization required",
        );
      item.text = text;
      if (scope !== undefined) {
        Object.assign(item, {
          origin: "remote",
          scope,
          actorId: String(body.actorId),
          permit: String(body.permit),
        });
      }
      item.version++;
      delete item.pause_reason;
    } else if (action === "move") {
      if (
        scope !== undefined &&
        this.items.some(
          (entry) => entry.origin === "remote" && entry.scope !== scope,
        )
      )
        throw new DomainError(
          403,
          "queue_binding_changed",
          "Review retained queue ordering in the local terminal",
        );
      if (this.items.some((entry) => entry.state !== "pending"))
        throw new DomainError(
          409,
          "queue_locked",
          "Resolve the in-flight queue item first",
        );
      const target = Number(body.to_index ?? body.index);
      if (
        !Number.isInteger(target) ||
        target < 0 ||
        target >= this.items.length
      )
        throw new DomainError(
          400,
          "invalid_position",
          "Invalid queue position",
        );
      this.items.splice(index, 1);
      this.items.splice(target, 0, item);
      for (const entry of this.items) entry.version++;
    } else
      throw new DomainError(
        400,
        "invalid_queue_operation",
        "Unknown queue operation",
      );
    this.save(before);
  }
  head(scope?: string) {
    const first = this.items[0];
    return first?.state === "pending" &&
      (scope === undefined
        ? first.origin === "local"
        : first.origin === "remote" && first.scope === scope)
      ? { ...first }
      : undefined;
  }
  claim(id: unknown, version: unknown, scope?: string) {
    const head = this.head(scope);
    if (!head || head.id !== id || head.version !== version)
      throw new DomainError(
        409,
        "queue_not_dispatched",
        "The queue changed before dispatch",
      );
    const before = structuredClone(this.items);
    this.items[0]!.state = "dispatching";
    this.save(before);
    return head;
  }
  finish(id: string, error?: unknown) {
    const index = this.items.findIndex((item) => item.id === id);
    if (index < 0) return;
    const before = structuredClone(this.items);
    if (!error) this.items.splice(index, 1);
    else {
      const item = this.items[index]!;
      item.state =
        error instanceof DomainError && error.code === "queue_not_dispatched"
          ? "pending"
          : "unknown";
      item.pause_reason =
        error instanceof Error ? error.message : "Dispatch outcome unknown";
    }
    try {
      this.persist();
    } catch (failure) {
      this.items.splice(0, this.items.length, ...before);
      this.items[index]!.state = "unknown";
      this.items[index]!.pause_reason =
        "Queue persistence failed after dispatch; review the transcript";
      try {
        this.persist();
      } catch {}
      throw failure;
    }
  }
  pause(id: unknown, version: unknown, reason: unknown, scope: string) {
    const item = this.head(scope);
    if (item && item.id === id && item.version === version) {
      this.items[0]!.pause_reason = String(reason).slice(0, 500);
      this.persist();
    }
  }
  private save(before: QueuedPrompt[]) {
    try {
      this.persist();
    } catch (error) {
      this.items.splice(0, this.items.length, ...before);
      throw error;
    }
  }
  private text(value: unknown) {
    if (typeof value !== "string" || !value.trim() || value.length > 200000)
      throw new DomainError(
        400,
        "invalid_message",
        "Enter a queued message (maximum 200000 characters)",
      );
    return value;
  }
}
