import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/identity/accounts.js";
import { Authority } from "../src/identity/authority.js";
import { Tokens, signingKey } from "../src/identity/tokens.js";
import { createIdentityApp } from "../src/identity/app.js";
import {
  passwordHash,
  secret,
  createHub,
  createComputer,
  invite,
  acceptInvite,
} from "../src/domain/commands.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const issuer = "http://127.0.0.1:19440",
  store = new Store(":memory:"),
  delivered: Array<{ method: string; target: string; code: string }> = [];
store.change((s) =>
  s.users.push({
    id: "alice",
    name: "Alice",
    email: "alice@example.test",
    passwordHash: passwordHash("isolated-password"),
    disabled: false,
  }),
);
const accounts = new Accounts(store, secret(), {
    async send(method, target, code) {
      delivered.push({ method, target, code });
    },
  }),
  authority = new Authority(
    store,
    accounts,
    new Tokens(issuer, await signingKey()),
  );
const app = await createIdentityApp({
  authority,
  secureCookies: false,
  codeDelivery: ["email", "phone"],
  clients: [
    { id: "native", redirectUris: [issuer + "/fixture-native-return"] },
  ],
  providers: [
    {
      id: "work",
      method: "feishu",
      async authorize(state) {
        return issuer + "/fixture-provider?state=" + encodeURIComponent(state);
      },
      async exchange(code) {
        assert.equal(code, "fixture-code");
        return {
          connection: "work",
          method: "feishu",
          subject: "verified-fixture-open-id",
          tenant: "test-organization",
          email: null,
          name: "Alice",
        };
      },
    },
  ],
});
app.get("/fixture-native-return", async (r) => {
  assert.ok((r.query as { code?: string }).code);
  return "Native authorization returned";
});
app.get("/fixture-provider", async (r, reply) =>
  reply.redirect(
    "/auth/work/callback?code=fixture-code&state=" +
      encodeURIComponent((r.query as { state: string }).state),
  ),
);
await app.listen({ host: "127.0.0.1", port: 19440 });
const { chromium } = await import(
    process.env.PLAYWRIGHT_MODULE ?? "playwright"
  ),
  browser = await chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: ["--no-sandbox", "--disable-dev-shm-usage"],
  }),
  page = await browser.newPage(),
  steps: string[] = [],
  errors: string[] = [];
page.on("pageerror", (e: any) => errors.push(e.message));
page.setDefaultTimeout(10000);
const pass = (name: string) => {
  steps.push(name);
  console.log("PASS", name);
};
async function otp(form: string, method: string, target: string) {
  await page.locator(form + " select[name=method]").selectOption(method);
  await page.locator(form + " input[name=target]").fill(target);
  await page.locator(form).getByRole("button", { name: "Send code" }).click();
  await page.getByLabel("Verification code").waitFor();
  await page.getByLabel("Verification code").fill(delivered.at(-1)!.code);
  const verified = page.waitForResponse(
    (r: any) =>
      r.url().endsWith("/api/v1/auth/code/verify") &&
      r.request().method() === "POST",
  );
  await page.getByRole("button", { name: "Verify code" }).click();
  await verified;
  await page.goto(issuer + "/?settings=1");
  await page.getByRole("heading", { name: "Your hubs" }).waitFor();
}
try {
  await page.goto(issuer + "/?settings=1");
  await page.getByLabel("Email", { exact: true }).fill("alice@example.test");
  await page.getByLabel("Password", { exact: true }).fill("isolated-password");
  await page.getByRole("button", { name: "Sign in", exact: true }).click();
  await page.getByText("Create a hub", { exact: true }).click();
  await page.getByLabel("Hub name").fill("Browser hub");
  await page.getByRole("button", { name: "Create hub", exact: true }).click();
  await page.locator("article").filter({ hasText: "Browser hub" }).waitFor();
  pass("Account owner creates a hub through the portal");
  await page.getByText("Hub service configuration", { exact: true }).click();
  await page.getByLabel("Public HTTPS origin").fill("https://browser-hub.test");
  const downloading = page.waitForEvent("download");
  await page
    .getByRole("button", { name: "Download new hub configuration" })
    .click();
  const config = JSON.parse(
    await readFile(await (await downloading).path(), "utf8"),
  );
  assert.equal(config.identityUrl, issuer);
  assert.equal(config.origin, "https://browser-hub.test");
  assert.ok(config.credential.length >= 32);
  pass(
    "Owner registers the hub and downloads its private service configuration",
  );
  await page
    .getByText("Link an email or phone number", { exact: true })
    .click();
  await otp("#link-code", "email", "linked@example.test");
  assert.equal(
    store
      .read()
      .identity.identities.find((i) => i.subject === "linked@example.test")
      ?.userId,
    "alice",
  );
  pass(
    "Fresh password login explicitly links a verified email without creating another account",
  );
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator("#otp").waitFor();
  await otp("#otp", "email", "linked@example.test");
  assert.equal(await page.locator("article").count(), 1);
  pass("Email-code login returns to the same hub and owner account");
  await page
    .getByText("Link an email or phone number", { exact: true })
    .click();
  await otp("#link-code", "phone", "+8613800000000");
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page.locator("#otp").waitFor();
  await otp("#otp", "phone", "+8613800000000");
  assert.equal(await page.locator("article").count(), 1);
  pass("Phone-code linking and login preserve account and hub ownership");
  await page
    .getByRole("link", { name: "Link feishu (work)", exact: true })
    .click();
  await page.goto(issuer + "/?settings=1");
  await page
    .getByText("feishu · verified-fixture-open-id", { exact: false })
    .waitFor();
  assert.equal(
    store.read().identity.identities.find((i) => i.connection === "work")
      ?.userId,
    "alice",
  );
  pass(
    "Provider linking round-trip binds state to the browser and preserves account identity (fixture provider)",
  );
  await page
    .locator("p")
    .filter({ hasText: "email · linked@example.test" })
    .getByRole("button", { name: "Remove", exact: true })
    .click();
  await page
    .getByText("email · linked@example.test", { exact: false })
    .waitFor({ state: "hidden" });
  assert.ok(
    !store
      .read()
      .identity.identities.some((i) => i.subject === "linked@example.test"),
  );
  pass("A freshly authenticated owner removes a linked identity");
  assert.deepEqual(errors, []);
  await page.screenshot({
    path: "artifacts/07-account-methods.png",
    fullPage: true,
  });
  await page.getByRole("button", { name: "Sign out", exact: true }).click();
  await page
    .getByRole("heading", { name: "Sign in to Codoxear", exact: true })
    .waitFor();
  await page.goto(
    issuer +
      "/oauth/authorize?" +
      new URLSearchParams({
        response_type: "code",
        client_id: "native",
        redirect_uri: issuer + "/fixture-native-return",
        state: "native-installation-test-state",
        code_challenge_method: "S256",
        code_challenge: createHash("sha256")
          .update("v".repeat(43))
          .digest("base64url"),
      }),
  );
  await page
    .getByRole("link", { name: "Sign in with feishu", exact: true })
    .click();
  await page
    .getByText("Native authorization returned", { exact: true })
    .waitFor();
  pass(
    "Provider login preserves the native PKCE continuation through the system-browser flow",
  );
  store.change((s) =>
    s.users.push({
      id: "bob",
      email: "bob@example.test",
      name: "Bob",
      passwordHash: passwordHash("isolated-password"),
      disabled: false,
    }),
  );
  const originalHub = store.read().hubs[0]!,
    target = store.change((s) => createHub(s, "bob", "Bob hub"));
  store.change((s) =>
    acceptInvite(
      s,
      "alice",
      invite(s, "bob", "hub", target.id, "alice@example.test", "operator")
        .token,
    ),
  );
  const owned = store.change((s) =>
    createComputer(
      s,
      "alice",
      originalHub.id,
      "Browser transfer computer",
      "alice",
    ),
  );
  await page.goto(issuer + "/?settings=1");
  await page.getByText("Move to another hub", { exact: true }).click();
  await page.getByLabel("Target hub", { exact: true }).selectOption(target.id);
  await page
    .getByRole("button", {
      name: "Move computer and disconnect old hub",
      exact: true,
    })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Target hub owner must issue" })
    .waitFor();
  assert.equal(
    store.read().computers.find((c) => c.id === owned.computer.id)!.hubId,
    originalHub.id,
  );
  const bobContext = await browser.newContext(),
    bob = await bobContext.newPage();
  try {
    await bob.goto(issuer + "/?settings=1");
    await bob.getByLabel("Email", { exact: true }).fill("bob@example.test");
    await bob.getByLabel("Password", { exact: true }).fill("isolated-password");
    await bob.getByRole("button", { name: "Sign in", exact: true }).click();
    await bob.getByText("Admit an existing computer", { exact: true }).click();
    await bob
      .getByLabel("Computer ID", { exact: true })
      .fill(owned.computer.id);
    await bob
      .getByRole("button", { name: "Create admission", exact: true })
      .click();
    await bob
      .getByRole("status")
      .filter({ hasText: "Share this admission" })
      .waitFor();
    await page
      .getByLabel("Target owner admission token", { exact: true })
      .fill(
        await bob.getByLabel("Admission token", { exact: true }).inputValue(),
      );
    await page
      .getByRole("button", {
        name: "Move computer and disconnect old hub",
        exact: true,
      })
      .click();
    await page
      .getByRole("status")
      .filter({ hasText: "Computer moved" })
      .waitFor();
    assert.equal(
      store.read().computers.find((c) => c.id === owned.computer.id)!.hubId,
      target.id,
    );
    assert.throws(() =>
      authority.device(originalHub.id, owned.computer.id, owned.credential),
    );
    assert.equal(store.read().identity.admissions.length, 0);
    pass(
      "Two owners use the portal to admit and move a computer; old attachment is rejected and admission is consumed",
    );
  } finally {
    await bobContext.close();
  }
  await page.goto(issuer + "/?settings=1");
  const ownedHub = page
    .locator("article")
    .filter({ hasText: originalHub.name });
  await ownedHub.getByText("Required sign-in method", { exact: true }).click();
  await ownedHub
    .getByLabel("Required method", { exact: true })
    .selectOption("wechat");
  await ownedHub
    .getByRole("button", { name: "Save sign-in requirement", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Fresh wechat sign-in" })
    .waitFor();
  assert.equal(
    store.read().identity.requirements.some((r) => r.hubId === originalHub.id),
    false,
  );
  await ownedHub
    .getByLabel("Required method", { exact: true })
    .selectOption("feishu");
  await ownedHub
    .getByRole("button", { name: "Save sign-in requirement", exact: true })
    .click();
  await page
    .getByRole("status")
    .filter({ hasText: "Sign-in requirement saved" })
    .waitFor();
  assert.equal(
    store.read().identity.requirements.find((r) => r.hubId === originalHub.id)
      ?.rule.method,
    "feishu",
  );
  pass(
    "Owner saves a proven sign-in requirement; an unproven method is rejected before locking the hub",
  );
  assert.deepEqual(errors, []);
} catch (e) {
  await page.screenshot({
    path: "artifacts/identity-failure.png",
    fullPage: true,
  });
  throw e;
} finally {
  await writeFile(
    "artifacts/identity-browser-results.json",
    JSON.stringify(
      {
        at: new Date().toISOString(),
        steps,
        errors,
        delivery: "in-memory fixture; no actual SMS/email provider",
        oauth: "fixture Feishu-shaped identity; no actual Feishu provider",
        passed: steps.length === 10 && errors.length === 0,
      },
      null,
      2,
    ),
  );
  await browser.close();
  await app.close();
  store.close();
}
