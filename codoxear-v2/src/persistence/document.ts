import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
/** A private transactional document for bounded local journals. No async work may run inside change. */
export class SqliteDocument<T> {
  private db: DatabaseSync;
  constructor(
    path: string,
    private key: string,
    initial: () => T,
  ) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS documents(key TEXT PRIMARY KEY,payload TEXT NOT NULL)",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO documents VALUES(?,?)")
      .run(key, JSON.stringify(initial()));
  }
  read(): T {
    return JSON.parse(
      (
        this.db
          .prepare("SELECT payload FROM documents WHERE key=?")
          .get(this.key) as { payload: string }
      ).payload,
    );
  }
  change<R>(fn: (value: T) => R): R {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = this.read(),
        result = fn(value);
      this.db
        .prepare("UPDATE documents SET payload=? WHERE key=?")
        .run(JSON.stringify(value), this.key);
      this.db.exec("COMMIT");
      return result;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
