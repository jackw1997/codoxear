/** Docker-only startup faults against the actual built client and native browser service workers. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, mkdir, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createServer } from "node:https";
import { createHash, X509Certificate } from "node:crypto";
import type { Socket } from "node:net";
import { workspaceAsset } from "../src/presentation/workspace-assets.js";

assert.ok(existsSync("/.dockerenv"), "Startup verification must run in Docker");
const directory = await mkdtemp(join(tmpdir(), "codoxear-client-startup-"));
const certificate = join(directory, "certificate.pem"),
  key = join(directory, "key.pem");
await promisify(execFile)("openssl", [
  "req",
  "-x509",
  "-newkey",
  "rsa:2048",
  "-nodes",
  "-keyout",
  key,
  "-out",
  certificate,
  "-days",
  "1",
  "-subj",
  "/CN=127.0.0.1",
  "-addext",
  "subjectAltName=IP:127.0.0.1",
]);
const certificateBytes = await readFile(certificate);
const spki = createHash("sha256")
  .update(
    new X509Certificate(certificateBytes).publicKey.export({
      type: "spki",
      format: "der",
    }),
  )
  .digest("base64");
type Fault =
  | "none"
  | "registration-failure"
  | "update-failure"
  | "registration-stall"
  | "update-stall"
  | "handshake-stall";
let fault: Fault = "none",
  workerRequests = 0;
const sockets = new Set<Socket>();
const server = createServer(
  { key: await readFile(key), cert: certificateBytes },
  (request, response) => {
    void (async () => {
      const path = new URL(request.url ?? "/", "https://127.0.0.1").pathname;
      if (path === "/client-worker.js") {
        workerRequests++;
        if (
          fault === "registration-stall" ||
          (fault === "update-stall" && workerRequests > 1)
        )
          return;
        if (
          fault === "registration-failure" ||
          (fault === "update-failure" && workerRequests > 1)
        ) {
          response.writeHead(503, {
            "Content-Type": "text/plain",
            "Cache-Control": "no-store",
          });
          response.end("Controlled worker download failure");
          return;
        }
      }
      const asset = await workspaceAsset("dist/client", path.slice(1), {
        issuer: "startup-fixture",
        accountId: "device",
        hubId: "local",
        computerId: "all",
      });
      response.writeHead(200, {
        "Content-Type": asset.type,
        "Cache-Control": "no-store",
        "Service-Worker-Allowed": "/",
        "Content-Security-Policy": "frame-ancestors 'none'",
      });
      // The real worker executes normally; this fault suppresses its readiness reply only.
      // No browser APIs, permission checks or application routes are replaced.
      const prefix =
        path === "/client-worker.js" && fault === "handshake-stall"
          ? 'self.addEventListener("message",event=>{if(event.data?.type==="codoxear-transport-check")event.stopImmediatePropagation();});\n'
          : "";
      response.end(
        prefix ? Buffer.concat([Buffer.from(prefix), asset.body]) : asset.body,
      );
    })().catch(() => {
      if (!response.headersSent) response.writeHead(404);
      response.end();
    });
  },
);
server.on("connection", (socket) => {
  sockets.add(socket);
  socket.on("close", () => sockets.delete(socket));
});
await new Promise<void>((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});
const address = server.address();
assert.ok(address && typeof address !== "string");
const origin = `https://127.0.0.1:${address.port}`;
const playwright = (await import(
  process.env.PLAYWRIGHT_MODULE ?? "@playwright/test"
)) as typeof import("@playwright/test");
const checks: string[] = [],
  evidence: unknown[] = [];
let browser: Awaited<ReturnType<typeof playwright.chromium.launch>> | undefined;
let browserVersion = "",
  passed = false;
async function launch(trusted: boolean) {
  return playwright.chromium.launch({
    headless: true,
    ...(process.env.CHROMIUM_PATH
      ? { executablePath: process.env.CHROMIUM_PATH }
      : {}),
    args: [
      "--no-sandbox",
      "--disable-dev-shm-usage",
      ...(trusted ? ["--ignore-certificate-errors-spki-list=" + spki] : []),
    ],
  });
}
async function check(
  name: string,
  mode: Fault,
  expected: RegExp | null,
  acceptedWarning = false,
) {
  fault = mode;
  workerRequests = 0;
  const context = await browser!.newContext({
    ignoreHTTPSErrors: acceptedWarning,
  });
  const page = await context.newPage();
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const started = Date.now();
  try {
    await page.goto(origin, { waitUntil: "domcontentloaded", timeout: 20000 });
    if (expected) {
      await page
        .locator("[data-codoxear-load-error] pre")
        .filter({ hasText: expected })
        .waitFor({ timeout: 20000 });
      const message = await page
        .locator("[data-codoxear-load-error] pre")
        .innerText();
      assert.match(message, expected);
      assert.ok(!/^Uncaught\b/.test(message));
      assert.equal(
        await page.evaluate(() => (window as any).__codoxearAppBootstrapped),
        false,
      );
      if (mode.endsWith("stall"))
        assert.ok(
          Date.now() - started < 19000,
          "Transport fault is bounded to its 15-second startup deadline",
        );
      evidence.push({
        name,
        mode,
        message,
        elapsedMs: Date.now() - started,
        workerRequests,
        errors,
      });
    } else {
      await page
        .getByRole("dialog", { name: "Hubs & computers", exact: true })
        .waitFor({ timeout: 20000 });
      assert.equal(
        await page.evaluate(() => (window as any).__codoxearAppBootstrapped),
        true,
      );
      evidence.push({ name, mode, boot: true, workerRequests, errors });
    }
    assert.deepEqual(
      errors,
      [],
      "Handled startup faults produce no uncaught page errors",
    );
    checks.push(name);
    console.log("PASS " + name);
  } finally {
    await context.close();
    for (const socket of sockets) socket.destroy();
  }
}
try {
  browser = await launch(false);
  browserVersion = browser.version();
  await check(
    "Accepted certificate warning shows an actionable trusted HTTPS error",
    "none",
    /valid HTTPS certificate trusted by your browser/,
    true,
  );
  await browser.close();
  browser = undefined;
  browser = await launch(true);
  await check(
    "Trusted fixture certificate starts the real module worker and client",
    "none",
    null,
  );
  await check(
    "Failed worker registration shows a registration error",
    "registration-failure",
    /could not register/,
  );
  await check(
    "Failed worker update shows an update error",
    "update-failure",
    /could not update/,
  );
  await check(
    "Stalled worker registration is bounded to fifteen seconds",
    "registration-stall",
    /timed out while registering/,
  );
  await check(
    "Stalled worker update shares the fifteen-second startup deadline",
    "update-stall",
    /timed out while updating/,
  );
  await check(
    "Missing real worker readiness replies are bounded to fifteen seconds",
    "handshake-stall",
    /within 15 seconds/,
  );
  passed = true;
} finally {
  await browser?.close();
  for (const socket of sockets) socket.destroy();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(directory, { recursive: true, force: true });
  await mkdir("artifacts", { recursive: true });
  await writeFile(
    "artifacts/client-startup-results.json",
    JSON.stringify(
      {
        passed,
        browserVersion,
        checks,
        evidence,
        limitations: [
          "Controlled TLS and worker-network faults with the actual built client; no physical Huawei browser acceptance",
          "Trusted fixture success uses its exact public-key exception solely inside this isolated Docker browser",
        ],
      },
      null,
      2,
    ),
  );
}
