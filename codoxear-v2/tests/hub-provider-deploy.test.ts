import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, writeFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { configureHubProviders } from "../deploy/fresh-v2/hub-providers.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const provider = { kind: "feishu", id: "work", name: "Work", clientId: "app-id", clientSecret: "secret-sentinel", tenant: "work-tenant" };
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "hub-providers-"));
  await mkdir(join(root, "config")); await mkdir(join(root, "hub-0"));
  const config = { independent: true, hubId: "work-hub", origin: "https://work.test", setupToken: "setup-sentinel", providers: [], customSetting: "preserve" };
  await writeFile(join(root, "config/hub-0.json"), JSON.stringify(config));
  await writeFile(join(root, "hub-0/catalog.sqlite"), "existing-history");
  const providerFile = join(root, "providers.json");
  await writeFile(providerFile, JSON.stringify({ providers: [provider] }));
  return { root, providerFile, config };
}
test("direct Hub provider setup preserves independent state and permits secret rotation", async () => {
  const f = await fixture();
  try {
    const result = await configureHubProviders(f.root, 0, f.providerFile);
    assert.equal(JSON.stringify(result).includes("secret-sentinel"), false);
    const file = join(f.root, "config/hub-0.json");
    const config = JSON.parse(await readFile(file, "utf8"));
    assert.deepEqual(config, { ...f.config, providers: [provider] });
    assert.equal((await stat(file)).mode & 0o777, 0o600);
    assert.equal(await readFile(join(f.root, "hub-0/catalog.sqlite"), "utf8"), "existing-history");
    const first = await readFile(file, "utf8");
    await configureHubProviders(f.root, 0, f.providerFile);
    assert.equal(await readFile(file, "utf8"), first);
    await writeFile(f.providerFile, JSON.stringify({ providers: [{ ...provider, clientSecret: "rotated-secret" }] }));
    await configureHubProviders(f.root, 0, f.providerFile);
    assert.equal(JSON.parse(await readFile(file, "utf8")).providers[0].clientSecret, "rotated-secret");
    assert.deepEqual(JSON.parse(await readFile(file + ".before-hub-providers", "utf8")), f.config);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
test("provider setup rejects multiple Feishu organizations and application or tenant replacement", async () => {
  const f = await fixture();
  try {
    const file = join(f.root, "config/hub-0.json");
    const initial = await readFile(file, "utf8");
    await writeFile(f.providerFile, JSON.stringify({ providers: [provider, { ...provider, id: "other-org", clientId: "other-app", tenant: "other-tenant" }] }));
    await assert.rejects(configureHubProviders(f.root, 0, f.providerFile));
    assert.equal(await readFile(file, "utf8"), initial);
    await writeFile(f.providerFile, JSON.stringify({ providers: [provider] }));
    await configureHubProviders(f.root, 0, f.providerFile);
    const configured = await readFile(file, "utf8");
    for (const replacement of [{ ...provider, clientId: "other-app" }, { ...provider, tenant: "other-tenant" },
      { ...provider, id: "another-connection", clientId: "another-app", tenant: "other-tenant" }]) {
      await writeFile(f.providerFile, JSON.stringify({ providers: [replacement] }));
      await assert.rejects(configureHubProviders(f.root, 0, f.providerFile));
      assert.equal(await readFile(file, "utf8"), configured);
    }
    assert.equal(existsSync(join(f.root, "login")), false);
  } finally { await rm(f.root, { recursive: true, force: true }); }
});
