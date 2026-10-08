import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  providerCatalog,
  configuredCatalogCredentials,
} from "../src/computer/provider-catalog.js";
assert.ok(
  existsSync("/.dockerenv"),
  "Provider discovery behavior must be tested in Docker",
);
const input = {
  backend: "pi" as const,
  base_url: "https://provider.invalid/deploy/v1",
  api_key: "private-secret",
};
test("Unknown Anthropic metadata exposes only proven request vocabulary without claiming provider capabilities", async () => {
  const { resolveCatalogLaunch } =
    await import("../src/computer/provider-catalog.js");
  const request = { ...input, api: "anthropic-messages" as const };
  const fetcher = (async (url: any) =>
    new Response(
      JSON.stringify({
        data: url.pathname.endsWith("/models")
          ? [{ id: "opaque-route" }]
          : [
              {
                model_group: "opaque-route",
                supports_reasoning: null,
                supported_reasoning_efforts: null,
              },
            ],
      }),
    )) as typeof fetch;
  const catalogue = await providerCatalog("/unused", request, fetcher);
  assert.equal(catalogue.models[0]!.supports_reasoning, null);
  assert.equal(catalogue.models[0]!.supported_reasoning_efforts, null);
  assert.deepEqual(catalogue.models[0]!.runtime_reasoning_efforts, [
    "none",
    "low",
    "medium",
    "high",
    "xhigh",
    "max",
  ]);
  const launch = {
    provider_catalog: true as const,
    model: "opaque-route",
    provider_config: {
      base_url: request.base_url,
      api_key: request.api_key,
      api: request.api,
    },
  };
  for (const effort of catalogue.models[0]!.runtime_reasoning_efforts!) {
    const result = await resolveCatalogLaunch(
      "/unused",
      "pi",
      { ...launch, reasoning_effort: effort },
      fetcher,
    );
    assert.equal(
      result.launch.reasoning_effort,
      effort === "none" ? "off" : effort,
    );
    assert.equal(
      result.catalogModel!.thinkingLevelMap[effort === "none" ? "off" : effort],
      effort,
    );
  }
  await assert.rejects(
    resolveCatalogLaunch(
      "/unused",
      "pi",
      { ...launch, reasoning_effort: "minimal" },
      fetcher,
    ),
    /cannot send/,
  );
});
test("Provider catalogue preserves precise declared levels and unknowns, scoped to caller-visible IDs", async () => {
  const seen: string[] = [];
  const fetcher = (async (url: any, options: any) => {
    seen.push(url.pathname);
    assert.equal(options.redirect, "manual");
    assert.equal(options.headers.Authorization, "Bearer private-secret");
    return new Response(
      JSON.stringify({
        data: url.pathname.endsWith("/v1/models")
          ? [
              { id: "known" },
              { id: "unknown" },
              { id: "false" },
              { id: "known" },
            ]
          : [
              {
                model_group: "known",
                supports_reasoning: true,
                supported_reasoning_efforts: ["low", "high", "max"],
              },
              {
                model_group: "unknown",
                supports_reasoning: true,
                supported_reasoning_efforts: null,
              },
              {
                model_group: "false",
                supports_reasoning: false,
                supported_reasoning_efforts: [],
              },
              {
                model_group: "forbidden",
                supports_reasoning: true,
                supported_reasoning_efforts: ["high"],
              },
            ],
      }),
    );
  }) as typeof fetch;
  const result = await providerCatalog("/unused", input, fetcher);
  assert.deepEqual(seen, ["/deploy/v1/models", "/deploy/model_group/info"]);
  assert.deepEqual(result, {
    metadata_available: true,
    models: [
      {
        id: "known",
        runtime_reasoning_efforts: ["low", "high", "max"],
        supports_reasoning: true,
        supported_reasoning_efforts: ["low", "high", "max"],
      },
      {
        id: "unknown",
        supports_reasoning: true,
        supported_reasoning_efforts: null,
      },
      {
        id: "false",
        runtime_reasoning_efforts: [],
        supports_reasoning: false,
        supported_reasoning_efforts: [],
      },
    ],
  });
  assert.equal(JSON.stringify(result).includes("private-secret"), false);
});

test("Discovered Anthropic efforts use exact adaptive payloads in managed and native installed Pi SDKs", async (t) => {
  const { resolveCatalogLaunch } =
    await import("../src/computer/provider-catalog.js");
  const { prepareProfile } =
    await import("../src/computer/managed/profiles.js");
  const { backendCommand } = await import("../src/computer/native/backend.js");
  const { default: privateProvider } =
    await import("../src/computer/native/pi-private-provider.js");
  const { computerPackagePaths } =
    await import("../src/computer/package-paths.js");
  const { pathToFileURL } = await import("node:url");
  const home = await mkdtemp(join(tmpdir(), "catalogue-anthropic-effort-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  const configured = join(home, ".pi", "agent", "models.json");
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  const original = JSON.stringify({
    providers: {
      gateway: {
        api: "anthropic-messages",
        baseUrl: input.base_url,
        apiKey: input.api_key,
        models: [{ id: "opaque-route", reasoning: false }],
      },
    },
  });
  await writeFile(configured, original);
  const levels = ["none", "minimal", "low", "high", "max"];
  const fetcher = (async (url: any) =>
    new Response(
      JSON.stringify({
        data: url.pathname.endsWith("/models")
          ? [{ id: "opaque-route" }]
          : [
              {
                model_group: "opaque-route",
                supports_reasoning: true,
                supported_reasoning_efforts: levels,
              },
            ],
      }),
    )) as typeof fetch;
  const catalogue = await providerCatalog(
    home,
    { backend: "pi", provider: "gateway" },
    fetcher,
  );
  assert.deepEqual(catalogue.models[0]!.runtime_reasoning_efforts, [
    "none",
    "low",
    "high",
    "max",
  ]);
  const baseLaunch = {
    provider_catalog: true as const,
    model_provider: "gateway",
    model: "opaque-route",
  };
  await assert.rejects(
    resolveCatalogLaunch(
      home,
      "pi",
      { ...baseLaunch, reasoning_effort: "minimal" },
      fetcher,
    ),
    /cannot send/,
  );
  const managedPath = join(
    computerPackagePaths().root,
    "runtime/oar/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js",
  );
  const nativePath =
    "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/node_modules/@earendil-works/pi-ai/dist/api/anthropic-messages.js";
  const managedVersion = JSON.parse(
    await readFile(
      join(
        computerPackagePaths().root,
        "runtime/oar/node_modules/@earendil-works/pi-ai/package.json",
      ),
      "utf8",
    ),
  ).version;
  const nativeVersion = JSON.parse(
    await readFile(
      "/usr/local/lib/node_modules/@earendil-works/pi-coding-agent/package.json",
      "utf8",
    ),
  ).version;
  assert.equal(managedVersion, "1.0.4");
  assert.equal(nativeVersion, "1.0.0");
  t.diagnostic(
    `Exact Anthropic payloads verified with managed pi-ai ${managedVersion} and native Pi CLI ${nativeVersion}`,
  );
  assert.ok(
    existsSync(nativePath),
    "Native Pi SDK must be installed in the verification image",
  );
  const sdks = await Promise.all(
    [managedPath, nativePath].map((path) => import(pathToFileURL(path).href)),
  );
  for (const requested of ["low", "high", "max", "none"] as const) {
    const resolved = await resolveCatalogLaunch(
      home,
      "pi",
      { ...baseLaunch, reasoning_effort: requested },
      fetcher,
    );
    assert.deepEqual(resolved.catalogModel!.compat, {
      forceAdaptiveThinking: true,
    });
    const previousFetch = globalThis.fetch;
    let profile: Awaited<ReturnType<typeof prepareProfile>>;
    try {
      globalThis.fetch = fetcher;
      profile = await prepareProfile({
        home,
        stateHome: home,
        cwd: home,
        backend: "pi",
        launch: { ...baseLaunch, reasoning_effort: requested },
      });
    } finally {
      globalThis.fetch = previousFetch;
    }
    const managedConfig = JSON.parse(
      await readFile(
        join(profile.env.OAR_PI_AGENT_DIR!, "models.json"),
        "utf8",
      ),
    );
    const managedModel = managedConfig.providers.codoxear_private.models[0];
    assert.equal(
      managedModel.reasoning,
      true,
      "Producer metadata overrides the stale local false only for this launch",
    );
    assert.deepEqual(managedModel.compat, { forceAdaptiveThinking: true });
    const plan = backendCommand(
      {
        home,
        cwd: home,
        backend: "pi",
        name: "catalogue fixture",
        sessionId: "broker-" + "a".repeat(32),
        launch: resolved.launch,
        catalogModel: resolved.catalogModel!,
      },
      false,
    );
    const privateEnv = Object.fromEntries(
      Object.entries(plan.env).filter(([key]) =>
        key.startsWith("CODOXEAR_PROVIDER_"),
      ),
    );
    const previousEnv = new Map(
      Object.keys(privateEnv).map((key) => [key, process.env[key]]),
    );
    let nativeConfig: any;
    try {
      Object.assign(process.env, privateEnv);
      privateProvider({
        registerProvider: (_name, config) => {
          nativeConfig = config;
        },
      });
    } finally {
      for (const [key, value] of previousEnv) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }
    assert.deepEqual(nativeConfig.models[0].compat, {
      forceAdaptiveThinking: true,
    });
    for (const [index, sdk] of sdks.entries()) {
      const source = index === 0 ? managedModel : nativeConfig.models[0];
      const model = {
        ...source,
        api: "anthropic-messages",
        provider: "codoxear_private",
        baseUrl: input.base_url,
      };
      let body: any;
      const events = [
        {
          type: "message_start",
          message: {
            id: "fixture",
            type: "message",
            role: "assistant",
            model: "opaque-route",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: { input_tokens: 0, output_tokens: 0 },
          },
        },
        {
          type: "content_block_start",
          index: 0,
          content_block: { type: "text", text: "" },
        },
        {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "fixture reply" },
        },
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "end_turn", stop_sequence: null },
          usage: { output_tokens: 1 },
        },
        { type: "message_stop" },
      ];
      const result = await sdk
        .streamSimple(
          model,
          {
            messages: [{ role: "user", content: "SDK fixture", timestamp: 0 }],
          },
          {
            apiKey: "fixture-key",
            ...(requested !== "none" ? { reasoning: requested } : {}),
            fetch: async (_url: any, options: any) => {
              body = JSON.parse(options.body);
              return new Response(
                events
                  .map(
                    (event) =>
                      `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`,
                  )
                  .join(""),
                { headers: { "content-type": "text/event-stream" } },
              );
            },
          },
        )
        .result();
      assert.notEqual(result.stopReason, "error", JSON.stringify(result));
      assert.equal(body.model, "opaque-route");
      if (requested === "none") {
        assert.deepEqual(body.thinking, { type: "disabled" });
        assert.equal(body.output_config, undefined);
      } else {
        assert.equal(body.thinking.type, "adaptive");
        assert.equal(
          body.thinking.budget_tokens,
          undefined,
          "Effort is never approximated through a budget",
        );
        assert.equal(body.output_config.effort, requested);
      }
    }
    assert.equal(
      await readFile(configured, "utf8"),
      original,
      "Configured provider files remain unchanged",
    );
  }
});
test("Metadata rejection preserves unknown models; redirects/list rejection and oversized bodies fail without secret leakage", async () => {
  const metadataDenied = (async (url: any) =>
    url.pathname.endsWith("/models")
      ? new Response(JSON.stringify({ data: [{ id: "alias" }] }))
      : new Response("private-secret", { status: 403 })) as typeof fetch;
  assert.deepEqual(await providerCatalog("/unused", input, metadataDenied), {
    metadata_available: false,
    models: [
      {
        id: "alias",
        supports_reasoning: null,
        supported_reasoning_efforts: null,
      },
    ],
  });
  for (const response of [
    new Response("private-secret", { status: 403 }),
    new Response(null, {
      status: 302,
      headers: { location: "https://elsewhere.invalid" },
    }),
    new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ]) {
    await assert.rejects(
      providerCatalog("/unused", input, (async () => response) as typeof fetch),
      (e) =>
        e instanceof Error &&
        e.message === "Provider model listing unavailable",
    );
  }
});
test("Configured Pi endpoint uses named environment credentials without executing commands", async (t) => {
  const home = await mkdtemp(join(tmpdir(), "provider-catalog-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  const file = join(home, ".pi", "agent", "models.json");
  await writeFile(
    file,
    JSON.stringify({
      providers: {
        configured: {
          baseUrl: "https://provider.invalid/v1",
          apiKey: "CATALOG_TEST_KEY",
        },
      },
    }),
  );
  assert.deepEqual(
    configuredCatalogCredentials(
      home,
      { backend: "pi", provider: "configured" },
      { CATALOG_TEST_KEY: "saved-secret" },
    ),
    { base: "https://provider.invalid/v1", key: "saved-secret" },
  );
  await writeFile(
    file,
    JSON.stringify({
      providers: {
        configured: {
          baseUrl: "https://provider.invalid/v1",
          apiKey: "!echo private-secret",
        },
      },
    }),
  );
  assert.throws(
    () =>
      configuredCatalogCredentials(
        home,
        { backend: "pi", provider: "configured" },
        {},
      ),
    /requires an endpoint and API key/,
  );
});

test("Discovered launches revalidate visibility and levels, resolve local credentials and opt extended Pi levels in without none/off translation", async () => {
  const { resolveCatalogLaunch } =
    await import("../src/computer/provider-catalog.js");
  const fetcher = (async (url: any) =>
    new Response(
      JSON.stringify({
        data: url.pathname.endsWith("/models")
          ? [{ id: "remote" }]
          : [
              {
                model_group: "remote",
                supports_reasoning: true,
                supported_reasoning_efforts: ["low", "high", "max", "none"],
              },
            ],
      }),
    )) as typeof fetch;
  const launch = {
    provider_catalog: true as const,
    model: "remote",
    reasoning_effort: "max",
    provider_config: { base_url: input.base_url, api_key: input.api_key },
  };
  const resolved = await resolveCatalogLaunch("/unused", "pi", launch, fetcher);
  assert.equal(resolved.launch.provider_config?.api_key, "private-secret");
  assert.equal(resolved.catalogModel?.reasoning, true);
  assert.deepEqual(resolved.catalogModel?.thinkingLevelMap, {
    off: "none",
    minimal: null,
    low: "low",
    medium: null,
    high: "high",
    xhigh: null,
    max: "max",
  });
  await assert.rejects(
    resolveCatalogLaunch(
      "/unused",
      "pi",
      { ...launch, reasoning_effort: "medium" },
      fetcher,
    ),
    /not advertised/,
  );
  const none = await resolveCatalogLaunch(
    "/unused",
    "pi",
    { ...launch, reasoning_effort: "none" },
    fetcher,
  );
  assert.equal(none.launch.reasoning_effort, "off");
  assert.equal(none.catalogModel?.thinkingLevelMap.off, "none");
  await assert.rejects(
    resolveCatalogLaunch(
      "/unused",
      "pi",
      { ...launch, model: "not-visible" },
      fetcher,
    ),
    /no longer visible/,
  );
  const laterOff = await resolveCatalogLaunch(
    "/unused",
    "pi",
    { ...launch, reasoning_effort: "off" },
    fetcher,
  );
  assert.equal(laterOff.catalogModel?.thinkingLevelMap.off, "none");
});

test("Installed Pi SDK emits exact discovered none/max/xhigh wire efforts through explicit maps", async () => {
  const { computerPackagePaths } =
    await import("../src/computer/package-paths.js");
  const { pathToFileURL } = await import("node:url");
  const sdk = await import(
    pathToFileURL(
      join(
        computerPackagePaths().root,
        "runtime/oar/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js",
      ),
    ).href
  );
  for (const requested of ["none", "max", "xhigh"]) {
    let body: any;
    const model = {
      id: "remote",
      name: "Remote",
      api: "openai-completions",
      provider: "catalogue",
      baseUrl: "https://provider.invalid/v1",
      reasoning: true,
      input: ["text"],
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      contextWindow: 128000,
      maxTokens: 1024,
      thinkingLevelMap: {
        off: "none",
        minimal: null,
        low: null,
        medium: null,
        high: null,
        xhigh: "xhigh",
        max: "max",
      },
      compat: { supportsReasoningEffort: true },
    };
    const message = await sdk
      .streamSimple(
        model,
        { messages: [{ role: "user", content: "SDK fixture", timestamp: 0 }] },
        {
          apiKey: "fixture-key",
          reasoning: requested === "none" ? "off" : requested,
          fetch: async (_url: any, options: any) => {
            body = JSON.parse(options.body);
            return new Response(
              "data: " +
                JSON.stringify({
                  id: "fixture",
                  object: "chat.completion.chunk",
                  created: 0,
                  model: "remote",
                  choices: [
                    {
                      index: 0,
                      delta: { role: "assistant", content: "Verified" },
                      finish_reason: null,
                    },
                  ],
                }) +
                "\n\ndata: " +
                JSON.stringify({
                  id: "fixture",
                  object: "chat.completion.chunk",
                  created: 0,
                  model: "remote",
                  choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
                }) +
                "\n\ndata: [DONE]\n\n",
              { headers: { "content-type": "text/event-stream" } },
            );
          },
        },
      )
      .result();
    assert.notEqual(message.stopReason, "error", JSON.stringify(message));
    assert.equal(body.reasoning_effort, requested);
  }
});

test("Unknown provider metadata permits explicit unverified Pi requests without clamp; explicit false and known-list off bypass reject", async () => {
  const { resolveCatalogLaunch } =
    await import("../src/computer/provider-catalog.js");
  const launch = {
    provider_catalog: true as const,
    model: "remote",
    reasoning_effort: "high",
    provider_config: { base_url: input.base_url, api_key: input.api_key },
  };
  const feed = (info: any) =>
    (async (url: any) =>
      new Response(
        JSON.stringify({
          data: url.pathname.endsWith("/models")
            ? [{ id: "remote" }]
            : [{ model_group: "remote", ...info }],
        }),
      )) as typeof fetch;
  const result = await resolveCatalogLaunch(
    "/unused",
    "pi",
    launch,
    feed({ supports_reasoning: null, supported_reasoning_efforts: null }),
  );
  assert.equal(result.catalogModel?.reasoning, true);
  assert.equal(result.catalogModel?.thinkingLevelMap.high, "high");
  assert.equal(result.catalogModel?.thinkingLevelMap.medium, null);
  await assert.rejects(
    resolveCatalogLaunch(
      "/unused",
      "pi",
      launch,
      feed({ supports_reasoning: false, supported_reasoning_efforts: null }),
    ),
    /not advertised/,
  );
  await assert.rejects(
    resolveCatalogLaunch(
      "/unused",
      "pi",
      { ...launch, reasoning_effort: "off" },
      feed({
        supports_reasoning: true,
        supported_reasoning_efforts: ["low", "high"],
      }),
    ),
    /not advertised/,
  );
});

test("Discovered launch preserves exact provider-prefixed IDs before internal qualification fallback", async (t) => {
  const { resolveCatalogLaunch } =
    await import("../src/computer/provider-catalog.js");
  const home = await mkdtemp(join(tmpdir(), "catalogue-identity-"));
  t.after(() => rm(home, { recursive: true, force: true }));
  await mkdir(join(home, ".pi", "agent"), { recursive: true });
  await writeFile(
    join(home, ".pi", "agent", "models.json"),
    JSON.stringify({
      providers: {
        gateway: { baseUrl: input.base_url, apiKey: input.api_key },
      },
    }),
  );
  const ids = [
    "gateway/private-route",
    "private-route",
    "codoxear_private/literal",
    "literal",
  ];
  const fetcher = (async (url: any) =>
    new Response(
      JSON.stringify({
        data: url.pathname.endsWith("/models")
          ? ids.map((id) => ({ id }))
          : ids.map((id) => ({
              model_group: id,
              supports_reasoning: true,
              supported_reasoning_efforts: ["high"],
            })),
      }),
    )) as typeof fetch;
  const launch = {
    provider_catalog: true as const,
    model_provider: "gateway",
    reasoning_effort: "high",
  };
  for (const [requested, expected] of [
    ["gateway/private-route", "gateway/private-route"],
    ["gateway/gateway/private-route", "gateway/private-route"],
    ["codoxear_private/literal", "codoxear_private/literal"],
    ["codoxear_private/private-route", "private-route"],
  ] as const) {
    const result = await resolveCatalogLaunch(
      home,
      "pi",
      { ...launch, model: requested },
      fetcher,
    );
    assert.equal(result.launch.model, expected);
  }
});

test("Known provider lists govern the installed SDK Off choice throughout later effort changes", async () => {
  const { resolveCatalogLaunch } =
    await import("../src/computer/provider-catalog.js");
  const { computerPackagePaths } =
    await import("../src/computer/package-paths.js");
  const { pathToFileURL } = await import("node:url");
  const sdk = await import(
    pathToFileURL(
      join(
        computerPackagePaths().root,
        "runtime/oar/node_modules/@earendil-works/pi-ai/dist/models.js",
      ),
    ).href
  );
  const launch = {
    provider_catalog: true as const,
    model: "remote",
    reasoning_effort: "high",
    provider_config: { base_url: input.base_url, api_key: input.api_key },
  };
  for (const levels of [
    ["low", "high"],
    ["none", "low", "high"],
  ]) {
    const fetcher = (async (url: any) =>
      new Response(
        JSON.stringify({
          data: url.pathname.endsWith("/models")
            ? [{ id: "remote" }]
            : [
                {
                  model_group: "remote",
                  supports_reasoning: true,
                  supported_reasoning_efforts: levels,
                },
              ],
        }),
      )) as typeof fetch;
    const result = await resolveCatalogLaunch("/unused", "pi", launch, fetcher);
    assert.equal(
      sdk.getSupportedThinkingLevels(result.catalogModel).includes("off"),
      levels.includes("none"),
    );
    assert.equal(
      result.catalogModel?.thinkingLevelMap.off,
      levels.includes("none") ? "none" : null,
    );
  }
});
