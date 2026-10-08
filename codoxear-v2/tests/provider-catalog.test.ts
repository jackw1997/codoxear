import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
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
