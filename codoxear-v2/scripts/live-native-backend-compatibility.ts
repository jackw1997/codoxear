/** Explicit compatibility probes against the existing private endpoint/model.
 * No API contract fallback or endpoint rewrite; capability failures are results. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn } from "node:child_process";
import { NativeRuntime } from "../src/computer/native/runtime.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const config = JSON.parse(
  await readFile("/live-provider/provider.json", "utf8"),
);
const redact = (value: unknown) =>
  String(value)
    .split(config.apiKey)
    .join("[private credential]")
    .split(config.url)
    .join("[private provider]")
    .split(new URL(config.url).hostname)
    .join("[private provider]")
    .replace(/https?:\/\/[^\s"'<>]+/g, "[endpoint]")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "");
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const proxy = spawn(
  process.execPath,
  [
    resolve("scripts/demo-provider-network.mjs"),
    "container",
    "/egress/provider-egress.sock",
  ],
  { stdio: "ignore" },
);
await wait(250);
process.env.CODEX_BIN = "/opt/codoxear-tools/node/bin/codex";
process.env.CLAUDE_BIN = "/tools/claude";
process.env.IS_SANDBOX = "1";
process.env.NODE_OPTIONS =
  "--import=" + resolve("scripts/live-provider-proxy.mjs");
const results: Array<Record<string, unknown>> = [];
for (const backend of ["codex", "cc"] as const) {
  const home = await mkdtemp(join(tmpdir(), "live-" + backend + "-")),
    workspace = join(home, "workspace");
  await mkdir(workspace);
  await mkdir(join(home, ".codex"));
  await mkdir(join(home, ".claude"));
  await writeFile(
    join(home, ".codex", "config.toml"),
    `[projects.${JSON.stringify(workspace)}]\ntrust_level = "trusted"\n`,
  );
  // Only the disposable test project/key is approved, never the user's config.
  await writeFile(
    join(home, ".claude", "settings.json"),
    JSON.stringify({ skipDangerousModePermissionPrompt: true }),
  );
  await writeFile(
    join(home, ".claude", ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      customApiKeyResponses: {
        approved: [config.apiKey.slice(-20)],
        rejected: [],
      },
      bypassPermissionsModeAccepted: true,
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    }),
    { mode: 0o600 },
  );
  const runtime = new NativeRuntime(home, workspace),
    marker = "LIVE_" + backend.toUpperCase() + "_COMPATIBILITY";
  const record: Record<string, unknown> = {
    backend,
    contract: backend === "codex" ? "openai-responses" : "anthropic-messages",
    endpointUnchanged: true,
    toolExecuted: false,
  };
  let id: string | undefined;
  try {
    id = (
      await runtime.createTerminal(backend, "Private provider compatibility", {
        cwd: workspace,
        model: config.model,
        provider_config: { base_url: config.url, api_key: config.apiKey },
      })
    ).localId;
    const readyEnd = Date.now() + 30000;
    while (true) {
      const s = await runtime.request(`/api/sessions/${id}/state`);
      if (s.readiness === "ready") break;
      if (s.readiness === "setup_required")
        throw Error("Native setup required: " + s.setup_message);
      assert.ok(Date.now() < readyEnd, "Native editor readiness timeout");
      await wait(100);
    }
    const text =
      "Use your shell tool exactly once to run:\n```sh\nprintf '" +
      marker +
      "\\n' >> compatibility-commits.txt\n```\nDo not run other commands. Then reply only with " +
      marker +
      ".";
    await runtime.request(`/api/sessions/${id}/send`, "POST", { text });
    const end = Date.now() + 90000;
    while (true) {
      const commits = await readFile(
        join(workspace, "compatibility-commits.txt"),
        "utf8",
      ).catch(() => "");
      if (commits.includes(marker)) {
        assert.deepEqual(commits.trim().split("\n"), [marker]);
        record.toolExecuted = true;
        break;
      }
      const tail = redact((await runtime.queueControl(id, "tail")).tail);
      if (
        /API Error:|invalid_request_error|model_not_found|does not support|not supported|404 Not Found|401 Unauthorized|403 Forbidden/i.test(
          tail,
        )
      )
        throw Error("Provider contract rejected: " + tail.slice(-2200));
      assert.ok(
        Date.now() < end,
        "No native shell commit within compatibility deadline",
      );
      await wait(200);
    }
    record.status = "accepted";
  } catch (error) {
    record.status = "unproven";
    record.reason = redact(error instanceof Error ? error.message : error);
    if (id)
      record.producerTail = redact(
        (
          await runtime
            .queueControl(id, "tail")
            .catch(() => ({ tail: "unavailable" }))
        ).tail,
      ).slice(-3500);
  } finally {
    if (id)
      await runtime
        .request(`/api/sessions/${id}/delete`, "POST", {})
        .catch(() => {});
    runtime.close();
  }
  results.push(record);
  console.log(
    "RESULT",
    backend,
    record.status,
    record.toolExecuted === true
      ? "actual native shell tool executed"
      : "actual native provider contract did not establish shell execution",
  );
}
await mkdir("artifacts", { recursive: true });
await writeFile(
  "artifacts/live-native-backend-compatibility-results.json",
  JSON.stringify(
    {
      results,
      limitations: [
        "Compatibility applies to the unchanged user-configured provider endpoint and model",
        "Unproven includes explicit native setup or provider contract rejection; no fallback inference",
      ],
    },
    null,
    2,
  ),
);
if (proxy.exitCode === null) proxy.kill("SIGTERM");
process.exit(0);
