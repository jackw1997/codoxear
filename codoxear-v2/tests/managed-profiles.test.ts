import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProfile } from "../src/computer/managed/profiles.js";

assert.ok(
  existsSync("/.dockerenv"),
  "Provider/runtime verification runs only in Docker",
);
test("Pi explicit models inherit the configured provider, including cold reopen", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    const native = join(home, ".pi", "agent");
    await mkdir(native, { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ defaultProvider: "litellm", defaultModel: "kimi-k3" }));
    await writeFile(join(native, "models.json"), JSON.stringify({ providers: { litellm: { models: [{ id: "moonshot/kimi-k3" }] } } }));
    const input = { home, stateHome: home, cwd: home, backend: "pi" as const };
    for (const [model, expected] of [
      ["kimi-k3", "litellm/kimi-k3"],
      ["litellm/kimi-k3", "litellm/kimi-k3"],
      ["openrouter/other-model", "openrouter/other-model"],
      ["moonshot/kimi-k3", "litellm/moonshot/kimi-k3"],
    ] as const) {
      const result = await prepareProfile({ ...input, model });
      assert.equal(result.model, expected);
      const reopened = await prepareProfile({ ...input, model, profile: result.profile });
      assert.equal(reopened.model, expected);
    }
    assert.equal((await prepareProfile(input)).model, undefined);
    assert.equal((await prepareProfile({ ...input, model: "kimi-k3", launch: { model_provider: "other" } })).model, "other/kimi-k3");
    await writeFile(join(home, ".pi", "settings.json"), JSON.stringify({ defaultProvider: "project" }));
    assert.equal((await prepareProfile({ ...input, model: "kimi-k3" })).model, "project/kimi-k3");
    assert.equal(JSON.parse(await readFile(join(native, "settings.json"), "utf8")).defaultProvider, "litellm");
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("Pi bare models without a configured provider produce an actionable setup error", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    await assert.rejects(prepareProfile({ home, stateHome: home, cwd: home, backend: "pi", model: "kimi-k3" }), /Choose a Pi provider/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("managed Pi retains native settings in an isolated profile without delegation", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    const native = join(home, ".pi", "agent");
    await mkdir(native, { recursive: true });
    await writeFile(join(native, "settings.json"), JSON.stringify({ theme: "dark", proxy: "https://proxy.invalid" }));
    await writeFile(join(native, "auth.json"), JSON.stringify({ openai: { type: "api_key", key: "native-test-key" } }));
    const result = await prepareProfile({ home, stateHome: home, cwd: home, backend: "pi" });
    assert.notEqual(result.env.OAR_PI_AGENT_DIR, native);
    assert.deepEqual(JSON.parse(await readFile(join(result.env.OAR_PI_AGENT_DIR!, "settings.json"), "utf8")), { theme: "dark", proxy: "https://proxy.invalid" });
    assert.equal(JSON.parse(await readFile(join(result.env.OAR_PI_AGENT_DIR!, "auth.json"), "utf8")).openai.key, "native-test-key");
    await writeFile(join(result.env.OAR_PI_AGENT_DIR!, "settings.json"), "{}");
    assert.equal(JSON.parse(await readFile(join(native, "settings.json"), "utf8")).theme, "dark");
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("managed OAR executable pins honor native CLI configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    const result = await prepareProfile({ home, stateHome: home, cwd: home, backend: "codex", launch: { env_vars: { CODEX_BIN: "/configured/codex", CLAUDE_BIN: "/configured/claude" } } });
    assert.equal(result.env.OAR_CODEX_BIN, "/configured/codex");
    assert.equal(result.env.OAR_CLAUDE_BIN, "/configured/claude");
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("explicit managed provider and authentication selections must match saved runtime configuration", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-selection-"));
  try {
    await mkdir(join(home, ".codex"), { recursive: true });
    await writeFile(join(home, ".codex", "config.toml"), 'model = "configured-model"\nmodel_provider = "gateway"\n');
    const input = { home, stateHome: home, cwd: home, backend: "codex" as const, model: "configured-model" };
    assert.equal((await prepareProfile({ ...input, launch: { model_provider: "gateway" } })).model, "configured-model");
    await assert.rejects(prepareProfile({ ...input, launch: { model_provider: "other" } }), /must match/);
    await writeFile(join(home, ".codex", "config.toml"), 'model = "configured-model"\nmodel_provider = "openai"\n');
    await writeFile(join(home, ".codex", "auth.json"), JSON.stringify({ auth_mode: "chatgpt", tokens: { access_token: "fixture-token" } }));
    const selected = await prepareProfile({ ...input, launch: { model_provider: "openai", preferred_auth_method: "chatgpt" } });
    assert.equal(selected.model, "configured-model");
    await assert.rejects(prepareProfile({ ...input, launch: { model_provider: "openai", preferred_auth_method: "apikey" } }), /authentication method must match/);
    await mkdir(join(home, ".claude"), { recursive: true });
    await writeFile(join(home, ".claude", "settings.json"), JSON.stringify({ model: "private-claude", env: { ANTHROPIC_BASE_URL: "https://configured-provider.example", ANTHROPIC_API_KEY: "fixture-key" } }));
    const claude = { ...input, backend: "cc" as const, model: "private-claude" };
    assert.equal((await prepareProfile({ ...claude, launch: { model_provider: "configured-provider.example" } })).model, "private-claude");
    await assert.rejects(prepareProfile({ ...claude, launch: { model_provider: "other" } }), /must match/);
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("private Pi delegation extension loads from its installed entry", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    const result = await prepareProfile({ home, stateHome: home, cwd: home, backend: "pi", delegation: { descriptor: join(home, "unused-descriptor.json") } });
    const extension = await import(pathToFileURL(join(result.env.OAR_PI_AGENT_DIR!, "extensions", "codoxear-delegation.ts")).href);
    assert.equal(typeof extension.default, "function");
  } finally { await rm(home, { recursive: true, force: true }); }
});
test("Pi private providers have separate homes and survive cold reopen without duplicating provider prefixes", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    const input = {
      home,
      stateHome: home,
      cwd: home,
      backend: "pi" as const,
      model: "private-model",
      launch: {
        model: "private-model",
        provider_config: {
          base_url: "https://provider.invalid/v1",
          api_key: "test-key-one",
        },
      },
    };
    const first = await prepareProfile(input);
    const second = await prepareProfile({
      ...input,
      launch: {
        ...input.launch,
        provider_config: {
          ...input.launch.provider_config,
          api_key: "test-key-two",
        },
      },
    });
    assert.notEqual(first.env.OAR_PI_AGENT_DIR, second.env.OAR_PI_AGENT_DIR);
    assert.equal(first.env.CODOXEAR_PROVIDER_API_KEY, "test-key-one");
    assert.equal(second.env.CODOXEAR_PROVIDER_API_KEY, "test-key-two");
    const reopened = await prepareProfile({
      home,
      stateHome: home,
      cwd: home,
      backend: "pi",
      model: first.model!,
      profile: first.profile,
    });
    assert.equal(reopened.model, "codoxear_private/private-model");
    assert.equal(reopened.env.CODOXEAR_PROVIDER_API_KEY, "test-key-one");
    const modelsText = await readFile(
      join(first.env.OAR_PI_AGENT_DIR!, "models.json"),
      "utf8",
    );
    assert.equal(modelsText.includes("test-key-one"), false);
    assert.equal(
      JSON.parse(modelsText).providers.codoxear_private.models[0].id,
      "private-model",
    );
    assert.equal(JSON.parse(modelsText).providers.codoxear_private.apiKey, "$CODOXEAR_PROVIDER_API_KEY");
    assert.equal(
      (await stat(join(home, "managed-profiles", first.profile, "launch.json")))
        .mode & 0o777,
      0o600,
    );
    assert.equal(
      (await stat(join(home, "managed-profiles", first.profile))).mode & 0o777,
      0o700,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("Codex private endpoint has an isolated config with an environment key reference", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    const result = await prepareProfile({
      home,
      stateHome: home,
      cwd: home,
      backend: "codex",
      model: "custom-model",
      launch: {
        provider_config: {
          base_url: "https://provider.invalid/v1",
          api_key: "private-test-key",
        },
      },
    });
    const config = await readFile(
      join(result.env.CODEX_HOME!, "config.toml"),
      "utf8",
    );
    assert.match(config, /wire_api = "responses"/);
    assert.match(config, /env_key = "CODOXEAR_PROVIDER_API_KEY"/);
    assert.equal(config.includes("private-test-key"), false);
    assert.equal(result.env.CODOXEAR_PROVIDER_API_KEY, "private-test-key");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
test("managed profiles refuse policy-changing environment and unsupported launch options", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-provider-"));
  try {
    const base = { home, stateHome: home, cwd: home, backend: "pi" as const };
    await assert.rejects(
      prepareProfile({
        ...base,
        launch: { env_vars: { OAR_CODEX_SANDBOX: "danger-full-access" } },
      }),
      /cannot be overridden/,
    );
    await assert.rejects(
      prepareProfile({ ...base, launch: { service_tier: "fast" } }),
      /cannot honor/,
    );
    await assert.rejects(
      prepareProfile({ ...base, profile: "../../escape" }),
      /Invalid managed profile/,
    );
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
