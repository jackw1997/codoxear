/** Docker acceptance of real Claude startup gates and confirmed first prompt. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "claude-readiness-")),
  workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });
await mkdir(join(home, ".claude"), { recursive: true });
Object.assign(process.env, { CLAUDE_BIN: "/tools/claude", IS_SANDBOX: "1" });
const runtime = new NativeRuntime(home, workspace),
  gateway = await backendGateway(),
  checks: string[] = [],
  children: ChildProcess[] = [];
let passed = false;
let finalSession: string | undefined;
const configPath = join(home, ".claude", ".claude.json");
const launch = {
  agent_backend: "cc",
  cwd: workspace,
  model: "PrivateModel",
  provider_config: { base_url: gateway.origin, api_key: "fixture-private-key" },
};
async function until<T>(
  check: () => Promise<T | false>,
  ms = 30000,
): Promise<T> {
  const end = Date.now() + ms;
  while (true) {
    const value = await check();
    if (value) return value;
    if (Date.now() > end) throw new Error("Claude readiness timeout");
    await new Promise((r) => setTimeout(r, 100));
  }
}
async function config(
  trust: boolean,
  key: boolean,
  keyValue = "fixture-private-key",
) {
  const text = JSON.stringify({
    hasCompletedOnboarding: true,
    bypassPermissionsModeAccepted: true,
    projects: trust ? { [workspace]: { hasTrustDialogAccepted: true } } : {},
    customApiKeyResponses: { approved: key ? [keyValue] : [], rejected: [] },
  });
  await writeFile(configPath, text);
  return text;
}
const pass = (name: string) => {
  checks.push(name);
  console.log("PASS", name);
};
async function blockedLaunch(fragment: string) {
  await assert.rejects(
    () => runtime.request("/api/sessions", "POST", launch),
    (e: any) => e.status === 400 && e.message.includes(fragment),
  );
}
async function stopSession(id: string) {
  const state = await runtime.request(`/api/sessions/${id}/state`);
  await runtime.request(`/api/sessions/${id}/delete`, "POST");
  await until(async () => {
    try {
      return (
        (await readFile(`/proc/${state.pid}/stat`, "utf8")).split(" ")[2] ===
        "Z"
      );
    } catch {
      return true;
    }
  });
}
async function terminal(key = "fixture-private-key") {
  const id = "broker-" + randomUUID().replace(/-/g, "");
  const child = spawn(
    process.execPath,
    [resolve("dist/server/computer/native/broker.js"), "--terminal"],
    { stdio: ["pipe", "ignore", "inherit"] },
  );
  children.push(child);
  child.stdin!.end(
    JSON.stringify({
      home,
      sessionId: id,
      backend: "cc",
      cwd: workspace,
      name: "Terminal fixture",
      launch: {
        model: "PrivateModel",
        provider_config: { base_url: gateway.origin, api_key: key },
      },
    }),
  );
  await until(async () => {
    try {
      const state = (await runtime.request(`/api/sessions/${id}/state`)) as any;
      return state.readiness === "setup_required" ? state : false;
    } catch {
      return false;
    }
  });
  const text = "FIRST_PROMPT_MUST_SURVIVE";
  await assert.rejects(
    () => runtime.request(`/api/sessions/${id}/send`, "POST", { text }),
    (e: any) =>
      e.status === 409 &&
      (e.code === "setup_required" || e.message.includes("setup required")),
  );
  assert.ok(
    !JSON.stringify(await runtime.request(`/api/sessions/${id}/tail`)).includes(
      text,
    ),
  );
  assert.equal(
    gateway.requests.filter((r) =>
      /\/(?:messages|responses|chat\/completions)(?:\?|$)/.test(r.path),
    ).length,
    0,
    "No inference before native setup",
  );
  await runtime.request(`/api/sessions/${id}/delete`, "POST");
  await until(async () => child.exitCode !== null || child.signalCode !== null);
  return id;
}
try {
  await blockedLaunch("onboarding");
  assert.equal(existsSync(configPath), false);
  pass(
    "Fresh web Claude launch blocks onboarding and leaves configuration untouched",
  );
  let before = await config(false, true);
  await blockedLaunch("trust");
  assert.equal(await readFile(configPath, "utf8"), before);
  pass(
    "Untrusted web workspace blocked before launch; trust configuration unchanged",
  );
  await terminal();
  assert.equal(
    JSON.parse(await readFile(configPath, "utf8")).projects?.[workspace]
      ?.hasTrustDialogAccepted,
    undefined,
  );
  pass(
    "Real terminal Claude trust screen detected; first prompt rejected before PTY injection or inference",
  );
  before = await config(true, false);
  await blockedLaunch("API key");
  assert.equal(await readFile(configPath, "utf8"), before);
  pass("Unapproved provider key blocked before launch; approval unchanged");
  const longKey = "fixture-only-long-key-01234567890123456789";
  await terminal(longKey);
  assert.deepEqual(
    JSON.parse(await readFile(configPath, "utf8")).customApiKeyResponses
      ?.approved ?? [],
    [],
  );
  pass(
    "Real terminal Claude API-key confirmation detected; prompt not injected and key not approved",
  );
  // This fixture change represents the user's explicit terminal approval.
  await config(true, true, longKey.slice(-20));
  const approved = (await runtime.request("/api/sessions", "POST", {
    ...launch,
    provider_config: { base_url: gateway.origin, api_key: longKey },
  })) as any;
  await until(
    async () =>
      (
        (await runtime.request(
          `/api/sessions/${approved.session_id}/state`,
        )) as any
      ).readiness === "ready",
  );
  pass(
    "Installed Claude accepts existing long fixture-key approval by last-20-character representation",
  );
  await stopSession(approved.session_id);
  await config(true, true);
  const created = (await runtime.request(
    "/api/sessions",
    "POST",
    launch,
  )) as any;
  finalSession = created.session_id;
  await until(
    async () =>
      (
        (await runtime.request(
          `/api/sessions/${created.session_id}/state`,
        )) as any
      ).readiness === "ready",
  );
  await runtime.request(`/api/sessions/${created.session_id}/send`, "POST", {
    text: "FIRST_READY_PROMPT",
  });
  await until(async () =>
    JSON.stringify(
      await runtime.request(
        `/api/sessions/${created.session_id}/messages/tail?limit=100`,
      ),
    ).includes("PRIVATE_PROVIDER_OK"),
  );
  pass(
    "Configured native Claude becomes ready and receives first prompt with native streamed response",
  );
  await stopSession(created.session_id);
  passed = true;
} finally {
  if (!passed && finalSession) {
    const state = await runtime
      .request(`/api/sessions/${finalSession}/state`)
      .catch(() => null);
    const tail = await runtime
      .request(`/api/sessions/${finalSession}/tail`)
      .catch(() => null);
    await mkdir("artifacts", { recursive: true });
    await writeFile(
      "artifacts/claude-readiness-failure-state.json",
      JSON.stringify({ state, tail }, null, 2),
    );
  }
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/claude-readiness-results.json",
    JSON.stringify(
      {
        passed,
        engine: "native-typescript",
        at: new Date().toISOString(),
        checks,
        startup_requests: gateway.requests,
      },
      null,
      2,
    ),
  );
  for (const child of children)
    if (child.exitCode === null && child.signalCode === null)
      child.kill("SIGTERM");
  runtime.close();
  await gateway.close();
}
