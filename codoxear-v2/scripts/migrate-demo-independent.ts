// One-time, non-destructive export of the existing Docker demo's hub catalogs.
// Existing Computer credentials and agent local IDs stay valid; shared sessions do not.
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Store } from "../src/persistence/store.js";
import { isolateHub } from "../src/hub/migration.js";
import { secret } from "../src/domain/commands.js";
if (!existsSync("/.dockerenv")) throw new Error("Docker only");
const base = process.env.CODOXEAR_DEMO_HOME ?? "/demo-data";
const destination = join(base, "independent");
if (existsSync(destination))
  throw new Error(
    "Independent migration destination already exists; refusing to overwrite",
  );
const source = new Store(join(base, "identity.sqlite"));
const snapshot = source.read();
source.close();
await mkdir(destination, { mode: 0o700 });
const ports = [];
const deployed = new Set<string>();
for (let i = 0; i < 2; i++) {
  const old = JSON.parse(await readFile(join(base, `hub-${i}.json`), "utf8"));
  deployed.add(old.hubId);
  const catalog = join(destination, `catalog-${i}.sqlite`),
    store = new Store(catalog);
  try {
    store.change((s) => Object.assign(s, isolateHub(snapshot, old.hubId)));
  } finally {
    store.close();
  }
  const origin = new URL(old.origin);
  const clientOrigin = origin.protocol + "//" + origin.hostname + ":8445";
  await writeFile(
    join(destination, `hub-${i}.json`),
    JSON.stringify({
      independent: true,
      origin: old.origin,
      hubId: old.hubId,
      catalog,
      database: join(destination, `sessions-${i}.sqlite`),
      signingKey: join(destination, `key-${i}.json`),
      otpKey: secret(),
      listenPort: 19530 + i,
      secureCookies: true,
      clientOrigins: [clientOrigin],
      clients: [
        { id: "codoxear-web", redirectUris: [clientOrigin + "/auth-callback"] },
      ],
    }),
    { mode: 0o600 },
  );
  ports.push({
    hubId: old.hubId,
    origin: old.origin,
    computers: snapshot.computers.filter((c) => c.hubId === old.hubId).length,
    agents: snapshot.agents.filter((a) => a.hubId === old.hubId).length,
  });
}
// Preserve catalogs for previously created, unhosted hubs. They need an operator
// supplied origin/configuration before they can be connected as independent hubs.
for (const hub of snapshot.hubs.filter((h) => !deployed.has(h.id))) {
  const saved = new Store(join(destination, "unhosted-" + hub.id + ".sqlite"));
  try {
    saved.change((s) => Object.assign(s, isolateHub(snapshot, hub.id)));
  } finally {
    saved.close();
  }
  ports.push({
    hubId: hub.id,
    origin: null,
    computers: snapshot.computers.filter((c) => c.hubId === hub.id).length,
    agents: snapshot.agents.filter((a) => a.hubId === hub.id).length,
  });
}
await writeFile(
  join(destination, "migration.json"),
  JSON.stringify(
    {
      at: new Date().toISOString(),
      sourceRevision: snapshot.revision,
      hubs: ports,
    },
    null,
    2,
  ),
  { mode: 0o600 },
);
console.log(
  "Exported independent hub catalogs; old database and agent processes unchanged.",
);
