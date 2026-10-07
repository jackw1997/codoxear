import "./testing/frontend-artifact.js";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { Authority } from "../src/identity/authority.js";
import {
  createHub,
  invite,
  acceptInvite,
  secret,
} from "../src/domain/commands.js";
if (!existsSync("/.dockerenv")) throw new Error("Only run fixtures in Docker");
const home = await mkdtemp(join(tmpdir(), "distributed-")),
  database = join(home, "identity.sqlite"),
  keyPath = join(home, "key.json"),
  issuer = "http://127.0.0.1:19420",
  store = new Store(database);
store.change((s) => {
  for (const name of ["alice", "bob"])
    s.users.push({
      id: name,
      name: name === "alice" ? "Alice" : "Bob",
      email: name + "@example.test",
      passwordHash: "",
      disabled: false,
    });
  for (const name of ["alice", "bob"])
    s.identity.identities.push({
      id: "fixture-google-" + name,
      userId: name,
      connection: "fixture-google",
      method: "google",
      subject: name,
      tenant: null,
      email: null,
      verifiedAt: Date.now(),
    });
});
const key = await signingKey(keyPath),
  accounts = new Accounts(store, secret(), {
    async send() {
      throw new Error("Not configured");
    },
  }),
  authority = new Authority(store, accounts, new Tokens(issuer, key)),
  aliceLogin = accounts.finish(
    {
      connection: "fixture-google",
      method: "google",
      subject: "alice",
      tenant: null,
      email: null,
      name: "Alice",
    },
    "fixture-alice",
  ),
  bobLogin = accounts.finish(
    {
      connection: "fixture-google",
      method: "google",
      subject: "bob",
      tenant: null,
      email: null,
      name: "Bob",
    },
    "fixture-bob",
  ),
  session = aliceLogin.session;
// Test-only browser credentials stay private; no production authentication bypass.
await writeFile(
  "artifacts/distributed-sessions.json",
  JSON.stringify({ alice: aliceLogin.credential, bob: bobLogin.credential }),
  { mode: 0o600 },
);
const hubs = store.change((s) => {
  const home = createHub(s, "alice", "Home hub"),
    work = createHub(s, "alice", "Work hub");
  acceptInvite(
    s,
    "bob",
    invite(
      s,
      "alice",
      "hub",
      home.id,
      {
        method: "google",
        connection: "fixture-google",
        subject: "bob",
        tenant: null,
      },
      "operator",
    ).token,
  );
  return [home, work];
});
const configs = [];
for (let i = 0; i < hubs.length; i++) {
  const hub = hubs[i]!,
    origin = "http://127.0.0.1:" + (19430 + i),
    registration = authority.registerHub(session, hub.id, origin);
  const path = join(home, "hub-" + i + ".json");
  await writeFile(
    path,
    JSON.stringify({
      ...registration,
      independent: false,
      identityUrl: issuer,
      database: join(home, "hub-" + i + ".sqlite"),
      listenPort: 19430 + i,
      secureCookies: false,
      development: true,
    }),
    { mode: 0o600 },
  );
  configs.push(path);
}
store.close();
const identityConfig = join(home, "identity.json");
await writeFile(
  identityConfig,
  JSON.stringify({
    issuer,
    database,
    signingKey: keyPath,
    listenPort: 19420,
    secureCookies: false,
  }),
  { mode: 0o600 },
);
const children = [
  spawn(process.execPath, ["dist/server/identity/main.js"], {
    env: { ...process.env, CODOXEAR_IDENTITY_CONFIG: identityConfig },
    stdio: "inherit",
  }),
  ...configs.map((path) =>
    spawn(process.execPath, ["dist/server/hub/main.js"], {
      env: { ...process.env, CODOXEAR_HUB_CONFIG: path },
      stdio: "inherit",
    }),
  ),
];
const stop = () => {
  for (const child of children)
    if (child.exitCode === null) child.kill("SIGTERM");
};
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
process.on("exit", stop);
for (const child of children)
  child.once("exit", (code) => {
    if (code) {
      process.exitCode = 1;
      stop();
    }
  });
