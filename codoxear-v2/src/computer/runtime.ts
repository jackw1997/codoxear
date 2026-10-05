import { DatabaseSync } from "node:sqlite";
import { randomUUID } from "node:crypto";
import { type Notification } from "../protocol/notifications.js";
import { type Operation } from "../contracts/tunnel.js";

export interface Runtime {
  readonly kind: "native" | "fixture";
  execute(operation: Operation): Promise<unknown>;
  close(): void;
  supportsProviderLaunch?(): Promise<boolean>;
  completions?(since: number): Promise<Notification[]>;
}
// Explicit synthetic runtime for isolated UI/transport tests. It never claims
// to run a model or a native CLI. Production setup must select a real adapter.
export class FixtureRuntime implements Runtime {
  readonly kind = "fixture" as const;
  private db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(
      "CREATE TABLE IF NOT EXISTS messages(agent TEXT,id TEXT,role TEXT,text TEXT,at INTEGER); CREATE TABLE IF NOT EXISTS agents(id TEXT PRIMARY KEY);",
    );
  }
  async execute(op: Operation): Promise<unknown> {
    if (op.op === "resume-candidates") return { sessions: [] };
    if (op.op === "workspace") return { id: "default", path: null };
    if (op.op === "launch-status")
      throw new Error("Launch status belongs to the Computer journal");
    if (op.op === "discover")
      return {
        sessions: this.db
          .prepare("SELECT id AS session_id FROM agents")
          .all()
          .map((s) => ({ ...s, agent_backend: "fixture" })),
        new_session_defaults: {},
        recent_cwds: [],
        tmux_available: false,
      };
    if (op.op === "create") {
      if (op.backend !== "fixture")
        throw new Error("This test computer supports the fixture backend only");
      this.db.prepare("INSERT INTO agents(id) VALUES(?)").run(op.agentId);
      return { localId: op.agentId };
    }
    if (!this.db.prepare("SELECT id FROM agents WHERE id=?").get(op.localId))
      throw new Error("Unknown local agent");
    if (op.op === "messages")
      return {
        messages: this.db
          .prepare(
            "SELECT id,role,text,at FROM messages WHERE agent=? ORDER BY at,rowid",
          )
          .all(op.localId),
      };
    if (op.op === "send") {
      this.db.exec("BEGIN");
      try {
        const insert = this.db.prepare(
          "INSERT INTO messages VALUES(?,?,?,?,?)",
        );
        const at = Date.now();
        insert.run(op.localId, randomUUID(), "user", op.text, at);
        insert.run(
          op.localId,
          randomUUID(),
          "assistant",
          `Fixture response: ${op.text}`,
          at + 1,
        );
        this.db.exec("COMMIT");
      } catch (e) {
        this.db.exec("ROLLBACK");
        throw e;
      }
      return { accepted: true, synthetic: true };
    }
    return { interrupted: true };
  }
  close(): void {
    this.db.close();
  }
}
