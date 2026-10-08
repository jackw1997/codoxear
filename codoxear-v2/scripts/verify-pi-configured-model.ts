/** Offline integration with the pinned OAR/Pi installation in the tools image. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OarFactory } from "../src/computer/managed/factory.js";

assert.ok(existsSync("/.dockerenv"), "Run in the bounded OAR Docker image");
const home = await mkdtemp(join(tmpdir(), "pi-configured-model-"));
try {
  const native = join(home, ".pi", "agent");
  await mkdir(native, { recursive: true });
  await writeFile(join(native, "settings.json"), JSON.stringify({
    defaultProvider: "litellm", defaultModel: "kimi-k3", defaultThinkingLevel: "off",
  }));
  await writeFile(join(native, "models.json"), JSON.stringify({ providers: {
    litellm: {
      baseUrl: "https://provider.invalid", apiKey: "fixture-key", api: "anthropic-messages",
      models: [{ id: "kimi-k3", name: "Kimi", reasoning: false, input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 128000, maxTokens: 16384 }],
    },
  } }));
  // The failed user request omitted model_provider and effort entirely.
  const input = { home, stateHome: home, cwd: home, backend: "pi" as const,
    model: "kimi-k3", permissionPolicy: "locally-trusted" as const };
  const factory = new OarFactory();
  const first = await factory.open(input);
  const profile = first.profile!;
  assert.ok(first.id);
  await first.dispose();
  const reopened = await factory.open({ ...input, profile });
  try { assert.ok(reopened.id); } finally { await reopened.dispose(); }
  console.log("PASS real OAR/Pi initializes and reopens an explicit bare model using the configured provider");
} finally {
  await rm(home, { recursive: true, force: true });
}
