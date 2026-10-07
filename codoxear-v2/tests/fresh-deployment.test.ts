import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, writeFile, readFile, stat, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { generateFreshState } from "../deploy/fresh-v2/bootstrap.js";
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
    await generateFreshState(target, undefined, source);
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
    assert.equal((await stat(join(target, "private/owner.json"))).mode & 0o777, 0o600);
    assert.equal(existsSync(join(target, "old-catalog.sqlite")), false);
    await assert.rejects(generateFreshState(target, undefined, source), /already exists/);
    assert.equal(await readFile(join(source, "pi-litellm-launch.json"), "utf8"), bytes);
  } finally { await rm(source, { recursive: true, force: true }); }
});
