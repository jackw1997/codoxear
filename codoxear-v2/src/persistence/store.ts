import { DatabaseSync } from "node:sqlite";
import { mkdirSync, chmodSync } from "node:fs";
import { dirname } from "node:path";
import { State, emptyState } from "../contracts/model.js";

// One authority owns this database. Every command loads and commits in a single
// SQLite transaction; no process-local cache can conceal another writer's edit.
export class Store {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path !== ":memory:")
      mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ":memory:") chmodSync(path, 0o600);
    this.db.exec(
      "PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000; CREATE TABLE IF NOT EXISTS catalog (id INTEGER PRIMARY KEY CHECK(id=1), payload TEXT NOT NULL);",
    );
    this.db
      .prepare("INSERT OR IGNORE INTO catalog(id,payload) VALUES(1,?)")
      .run(JSON.stringify(emptyState()));
  }
  read(): State {
    return State.parse(
      JSON.parse(
        (
          this.db.prepare("SELECT payload FROM catalog WHERE id=1").get() as {
            payload: string;
          }
        ).payload,
      ),
    );
  }
  change<T>(command: (state: State) => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const s = this.read();
      const result = command(s);
      s.revision += 1;
      State.parse(s);
      validateRelations(s);
      this.db
        .prepare("UPDATE catalog SET payload=? WHERE id=1")
        .run(JSON.stringify(s));
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }
  close(): void {
    this.db.close();
  }
}
function unique(values: string[], name: string): void {
  if (new Set(values).size !== values.length)
    throw new Error(`Duplicate ${name}`);
}
function validateRelations(s: State): void {
  unique(
    s.agentGrants.map((g) => `${g.agentId}:${g.userId}`),
    "agent grant",
  );
  for (const g of s.agentGrants)
    if (
      !s.agents.some((a) => a.id === g.agentId) ||
      !s.users.some((u) => u.id === g.userId)
    )
      throw new Error("Agent grant needs an existing agent and user");
  unique(
    s.identity.workspaceGrants.map((g) => `${g.computerId}:${g.userId}:${g.workspaceId}`),
    "workspace grant",
  );
  for (const g of s.identity.workspaceGrants)
    if (
      !s.computers.some((c) => c.id === g.computerId) ||
      !s.users.some((u) => u.id === g.userId)
    )
      throw new Error("Workspace grant needs an existing computer and user");
  for (const key of [
    "users",
    "hubs",
    "computers",
    "agents",
    "invitations",
  ] as const)
    unique(
      s[key].map((x) => x.id),
      key,
    );
  unique(
    s.users.map((x) => x.email),
    "email",
  );
  unique(
    s.memberships.map((m) => `${m.resource}:${m.resourceId}:${m.userId}`),
    "membership",
  );
  unique(
    s.priorGrants.map((g) => `${g.userId}:${g.agentId}`),
    "prior grant",
  );
  unique(
    s.identity.identities.map((i) => JSON.stringify([i.connection, i.subject])),
    "external identity",
  );
  unique(
    s.identity.identities.map((i) => i.id),
    "identity ID",
  );
  unique(
    s.identity.sessions.map((i) => i.id),
    "identity session",
  );
  unique(
    s.identity.sessions.map((i) => i.credentialHash),
    "identity credential",
  );
  unique(
    s.identity.hubs.map((h) => h.hubId),
    "hub registration",
  );
  unique(
    s.identity.requirements.map((h) => h.hubId),
    "hub login requirement",
  );
  unique(
    s.identity.refresh.map((r) => r.tokenHash),
    "refresh token",
  );
  unique(
    s.identity.codes.map((c) => c.hash),
    "authorization code",
  );
  const identitySessions = new Map(
    s.identity.sessions.map((session) => [session.id, session]),
  );
  for (const identity of s.identity.identities)
    if (!s.users.some((u) => u.id === identity.userId))
      throw new Error("Identity needs an existing user");
  for (const session of s.identity.sessions) {
    if (!s.users.some((u) => u.id === session.userId))
      throw new Error("Session needs an existing user");
    const visited = new Set<string>([session.id]);
    let parent = session.parentId;
    while (parent) {
      const source = identitySessions.get(parent);
      if (!source || source.userId !== session.userId || visited.has(parent))
        throw new Error("Invalid session ancestry");
      visited.add(parent);
      parent = source.parentId;
    }
  }
  for (const token of [...s.identity.refresh, ...s.identity.codes])
    if (!identitySessions.has(token.sessionId))
      throw new Error("Credential needs an existing session");
  for (const h of [...s.identity.hubs, ...s.identity.requirements])
    if (!s.hubs.some((hub) => hub.id === h.hubId))
      throw new Error("Identity metadata needs an existing hub");
  const users = new Set(s.users.map((u) => u.id)),
    hubs = new Set(s.hubs.map((h) => h.id));
  for (const h of s.hubs)
    if (!users.has(h.ownerId))
      throw new Error("Hub needs exactly one existing owner");
  for (const c of s.computers)
    if (!users.has(c.ownerId) || !hubs.has(c.hubId))
      throw new Error("Computer needs exactly one owner and hub");
  for (const a of s.agents)
    if (
      !s.computers.some((c) => c.id === a.computerId && c.hubId === a.hubId) ||
      !users.has(a.creatorId)
    )
      throw new Error("Invalid agent ancestry");
}
