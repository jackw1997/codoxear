/** Docker-only real native CLI acceptance against local scripted provider APIs. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "native-private-")),
  workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(join(home, ".codex"), { recursive: true });
await writeFile(
  join(home, ".codex", "config.toml"),
  `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
);
await mkdir(join(home, ".claude"), { recursive: true });
await writeFile(
  join(home, ".claude", ".claude.json"),
  JSON.stringify({
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: { [workspace]: { hasTrustDialogAccepted: true } },
    customApiKeyResponses: { approved: ["fixture-private-key"], rejected: [] },
  }),
);
Object.assign(process.env, {
  PI_BIN: "/opt/codoxear-tools/node/bin/pi",
  CODEX_BIN: "/opt/codoxear-tools/node/bin/codex",
  CLAUDE_BIN: "/tools/claude",
  IS_SANDBOX: "1",
});
const gateway = await backendGateway(0),
  runtime = new NativeRuntime(home, workspace),
  results: any[] = [];
let passed = false;
let activeId: string | undefined;
async function until(check: () => Promise<boolean> | boolean, ms = 60000) {
  const end = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > end) throw new Error("Native provider timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}
try {
  for (const [backend, api] of [
    ["pi", "openai-completions"],
    ["pi", "anthropic-messages"],
    ["pi", "openai-responses"],
    ["codex", null],
    ["cc", null],
  ] as const) {
    const before = gateway.requests.length;
    const created = (await runtime.request("/api/sessions", "POST", {
      agent_backend: backend,
      cwd: workspace,
      model: "PrivateModel",
      provider_config: {
        base_url:
          gateway.origin +
          (backend !== "cc" && api !== "anthropic-messages" ? "/v1" : ""),
        api_key: "fixture-private-key",
        ...(api ? { api } : {}),
      },
    })) as any;
    const id = created.session_id;
    activeId = id;
    await until(
      async () =>
        ((await runtime.request(`/api/sessions/${id}/state`)) as any)
          .readiness === "ready",
    );
    await runtime.request(`/api/sessions/${id}/send`, "POST", {
      text: "Return the provider fixture acknowledgement.",
    });
    await until(() =>
      gateway.requests
        .slice(before)
        .some((r) => r.model === "PrivateModel" && r.authorized),
    );
    await until(async () =>
      JSON.stringify(
        await runtime.request(`/api/sessions/${id}/messages/tail?limit=100`),
      ).includes("PRIVATE_PROVIDER_OK"),
    );
    const routed = gateway.requests
      .slice(before)
      .filter((r) => r.model === "PrivateModel");
    assert.ok(
      routed.length && routed.every((r) => r.authorized),
      `${backend}: private endpoint and key verified`,
    );
    results.push({
      backend,
      api,
      response_received: true,
      endpoint_and_key_verified: true,
      requests: routed,
    });
    console.log(
      "PASS",
      backend,
      api ?? "native",
      "private endpoint/key and transcript",
    );
    await runtime.request(`/api/sessions/${id}/delete`, "POST");
  }
  passed = results.length === 5;
} finally {
  if (!passed && activeId) {
    const state = await runtime
      .request(`/api/sessions/${activeId}/state`)
      .catch(() => null);
    await writeFile(
      "artifacts/private-provider-failure-state.json",
      JSON.stringify(state, null, 2),
    );
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/private-provider-cli-results.json",
    JSON.stringify(
      {
        passed,
        engine: "native-typescript",
        at: new Date().toISOString(),
        results,
      },
      null,
      2,
    ),
  );
  runtime.close();
  await gateway.close();
}
