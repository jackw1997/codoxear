/** Mount read-only into a final pruned image and run with Node's type stripping.
 * No repository dependencies, runtime sessions, provider calls, or peer services.
 */
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { pathToFileURL } from "node:url";

assert(existsSync("/.dockerenv"), "Final image smoke requires Docker");
assert.equal(process.getuid?.(), 1000, "Final image must run as node");
const [role, ...extra] = process.argv.slice(2);
const roles = ["computer", "hub", "identity", "server", "frontend"];
assert(role && roles.includes(role) && !extra.length, "Specify one image role");
for (const peer of roles.filter((name) => name !== role && name !== "frontend"))
  assert(!existsSync(`/app/dist/server/${peer}`), "Peer compiled runtime: " + peer);
for (const path of ["src", "frontend", "components", "build.mjs", "tsconfig.json"])
  assert(!existsSync("/app/" + path), "Build/source artifact: " + path);
for (const dependency of ["typescript", "tsx", "tsup", "esbuild", "vite"])
  assert(!existsSync("/app/node_modules/" + dependency), "Development dependency: " + dependency);
if (role === "frontend") assert(!existsSync("/app/node_modules"));
else for (const module of ["client", "web", "workspace", "identity"])
  assert(!existsSync("/app/dist/" + module), "Frontend artifact in backend: " + module);
assert(!process.env.CODOXEAR_FRONTEND_ASSETS_ROOT, "Smoke requires unattached UI");

const temporary = await mkdtemp(join(tmpdir(), "codoxear-image-smoke-"));
let child: ChildProcess | undefined;
let exited: Promise<{ code: number | null; signal: NodeJS.Signals | null }> | undefined;
let log = "";
const checks = ["pruned runtime artifacts", "UID 1000"];
try {
  if (role === "computer") {
    const entry = pathToFileURL("/app/dist/server/computer/api.js").href;
    const { createComputerApi } = await import(entry);
    const home = join(temporary, "computer");
    await mkdir(home);
    const api = createComputerApi(home);
    const status = await api.status();
    assert.equal(status.attached, false);
    assert.equal(status.running, false);
    const doctor = await api.doctor();
    assert(doctor.issues.includes("Computer is not attached"));
    assert(!doctor.issues.some((issue: string) => /missing from|not installed|exactly 0\.13\.3/.test(issue)), "Installed package/runtime missing");
    const installed = JSON.parse(await readFile("/app/runtime/oar/node_modules/@botiverse/oar/package.json", "utf8"));
    assert.equal(installed.version, "0.13.3");
    await import(pathToFileURL("/app/runtime/oar/load.mjs").href);
    checks.push("compiled Computer status/doctor", "pinned OAR loads without sessions");
  } else {
    const port = 18430;
    const origin = "http://127.0.0.1:" + port;
    const configFile = join(temporary, "config.json");
    const database = join(temporary, "catalog.sqlite");
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      CODOXEAR_BOOTSTRAP_EMAIL: "owner@image-smoke.invalid",
      CODOXEAR_BOOTSTRAP_PASSWORD: randomBytes(32).toString("hex"),
      CODOXEAR_INSECURE_LOCAL_HTTP: "1",
    };
    let entry = `/app/dist/server/${role}/main.js`;
    if (role === "hub" || role === "identity") {
      await writeFile(configFile, JSON.stringify({
        ...(role === "hub" ? { origin, hubId: "image-smoke-hub" } : { issuer: origin }),
        database,
        signingKey: join(temporary, "key.json"),
        setupToken: randomBytes(32).toString("hex"),
        listenPort: port,
        secureCookies: false,
      }), { mode: 0o600 });
      env[role === "hub" ? "CODOXEAR_HUB_CONFIG" : "CODOXEAR_IDENTITY_CONFIG"] = configFile;
    } else if (role === "server") {
      assert.equal(env.CODOXEAR_V2_DATABASE, "/home/node/.local/share/codoxear-v2/server/catalog.sqlite", "Image supplies writable default DB");
      assert(isAbsolute(env.CODOXEAR_V2_DATABASE));
      assert(!existsSync(env.CODOXEAR_V2_DATABASE), "Server smoke requires pristine state");
      env.CODOXEAR_V2_PORT = String(port);
    } else {
      entry = "/app/serve.mjs";
      env.CODOXEAR_CLIENT_PORT = String(port);
    }
    child = spawn(process.execPath, [entry], { cwd: "/app", env, stdio: ["ignore", "pipe", "pipe"] });
    exited = new Promise((resolve, reject) => {
      child!.once("error", reject);
      child!.once("exit", (code, signal) => resolve({ code, signal }));
    });
    // Attach immediately so an early spawn error cannot become unhandled.
    void exited.catch(() => {});
    for (const stream of [child.stdout, child.stderr])
      stream!.on("data", (chunk) => { log = (log + String(chunk)).slice(-16000); });
    let health: { ok?: boolean; accounts?: boolean } | undefined;
    const deadline = Date.now() + 20000;
    while (Date.now() < deadline) {
      assert(child.exitCode === null && child.signalCode === null, "Runtime exited: " + log);
      try {
        const response = await fetch(origin + "/health", { signal: AbortSignal.timeout(1000) });
        if (response.ok) { health = await response.json() as typeof health; break; }
      } catch {}
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.equal(health?.ok, true, "Runtime health: " + log);
    const request = (path: string) => fetch(origin + path, { signal: AbortSignal.timeout(3000) });
    const page = await request("/");
    if (role === "frontend") {
      assert.equal(health?.accounts, false);
      assert.equal(page.status, 200);
      assert.match(await page.text(), /<!doctype html/i);
      assert.equal((await request("/api/v1/me")).status, 404);
      checks.push("frontend health/page without backend");
    } else {
      assert.equal(page.status, 404, "No attached UI");
      assert.equal((await request(role === "server" ? "/api/me" : "/api/v1/me")).status, 401);
      if (role === "server") assert(existsSync(env.CODOXEAR_V2_DATABASE!));
      checks.push("compiled API health", "account authentication", "unattached UI 404");
      if (role === "server") checks.push("image default DB writable as node");
    }
  }
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child!.kill("SIGKILL"), 5000);
    try {
      const outcome = await exited!;
      assert.equal(outcome.code, 0, "Owned runtime exits cleanly");
    } finally { clearTimeout(timer); }
  }
  await rm(temporary, { recursive: true, force: true });
}
console.log(JSON.stringify({ role, passed: true, checks }));
