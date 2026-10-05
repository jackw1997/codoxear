// @ts-nocheck -- Behavioral browser fixtures retain their dynamic Playwright contracts.
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import Fastify from "fastify";
import { workspaceAsset } from "../src/hub/workspace.ts";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ?? "playwright"
);
const app = Fastify(),
  checks = [],
  errors = [],
  launches = [],
  edits = [];
let origin;
const session = (id, computer, alias, extra = {}) => ({
  session_id: id,
  alias,
  agent_backend: "pi",
  cwd: "/workspace",
  broker_pid: 123,
  owned: true,
  model: "fixture-model",
  reasoning_effort: "off",
  model_provider: "local",
  provider_choice: "local",
  codoxear_computer_id: computer,
  updated_ts: Date.now() / 1000,
  start_ts: Date.now() / 1000,
  busy: false,
  queue_len: 0,
  ...extra,
});
let sessions = [
  session("agent-a", "laptop", "Laptop conversation"),
  session("agent-b", "workstation", "Work conversation"),
  session("agent-private", "workstation", "Private conversation", {
    launch_requires_reentry: true,
  }),
  session(
    "agent-private-legacy",
    "workstation",
    "Existing private conversation",
    {
      model_provider: "codoxear_private",
    },
  ),
];
const placements = () =>
  ["laptop", "workstation"].map((computerId) => ({
    computerId,
    computerName: computerId,
    hubId: "hub",
    hubName: "Fixture hub",
    origin,
  }));
app.get("/api/agent-directory", async () => ({
  agents: sessions.map((s) => ({
    id: s.session_id,
    computerId: s.codoxear_computer_id,
    computerName: s.codoxear_computer_id,
    hubId: "hub",
    name: s.alias,
  })),
  placements: placements(),
}));
app.get("/workspace/api/sessions", async () => ({
  sessions,
  recent_cwds: [],
  new_session_defaults: {},
  tmux_available: false,
}));
app.get("/workspace/api/sessions/:id/access", async () => ({
  access: { mode: "full" },
}));
app.post("/workspace/api/sessions/:id/edit", async (r) => {
  const s = sessions.find((s) => s.session_id === r.params.id);
  assert.ok(s);
  edits.push(r.body);
  Object.assign(s, {
    alias: r.body.name,
    priority_offset: r.body.priority_offset,
    snooze_until: r.body.snooze_until,
    snoozed: !!r.body.snooze_until,
    dependency_session_id: r.body.dependency_session_id,
  });
  return { ok: true };
});
app.post("/api/v1/computers/:id/api/sessions", async (r) => {
  launches.push({ computer: r.params.id, body: r.body });
  const id = "agent-copy-" + launches.length;
  sessions.push(session(id, r.params.id, "Duplicated conversation"));
  return { agent_id: id, session_id: id };
});
app.get("/workspace/api/sessions/:id/messages/tail", async () => ({
  events: [],
  busy: false,
  queue_len: 0,
  token: null,
}));
app.get("/workspace/api/sessions/:id/diagnostics", async () => ({ ok: true }));
app.get("/setup", async (_r, reply) =>
  reply.type("text/html").send("<!doctype html><title>Fixture</title>"),
);
app.get("/*", async (r, reply) => {
  try {
    const a = await workspaceAsset("dist/client", r.params["*"], {
      issuer: "local-client",
      accountId: "test",
      hubId: "hub",
      computerId: "all",
    });
    return reply.type(a.type).send(a.body);
  } catch {
    return reply.code(404).send({ error: "Fixture route unavailable" });
  }
});
origin = await app.listen({ host: "127.0.0.1", port: 0 });
const browser = await chromium.launch({
  headless: true,
  executablePath: process.env.CHROMIUM_PATH,
  args: ["--no-sandbox", "--disable-dev-shm-usage"],
});
const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
page.setDefaultTimeout(15000);
page.on("pageerror", (e) => errors.push(e.message));
let passed = false;
const pass = (message) => {
  checks.push(message);
  console.log("PASS", message);
};
try {
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
          name: "Fixture hub",
          accountId: "test",
          accessToken: "fixture",
          refreshToken: "fixture",
          expiresAt: Date.now() + 3600000,
          identity: { name: "Test", method: "password", key: "test" },
        },
        "test-login",
      );
      tx.oncomplete = resolve;
      tx.onerror = reject;
    });
  }, origin);
  await page.goto(origin + "/#session=account~agent-a");
  await page.getByText("Work conversation", { exact: true }).first().waitFor();
  const work = page.locator('[data-session-id="account~agent-b"]');
  await work.hover();
  // Duplicate an unselected card while a different Computer is selected.
  await work
    .getByRole("button", { name: "Duplicate session", exact: true })
    .click();
  await page.waitForURL(/agent-copy-1/);
  assert.equal(launches.length, 1);
  assert.equal(launches[0].computer, "workstation");
  assert.equal(launches[0].body.model, "fixture-model");
  pass(
    "Duplicate preserves source Computer and model and selects the scoped v2 result",
  );
  const privateCard = page.locator('[data-session-id="account~agent-private"]');
  await privateCard.hover();
  await privateCard
    .getByRole("button", { name: "Duplicate session", exact: true })
    .click();
  await page.getByText(/re-enter this agent's provider credentials/).waitFor();
  assert.equal(launches.length, 1);
  const existingPrivate = page.locator(
    '[data-session-id="account~agent-private-legacy"]',
  );
  await existingPrivate.hover();
  await existingPrivate
    .getByRole("button", { name: "Duplicate session", exact: true })
    .click();
  await page.getByText(/re-enter this agent's provider credentials/).waitFor();
  assert.equal(launches.length, 1);
  pass(
    "New and existing private-provider duplicate requests credential re-entry without launching a default provider",
  );
  await work.hover();
  await work
    .getByRole("button", { name: "Edit conversation", exact: true })
    .click();
  await page.locator("#editNameInput").fill("Renamed work");
  await page.locator('[data-snooze-mode="4h"]').click();
  await page.locator("#editPriorityRange").fill("0.25");
  await page.locator("#editSaveBtn").click();
  await page.getByText("Renamed work", { exact: true }).first().waitFor();
  assert.equal(edits.length, 1);
  assert.ok(edits[0].snooze_until > Date.now() / 1000);
  assert.equal(edits[0].priority_offset, 0.25);
  await page.reload();
  await page.getByText("Renamed work", { exact: true }).first().waitFor();
  await page.locator('[data-session-id="account~agent-b"]').hover();
  await page
    .locator('[data-session-id="account~agent-b"]')
    .getByRole("button", { name: "Edit conversation", exact: true })
    .click();
  assert.equal(
    await page.locator("#editNameInput").inputValue(),
    "Renamed work",
  );
  assert.equal(await page.locator("#editPriorityRange").inputValue(), "0.25");
  assert.ok(
    (
      await page.locator('[data-snooze-mode="custom"]').getAttribute("class")
    ).includes("active"),
  );
  await page.locator("#editDependencyBtn").click();
  assert.equal(
    await page
      .locator("#editDependencyMenu")
      .getByText(/Laptop conversation/)
      .count(),
    0,
  );
  pass(
    "Edit rename, priority and snooze survive browser reload; dependency picker excludes another Computer",
  );
  assert.deepEqual(errors, []);
  passed = true;
} finally {
  await mkdir("artifacts", { recursive: true });
  if (!passed)
    await writeFile("artifacts/lifecycle-failure.html", await page.content());
  await writeFile(
    "artifacts/lifecycle-results.json",
    JSON.stringify({ passed, checks, errors, launches, edits }, null, 2),
  );
  await browser.close();
  await app.close();
}
