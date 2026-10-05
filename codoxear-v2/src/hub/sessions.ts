import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { secret, digest } from "../domain/commands.js";
export interface HubSession {
  identityToken: string;
  refreshToken: string;
  hubToken: string;
  tokenExpiresAt: number;
  expiresAt: number;
}
export class HubSessions {
  private db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS browser_sessions(hash TEXT PRIMARY KEY,payload TEXT NOT NULL);CREATE TABLE IF NOT EXISTS login_flows(hash TEXT PRIMARY KEY,payload TEXT NOT NULL);",
    );
  }
  create(value: HubSession) {
    const token = secret();
    this.db
      .prepare("INSERT INTO browser_sessions VALUES(?,?)")
      .run(digest(token), JSON.stringify(value));
    return token;
  }
  get(token: string): HubSession | null {
    const row = this.db
      .prepare("SELECT payload FROM browser_sessions WHERE hash=?")
      .get(digest(token)) as { payload: string } | undefined;
    if (!row) return null;
    const value = JSON.parse(row.payload) as HubSession;
    return value.expiresAt > Date.now() ? value : null;
  }
  update(token: string, value: HubSession) {
    this.db
      .prepare("UPDATE browser_sessions SET payload=? WHERE hash=?")
      .run(JSON.stringify(value), digest(token));
  }
  delete(token: string) {
    this.db
      .prepare("DELETE FROM browser_sessions WHERE hash=?")
      .run(digest(token));
  }
  flow(
    state: string,
    value: {
      browserHash: string;
      verifier: string;
      expiresAt: number;
      destination?: string;
    },
  ) {
    this.db
      .prepare("INSERT INTO login_flows VALUES(?,?)")
      .run(digest(state), JSON.stringify(value));
  }
  consume(state: string, browser: string) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const row = this.db
        .prepare("SELECT payload FROM login_flows WHERE hash=?")
        .get(digest(state)) as { payload: string } | undefined;
      const value = row
        ? (JSON.parse(row.payload) as {
            destination?: string;
            browserHash: string;
            verifier: string;
            expiresAt: number;
          })
        : null;
      if (
        !value ||
        value.browserHash !== digest(browser) ||
        value.expiresAt <= Date.now()
      ) {
        this.db.exec("COMMIT");
        return null;
      }
      this.db
        .prepare("DELETE FROM login_flows WHERE hash=?")
        .run(digest(state));
      this.db.exec("COMMIT");
      return value;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }
  close() {
    this.db.close();
  }
}
