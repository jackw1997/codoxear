import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store } from "../src/persistence/store.js";
import { createHub, passwordHash } from "../src/domain/commands.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { createApp } from "../src/server/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import {
  frontendAsset,
  frontendAssetsRoot,
} from "../src/presentation/frontend-assets.js";
import { workspaceAsset } from "../src/presentation/workspace-assets.js";

assert.ok(existsSync("/.dockerenv"), "Docker only");

async function services(root?: string) {
  const store = new Store(":memory:");
  const hubId = store.change((state) => {
    state.users.push({
      id: "owner",
      name: "Owner",
      email: "owner@example.test",
      passwordHash: passwordHash("test-password"),
      disabled: false,
    });
    return createHub(state, "owner", "Artifact test").id;
  });
  const local = await independentAuthority({
    origin: "https://artifact.test",
    hubId,
    store,
    otpKey: "artifact-test-key".repeat(4),
    frontendAssetsRoot: root,
    secureCookies: false,
  });
  const sessions = new HubSessions(":memory:");
  const hub = await createHubApp({
    origin: "https://artifact.test",
    authority: local.client,
    localIdentity: local.identity,
    sessions,
    tunnels: new Tunnels(),
    frontendAssetsRoot: root,
    secureCookies: false,
  });
  const server = await createApp({
    store,
    tunnels: new Tunnels(),
    frontendAssetsRoot: root,
  });
  return {
    identity: local.identity,
    hub,
    server,
    async close() {
      await hub.close();
      await server.close();
      await local.identity.close();
      sessions.close();
      store.close();
    },
  };
}

test("backend APIs start without frontend artifacts and UI routes report their absence", async () => {
  const original = process.env.CODOXEAR_FRONTEND_ASSETS_ROOT;
  delete process.env.CODOXEAR_FRONTEND_ASSETS_ROOT;
  const apps = await services();
  try {
    for (const app of [apps.identity, apps.hub, apps.server]) {
      assert.equal((await app.inject("/health")).statusCode, 200);
      const ui = await app.inject("/");
      assert.equal(ui.statusCode, 404);
      assert.equal(ui.json().code, "ui_unavailable");
    }
    const login = await apps.hub.inject("/login");
    assert.equal(login.statusCode, 404);
    assert.equal(login.json().code, "ui_unavailable");
    assert.equal(
      (await apps.identity.inject("/api/v1/auth/options")).statusCode,
      200,
    );
    assert.equal((await apps.hub.inject("/api/auth/options")).statusCode, 200);
    assert.equal(
      (await apps.server.inject("/api/auth/options")).statusCode,
      200,
    );
  } finally {
    await apps.close();
    if (original !== undefined)
      process.env.CODOXEAR_FRONTEND_ASSETS_ROOT = original;
  }
});

test("separate absolute frontend artifact supplies UI assets and fences traversal", async () => {
  const root = await mkdtemp(join(tmpdir(), "frontend-artifact-"));
  for (const module of ["web", "identity/appearance", "client", "workspace"])
    await mkdir(join(root, module), { recursive: true });
  await writeFile(
    join(root, "web/index.html"),
    "<!doctype html><html><head></head><body>External artifact</body></html>",
  );
  await writeFile(
    join(root, "workspace/index.html"),
    "<html><head></head><body>Workspace artifact</body></html>",
  );
  await writeFile(
    join(root, "identity/account.js"),
    "globalThis.accountArtifact = true;",
  );
  await writeFile(
    join(root, "identity/appearance/app.css"),
    ":root { color: black; }",
  );
  await writeFile(
    join(root, "identity/cache-design.html"),
    "<html>External guide</html>",
  );
  await writeFile(
    join(root, "client/hub-login.js"),
    "globalThis.loginArtifact = true;",
  );
  await symlink(
    join(root, "identity/account.js"),
    join(root, "workspace/escaped.js"),
  );
  const apps = await services(root);
  try {
    for (const app of [apps.hub, apps.server]) {
      const page = await app.inject("/");
      assert.equal(page.statusCode, 200, page.body);
      assert.equal(
        page.body,
        "<!doctype html><html><head></head><body>External artifact</body></html>",
      );
    }
    assert.equal((await apps.identity.inject("/")).statusCode, 200);
    assert.equal(
      (await apps.identity.inject("/account.js")).body,
      "globalThis.accountArtifact = true;",
    );
    assert.equal(
      (await apps.identity.inject("/appearance/app.css")).statusCode,
      200,
    );
    assert.equal(
      (await apps.identity.inject("/cache-design")).body,
      "<html>External guide</html>",
    );
    assert.equal(
      (await apps.hub.inject("/hub-login.js")).body,
      "globalThis.loginArtifact = true;",
    );
    assert.equal((await apps.hub.inject("/login")).statusCode, 200);
    const context = {
      issuer: "https://artifact.test",
      accountId: "owner",
      hubId: "hub",
      computerId: "computer",
    };
    const workspace = await workspaceAsset(
      join(root, "workspace"),
      "",
      context,
    );
    assert.match(workspace.body.toString(), /codoxear-connection-context/);
    await assert.rejects(
      frontendAsset(root, "workspace", "../identity/account.js"),
      { code: "invalid_path" },
    );
    await assert.rejects(frontendAsset(root, "workspace", "escaped.js"), {
      code: "invalid_path",
    });
    await assert.rejects(
      workspaceAsset(join(root, "workspace"), "escaped.js", context),
      { code: "invalid_path" },
    );
    assert.throws(() => frontendAssetsRoot("dist"), /absolute paths/);
  } finally {
    await apps.close();
    await rm(root, { recursive: true, force: true });
  }
});
