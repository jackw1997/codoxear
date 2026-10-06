import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { prepareProfile } from "../src/computer/managed/profiles.js";

assert.ok(
  existsSync("/.dockerenv"),
  "Provider/runtime verification runs only in Docker",
);
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
