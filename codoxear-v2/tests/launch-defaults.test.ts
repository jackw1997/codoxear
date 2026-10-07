import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { readLaunchDefaults } from "../src/computer/native/launch-defaults.js";

assert.ok(existsSync("/.dockerenv"), "Launch configuration behavior must be tested in Docker");
async function fixture(t: { after: (fn: () => Promise<void>) => void }) {
  const home = await mkdtemp(join(tmpdir(), "launch-defaults-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const put = async (path: string, value: unknown) => {
    const target = join(home, path);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, typeof value === "string" ? value : JSON.stringify(value));
  };
  return { home, workspace, put };
}

test("absent configuration has no invented provider, model, auth or backend selection", async t => {
  const f = await fixture(t), defaults = readLaunchDefaults(f.home, f.workspace, {});
  assert.equal("default_backend" in defaults, false);
  for (const backend of Object.values(defaults.backends)) {
    assert.equal(backend.model, null);
    assert.equal(backend.model_provider, null);
    assert.equal(backend.provider_choice, null);
    assert.equal(backend.reasoning_effort, null);
    assert.equal(backend.preferred_auth_method, null);
    assert.deepEqual(backend.provider_choices, []);
    assert.deepEqual(backend.models, []);
    assert.deepEqual(backend.reasoning_efforts, []);
  }
});

test("Pi exposes exact dynamic provider identities, configured model and off thinking without secrets", async t => {
  const f = await fixture(t);
  await f.put(".pi/agent/settings.json", { defaultProvider: "litellm", defaultModel: "team/kimi", defaultThinkingLevel: "off" });
  await f.put(".pi/agent/models.json", { providers: {
    litellm: { apiKey: "secret-pi-key", baseUrl: "https://provider.invalid", models: [{ id: "team/kimi", reasoning: false }] },
    Zai: { apiKey: "secret-zai-key", models: [{ id: "glm", reasoning: true, thinkingLevelMap: { xhigh: "high", max: null } }] },
    Micu: { models: [{ id: "model-with-no-reasoning" }] },
  } });
  await f.put(".pi/agent/auth.json", { Openai: { type: "api_key", key: "secret-openai-key" }, "oauth-provider": { type: "oauth", access: "secret-oauth" } });
  const defaults = readLaunchDefaults(f.home, f.workspace, {}), pi = defaults.backends.pi;
  assert.equal(pi.model_provider, "litellm");
  assert.equal(pi.provider_choice, "litellm");
  assert.equal(pi.model, "team/kimi");
  assert.equal(pi.reasoning_effort, "off");
  assert.deepEqual(pi.provider_choices, ["litellm", "Zai", "Micu", "Openai", "oauth-provider"]);
  assert.deepEqual(pi.provider_models.litellm, ["team/kimi"]);
  assert.deepEqual(pi.provider_models.Zai, ["glm"]);
  assert.deepEqual(pi.reasoning_efforts_by_model["litellm/team/kimi"], ["off"]);
  assert.deepEqual(pi.reasoning_efforts_by_model["Micu/model-with-no-reasoning"], ["off"]);
  assert.deepEqual(pi.reasoning_efforts_by_model["Zai/glm"], ["off", "xhigh"]);
  const advertised = JSON.stringify(defaults);
  for (const credential of ["secret-pi-key", "secret-zai-key", "secret-openai-key", "secret-oauth", "provider.invalid"])
    assert.equal(advertised.includes(credential), false);
});

test("Pi workspace selection and model-specific thinking override global settings", async t => {
  const f = await fixture(t);
  await f.put(".pi/agent/settings.json", { defaultProvider: "global", defaultModel: "global-model", defaultThinkingLevel: "high" });
  await f.put("workspace/.pi/settings.json", { defaultProvider: "local", defaultModel: "local-model", modelThinkingLevels: { "local/local-model": "off" } });
  const pi = readLaunchDefaults(f.home, f.workspace, {}).backends.pi;
  assert.equal(pi.provider_choice, "local");
  assert.deepEqual(pi.provider_models, { local: ["local-model"] });
  assert.equal(pi.reasoning_effort, "off");
});

test("Codex reads active profile scalars and does not confuse nested keys or multiline strings with root settings", async t => {
  const f = await fixture(t);
  await f.put(".codex/config.toml", `profile = 'work'\nmodel = "root-model"\nmodel_provider = "gateway"\nmodel_reasoning_effort = "low"\n[model_providers.gateway]\nmodel = "nested-wrong-model"\nmodel_provider = "nested-wrong-provider"\napi_key = "secret-codex"\n[profiles.work]\nmodel = 'selected#model' # comment\nmodel_reasoning_effort = 'high'\n[profiles.other]\nmodel = "other-model"\n`);
  const codex = readLaunchDefaults(f.home, f.workspace, {}).backends.codex;
  assert.equal(codex.model, "selected#model");
  assert.equal(codex.model_provider, "gateway");
  assert.equal(codex.reasoning_effort, "high");
  assert.equal(codex.preferred_auth_method, null);
  assert.deepEqual(codex.provider_choices, ["gateway"]);
  assert.deepEqual(codex.provider_models, { gateway: ["selected#model"] });
  await f.put(".codex/config.toml", `description = """\nmodel = "fake-string-model"\n"""\n[projects."/workspace"]\nmodel = "nested-only"\n`);
  assert.equal(readLaunchDefaults(f.home, f.workspace, {}).backends.codex.model, null);
});

test("Codex exposes known authentication and its cached model capabilities only for OpenAI", async t => {
  const f = await fixture(t);
  await f.put(".codex/config.toml", 'model = "model-a"\nmodel_reasoning_effort = "high"\n');
  await f.put(".codex/auth.json", { auth_mode: "chatgpt", tokens: { access_token: "secret-codex-token" } });
  await f.put(".codex/models_cache.json", { models: [
    { slug: "model-a", visibility: "list", supported_reasoning_levels: [{ effort: "low" }, { effort: "high" }] },
    { slug: "model-b", visibility: "list", supported_reasoning_levels: [{ effort: "medium" }] },
    { slug: "hidden-model", visibility: "hide" },
  ] });
  const defaults = readLaunchDefaults(f.home, f.workspace, {}), codex = defaults.backends.codex;
  assert.equal(codex.model_provider, "openai");
  assert.equal(codex.provider_choice, "chatgpt");
  assert.equal(codex.preferred_auth_method, "chatgpt");
  assert.deepEqual(codex.provider_models.chatgpt, ["model-a", "model-b"]);
  assert.deepEqual(codex.reasoning_efforts_by_model["chatgpt/model-a"], ["low", "high"]);
  assert.equal(JSON.stringify(defaults).includes("secret-codex-token"), false);
  await f.put(".codex/config.toml", 'model_provider = "gateway"\nmodel = "gateway-model"\n');
  assert.deepEqual(readLaunchDefaults(f.home, f.workspace, {}).backends.codex.models, ["gateway-model"]);
});

test("Claude resolves configured endpoint identity, nested env sources and model without exposing keys", async t => {
  const f = await fixture(t);
  await f.put(".claude/settings.json", { model: "configured-model", effortLevel: "low", env: { ANTHROPIC_BASE_URL: "https://litellm.example.invalid/api", ANTHROPIC_API_KEY: "secret-claude", ANTHROPIC_MODEL: "environment-model" } });
  await f.put("workspace/.claude/settings.json", { env: { UNRELATED_FLAG: "1" } });
  await f.put("workspace/.claude/settings.local.json", { effortLevel: "high" });
  const defaults = readLaunchDefaults(f.home, f.workspace, {}), cc = defaults.backends.cc;
  assert.equal(cc.provider_choice, "litellm.example.invalid");
  assert.equal(cc.model, "environment-model");
  assert.equal(cc.reasoning_effort, "high");
  assert.deepEqual(cc.provider_models, { "litellm.example.invalid": ["environment-model"] });
  assert.equal(JSON.stringify(defaults).includes("secret-claude"), false);
  assert.equal(readLaunchDefaults(f.home, f.workspace, { CLAUDE_CODE_USE_VERTEX: "1", ANTHROPIC_MODEL: "vertex-model" }).backends.cc.provider_choice, "vertex");
});
