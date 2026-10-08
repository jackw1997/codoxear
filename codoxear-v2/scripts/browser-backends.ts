import { createAllowedComputer } from "./testing/authorized-fixtures.js";
import "./testing/frontend-artifact.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
/** Docker-only native Codex/Claude browser acceptance with scripted inference.
 * The fixture workspace is trusted and onboarding is preconfigured; no user credentials.
 * Import/interrupt and fresh-install trust prompts are separate acceptance gaps. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn, execFileSync } from "node:child_process";
import { Store } from "../src/persistence/store.js";
import { createHubApp } from "../src/hub/app.js";
import { createIdentityApp } from "../src/identity/app.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { AuthorityClient } from "../src/hub/authority-client.js";
import { NotificationInbox } from "../src/hub/notifications.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/server/tunnels.js";
import {
  createHub,
  passwordHash,
  secret,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "native-browser-")),
  workspace = join(home, "workspace");
await mkdir(workspace, { recursive: true });
await writeFile(join(workspace, "tracked.txt"), "original line\n");
for (const args of [
  ["init"],
  ["config", "user.email", "test@example.invalid"],
  ["config", "user.name", "Verification"],
  ["add", "tracked.txt"],
  ["commit", "-m", "fixture"],
])
  execFileSync("/usr/bin/git", args, { cwd: workspace, stdio: "ignore" });
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
    customApiKeyResponses: { approved: ["fixture-private-key"], rejected: [] },
    bypassPermissionsModeAccepted: true,
    projects: { [workspace]: { hasTrustDialogAccepted: true } },
  }),
);
Object.assign(process.env, {
  PI_BIN: "/opt/codoxear-tools/node/bin/pi",
  CODEX_BIN: "/opt/codoxear-tools/node/bin/codex",
  CLAUDE_BIN: "/tools/claude",
  IS_SANDBOX: "1",
});
const nativeRuntime = new NativeRuntime(home, workspace, join(home, "computer"));
const gateway = await backendGateway();
let logs = "";
async function until(check: () => Promise<boolean> | boolean, ms = 30000) {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("Timeout\n" + logs.slice(-5000));
    await new Promise((r) => setTimeout(r, 100));
  }
}
const store = new Store(":memory:");
store.change((s) =>
  s.users.push({
    id: "alice",
    email: "alice@test.invalid",
    name: "Alice",
    passwordHash: passwordHash("isolated-password"),
    disabled: false,
  }),
);
const computer = store.change((s) =>
  createAllowedComputer(
    s,
    "alice",
    createHub(s, "alice", "Runtime test").id,
    "Native backends",
    "alice",
  ),
);
const issuer = "http://127.0.0.1:19740",
  origin = "http://127.0.0.1:19744",
  accounts = new Accounts(store, secret(), { async send() {} }),
  authority = new Authority(
    store,
    accounts,
    new Tokens(issuer, await signingKey()),
  ),
  identitySession = accounts.password(
    "alice@test.invalid",
    "isolated-password",
    "test",
  ).session,
  registration = authority.registerHub(
    identitySession,
    computer.computer.hubId,
    origin,
  ),
  sessions = new HubSessions(join(home, "hub.sqlite")),
  identity = await createIdentityApp({ authority, secureCookies: false });
await identity.listen({ host: "127.0.0.1", port: 19740 });
const client = new AuthorityClient(
  issuer,
  registration.hubId,
  registration.credential,
);
const notifications = new NotificationInbox(
  join(home, "notifications.sqlite"),
  registration.hubId,
  async (sessionId, agentId, computerId, binding) => {
    authority.authorizeNotification(
      registration.hubId,
      sessionId,
      agentId,
      computerId,
      binding,
    );
  },
);
let tunnels = new Tunnels(),
  hub = await createHubApp({
    origin,
    authority: client,
    notifications,
    sessions,
    tunnels,
    secureCookies: false,
  });
await hub.listen({ host: "127.0.0.1", port: 19744 });
const api = createComputerApi(join(home, "computer"));
await api.attach({
  version: 1,
  hubUrl: "http://127.0.0.1:19744",
  hubId: computer.computer.hubId,
  computerId: computer.computer.id,
  credential: computer.credential,
  runtime: "native",
  nativeHome: home,
  workspacePath: workspace,
});
const service = api.service();
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE!);
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
  }),
  page = await context.newPage();
page.setDefaultTimeout(20000);
const checks: string[] = [];
const pass = (text: string) => {
  checks.push(text);
  console.log("PASS", text);
};
let passed = false;
await mkdir("artifacts", { recursive: true });
try {
  await until(async () => {
    try {
      await nativeRuntime.execute({ op: "discover" });
      return true;
    } catch {
      return false;
    }
  });
  await until(async () => {
    try {
      return (await fetch("http://127.0.0.1:19821")).ok;
    } catch {
      return false;
    }
  });
  await service.start();
  await until(() => tunnels.online(computer.computer.id));
  await page.goto(issuer);
  await page.getByLabel("Email", { exact: true }).fill("alice@test.invalid");
  await page.getByLabel("Password", { exact: true }).fill("isolated-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.goto(origin);
  await page.getByRole("link", { name: "Sign in to your account" }).click();
  await page
    .getByRole("button", { name: "New agent", exact: true })
    .first()
    .waitFor();
  for (const backend of ["codex", "cc"]) {
    await page.goto(origin);
    await page
      .getByRole("button", { name: "New agent", exact: true })
      .first()
      .click();
    const dialog = page.getByRole("dialog", { name: "New agent", exact: true });
    await dialog.getByLabel("Agent name").fill("Native " + backend);
    await dialog.getByLabel("Runtime", { exact: true }).selectOption(backend);
    await dialog
      .getByLabel("Provider", { exact: true })
      .selectOption({ label: "Custom API" });
    await dialog
      .getByLabel("API URL", { exact: true })
      .fill("http://127.0.0.1:19821" + (backend === "codex" ? "/v1" : ""));
    await dialog
      .getByLabel("API key", { exact: true })
      .fill("fixture-private-key");
    await dialog
      .getByLabel("Custom model", { exact: true })
      .fill("PrivateModel");
    await dialog.getByText("More", { exact: true }).click();
    await dialog
      .getByLabel("Working directory", { exact: true })
      .fill(workspace);
    if (backend === "cc") {
      await dialog.getByText("Advanced", { exact: true }).click();
      await dialog
        .getByLabel("Claude command override", { exact: true })
        .fill("/tools/claude");
    }
    await dialog
      .getByRole("button", { name: "Create agent", exact: true })
      .click();
    await dialog.waitFor({ state: "hidden", timeout: 60000 });
    await page
      .getByLabel("Message", { exact: true })
      .fill("Return PRIVATE_PROVIDER_OK");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page
      .getByText("PRIVATE_PROVIDER_OK", { exact: true })
      .first()
      .waitFor({ timeout: 60000 });
    pass(
      backend +
        ": browser creation, private gateway send and transcript use real CLI",
    );
    await page.reload();
    await page
      .getByText("PRIVATE_PROVIDER_OK", { exact: true })
      .first()
      .waitFor({ timeout: 30000 });
    pass(backend + ": browser reconnect restores transcript");
    if (backend === "codex") {
      // Stop only this recorded Docker fixture process, preserving its saved native log.
      const catalog = (await nativeRuntime.request("/api/sessions")) as any;
      const native = catalog.sessions.find(
        (row: any) => row.agent_backend === "codex",
      );
      assert.ok(native?.session_id);
      await nativeRuntime.request(
        "/api/sessions/" + native.session_id + "/delete",
        "POST",
      );
      await until(async () => {
        const next = (await nativeRuntime.request("/api/sessions")) as any;
        return !next.sessions.some(
          (row: any) => row.session_id === native.session_id,
        );
      });
      await page.goto(origin);
      await page
        .getByRole("button", { name: "New agent", exact: true })
        .first()
        .click();
      const resumed = page.locator("dialog.agent-creation");
      await resumed.getByLabel("Agent name").fill("Resumed Codex");
      await resumed
        .getByLabel("Runtime", { exact: true })
        .selectOption("codex");
      await resumed.getByLabel("Start", { exact: true }).selectOption("resume");
      await resumed
        .getByLabel("Session working directory", { exact: true })
        .fill(workspace);
      await resumed
        .getByRole("button", { name: "Find saved sessions", exact: true })
        .click();
      await until(
        async () =>
          (await resumed
            .getByLabel("Saved sessions", { exact: true })
            .locator("option")
            .count()) > 1,
      );
      await resumed
        .getByLabel("Saved sessions", { exact: true })
        .selectOption({ index: 1 });
      assert.ok(
        await resumed.getByLabel("Session ID", { exact: true }).inputValue(),
      );
      await resumed
        .getByLabel("Provider", { exact: true })
        .selectOption({ label: "Custom API" });
      await resumed
        .getByLabel("API URL", { exact: true })
        .fill("http://127.0.0.1:19821/v1");
      await resumed
        .getByLabel("API key", { exact: true })
        .fill("fixture-private-key");
      await resumed
        .getByLabel("Custom model", { exact: true })
        .fill("PrivateModel");
      await resumed
        .getByRole("button", { name: "Resume agent", exact: true })
        .click();
      await resumed.waitFor({ state: "hidden", timeout: 60000 });

      await page
        .getByText("PRIVATE_PROVIDER_OK", { exact: true })
        .first()
        .waitFor({ timeout: 30000 });
      await page
        .getByLabel("Message", { exact: true })
        .fill("Continue with PRIVATE_PROVIDER_OK");
      await page.getByRole("button", { name: "Send", exact: true }).click();
      await until(
        async () =>
          (await page
            .getByText("PRIVATE_PROVIDER_OK", { exact: true })
            .count()) >= 2,
      );
      pass(
        "codex: scoped saved-session picker resumes native history and accepts another turn",
      );
    }
  }
  const routed = await (await fetch("http://127.0.0.1:19821")).json();
  for (const protocol of ["responses", "messages"]) {
    const matching = routed.filter(
      (r: any) =>
        r.path.split("?")[0].endsWith("/" + protocol) &&
        r.model === "PrivateModel",
    );
    assert.ok(matching.length > 0);
    assert.ok(matching.every((r: any) => r.authorized));
    pass(
      protocol +
        ": entered private model and fixture API key verified at gateway",
    );
  }
  passed = true;
} catch (error) {
  console.error(error);
  console.error(
    "BROWSER STATE",
    (await page.locator("body").innerText()).slice(-6000),
  );
  console.error(logs.slice(-6000));
  await page.screenshot({
    path: "artifacts/browser-backends-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await writeFile(
    "artifacts/browser-backends-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        limitations: [
          "Scripted inference only; no hosted provider credentials",
          "Trusted, pre-onboarded Claude fixture",
          "Native import and interrupt not exercised",
          "Native Pi/Claude saved-session resume not exercised",
          "Native Codex resume requires CLI project trust; trusted fixture only",
          "Fresh Claude setup is verified in separate readiness acceptance; user decisions remain in the local terminal",
        ],
      },
      null,
      2,
    ),
  );
  await browser.close();
  nativeRuntime.close();
  await gateway.close();
  tunnels.close();
  // Native brokers survive Computer shutdown by design. Docker teardown owns
  // their termination; do not wait indefinitely for long-lived transport cleanup.
  await Promise.race([
    service
      .stop()
      .then(() => hub.close())
      .then(() => identity.close()),
    new Promise((resolve) => setTimeout(resolve, 3000)),
  ]);
  notifications.close();
  sessions.close();
  store.close();
  process.exit(passed ? 0 : 1);
}
