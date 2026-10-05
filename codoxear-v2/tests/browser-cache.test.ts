import test from "node:test";
import assert from "node:assert/strict";
import { ConversationCache } from "../web/workspace/cache.js";
import {
  boundedSet,
  LOCAL_BUDGET,
  localBytes,
} from "../web/shared/local-storage.js";
class MemoryStorage implements Storage {
  values = new Map<string, string>();
  get length() {
    return this.values.size;
  }
  key(i: number) {
    return [...this.values.keys()][i] ?? null;
  }
  getItem(k: string) {
    return this.values.get(k) ?? null;
  }
  setItem(k: string, v: string) {
    this.values.set(k, v);
  }
  removeItem(k: string) {
    this.values.delete(k);
  }
  clear() {
    this.values.clear();
  }
}
test("conversation cache evicts least recently used agents and bounds event payloads", () => {
  const cache = new ConversationCache();
  for (const id of ["a", "b", "c"]) cache.set(id, { events: [{ text: id }] });
  cache.get("a");
  cache.set("d", {
    events: Array.from({ length: 250 }, (_, n) => ({
      text: String(n),
      history_cursor: String(n),
    })),
  });
  assert.deepEqual([...cache.keys()], ["c", "a", "d"]);
  assert.equal(cache.get("d").events.length, 200);
  assert.equal(cache.get("d").historyCursor, "50");
  cache.set("huge", { events: [{ text: "x".repeat(6 * 1024 * 1024) }] });
  assert.ok(cache.bytes <= cache.maxBytes);
  assert.ok(!cache.has("huge"));
});
test("directory removal drops cached content and rejects late responses", () => {
  const cache = new ConversationCache();
  cache.setDirectory([{ id: "allowed" }, { id: "removed" }]);
  cache.set("removed", { events: [{ text: "private" }] });
  cache.setDirectory([{ id: "allowed" }]);
  cache.set("removed", { events: [{ text: "late" }] });
  assert.equal(cache.has("removed"), false);
});
test("local budget rejects oversized writes without evicting unsent drafts", () => {
  const storage = new MemoryStorage(),
    key = '["codoxear-v2","account"]:codexweb.draft.a';
  boundedSet(storage, key, "unsent");
  assert.throws(() => boundedSet(storage, key, "x".repeat(LOCAL_BUDGET)), {
    name: "QuotaExceededError",
  });
  assert.equal(storage.getItem(key), "unsent");
  boundedSet(storage, "codoxear.ui.theme", "slate");
  assert.ok(localBytes(storage) <= LOCAL_BUDGET);
});
