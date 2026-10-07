import "./testing/frontend-artifact.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { backendGateway } from "./backend-gateway.js";
/** Docker-only native Codex/Claude browser acceptance with scripted inference.
 * The fixture workspace is trusted and onboarding is preconfigured; no user credentials.
 * Import/interrupt and fresh-install trust prompts are separate acceptance gaps. */
import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, chmod } from "node:fs/promises";
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
  createComputer,
  passwordHash,
  secret,
} from "../src/domain/commands.js";
import { createComputerApi } from "../src/computer/api.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const home = await mkdtemp(join(tmpdir(), "cc-browser-")),
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
await mkdir(join(home, ".claude"), { recursive: true });
await writeFile(
  join(home, ".claude", ".claude.json"),
  JSON.stringify({
    hasCompletedOnboarding: true,
    customApiKeyResponses: { approved: ["fixture-private-key"], rejected: [] },
    bypassPermissionsModeAccepted: true,
    projects: {},
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
  createComputer(
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
      return (await fetch("http://127.0.0.1:19743/api/me")).status === 401;
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
    .click();
  const dialog = page.getByRole("dialog", { name: "New agent", exact: true });
  await dialog.getByLabel("Agent name").fill("Claude readiness");
  await dialog.getByLabel("Runtime", { exact: true }).selectOption("cc");
  await dialog
    .getByLabel("Provider", { exact: true })
    .selectOption({ label: "Custom API" });
  await dialog
    .getByLabel("API URL", { exact: true })
    .fill("http://127.0.0.1:19821");
  await dialog
    .getByLabel("API key", { exact: true })
    .fill("fixture-private-key");
  await dialog.getByLabel("Custom model", { exact: true }).fill("PrivateModel");
  await dialog.getByText("More", { exact: true }).click();
  await dialog.getByLabel("Working directory", { exact: true }).fill(workspace);
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await dialog
    .getByText(/Claude Code setup required:/)
    .waitFor({ timeout: 60000 });
  assert.equal(
    await dialog.getByLabel("Agent name").inputValue(),
    "Claude readiness",
  );
  assert.equal(
    await dialog.getByLabel("API URL", { exact: true }).inputValue(),
    "http://127.0.0.1:19821",
  );
  assert.equal(
    await dialog.getByLabel("API key", { exact: true }).inputValue(),
    "fixture-private-key",
  );
  assert.equal(
    await dialog.getByLabel("Custom model", { exact: true }).inputValue(),
    "PrivateModel",
  );
  pass(
    "Browser trust setup rejection is actionable and retains creation form values",
  );
  // This is fixture preparation, representing explicit terminal setup by the user.
  await writeFile(
    join(home, ".claude", ".claude.json"),
    JSON.stringify({
      hasCompletedOnboarding: true,
      bypassPermissionsModeAccepted: true,
      customApiKeyResponses: {
        approved: ["fixture-private-key"],
        rejected: [],
      },
      projects: { [workspace]: { hasTrustDialogAccepted: true } },
    }),
  );
  const gate = join(home, "startup-gate"),
    wrapper = join(home, "claude-wrapper");
  execFileSync("/usr/bin/mkfifo", [gate]);
  await writeFile(
    wrapper,
    `#!/bin/sh\nread -r startup < '${gate}'\nexec /tools/claude "$@"\n`,
  );
  await chmod(wrapper, 0o755);
  await dialog.getByText("Advanced", { exact: true }).click();
  await dialog
    .getByLabel("Claude command override", { exact: true })
    .fill(wrapper);
  await dialog
    .getByRole("button", { name: "Create agent", exact: true })
    .click();
  await dialog.waitFor({ state: "hidden", timeout: 60000 });
  const composer = page.getByLabel("Message", { exact: true });
  await composer.fill("FIRST_BROWSER_PROMPT");
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page.getByText(/Claude Code is starting:/).waitFor();
  assert.equal(await composer.inputValue(), "FIRST_BROWSER_PROMPT");
  await until(
    async () =>
      !(await page
        .getByRole("button", { name: "Send", exact: true })
        .isDisabled()),
  );
  assert.equal(
    await page.getByText(/previous send has an unknown outcome/).count(),
    0,
  );
  pass(
    "Definitive early send rejection retains composer text and allows retry without an unknown-outcome warning",
  );
  // Release the wrapper barrier; inference still uses the actual installed CLI.
  await writeFile(gate, "ready\n");
  await until(async () => {
    const catalog = (await nativeRuntime.request("/api/sessions")) as any;
    const native = catalog.sessions.find((r: any) => r.agent_backend === "cc");
    if (!native) return false;
    const state = (await nativeRuntime.request(
      "/api/sessions/" + native.session_id + "/state",
    )) as any;
    return state.readiness === "ready";
  });
  await page.getByRole("button", { name: "Send", exact: true }).click();
  await page
    .getByText("PRIVATE_PROVIDER_OK", { exact: true })
    .first()
    .waitFor({ timeout: 60000 });
  pass(
    "Configured native Claude accepts first browser prompt and renders streamed response",
  );
  passed = true;
} catch (error) {
  console.error(error);
  console.error(
    "BROWSER STATE",
    (await page.locator("body").innerText()).slice(-6000),
  );
  console.error(logs.slice(-6000));
  await page.screenshot({
    path: "artifacts/browser-claude-readiness-failure.png",
    fullPage: true,
  });
  throw error;
} finally {
  await writeFile(
    "artifacts/browser-claude-readiness-results.json",
    JSON.stringify(
      {
        passed,
        checks,
        limitations: [
          "Scripted inference only; no hosted provider credentials",
          "Onboarding/private authentication uses fixture-only configuration",
          "Native import and interrupt not exercised",
          "Setup dialogs completed in terminal; never autoaccepted by app",
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
