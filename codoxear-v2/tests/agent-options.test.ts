import test from "node:test";
import assert from "node:assert/strict";
import {
  defaultsFor,
  modelsFor,
  effortsFor,
  launchOptions,
  type BackendDefaults,
} from "../web/shared/agent-options.js";
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
  assert.deepEqual(modelsFor(pi, ""), ["same-name", "a-only"]);
  assert.deepEqual(modelsFor(pi, "missing"), []);
  assert.deepEqual(effortsFor(pi, "a", "same-name"), ["off"]);
  assert.deepEqual(effortsFor(pi, "b", "same-name"), ["low", "high"]);
  assert.deepEqual(effortsFor(pi, "", ""), ["off"]);
  assert.deepEqual(defaultsFor({}, "cc").reasoning_efforts, [
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
    "auto",
  ]);
});
test("configured defaults omit overrides; alternate Pi providers require a model", () => {
  assert.deepEqual(launchOptions("pi", pi, empty), {});
  assert.deepEqual(launchOptions("pi", pi, { ...empty, provider: "a" }), {
    model_provider: "a",
    model: "same-name",
  });
  assert.throws(
    () => launchOptions("pi", pi, { ...empty, provider: "b" }),
    /Choose a model/,
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
      fast: true,
    }),
    {
      model_provider: "openai",
      preferred_auth_method: "chatgpt",
      service_tier: "fast",
    },
  );
  assert.deepEqual(
    launchOptions("codex", codex, { ...empty, provider: "openai-api" }),
    { model_provider: "openai", preferred_auth_method: "apikey" },
  );
  assert.deepEqual(
    launchOptions("codex", codex, { ...empty, provider: "gateway" }),
    { model_provider: "gateway", preferred_auth_method: "apikey" },
  );
  assert.deepEqual(
    launchOptions(
      "cc",
      {},
      { ...empty, provider: "gateway", model: "claude-custom", fast: true },
    ),
    { model: "claude-custom", service_tier: "fast" },
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
      /model ID/,
    );
  });
}
test("Pi preset keys and compatibility options are forwarded", () => {
  assert.deepEqual(
    launchOptions(
      "pi",
      {},
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
