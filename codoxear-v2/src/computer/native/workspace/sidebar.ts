import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import { DomainError } from "../../../contracts/model.js";

type Entry = {
  alias?: string;
  priority_offset: number;
  snooze_until: number | null;
  dependency_session_id: string | null;
};
export class NativeSidebar {
  constructor(private directory: string) {}
  private read(): Record<string, Entry> {
    try {
      return JSON.parse(
        readFileSync(join(this.directory, "sidebar.json"), "utf8"),
      );
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw error;
    }
  }
  private write(entries: Record<string, Entry>) {
    const path = join(this.directory, "sidebar.json");
    writeFileSync(path + ".tmp", JSON.stringify(entries), { mode: 0o600 });
    renameSync(path + ".tmp", path);
  }
  edit(id: string, body: Record<string, unknown>, activeIds: Set<string>) {
    const invalid = (message: string): never => {
      throw new DomainError(400, "invalid_sidebar", message);
    };
    if (typeof body.name !== "string") invalid("name required");
    const alias = (body.name as string)
      .trim()
      .replace(/\s+/g, " ")
      .slice(0, 80)
      .trim();
    const number = (value: unknown, field: string) => {
      if (
        typeof value === "boolean" ||
        (typeof value !== "number" && typeof value !== "string")
      )
        invalid(`${field} must be a number`);
      const result = Number(value);
      if (!Number.isFinite(result)) invalid(`${field} must be finite`);
      return result;
    };
    const priority_offset =
      body.priority_offset == null
        ? 0
        : number(body.priority_offset, "priority_offset");
    if (priority_offset < -1 || priority_offset > 1)
      invalid("priority_offset must be within [-1, 1]");
    const snooze =
      body.snooze_until == null || body.snooze_until === ""
        ? 0
        : number(body.snooze_until, "snooze_until");
    const snooze_until = snooze > 0 ? snooze : null;
    if (
      body.dependency_session_id != null &&
      typeof body.dependency_session_id !== "string"
    )
      invalid("dependency_session_id must be a string or null");
    const dependency_session_id =
      (body.dependency_session_id as string | undefined)?.trim() || null;
    if (dependency_session_id === id)
      invalid("session cannot depend on itself");
    if (dependency_session_id && !activeIds.has(dependency_session_id))
      invalid("dependency session not found");
    const entries = this.read();
    entries[id] = {
      alias,
      priority_offset,
      snooze_until,
      dependency_session_id,
    };
    this.write(entries);
    return {
      ok: true,
      alias,
      priority_offset,
      snooze_until,
      dependency_session_id,
    };
  }
  rename(id: string, name: string) {
    const entries = this.read();
    entries[id] = {
      priority_offset: 0,
      snooze_until: null,
      dependency_session_id: null,
      ...entries[id],
      alias: name.trim().replace(/\s+/g, " ").slice(0, 80).trim(),
    };
    this.write(entries);
    return { ok: true, alias: entries[id]!.alias };
  }
  project(
    id: string,
    alias: string,
    updated: number,
    activeIds: Set<string>,
    now = Date.now() / 1000,
  ) {
    const entry = this.read()[id];
    const dependency_session_id =
      entry?.dependency_session_id &&
      entry.dependency_session_id !== id &&
      activeIds.has(entry.dependency_session_id)
        ? entry.dependency_session_id
        : null;
    const snooze_until =
      entry?.snooze_until && entry.snooze_until > now
        ? entry.snooze_until
        : null;
    const priority_offset = entry?.priority_offset ?? 0;
    const time_priority = Math.exp(
      (-Math.LN2 * (Math.floor(Math.max(0, now - updated) / 30) * 30)) /
        (8 * 3600),
    );
    const base_priority = Math.max(
      0,
      Math.min(1, time_priority + priority_offset),
    );
    return {
      alias: entry?.alias ?? alias,
      priority_offset,
      snooze_until,
      dependency_session_id,
      blocked: !!dependency_session_id,
      snoozed: !!snooze_until,
      time_priority,
      base_priority,
      final_priority: dependency_session_id || snooze_until ? 0 : base_priority,
    };
  }
}
