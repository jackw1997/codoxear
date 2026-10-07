import assert from "node:assert/strict";
import { request } from "node:http";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { existsSync } from "node:fs";

assert.ok(existsSync("/.dockerenv"), "Run frontend behavioral acceptance in Docker");

const entry = new URL("../serve.mjs", import.meta.url).href;
const { createStaticServer } = await import(entry);

test("standalone static client serves built assets and fences filesystem and API access", async () => {
  const server = createStaticServer();
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert(address && typeof address === "object");
  const get = (path: string, method = "GET") => new Promise<{ status: number; headers: import("node:http").IncomingHttpHeaders; body: string }>((resolve, reject) => {
    const req = request({ hostname: "127.0.0.1", port: address.port, path, method }, response => {
      const chunks: Buffer[] = [];
      response.on("data", chunk => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode!, headers: response.headers, body: Buffer.concat(chunks).toString("utf8") }));
    });
    req.on("error", reject);
    req.end();
  });
  const temporary = await mkdtemp(join(tmpdir(), "codoxear-static-test-"));
  const link = fileURLToPath(new URL("../dist/client/escape-test.txt", import.meta.url));
  try {
    const health = await get("/health");
    assert.equal(health.status, 200);
    assert.deepEqual(JSON.parse(health.body), { ok: true, service: "static-client", accounts: false });
    const head = await get("/health", "HEAD");
    assert.equal(head.status, 200);
    assert.equal(head.body, "");
    assert.equal(head.headers["content-type"], "application/json");
    const html = await get("/");
    assert.equal(html.status, 200);
    assert.match(html.headers["content-type"]!, /^text\/html/);
    const match = html.body.match(/<script type="application\/json" id="codoxear-connection-context">([^<]+)<\/script>/);
    assert(match);
    assert.deepEqual(JSON.parse(match[1]!), { issuer: "local-client", accountId: "device", hubId: "local", computerId: "all" });
    assert.equal(html.headers["x-content-type-options"], "nosniff");
    assert.equal(html.headers["referrer-policy"], "no-referrer");
    assert.equal(html.headers["content-security-policy"], "frame-ancestors 'none'");
    assert.equal(html.headers["cache-control"], "no-store");
    const release = await get("/client-release.json");
    assert.equal(release.status, 200);
    assert.equal(release.headers["cache-control"], "no-store");
    const version = JSON.parse(release.body).version;
    assert.match(version, /^[a-f0-9]{16}$/);
    assert.match(html.body, new RegExp("app\\.bundle\\.js\\?v=" + version));
    assert.equal((await get("/src/main.ts")).status, 404);
    assert.equal((await get("/app.js")).status, 404);
    assert.equal((await get("/app_new_session.js")).status, 404);
    for (const path of ["/pdf.mjs", "/pdf.worker.mjs"])
      assert.equal((await get(path)).status, 200);
    const callback = await get("/auth-callback");
    assert.equal(callback.status, 200);
    assert.equal(callback.headers["cache-control"], "no-store");
    assert.match(callback.body, /src="\/client-callback\.js"/);
    const callbackScript = await get("/client-callback.js");
    assert.equal(callbackScript.status, 200);
    assert.equal(callbackScript.headers["cache-control"], "no-store");
    assert(callbackScript.body.length > 0);
    const worker = await get("/client-worker.js?push=example");
    assert.equal(worker.status, 200);
    assert.equal(worker.headers["service-worker-allowed"], "/");
    assert.equal(worker.headers["cache-control"], "no-cache");
    assert.match(worker.headers["content-type"]!, /^text\/javascript/);
    assert.equal((await get("/dist/app.bundle.js?v=version")).headers["cache-control"], "public, max-age=31536000, immutable");
    for (const path of ["/api/v1/users", "/oauth/token", "/gateway/test"]) assert.equal((await get(path)).status, 404);
    for (const path of ["/../package.json", "/%2e%2e/package.json", "/%252e%252e/package.json", "/%5cpackage.json", "/%ZZ", "/%00"]) assert.equal((await get(path)).status, 400);
    await writeFile(join(temporary, "secret.txt"), "outside-secret");
    await symlink(join(temporary, "secret.txt"), link);
    const escaped = await get("/escape-test.txt");
    assert.equal(escaped.status, 403);
    assert(!escaped.body.includes("outside-secret"));
    assert.equal((await get("/missing-asset")).status, 404);
    assert.equal((await get("/health", "POST")).status, 405);
  } finally {
    await rm(link, { force: true });
    await rm(temporary, { force: true, recursive: true });
    await new Promise<void>((resolve, reject) => server.close((error: Error | undefined) => error ? reject(error) : resolve()));
  }
});
