import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultsFor,
  modelsFor,
  providersFor,
  effortsFor,
  launchOptions,
  type BackendDefaults,
} from "../frontend/web/shared/agent-options.js";
const pi: BackendDefaults = {
  provider_choice: "a",
  model: "same-name",
  provider_choices: ["a", "b"],
  models: ["same-name", "a-only", "b-only"],
  provider_models: { a: ["same-name", "a-only"], b: ["same-name", "b-only"] },
  reasoning_efforts: ["off", "low", "high"],
  reasoning_efforts_by_model: {
    "a/same-name": ["off"],
    "b/same-name": ["low", "high"],
  },
};
const empty = { provider: "", model: "", effort: "", fast: false, cwd: "" };
test("provider/model catalogs preserve namespaces and constrain reasoning to the selected model", () => {
  assert.deepEqual(modelsFor(pi, "b"), ["same-name", "b-only"]);
  assert.deepEqual(modelsFor(pi, ""), []);
  assert.deepEqual(modelsFor(pi, "missing"), []);
  assert.deepEqual(effortsFor(pi, "a", "same-name"), ["off"]);
  assert.deepEqual(effortsFor(pi, "b", "same-name"), ["low", "high"]);
  assert.deepEqual(effortsFor(pi, "", ""), ["off"]);
  assert.equal(defaultsFor({}, "cc").reasoning_efforts, undefined);
  assert.deepEqual(providersFor(pi, "pi"), ["a", "b", "__custom_api__"]);
  assert.deepEqual(providersFor({}, "codex"), ["__custom_api__"]);
  assert.deepEqual(providersFor({ model_provider: "anthropic" }, "cc"), [
    "anthropic",
    "__custom_api__",
  ]);
});
test("provider, model and supported reasoning must be explicit", () => {
  assert.throws(() => launchOptions("pi", pi, empty), /Choose a provider/);
  assert.throws(
    () => launchOptions("pi", pi, { ...empty, provider: "a" }),
    /Choose a model/,
  );
  assert.deepEqual(
    launchOptions("pi", pi, {
      ...empty,
      provider: "a",
      model: "same-name",
      effort: "off",
    }),
    {
      model_provider: "a",
      model: "same-name",
      reasoning_effort: "off",
    },
  );
  assert.throws(
    () =>
      launchOptions("pi", pi, { ...empty, provider: "b", model: "same-name" }),
    /Choose a reasoning level/,
  );
  assert.throws(
    () =>
      launchOptions("pi", pi, { ...empty, provider: "missing", model: "x" }),
    /configured/,
  );
  assert.throws(
    () =>
      launchOptions("pi", pi, {
        ...empty,
        provider: "a",
        model: "same-name",
        effort: "high",
      }),
    /supported/,
  );
  assert.deepEqual(
    launchOptions("pi", pi, {
      ...empty,
      provider: "b",
      model: "custom/id",
      effort: "high",
      cwd: " /project ",
    }),
    {
      model_provider: "b",
      model: "custom/id",
      reasoning_effort: "high",
      cwd: "/project",
    },
  );
});
test("Codex auth and Fast settings map to CLI options; unsupported Fast never leaks", () => {
  const codex = {
    provider_choices: ["chatgpt", "openai-api", "gateway"],
    supports_fast: true,
  };
  assert.deepEqual(
    launchOptions("codex", codex, {
      ...empty,
      provider: "chatgpt",
      model: "selected-model",
      fast: true,
    }),
    {
      model: "selected-model",
      model_provider: "openai",
      preferred_auth_method: "chatgpt",
      service_tier: "fast",
    },
  );
  assert.deepEqual(
    launchOptions("codex", codex, {
      ...empty,
      provider: "openai-api",
      model: "selected-model",
    }),
    {
      model: "selected-model",
      model_provider: "openai",
      preferred_auth_method: "apikey",
    },
  );
  assert.deepEqual(
    launchOptions("codex", codex, {
      ...empty,
      provider: "gateway",
      model: "selected-model",
    }),
    { model: "selected-model", model_provider: "gateway" },
  );
  assert.deepEqual(
    launchOptions(
      "cc",
      { provider_choices: ["gateway"] },
      { ...empty, provider: "gateway", model: "claude-custom", fast: true },
    ),
    { model: "claude-custom", model_provider: "gateway", service_tier: "fast" },
  );
});

for (const backend of ["pi", "codex", "cc"] as const) {
  test(`${backend} accepts a private endpoint and key without computer configuration`, () => {
    const launch = launchOptions(
      backend,
      {},
      {
        ...empty,
        provider: "__custom_api__",
        model: "PrivateModel",
        apiUrl: "https://private.test/v1/",
        apiKey: "test-key",
        envVars: { EXTRA: "value" },
        command: "my-claude",
      },
    );
    assert.equal(launch.model, "PrivateModel");
    assert.deepEqual(launch.provider_config, {
      base_url: "https://private.test/v1",
      api_key: "test-key",
      ...(backend === "pi"
        ? { api: "openai-completions", image_support: false }
        : {}),
    });
    assert.deepEqual(launch.env_vars, { EXTRA: "value" });
    assert.equal(launch.command, backend === "cc" ? "my-claude" : undefined);
    assert.equal(launch.model_provider, undefined);
    for (const apiUrl of [
      "bad",
      "file:///etc/passwd",
      "https://key:secret@private.test",
    ])
      assert.throws(
        () =>
          launchOptions(
            backend,
            {},
            {
              ...empty,
              provider: "__custom_api__",
              model: "x",
              apiUrl,
              apiKey: "test-key",
            },
          ),
        /API URL/,
      );
    assert.throws(
      () =>
        launchOptions(
          backend,
          {},
          {
            ...empty,
            provider: "__custom_api__",
            model: "x",
            apiUrl: "https://private.test",
          },
        ),
      /API key/,
    );
    assert.throws(
      () =>
        launchOptions(
          backend,
          {},
          {
            ...empty,
            provider: "__custom_api__",
            apiUrl: "https://private.test",
            apiKey: "test-key",
          },
        ),
      /Choose a model/,
    );
  });
}
test("Configured Pi provider keys and compatibility options are forwarded", () => {
  assert.deepEqual(
    launchOptions(
      "pi",
      { provider_choices: ["deepseek"] },
      {
        ...empty,
        provider: "deepseek",
        model: "deepseek-chat",
        apiKey: "test-key",
      },
    ),
    {
      model_provider: "deepseek",
      model: "deepseek-chat",
      provider_config: { api_key: "test-key" },
    },
  );
  const launch = launchOptions(
    "pi",
    {},
    {
      ...empty,
      provider: "__custom_api__",
      model: "private",
      apiUrl: "https://private.test",
      apiKey: "test-key",
      api: "anthropic-messages",
      imageSupport: true,
    },
  );
  assert.equal(launch.provider_config?.api, "anthropic-messages");
  assert.equal(launch.provider_config?.image_support, true);
});

test("configured identities remain precise and empty catalogs cannot synthesize provider/model defaults", () => {
  const configured = {
    model_provider: "litellm",
    model: "gateway-model",
    provider_models: { other: ["other-model"] },
  };
  assert.deepEqual(providersFor(configured, "codex"), [
    "other",
    "litellm",
    "__custom_api__",
  ]);
  assert.deepEqual(modelsFor(configured, "litellm"), ["gateway-model"]);
  assert.deepEqual(modelsFor(configured, "other"), ["other-model"]);
  for (const backend of ["pi", "codex", "cc"] as const) {
    assert.throws(
      () =>
        launchOptions(
          backend,
          {},
          { ...empty, provider: "zai", model: "arbitrary" },
        ),
      /configured/,
    );
    assert.throws(
      () =>
        launchOptions(backend, configured, {
          ...empty,
          provider: "litellm",
          model: "default",
        }),
      /Choose a model/,
    );
    assert.deepEqual(
      launchOptions(backend, configured, {
        ...empty,
        provider: "litellm",
        model: "gateway-model",
      }),
      { model: "gateway-model", model_provider: "litellm" },
    );
  }
});
