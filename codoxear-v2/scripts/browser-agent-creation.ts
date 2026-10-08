// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import "./testing/frontend-artifact.js";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { writeFile, mkdir } from "node:fs/promises";
import { build } from "esbuild";
import Fastify from "fastify";
import { workspaceAsset } from "../src/hub/workspace.ts";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const catalogs = {
  laptop: {
    new_session_defaults: {
      backends: {
        pi: {
          provider_choice: "local",
          model: "pi-default",
          reasoning_effort: "off",
          provider_choices: ["local", "anthropic"],
          models: ["pi-default", "pi-reasoner"],
          provider_models: {
            local: ["pi-default"],
            anthropic: ["pi-reasoner"],
          },
          reasoning_efforts: ["off", "minimal", "low", "medium", "high"],
          reasoning_efforts_for_custom_model: ["off", "minimal", "low", "medium", "high"],
          reasoning_efforts_by_model: {
            "anthropic/pi-reasoner": ["off", "minimal", "low", "medium", "high"],
            "local/pi-default": ["off"],
          },
        },
        codex: {
          provider_choice: "chatgpt",
          model: "codex-model",
          reasoning_effort: "high",
          provider_choices: ["chatgpt", "openai-api"],
          models: ["codex-model", "codex-small"],
          reasoning_efforts: ["low", "medium", "high"],
          reasoning_efforts_by_model: {
            "codex-model": ["low", "medium", "high", "ultra"],
            "codex-small": ["low", "medium"],
          },
          supports_fast: true,
        },
        cc: {
          provider_choice: "anthropic",
          provider_choices: ["anthropic"],
          model_provider: "anthropic",
          model: "sonnet",
          reasoning_effort: "high",
          models: ["sonnet", "opus", "haiku"],
          reasoning_efforts: ["low", "medium", "high"],
          supports_fast: false,
        },
      },
    },
  },
  workstation: {
    new_session_defaults: {
      backends: {
        pi: {
          provider_choices: ["work-provider"],
          provider_models: { "work-provider": ["work-model"] },
          reasoning_efforts: ["off"],
        },
      },
    },
  },
};
let origin,
  delayLaptop = false,
  delayLaunch = false;
let discoveryMode = "success", releaseDiscovery;
const discoveryCalls = [];
const received = [],
  errors = [],
  checks = [];
let passed = false;
const placements = () =>
  ["laptop", "workstation"].map((computerId) => ({
    computerId,
    computerName: computerId === "laptop" ? "Home laptop" : "Work computer",
    hubName: "Test hub",
    hubId: "hub",
    origin,
  }));
const app = Fastify();
app.get("/api/agent-directory", async () => ({
  agents: [],
  placements: placements(),
}));
app.get("/workspace/api/sessions", async () => ({
  sessions: [],
  recent_cwds: [],
  new_session_defaults: {},
  tmux_available: false,
}));
app.get("/api/computers/:id/resume-candidates", async (r) => ({
  sessions: [
    {
      session_id: `saved-${r.params.id}-${r.query.backend}`,
      alias: "Saved work",
    },
  ],
}));
app.get("/api/computers/:id/launch-defaults", async (r) => {
  if (r.params.id === "laptop" && delayLaptop)
    await new Promise((resolve) => setTimeout(resolve, 700));
  return catalogs[r.params.id];
});
app.post("/api/computers/:id/provider-catalog", async (r, reply) => {
  discoveryCalls.push({ computer: r.params.id, body: r.body });
  if (discoveryMode === "delayed") await new Promise(resolve => { releaseDiscovery = resolve; });
  if (discoveryMode === "denied") return reply.code(403).send({ error: "Caller key cannot list models." });
  if (discoveryMode.startsWith("anthropic")) return { metadata_available: true, models: [{ id: "caller-anthropic", supports_reasoning: true, supported_reasoning_efforts: ["low", "high", "max"], runtime_reasoning_efforts: discoveryMode === "anthropic-unsupported" ? [] : ["low", "high", "max"] }] };
  return { metadata_available: true, models: [
    { id: "caller-reasoner", supports_reasoning: true, supported_reasoning_efforts: ["none", "low", "high", "max", "unsupported-level"], runtime_reasoning_efforts: ["none", "low", "high", "max"] },
    { id: "caller-unknown", supports_reasoning: null, supported_reasoning_efforts: null },
    { id: "caller-missing" },
  ] };
});
for (const path of [
  "/api/v1/computers/:id/api/sessions",
  "/api/computers/:id/agents",
])
  app.post(path, async (r, reply) => {
    received.push({ computer: r.params.id, body: r.body });
    if (delayLaunch) await new Promise((resolve) => setTimeout(resolve, 500));
    return reply
      .code(422)
      .send({ error: "Selection recorded by isolated verification." });
  });
app.get("/legacy-worker.js", async (_r, reply) =>
  reply
    .type("text/javascript")
    .send(
      `self.addEventListener('install', e => e.waitUntil(self.skipWaiting())); self.addEventListener('activate', e => e.waitUntil(self.clients.claim())); self.addEventListener('message', e => { if(e.data?.type === 'codoxear-transport-check') e.ports[0]?.postMessage({type:'codoxear-transport-ready',version:3}); }); self.addEventListener('fetch', e => { if (new URL(e.request.url).pathname.startsWith('/api/')) e.respondWith(new Response(JSON.stringify({error:'This is a static client. Authentication and APIs belong to your connected hubs.'}), {status:404,headers:{'Content-Type':'application/json'}})); });`,
    ),
);
app.get("/api/v1/me", async () => ({
  id: "test",
  name: "Test",
  hubRole: "owner",
  identities: [
    {
      method: "google",
      connection: "fixture-google",
      subject: "test-verified",
      tenant: null,
    },
  ],
  context: {
    method: "google",
    identityId: "test-verified",
    authenticatedAt: Date.now(),
  },
}));
app.get("/api/hubs", async () => [
  { id: "hub", name: "Test hub", ownerId: "test", role: "owner", policy: null },
]);
app.get("/api/v1/computers", async () =>
  placements().map((p) => ({
    id: p.computerId,
    name: p.computerName,
    ownerId: "test",
    online: true,
    canManage: true,
    canUse: true,
    canRead: true,
    canWrite: true,
    canCreate: true,
    policy: null,
    effectivePolicy: "remove",
  })),
);
app.get("/setup", async (_r, reply) =>
  reply.type("text/html").send("<!doctype html><title>Isolated setup</title>"),
);
const harness = await build({
  stdin: {
    contents:
      'import {placementDialog} from "./frontend/web/shared/ui.js"; window.openCreation = () => placementDialog(window.placements, async (p, values) => { const r = await fetch(`/api/computers/${p.computerId}/agents`, {method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify(values)}); if(!r.ok) throw new Error((await r.json()).error); }); document.querySelector("button").onclick = window.openCreation;',
    resolveDir: process.cwd(),
  },
  bundle: true,
  write: false,
  format: "esm",
});
app.get("/shared.js", async (_r, reply) =>
  reply.type("text/javascript").send(harness.outputFiles[0].text),
);
app.get("/shared", async (_r, reply) =>
  reply
    .type("text/html")
    .send(
      `<!doctype html><html data-theme="clay"><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/app.css"><link rel="stylesheet" href="/themes/clay.css"><link rel="stylesheet" href="/agent-creation.css"></head><body><button>New agent</button><script>window.placements=${JSON.stringify(placements())}</script><script type="module" src="/shared.js"></script></body></html>`,
    ),
);
app.get("/*", async (r, reply) => {
  try {
    const asset = await workspaceAsset("dist/client", r.params["*"], {
      issuer: "local-client",
      accountId: "test",
      hubId: "hub",
      computerId: "all",
    });
    return reply.type(asset.type).send(asset.body);
  } catch {
    return reply.code(404).send({ error: "Fixture route unavailable" });
  }
});
origin = await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({
  headless: true,
  ...(process.env.CHROMIUM_PATH
    ? { executablePath: process.env.CHROMIUM_PATH }
    : {}),
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 1000 },
});
let page = await context.newPage();
page.setDefaultTimeout(10000);
page.on("pageerror", (e) => errors.push(e.message));
const pass = (text) => {
  checks.push(text);
  console.log("PASS", text);
};
const dialog = () =>
  page.getByRole("dialog", { name: "New agent", exact: true });
async function assertEventually(predicate) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (predicate()) return;
    await new Promise(resolve => setTimeout(resolve, 10));
  }
  assert.fail("Controlled discovery request did not arrive");
}
async function ready() {
  await dialog().waitFor();
  await page.waitForFunction(
    () => document.querySelector("dialog [type=submit]")?.disabled === false,
  );
}
async function submit() {
  const count = received.length;
  await dialog()
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await dialog()
    .getByRole("alert")
    .getByText("Selection recorded by isolated verification.")
    .waitFor();
  assert.equal(received.length, count + 1);
  return received.at(-1);
}
try {
  await mkdir("artifacts", { recursive: true });
  await page.goto(origin + "/setup");
  await page.evaluate(async (origin) => {
    const db = await new Promise((resolve, reject) => {
      const r = indexedDB.open("codoxear-client-identities", 1);
      r.onupgradeneeded = () => r.result.createObjectStore("credentials");
      r.onsuccess = () => resolve(r.result);
      r.onerror = () => reject(r.error);
    });
    await new Promise((resolve, reject) => {
      const tx = db.transaction("credentials", "readwrite");
      tx.objectStore("credentials").put(
        {
          id: "test-login",
          accountKey: "account",
          hubId: "hub",
          origin,
          name: "Test hub",
          accountId: "test",
          role: "owner",
          accessToken: "fixture-token",
          refreshToken: "fixture-refresh",
          expiresAt: Date.now() + 3600000,
          identity: { name: "Test", method: "google", key: "test-verified" },
        },
        "test-login",
      );
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  }, origin);
  await page.evaluate(async () => {
    await navigator.serviceWorker.register("/legacy-worker.js", { scope: "/" });
    await navigator.serviceWorker.ready;
    if (!navigator.serviceWorker.controller)
      await new Promise((resolve) =>
        navigator.serviceWorker.addEventListener("controllerchange", resolve, {
          once: true,
        }),
      );
  });
  const legacyFailure = await page.evaluate(async () => ({
    status: (await fetch("/api/client/hubs/test-login/api/hubs")).status,
  }));
  assert.equal(legacyFailure.status, 404);
  await page.goto(origin);
  await page
    .getByRole("button", { name: "Hubs & computers", exact: true })
    .click();
  const connections = page.getByRole("dialog", {
    name: "Hubs & computers",
    exact: true,
  });
  await connections.locator("summary").filter({ hasText: "Test hub" }).click();
  await connections
    .getByRole("button", { name: "Home laptop", exact: false })
    .waitFor();
  assert.equal(
    await connections
      .getByText("This is a static client.", { exact: false })
      .count(),
    0,
  );
  await connections.getByRole("button", { name: "Back", exact: true }).click();
  pass(
    "An already-controlled tab upgrades the old worker before rendering; Hubs & computers loads working controls instead of the static-client error",
  );
  await page.locator("#newBtn").click();
  await ready();
  assert.deepEqual(
    await dialog()
      .getByLabel("Runtime", { exact: true })
      .locator("option")
      .allTextContents(),
    ["Pi", "Codex", "Claude Code"],
  );
  assert.equal(
    await dialog().getByLabel("Provider", { exact: true }).inputValue(),
    "local",
  );
  assert.equal(
    await dialog().getByLabel("Model", { exact: true }).inputValue(),
    "pi-default",
  );
  assert.equal(
    await dialog().getByLabel("Reasoning", { exact: true }).inputValue(),
    "off",
  );
  await dialog().getByText("The Computer’s model configuration does not advertise reasoning levels beyond Off.", { exact: true }).waitFor();
  assert.deepEqual(await dialog().getByLabel("Reasoning", { exact: true }).locator("option").allTextContents(), ["Choose a reasoning level", "Off"]);
  pass("Configured non-reasoning model exposes only Off and explains its Computer metadata constraint");
  await page.screenshot({ path: "artifacts/creation-pi-off-metadata.png" });
  for (const field of ["Provider", "Model", "Reasoning"]) {
    const options = await dialog()
      .getByLabel(field, { exact: true })
      .locator("option")
      .allTextContents();
    assert.ok(
      options.every((label) => !/Configured|Runtime default/.test(label)),
    );
  }
  const providerPlaceholder = dialog()
    .getByLabel("Provider", { exact: true })
    .locator('option[value=""]');
  assert.deepEqual(
    await providerPlaceholder.evaluate((option) => ({
      disabled: option.disabled,
      nativeDisabled: option.matches(":disabled"),
    })),
    { disabled: true, nativeDisabled: true },
  );
  pass(
    "Configured provider, model and reasoning are selected as real values, with disabled placeholders and no generic default option",
  );
  await dialog().getByLabel("Agent name").fill("Phone agent");
  await dialog()
    .getByLabel("Provider", { exact: true })
    .selectOption("anthropic");
  assert.deepEqual(
    await dialog()
      .getByLabel("Model", { exact: true })
      .locator("option")
      .allTextContents(),
    ["Choose a model", "pi-reasoner", "Custom…"],
  );
  await dialog()
    .getByLabel("Model", { exact: true })
    .selectOption("pi-reasoner");
  await dialog().getByText("More", { exact: true }).click();
  assert.deepEqual(
    await dialog()
      .getByLabel("Reasoning", { exact: true })
      .locator("option")
      .allTextContents(),
    ["Choose a reasoning level", "Off", "Minimal", "Low", "Medium", "High"],
  );
  assert.equal(await dialog().getByText("The Computer’s model configuration does not advertise reasoning levels beyond Off.", { exact: true }).isVisible(), false);
  pass("Configured reasoning model receives the producer-derived standard levels without an explicit thinking-level map");
  await dialog().getByLabel("Reasoning", { exact: true }).selectOption("high");
  assert.equal(await dialog().getByLabel("Fast mode").isVisible(), false);
  await page.screenshot({ path: "artifacts/creation-pi-desktop.png" });
  assert.deepEqual((await submit()).body, {
    name: "Phone agent",
    agent_backend: "pi",
    model_provider: "anthropic",
    model: "pi-reasoner",
    reasoning_effort: "high",
    create_in_tmux: false,
  });
  pass(
    "Independent client opens Pi/Codex/Claude creation; provider-specific Pi models and reasoning reach the service worker launch request",
  );
  await dialog().getByLabel("Runtime", { exact: true }).selectOption("codex");
  await dialog()
    .getByLabel("Provider", { exact: true })
    .selectOption("chatgpt");
  await dialog()
    .getByLabel("Model", { exact: true })
    .selectOption("codex-model");
  await dialog().getByLabel("Reasoning", { exact: true }).selectOption("ultra");
  await dialog()
    .getByLabel("Model", { exact: true })
    .selectOption("codex-small");
  assert.equal(
    await dialog().getByLabel("Reasoning", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await dialog()
      .getByLabel("Reasoning", { exact: true })
      .locator("option[value=ultra]")
      .count(),
    0,
  );
  const beforeMissingEffort = received.length;
  await dialog()
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  assert.equal(received.length, beforeMissingEffort);
  assert.equal(
    await dialog()
      .getByLabel("Reasoning", { exact: true })
      .evaluate((el) => el.validity.valueMissing),
    true,
  );
  await dialog().getByLabel("Reasoning", { exact: true }).selectOption("low");
  await dialog().getByText("Fast mode", { exact: true }).click();
  assert.equal(await dialog().getByLabel("Fast mode").isChecked(), true);
  assert.deepEqual((await submit()).body, {
    name: "Phone agent",
    agent_backend: "codex",
    model_provider: "openai",
    preferred_auth_method: "chatgpt",
    model: "codex-small",
    reasoning_effort: "low",
    service_tier: "fast",
    create_in_tmux: false,
  });
  pass(
    "Codex maps ChatGPT authentication and Fast correctly; changing models removes unsupported reasoning",
  );
  await dialog().getByLabel("Runtime", { exact: true }).selectOption("cc");
  assert.equal(
    await dialog().getByLabel("Provider", { exact: true }).inputValue(),
    "anthropic",
  );
  assert.equal(await dialog().getByLabel("Fast mode").isVisible(), true);
  await dialog()
    .getByLabel("Model", { exact: true })
    .selectOption("__custom__");
  await dialog().getByLabel("Custom model", { exact: true }).fill("   ");
  const beforeInvalid = received.length;
  await dialog()
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await dialog()
    .getByRole("alert")
    .getByText("Enter a custom model ID.")
    .waitFor();
  assert.equal(received.length, beforeInvalid);
  assert.equal(
    await dialog()
      .getByLabel("Custom model", { exact: true })
      .getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(
    await dialog()
      .getByLabel("Custom model", { exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await dialog()
    .getByLabel("Custom model", { exact: true })
    .fill("claude-custom");
  await dialog()
    .getByLabel("Reasoning", { exact: true })
    .selectOption("medium");
  assert.deepEqual((await submit()).body, {
    name: "Phone agent",
    agent_backend: "cc",
    model_provider: "anthropic",
    model: "claude-custom",
    reasoning_effort: "medium",
    create_in_tmux: false,
  });
  pass(
    "Claude Code supports custom model and reasoning without inheriting another runtime's provider or Fast setting",
  );
  await dialog().getByLabel("Runtime", { exact: true }).selectOption("pi");
  await dialog().getByLabel("Provider", { exact: true }).selectOption("anthropic");
  discoveryMode = "anthropic-unsupported";
  await dialog().getByRole("button", { name: "Discover models", exact: true }).click();
  await dialog().locator("[data-discovery-status]").filter({ hasText: "1 caller-key-visible models" }).waitFor();
  assert.deepEqual(discoveryCalls.at(-1), { computer: "laptop", body: { backend: "pi", provider: "anthropic" } });
  await dialog().getByLabel("Model", { exact: true }).selectOption("caller-anthropic");
  const advertised = dialog().getByLabel("Requested reasoning", { exact: true });
  assert.deepEqual(await advertised.locator("option").allTextContents(), ["Choose a reasoning level", "Low (unavailable for this runtime/API)", "High (unavailable for this runtime/API)", "Maximum (unavailable for this runtime/API)"]);
  for (const value of ["low", "high", "max"]) assert.equal(await advertised.locator(`option[value="${value}"]`).isDisabled(), true);
  await dialog().getByText("This runtime/API cannot submit any of this model's advertised levels.", { exact: false }).waitFor();
  assert.equal(await dialog().getByLabel("Model", { exact: true }).inputValue(), "caller-anthropic");
  await page.screenshot({ path: "artifacts/creation-anthropic-unsupported.png", mask: [dialog().getByLabel("API key", { exact: true })] });
  discoveryMode = "anthropic-supported";
  await dialog().getByRole("button", { name: "Discover models", exact: true }).click();
  await dialog().locator("[data-discovery-status]").filter({ hasText: "1 caller-key-visible models" }).waitFor();
  assert.equal(await dialog().getByLabel("Model", { exact: true }).inputValue(), "caller-anthropic");
  assert.deepEqual(await advertised.locator("option").allTextContents(), ["Choose a reasoning level", "Low", "High", "Maximum"]);
  assert.equal(await advertised.inputValue(), "");
  for (const value of ["low", "high", "max"]) assert.equal(await advertised.locator(`option[value="${value}"]`).isDisabled(), false);
  await advertised.selectOption("max");
  const anthropicLaunch = (await submit()).body;
  assert.equal(anthropicLaunch.provider_catalog, true);
  assert.equal(anthropicLaunch.model_provider, "anthropic");
  assert.equal(anthropicLaunch.model, "caller-anthropic");
  assert.equal(anthropicLaunch.reasoning_effort, "max");
  assert.equal(anthropicLaunch.provider_config, undefined);
  await page.screenshot({ path: "artifacts/creation-anthropic-max.png", mask: [dialog().getByLabel("API key", { exact: true })] });
  pass("Configured Anthropic discovery preserves advertised disabled levels and selected model, then producer compatibility enables exact explicit Max without copying private credentials");
  discoveryMode = "success";
  await dialog().getByLabel("Provider", { exact: true }).selectOption("local");
  await dialog().getByRole("button", { name: "Discover models", exact: true }).click();
  await dialog().locator("[data-discovery-status]").filter({ hasText: "3 caller-key-visible models" }).waitFor();
  assert.deepEqual(discoveryCalls.at(-1), { computer: "laptop", body: { backend: "pi", provider: "local" } });
  assert.deepEqual(await dialog().getByLabel("Model", { exact: true }).locator("option").allTextContents(), ["Choose a model", "caller-reasoner", "caller-unknown", "caller-missing", "Custom…"]);
  await dialog().getByLabel("Model", { exact: true }).selectOption("caller-reasoner");
  assert.deepEqual(await dialog().getByLabel("Requested reasoning", { exact: true }).locator("option").allTextContents(), ["Choose a reasoning level", "None", "Low", "High", "Maximum", "unsupported-level (unavailable for this runtime/API)"]);
  assert.equal(await dialog().getByLabel("Requested reasoning", { exact: true }).locator('option[value="unsupported-level"]').isDisabled(), true);
  for (const model of ["caller-unknown", "caller-missing"]) {
    await dialog().getByLabel("Model", { exact: true }).selectOption(model);
    await dialog().getByText("LiteLLM reasoning metadata is unknown. These are runtime request levels from this Computer; provider acceptance is not verified.", { exact: true }).waitFor();
    assert.deepEqual(await dialog().getByLabel("Requested reasoning", { exact: true }).locator("option").allTextContents(), ["Choose a reasoning level", "Off", "Minimal", "Low", "Medium", "High"]);
    if (model === "caller-unknown") await page.screenshot({ path: "artifacts/creation-discovery-unknown.png", mask: [dialog().getByLabel("API key", { exact: true })] });
    await dialog().getByLabel("Requested reasoning", { exact: true }).selectOption("low");
    assert.equal(await dialog().getByLabel("Requested reasoning", { exact: true }).inputValue(), "low");
  }
  pass("Configured-provider discovery sends only the selected provider, replaces global models, intersects exact advertised effort requests, and leaves null/missing metadata explicitly unknown");
  await dialog().getByLabel("Provider", { exact: true }).selectOption("__custom_api__");
  await dialog().getByLabel("API URL", { exact: true }).fill("https://caller.test/v1");
  await dialog().getByLabel("API key", { exact: true }).fill("caller-discovery-private-key");
  discoveryMode = "denied";
  await dialog().getByRole("button", { name: "Discover models", exact: true }).click();
  await dialog().getByText("Model discovery failed: Caller key cannot list models.", { exact: true }).waitFor();
  assert.deepEqual(discoveryCalls.at(-1), { computer: "laptop", body: { backend: "pi", base_url: "https://caller.test/v1", api: "openai-completions", api_key: "caller-discovery-private-key" } });
  discoveryMode = "success";
  await dialog().getByRole("button", { name: "Discover models", exact: true }).click();
  await dialog().locator("[data-discovery-status]").filter({ hasText: "3 caller-key-visible models" }).waitFor();
  assert.equal(await dialog().locator("[data-discovery-status]").textContent().then(t => t.includes("caller-discovery-private-key")), false);
  assert.equal(await page.evaluate(() => JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage)]).includes("caller-discovery-private-key")), false);
  await dialog().getByLabel("Model", { exact: true }).selectOption("caller-reasoner");
  assert.deepEqual(await dialog().getByLabel("Requested reasoning", { exact: true }).locator("option").allTextContents(), ["Choose a reasoning level", "None", "Low", "High", "Maximum", "unsupported-level (unavailable for this runtime/API)"]);
  assert.equal(await dialog().getByLabel("Requested reasoning", { exact: true }).locator('option[value="unsupported-level"]').isDisabled(), true);
  await dialog().getByLabel("Requested reasoning", { exact: true }).selectOption("max");
  await page.screenshot({ path: "artifacts/creation-discovery-max.png", mask: [dialog().getByLabel("API key", { exact: true })] });
  const discoveredLaunch = (await submit()).body;
  assert.equal(discoveredLaunch.provider_catalog, true);
  assert.equal(discoveredLaunch.model, "caller-reasoner");
  assert.equal(discoveredLaunch.reasoning_effort, "max");
  assert.equal(discoveredLaunch.provider_config.api, "openai-completions");
  pass("Discovered model uses its proven runtime vocabulary, excludes unsupported values, and submits exact Max with provider_catalog confirmation without client aliases");
  pass("Custom discovery uses the caller-entered key and URL, shows a precise denied-listing error, allows retry, and never stores or reflects the secret");
  for (const change of ["provider", "placement"]) {
    discoveryMode = "delayed"; releaseDiscovery = undefined;
    await dialog().getByRole("button", { name: "Discover models", exact: true }).click();
    // Wait for the controlled endpoint to receive the request, without supplying a browser result.
    await assertEventually(() => typeof releaseDiscovery === "function");
    if (change === "provider") await dialog().getByLabel("Provider", { exact: true }).selectOption("local");
    else await dialog().getByLabel("Computer & hub", { exact: true }).selectOption("1");
    const staleDelivered = page.waitForEvent("response", { predicate: response => response.url().includes("provider-catalog"), timeout: 5000 }).catch(() => null);
    releaseDiscovery(); await staleDelivered;
    if (change === "placement") await ready();
    assert.equal(await dialog().getByLabel("Model", { exact: true }).locator('option[value="caller-reasoner"]').count(), 0);
    assert.equal(await dialog().getByLabel("API key", { exact: true }).inputValue(), "");
  }
  discoveryMode = "success";
  await dialog().getByLabel("Computer & hub", { exact: true }).selectOption("0"); await ready();
  pass("Provider and Computer changes cancel in-flight discovery and reject late models while clearing caller credentials");
  for (const runtime of ["pi", "codex", "cc"]) {
    await dialog().getByLabel("Runtime", { exact: true }).selectOption(runtime);
    await dialog()
      .getByLabel("Provider", { exact: true })
      .selectOption("__custom_api__");
    await dialog().getByText("These levels are requests understood by the runtime. The provider or model may reject the requested level.", { exact: true }).waitFor();
    if (runtime === "pi") assert.deepEqual(await dialog().getByLabel("Requested reasoning", { exact: true }).locator("option").allTextContents(), ["Choose a reasoning level", "Off", "Minimal", "Low", "Medium", "High"]);
    assert.equal(
      await dialog().getByLabel("Custom model", { exact: true }).isVisible(),
      true,
    );
    await dialog()
      .getByLabel("API URL", { exact: true })
      .fill("https://private.test/v1");
    await dialog()
      .getByLabel("API key", { exact: true })
      .fill("fixture-private-key");
    await dialog()
      .getByLabel("Custom model", { exact: true })
      .fill("PrivateModel");
    await dialog().getByLabel("Requested reasoning", { exact: true }).selectOption("low");
    if (runtime === "pi") await page.screenshot({ path: "artifacts/creation-pi-custom-request.png" });
    assert.equal(
      await dialog()
        .getByLabel("API key", { exact: true })
        .getAttribute("type"),
      "password",
    );
    if (runtime === "pi") {
      await dialog()
        .getByLabel("API compatibility")
        .selectOption("anthropic-messages");
      await dialog().getByText("Image support", { exact: true }).click();
      assert.equal(
        await dialog().getByLabel("Image support").isChecked(),
        true,
      );
    }
    await dialog().getByText("Advanced", { exact: true }).click();
    await dialog()
      .getByRole("button", { name: "Add variable", exact: true })
      .click();
    await dialog().getByLabel("Variable name").fill("EXTRA_SETTING");
    await dialog().getByLabel("Variable value").fill("fixture-env-value");
    if (runtime === "cc") {
      await dialog()
        .getByLabel("Claude command override")
        .fill("private-claude");
      await dialog().getByText("Fast mode", { exact: true }).click();
      assert.equal(await dialog().getByLabel("Fast mode").isChecked(), true);
    }
    const request = (await submit()).body;
    assert.equal(request.reasoning_effort, "low");
    assert.deepEqual(request.provider_config, {
      base_url: "https://private.test/v1",
      api_key: "fixture-private-key",
      ...(runtime === "pi"
        ? { api: "anthropic-messages", image_support: true }
        : {}),
    });
    assert.deepEqual(request.env_vars, { EXTRA_SETTING: "fixture-env-value" });
    assert.equal(
      request.command,
      runtime === "cc" ? "private-claude" : undefined,
    );
    assert.equal(request.service_tier, runtime === "cc" ? "fast" : undefined);
    assert.equal(request.model_provider, undefined);
    await dialog().getByText("Advanced", { exact: true }).click();
    await dialog()
      .getByLabel("Provider", { exact: true })
      .selectOption(
        runtime === "pi"
          ? "local"
          : runtime === "codex"
            ? "chatgpt"
            : "anthropic",
      );
    assert.equal(
      await dialog().getByLabel("API key", { exact: true }).inputValue(),
      "",
    );
    assert.equal(
      await dialog().getByLabel("API URL", { exact: true }).inputValue(),
      "",
    );
    pass(
      `${runtime}: private endpoint, masked key, custom model and advanced controls reach the launch; switching providers clears credentials`,
    );
  }
  await dialog()
    .getByLabel("Provider", { exact: true })
    .selectOption("__custom_api__");
  await dialog()
    .getByLabel("API URL", { exact: true })
    .fill("https://private.test");
  await dialog().getByLabel("API key", { exact: true }).fill("fixture-key");
  await dialog().getByLabel("Runtime", { exact: true }).selectOption("pi");
  assert.equal(
    await dialog().getByLabel("API key", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await dialog().getByLabel("Claude command override").inputValue(),
    "",
  );
  assert.equal(await dialog().getByLabel("Variable name").count(), 0);
  assert.equal(await dialog().getByLabel("Fast mode").isChecked(), false);
  await dialog()
    .getByLabel("Provider", { exact: true })
    .selectOption("__custom_api__");
  await dialog()
    .getByLabel("API URL", { exact: true })
    .fill("https://private.test");
  await dialog().getByLabel("API key", { exact: true }).fill("fixture-key");
  await dialog()
    .getByLabel("Working directory", { exact: true })
    .fill("/old-computer");
  await dialog()
    .getByLabel("Computer & hub", { exact: true })
    .selectOption("1");
  await ready();
  await dialog().getByLabel("Runtime", { exact: true }).selectOption("pi");
  assert.equal(
    await dialog().getByLabel("API key", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await dialog().getByLabel("API URL", { exact: true }).inputValue(),
    "",
  );
  assert.equal(
    await dialog()
      .getByLabel("Working directory", { exact: true })
      .inputValue(),
    "",
  );
  assert.deepEqual(
    await dialog()
      .getByLabel("Provider", { exact: true })
      .locator("option")
      .allTextContents(),
    ["Choose a provider", "work-provider", "Custom API"],
  );
  assert.equal(
    await dialog().getByLabel("Provider", { exact: true }).inputValue(),
    "",
  );
  const beforeUnknown = received.length;
  await dialog()
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  assert.equal(received.length, beforeUnknown);
  assert.equal(
    await dialog()
      .getByLabel("Provider", { exact: true })
      .evaluate((el) => el.validity.valueMissing),
    true,
  );
  await dialog()
    .getByLabel("Provider", { exact: true })
    .selectOption("work-provider");
  await dialog()
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  assert.equal(received.length, beforeUnknown);
  assert.equal(
    await dialog()
      .getByLabel("Model", { exact: true })
      .evaluate((el) => el.validity.valueMissing),
    true,
  );
  pass(
    "Unknown configured provider or model stays unselected and cannot create an agent with empty launch values",
  );
  delayLaptop = true;
  await dialog()
    .getByLabel("Computer & hub", { exact: true })
    .selectOption("0");
  await dialog()
    .getByRole("button", { name: "Loading choices…", exact: true })
    .waitFor();
  assert.equal(
    await dialog()
      .getByRole("button", { name: "Loading choices…", exact: true })
      .isDisabled(),
    true,
  );
  await dialog()
    .getByRole("status")
    .getByText("Loading choices from this computer…")
    .waitFor();
  for (const label of ["Runtime", "Provider", "Model"])
    assert.equal(await dialog().getByLabel(label, { exact: true }).isDisabled(), true);
  assert.equal(await dialog().getByRole("button", { name: "Cancel", exact: true }).isEnabled(), true);
  await dialog()
    .getByLabel("Computer & hub", { exact: true })
    .selectOption("1");
  await ready();
  for (const label of ["Runtime", "Provider", "Model"])
    assert.equal(await dialog().getByLabel(label, { exact: true }).isEnabled(), true);
  await page.waitForTimeout(800);
  assert.equal(
    await dialog()
      .getByLabel("Provider", { exact: true })
      .locator("option[value=anthropic]")
      .count(),
    0,
  );
  pass(
    "Switching computers clears previous selections and paths; late catalog responses cannot replace current choices",
  );
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  await context.close();
  const sharedContext = await browser.newContext({
    serviceWorkers: "block",
    viewport: { width: 1440, height: 1000 },
  });
  page = await sharedContext.newPage();
  page.setDefaultTimeout(10000);
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(origin + "/shared");
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await ready();
  assert.equal(
    await dialog()
      .getByLabel("Agent name")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Escape");
  assert.equal(await dialog().isVisible(), true);
  const closeButton = dialog().getByRole("button", {
    name: "Close",
    exact: true,
  });
  await closeButton.focus();
  await page.keyboard.press("Shift+Tab");
  assert.equal(
    await dialog()
      .getByRole("button", { name: "Create agent", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await page.keyboard.press("Tab");
  assert.equal(
    await closeButton.evaluate((el) => el === document.activeElement),
    true,
  );
  await dialog().getByLabel("Agent name").fill("   ");
  await dialog()
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await dialog().getByRole("alert").getByText("Enter an agent name.").waitFor();
  assert.equal(
    await dialog().getByLabel("Agent name").getAttribute("aria-invalid"),
    "true",
  );
  assert.equal(
    await dialog()
      .getByLabel("Agent name")
      .evaluate((el) => el === document.activeElement),
    true,
  );
  await dialog().getByLabel("Agent name").fill("Default config");
  assert.equal(
    await dialog().getByLabel("Agent name").getAttribute("aria-invalid"),
    null,
  );
  delayLaunch = true;
  const pendingSubmit = submit();
  await dialog()
    .getByRole("button", { name: "Creating agent…", exact: true })
    .waitFor();
  assert.equal(
    await dialog().getByLabel("Runtime", { exact: true }).isDisabled(),
    true,
  );
  assert.equal(
    await dialog().locator("form").getAttribute("aria-busy"),
    "true",
  );
  await page.keyboard.press("Escape");
  assert.equal(await dialog().isVisible(), true);
  assert.deepEqual((await pendingSubmit).body, {
    name: "Default config",
    backend: "pi",
    launch: {
      model_provider: "local",
      model: "pi-default",
      reasoning_effort: "off",
    },
  });
  delayLaunch = false;
  pass(
    "Keyboard focus wraps within creation; Escape preserves dialog; invalid names focus their associated alert; pending launch announces status and locks choices",
  );
  assert.deepEqual((await submit()).body, {
    name: "Default config",
    backend: "pi",
    launch: {
      model_provider: "local",
      model: "pi-default",
      reasoning_effort: "off",
    },
  });
  await page.setViewportSize({ width: 390, height: 844 });
  for (const runtime of ["pi", "codex", "cc"]) {
    await dialog().getByLabel("Runtime", { exact: true }).selectOption(runtime);
    if (runtime === "pi")
      await dialog().getByText("More", { exact: true }).click();
    await dialog()
      .getByLabel("Provider", { exact: true })
      .selectOption("__custom_api__");
    await dialog()
      .getByLabel("API URL", { exact: true })
      .fill("https://private.test/v1");
    await dialog().getByLabel("API key", { exact: true }).fill("fixture-key");
    await dialog()
      .getByLabel("Custom model", { exact: true })
      .fill("PrivateModel");
    assert.ok(
      await dialog()
        .locator(".agent-creation-body")
        .evaluate((el) => el.scrollWidth <= el.clientWidth),
    );
    assert.ok(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= innerWidth,
      ),
    );
    const box = await dialog().boundingBox();
    assert.ok(
      box.width <= 390 && box.height <= 844 && box.x >= 0 && box.y >= 0,
    );
    await page.screenshot({ path: `artifacts/creation-${runtime}-mobile.png` });
  }
  await dialog().getByRole("button", { name: "Cancel", exact: true }).click();
  assert.equal(
    await page
      .getByRole("button", { name: "New agent", exact: true })
      .evaluate((el) => el === document.activeElement),
    true,
  );
  pass(
    "Account/workspace form submits the actual configured provider, model and reasoning; all three runtime forms fit 390px and cancel restores focus",
  );
  await page.getByRole("button", { name: "New agent", exact: true }).click();
  await ready();
  const resume = page.locator("dialog.agent-creation");
  await resume.getByLabel("Agent name").fill("Continue saved work");
  await resume.getByLabel("Runtime", { exact: true }).selectOption("codex");
  await resume.getByLabel("Start", { exact: true }).selectOption("resume");
  await resume
    .getByLabel("Session working directory", { exact: true })
    .fill("/saved/workspace");
  await resume
    .getByRole("button", { name: "Find saved sessions", exact: true })
    .click();
  await resume
    .getByLabel("Saved sessions", { exact: true })
    .selectOption({ label: "Saved work" });
  assert.equal(
    await resume.getByLabel("Session ID", { exact: true }).inputValue(),
    "saved-laptop-codex",
  );
  await resume
    .getByRole("button", { name: "Resume agent", exact: true })
    .click();
  await page.waitForTimeout(150);
  assert.equal(
    received.at(-1).body.launch.resume_session_id,
    "saved-laptop-codex",
  );
  assert.equal(received.at(-1).body.launch.cwd, "/saved/workspace");
  assert.equal(received.at(-1).body.launch.provider_config, undefined);
  await resume.getByLabel("Runtime", { exact: true }).selectOption("pi");
  assert.equal(
    await resume.getByLabel("Session ID", { exact: true }).inputValue(),
    "",
  );
  await resume.getByLabel("Session ID", { exact: true }).fill("explicit-pi-id");
  await resume
    .getByRole("button", { name: "Resume agent", exact: true })
    .click();
  await page.waitForTimeout(150);
  assert.equal(received.at(-1).body.launch.resume_session_id, "explicit-pi-id");
  await page.screenshot({ path: "artifacts/resume-mobile.png" });
  await resume.getByRole("button", { name: "Cancel", exact: true }).click();
  pass(
    "Resume selects a scoped saved session or explicit ID, clears IDs on runtime changes, and sends no saved credentials",
  );
  assert.deepEqual(errors, []);
  passed = true;
} catch (error) {
  errors.push(error instanceof Error ? error.stack : String(error));
  await page
    .screenshot({
      path: "artifacts/agent-creation-failure.png",
      fullPage: true,
    })
    .catch(() => {});
  await writeFile(
    "artifacts/agent-creation-failure.html",
    await page.content(),
  ).catch(() => {});
  throw error;
} finally {
  await writeFile(
    "artifacts/agent-creation-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        errors,
        launches: received.map(({ computer, body }) => ({
          computer,
          body: {
            ...body,
            ...(body.provider_config
              ? {
                  provider_config: {
                    ...body.provider_config,
                    api_key: "[redacted]",
                  },
                }
              : {}),
            ...(body.env_vars
              ? {
                  env_vars: Object.fromEntries(
                    Object.keys(body.env_vars).map((key) => [
                      key,
                      "[redacted]",
                    ]),
                  ),
                }
              : {}),
          },
        })),
      },
      null,
      2,
    ),
  );
  await browser.close();
  await app.close();
}
