// @ts-nocheck -- Installed-package smoke imports dynamic compiled public entries, separate from repository source types.
// Copied into a clean package container from the same reviewed commit.
// Uses only Node built-ins and the installed package's public compiled entries.
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { spawn, execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import {
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

assert.ok(
  existsSync("/.dockerenv"),
  "Package smoke acceptance runs only in Docker",
);
const [role, output = "/tmp/package-smoke.json"] = process.argv.slice(2);
assert.ok(["frontend", "computer", "hub", "identity", "server"].includes(role));
const peers = ["computer", "hub", "identity", "server"].filter(
  (peer) => peer !== role,
);
const checks = [];
const temporary = await mkdtemp(join(tmpdir(), "codoxear-package-smoke-"));
let child;
let exited;
let processLog = "";
let passed = false;
let failure;
const result = { role, checks, compiledEntries: [], http: [] };
try {
  for (const peer of peers)
    assert.equal(
      existsSync(resolve("src", peer)),
      false,
      "No peer source: " + peer,
    );
  assert.equal(
    existsSync("components"),
    false,
    "No monorepo component templates",
  );
  if (role !== "frontend") {
    for (const path of [
      "frontend",
      "src/web",
      "dist/client",
      "dist/workspace",
      "dist/identity",
      "dist/web",
    ])
      assert.equal(
        existsSync(path),
        false,
        "API package has no frontend artifacts: " + path,
      );
    const release = JSON.parse(await readFile("release.json", "utf8"));
    const component = JSON.parse(await readFile("component.json", "utf8"));
    assert.equal(release.component, role);
    const owners = await readdir("src");
    const allowed = new Set([
      role,
      ...component.sharedLibraries.map((path) => path.replace(/^src\//, "")),
    ]);
    assert.ok(
      owners.every((owner) => allowed.has(owner)),
      "Only own source and declared libraries",
    );
    for (const entry of component.entries) {
      const compiled = entry
        .replace(/^src\//, "dist/server/")
        .replace(/\.ts$/, ".js");
      assert.ok(existsSync(compiled), "Compiled entry: " + compiled);
      result.compiledEntries.push(compiled);
    }
    result.commit = release.commit;
    result.dependencies = release.dependencies;
    result.sourceCount = release.sources.length;
  } else {
    assert.equal(
      existsSync("runtime/oar"),
      false,
      "Frontend has no agent runtime",
    );
    assert.ok(existsSync("dist/client/index.html"));
    result.compiledEntries.push("dist/client/index.html", "serve.mjs");
  }
  checks.push(
    "own exported source and declared libraries only; no peer source or browser artifacts in APIs",
  );

  if (role === "computer") {
    const { createComputerApi } = await import(
      pathToFileURL(resolve("dist/server/computer/api.js")).href
    );
    const home = join(temporary, "computer");
    await mkdir(home);
    const api = createComputerApi(home);
    const status = await api.status();
    assert.equal(status.attached, false);
    assert.equal(status.running, false);
    const doctor = await api.doctor();
    assert.ok(doctor.issues.includes("Computer is not attached"));
    const cli = JSON.parse(
      execFileSync(
        process.execPath,
        ["dist/server/computer/main.js", "status"],
        {
          env: { ...process.env, CODOXEAR_COMPUTER_HOME: home },
          encoding: "utf8",
          timeout: 10000,
        },
      ),
    );
    assert.equal(cli.attached, false);
    const oar = JSON.parse(
      await readFile(
        "runtime/oar/node_modules/@botiverse/oar/package.json",
        "utf8",
      ),
    );
    assert.equal(oar.version, "0.13.3");
    await import(pathToFileURL(resolve("runtime/oar/load.mjs")).href);
    checks.push(
      "compiled typed API status/doctor and CLI run without attachment or peer services",
    );
    checks.push(
      "own pinned OAR runtime installs and loads without starting a model session",
    );
  } else {
    const port = 18430;
    const origin = "http://127.0.0.1:" + port;
    const config = join(temporary, "config.json");
    const database = join(temporary, "catalog.sqlite");
    const env = {
      ...process.env,
      CODOXEAR_INSECURE_LOCAL_HTTP: "1",
    };
    let entry = "dist/server/" + role + "/main.js";
    if (role === "hub") {
      await writeFile(
        config,
        JSON.stringify({
          origin,
          hubId: "isolation-hub",
          initialization: { token: randomBytes(32).toString("base64url"), expiresAt: Date.now() + 3600000 },
          otpKey: "isolation-only-key".repeat(4),
          database,
          listenPort: port,
          secureCookies: false,
        }),
      );
      env.CODOXEAR_HUB_CONFIG = config;
    } else if (role === "identity") {
      await writeFile(
        config,
        JSON.stringify({
          issuer: origin,
          database,
          signingKey: join(temporary, "key.json"),
          otpKey: "isolation-only-key".repeat(4),
          listenPort: port,
          secureCookies: false,
        }),
      );
      env.CODOXEAR_IDENTITY_CONFIG = config;
    } else if (role === "server") {
      env.CODOXEAR_BOOTSTRAP_EMAIL = "owner@isolation.invalid";
      env.CODOXEAR_BOOTSTRAP_PASSWORD = "isolation-fixture-password";
      env.CODOXEAR_V2_DATABASE = database;
      env.CODOXEAR_V2_PORT = String(port);
    } else {
      entry = "serve.mjs";
      env.CODOXEAR_CLIENT_PORT = String(port);
    }
    child = spawn(process.execPath, [entry], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    exited = new Promise((done, reject) => {
      child.once("error", reject);
      child.once("exit", (code, signal) => done({ code, signal }));
    });
    for (const stream of [child.stdout, child.stderr])
      stream.on("data", (chunk) => {
        processLog = (processLog + chunk).slice(-16000);
      });
    const deadline = Date.now() + 20000;
    let health;
    while (Date.now() < deadline) {
      assert.equal(
        child.exitCode,
        null,
        "Own entry exited before health: " + processLog,
      );
      try {
        const response = await fetch(origin + "/health", {
          signal: AbortSignal.timeout(1000),
        });
        if (response.ok) {
          health = await response.json();
          break;
        }
      } catch {}
      await new Promise((done) => setTimeout(done, 100));
    }
    assert.equal(health?.ok, true, "Own API health starts: " + processLog);
    result.http.push({ path: "/health", status: 200, body: health });
    if (role === "frontend") {
      assert.equal(health.accounts, false);
      const index = await fetch(origin + "/");
      assert.equal(index.status, 200);
      assert.match(await index.text(), /<!doctype html/i);
      result.http.push({ path: "/", status: 200 });
      const response = await fetch(origin + "/api/v1/me");
      assert.equal(response.status, 404);
      result.http.push({ path: "/api/v1/me", status: 404 });
      checks.push(
        "static frontend health and built page work without any backend; account API is absent",
      );
    } else {
      const path = role === "server" ? "/api/me" : "/api/v1/me";
      const response = await fetch(origin + path);
      assert.equal(
        response.status,
        401,
        "Own account API requires authentication",
      );
      result.http.push({ path, status: 401 });
      checks.push(
        "own compiled API entry boots, serves health and enforces account authentication without UI assets or peer services",
      );
    }
  }
  passed = true;
} catch (error) {
  failure = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  if (child && child.exitCode === null && child.signalCode === null) {
    child.kill("SIGTERM");
    const timer = setTimeout(() => child.kill("SIGKILL"), 5000);
    const outcome = await exited.finally(() => clearTimeout(timer));
    assert.equal(outcome.code, 0, "Own service exits cleanly on SIGTERM");
  }
  await writeFile(
    output,
    JSON.stringify(
      { ...result, passed, ...(failure ? { failure } : {}) },
      null,
      2,
    ) + "\n",
  );
  await rm(temporary, { recursive: true, force: true });
}
