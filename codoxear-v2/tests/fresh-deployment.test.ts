import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFreshState } from "../deploy/fresh-v2/bootstrap.js";
import { provisionFreshState } from "../deploy/fresh-v2/provision.js";
import { Store } from "../src/persistence/store.js";
import { digest } from "../src/domain/commands.js";
import { canCreate } from "../src/domain/policy.js";
import { prepareFreshGateway } from "../deploy/fresh-v2/gateway.js";
assert.ok(existsSync("/.dockerenv"), "Fresh deployment tests run only in Docker");
test("fresh generation preserves origins and provider defaults without importing state", async () => {
  const source = await mkdtemp(join(tmpdir(), "fresh-input-"));
  const target = join(source, "new");
  try {
    const origins = { client: "https://example.test:8445", guide: "https://example.test:8444/guide", hubs: ["https://example.test:8446", "https://example.test:8447"] };
    const launch = { model: "saved-model", reasoning_effort: "high", provider_config: { base_url: "https://provider.example.test/v1", api_key: "private-key-sentinel", api: "openai-completions", image_support: true } };
    await writeFile(join(source, "public-origins.json"), JSON.stringify(origins));
    const bytes = JSON.stringify(launch);
    await writeFile(join(source, "pi-litellm-launch.json"), bytes);
    await writeFile(join(source, "old-catalog.sqlite"), "old history must stay separate");
    await generateFreshState(target, source);
    assert.equal(await readFile(join(target, "private/pi-litellm-launch.json"), "utf8"), bytes);
    const ids = [];
    for (let i = 0; i < 2; i++) {
      const config = JSON.parse(await readFile(join(target, `config/hub-${i}.json`), "utf8"));
      assert.equal(config.origin, origins.hubs[i]);
      assert.equal(JSON.stringify(config).includes("private-key-sentinel"), false);
      ids.push(config.hubId);
      assert.equal(existsSync(join(target, `hub-${i}/catalog.sqlite`)), false);
    }
    assert.notEqual(ids[0], ids[1]);
    for (const computer of ["computer-a", "computer-b"]) {
      const models = JSON.parse(await readFile(join(target, `${computer}/.pi/agent/models.json`), "utf8"));
      assert.equal(models.providers.litellm.apiKey, launch.provider_config.api_key);
      const settings = JSON.parse(await readFile(join(target, `${computer}/.pi/agent/settings.json`), "utf8"));
      assert.equal(settings.defaultModel, launch.model);
      assert.equal(settings.defaultThinkingLevel, "high");
    }
    assert.equal((await stat(join(target, "private/initialization.json"))).mode & 0o777, 0o600);
    assert.equal(existsSync(join(target, "old-catalog.sqlite")), false);
    await prepareFreshGateway(target);
    const gatewayFile = join(target, "gateway/Caddyfile");
    const gatewayBytes = await readFile(gatewayFile, "utf8");
    assert.equal(gatewayBytes.includes("private-key-sentinel"), false);
    assert.equal(gatewayBytes.includes("reverse_proxy hub-0:17430"), true);
    assert.equal(gatewayBytes.includes("reverse_proxy hub-1:17430"), true);
    assert.equal(gatewayBytes.includes("reverse_proxy client:19520"), true);
    assert.equal(gatewayBytes.includes("handle /guide"), true);
    assert.equal((await stat(gatewayFile)).mode & 0o777, 0o600);
    await prepareFreshGateway(target);
    assert.equal(await readFile(gatewayFile, "utf8"), gatewayBytes);
    await writeFile(gatewayFile, "operator-edited configuration");
    await assert.rejects(prepareFreshGateway(target), /refusing to overwrite/);
    assert.equal(await readFile(gatewayFile, "utf8"), "operator-edited configuration");
    await assert.rejects(generateFreshState(target, source), /already exists/);
    assert.equal(await readFile(join(source, "pi-litellm-launch.json"), "utf8"), bytes);
    assert.deepEqual(await provisionFreshState(target), { alreadyProvisioned: false });
    const receiptBytes = await readFile(join(target, "provision-receipt.json"), "utf8");
    const receipt = JSON.parse(receiptBytes);
    const owner = JSON.parse(await readFile(join(target, "private/initialization.json"), "utf8"));
    const store = new Store(join(target, "hub-0/catalog.sqlite"));
    try {
      const state = store.read();
      assert.equal(state.users.length, 1);
      assert.equal(state.users[0]!.passwordHash, "");
      assert.equal(state.users[0]!.disabled, true);
      assert.equal(state.computers.length, 2);
      for (const name of ["computer-a", "computer-b"]) {
        const attachment = JSON.parse(await readFile(join(target, name, "computer/attachment.json"), "utf8"));
        const computer = state.computers.find(c => c.id === attachment.computerId)!;
        assert.equal(attachment.hubId, receipt.hubs[0].hubId);
        assert.equal(computer.credentialHash, digest(attachment.credential));
        assert.equal(canCreate(state, state.users[0]!.id, computer), false);
        assert.equal(attachment.oarMaxResident, 1);
        assert.equal(attachment.runtime, "oar");
        assert.equal(JSON.stringify(attachment).includes(new URL(owner.hubs[0].url).searchParams.get("token")!), false);
      }
    } finally { store.close(); }
    assert.deepEqual(await provisionFreshState(target), { alreadyProvisioned: true });
    assert.equal(await readFile(join(target, "provision-receipt.json"), "utf8"), receiptBytes);
    await writeFile(join(target, "provision-receipt.json"), JSON.stringify({ status: "pending" }));
    await assert.rejects(provisionFreshState(target), /partial or invalid/);
    await rm(join(target, "provision-receipt.json"));
    await assert.rejects(provisionFreshState(target), /not empty/);
  } finally { await rm(source, { recursive: true, force: true }); }
});
