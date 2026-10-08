import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat, mkdir, writeFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProfile } from "../src/computer/managed/profiles.js";
import { savedLaunch, savedSettings } from "../src/computer/managed/settings.js";

assert.ok(
  existsSync("/.dockerenv"),
  "Provider/runtime verification runs only in Docker",
);
test("Discovered managed profiles retain their original caller key and private definitions across model and effort changes", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-details-profile-"));
  const fetcher = globalThis.fetch;
  const seen: { url: string; key: string }[] = [];
  globalThis.fetch = (async (url: URL, options: any) => {
    seen.push({ url: String(url), key: options.headers.Authorization });
    return new Response(JSON.stringify({ data: url.pathname.endsWith("/models") ? [{ id: "first" }, { id: "second" }, { id: "plain" }] : [...["first", "second"].map((model_group) => ({ model_group, supports_reasoning: true, supported_reasoning_efforts: ["high", "max"] })), { model_group: "plain", supports_reasoning: false, supported_reasoning_efforts: [] }] }));
  }) as typeof fetch;
  try {
    const native = join(home, ".pi", "agent");
    await mkdir(native, { recursive: true });
    const original = { providers: { gateway: { api: "anthropic-messages", baseUrl: "https://original.invalid/v1", apiKey: "original-private-key", models: [{ id: "first", reasoning: true }] }, unrelated: { api: "openai-completions", models: [{ id: "retained", contextWindow: 777 }] } }, customOption: "retained" };
    await writeFile(join(native, "models.json"), JSON.stringify(original));
    await writeFile(join(native, "settings.json"), JSON.stringify({ theme: "dark", proxy: "https://proxy.invalid" }));
    const input = { home, stateHome: home, cwd: home, backend: "pi" as const };
    const first = await prepareProfile({ ...input, model: "first", effort: "high", launch: { provider_catalog: true, model_provider: "gateway", model: "first", reasoning_effort: "high" } });
    const launch = (await savedLaunch(home, first.profile))!;
    assert.equal(launch.provider_config?.api_key, "original-private-key");
    await writeFile(join(native, "models.json"), JSON.stringify({ providers: { gateway: { ...original.providers.gateway, baseUrl: "https://changed.invalid/v1", apiKey: "changed-private-key" } } }));
    seen.length = 0;
    const changed = await prepareProfile({ ...input, profile: first.profile, model: "second", effort: "max" });
    assert.equal(changed.model, "codoxear_private/second");
    assert.equal(changed.effort, "max");
    assert.ok(seen.length >= 2);
    assert.ok(seen.every((entry) => entry.url.startsWith("https://original.invalid/") && entry.key === "Bearer original-private-key"));
    const privateModels = JSON.parse(await readFile(join(first.env.OAR_PI_AGENT_DIR!, "models.json"), "utf8"));
    assert.deepEqual(privateModels.providers.unrelated, original.providers.unrelated);
    assert.deepEqual(privateModels.providers.gateway, original.providers.gateway);
    assert.equal(privateModels.customOption, "retained");
    assert.equal(privateModels.providers.codoxear_private.models.length, 2);
    assert.equal(privateModels.providers.codoxear_private.models.find((entry: any) => entry.id === "second").thinkingLevelMap.max, "max");
    assert.deepEqual(JSON.parse(await readFile(join(first.env.OAR_PI_AGENT_DIR!, "settings.json"), "utf8")), { theme: "dark", proxy: "https://proxy.invalid" });
    const settings = await savedSettings(home, first.profile, "pi", changed.model!, "max", launch);
    assert.equal(settings.request?.api_key, "original-private-key");
    assert.ok(settings.catalog.models.find((entry) => entry.id === "second")!.runtime_reasoning_efforts!.includes("max"));
    assert.equal(JSON.stringify(settings.catalog).includes("original-private-key"), false);
    const disabled = await prepareProfile({ ...input, profile: first.profile, model: "plain", effort: "off" });
    assert.equal(disabled.effort, "off", "Cold resume explicitly disables the previous high/max thinking selection");
    const disabledModels = JSON.parse(await readFile(join(first.env.OAR_PI_AGENT_DIR!, "models.json"), "utf8"));
    assert.equal(disabledModels.providers.codoxear_private.models.find((entry: any) => entry.id === "plain").reasoning, false);
  } finally { globalThis.fetch = fetcher; await rm(home, { recursive: true, force: true }); }
});
test("Older named profiles rediscover only the explicit provider matching the saved private endpoint and model API", async () => {
  const home = await mkdtemp(join(tmpdir(), "managed-older-details-profile-"));
  try {
    const profile = "a".repeat(32), directory = join(home, "managed-profiles", profile);
    await mkdir(join(directory, "pi"), { recursive: true });
    const launch = { provider_catalog: true as const, model_provider: "gateway", model: "saved", reasoning_effort: "max" };
    await writeFile(join(directory, "launch.json"), JSON.stringify(launch));
    await writeFile(join(directory, "pi", "models.json"), JSON.stringify({ providers: { codoxear_private: { baseUrl: "https://saved.invalid/v1", api: "anthropic-messages", apiKey: "$CODOXEAR_PROVIDER_API_KEY", models: [{ id: "saved", reasoning: true, thinkingLevelMap: { off: null, minimal: null, low: "low", medium: null, high: "high", xhigh: null, max: "max" } }] } } }));
    await writeFile(join(directory, "pi", "auth.json"), "{}");
    await mkdir(join(home, ".pi", "agent"), { recursive: true });
    const path = join(home, ".pi", "agent", "models.json");
    const configured = { providers: { gateway: { baseUrl: "https://saved.invalid/v1", api: "openai-completions", apiKey: "rotated-caller-key", models: [{ id: "saved", api: "anthropic-messages" }] }, unrelated: { baseUrl: "https://saved.invalid/v1", api: "anthropic-messages", apiKey: "unrelated-admin-key" } } };
    await writeFile(path, JSON.stringify(configured));
    const read = () => savedSettings(home, profile, "pi", "codoxear_private/saved", "max", launch, home);
    const settings = await read();
    assert.equal(settings.model, "saved");
    assert.equal(settings.provider, "gateway");
    assert.equal(settings.request?.api_key, "rotated-caller-key");
    assert.deepEqual(settings.catalog.models[0]!.runtime_reasoning_efforts, ["low", "high", "max"]);
    assert.equal(settings.provenanceRequired, false);
    configured.providers.gateway.baseUrl = "https://changed.invalid/v1";
    await writeFile(path, JSON.stringify(configured));
    assert.equal((await read()).request, null);
    assert.equal((await read()).provenanceRequired, true);
    configured.providers.gateway.baseUrl = "https://saved.invalid/v1";
    configured.providers.gateway.models[0]!.api = "openai-completions";
    await writeFile(path, JSON.stringify(configured));
    assert.equal((await read()).request, null);
    assert.equal(JSON.stringify((await read()).catalog).includes("rotated-caller-key"), false);
  } finally { await rm(home, { recursive: true, force: true }); }
});
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

test('Named discovered Pi models use isolated revalidated definitions and retained local credentials on reopen',async t=>{
 const home=await mkdtemp(join(tmpdir(),'managed-discovered-'));t.after(()=>rm(home,{recursive:true,force:true}));
 const native=join(home,'.pi','agent');await mkdir(native,{recursive:true});
 const local={providers:{gateway:{baseUrl:'https://provider.invalid/v1',apiKey:'configured-secret',models:[{id:'old',reasoning:false}]}}};
 await writeFile(join(native,'models.json'),JSON.stringify(local));
 t.mock.method(globalThis,'fetch',async(url:URL)=>new Response(JSON.stringify({data:url.pathname.endsWith('/models')?[{id:'remote'}]:[{model_group:'remote',supports_reasoning:true,supported_reasoning_efforts:['low','high','max']}]})));
 const input={home,stateHome:home,cwd:home,backend:'pi' as const,model:'remote',effort:'max',launch:{provider_catalog:true as const,model_provider:'gateway'}};
 const profile=await prepareProfile(input);
 assert.equal(profile.model,'codoxear_private/remote');
 assert.equal(profile.env.CODOXEAR_PROVIDER_API_KEY,'configured-secret');
 const generated=JSON.parse(await readFile(join(profile.env.OAR_PI_AGENT_DIR!,'models.json'),'utf8'));
 assert.equal(generated.providers.codoxear_private.models[0].reasoning,true);
 assert.deepEqual(generated.providers.codoxear_private.models[0].thinkingLevelMap,{minimal:null,low:'low',medium:null,high:'high',xhigh:null,max:'max',off:null});
 assert.deepEqual(JSON.parse(await readFile(join(native,'models.json'),'utf8')),local);
 assert.equal((await prepareProfile({...input,profile:profile.profile})).model,'codoxear_private/remote');
 await assert.rejects(prepareProfile({...input,effort:'medium'}),/not advertised/);
});
