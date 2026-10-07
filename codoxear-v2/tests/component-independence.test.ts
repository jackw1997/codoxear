import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createServer } from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import { Store } from "../src/persistence/store.js";
import { Accounts } from "../src/auth/accounts.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";

assert.ok(existsSync("/.dockerenv"), "Run component acceptance in Docker");
async function port() {
  const server = createServer();
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const value = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return value;
}
function start(entry: string, environment: Record<string, string>) {
  const child = spawn(process.execPath, ["--import", "tsx", entry], {
    env: { ...process.env, ...environment },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout!.on("data", chunk => { output += String(chunk); });
  child.stderr!.on("data", chunk => { output += String(chunk); });
  return { child, output: () => output };
}
async function ready(origin: string, process: ReturnType<typeof start>) {
  for (let attempt = 0; attempt < 150; attempt++) {
    if (process.child.exitCode !== null) throw new Error(process.output());
    try { if ((await fetch(origin + "/health")).ok) return; } catch {}
    await new Promise(resolve => setTimeout(resolve, 40));
  }
  throw new Error("Component did not start: " + process.output());
}
async function stop(child: ChildProcess) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
test("static client starts without hub/account/computer configuration", async () => {
  const origin = "http://127.0.0.1:" + await port();
  const process = start("frontend/serve.mjs", {
    CODOXEAR_CLIENT_PORT: new URL(origin).port,
    CODOXEAR_HUB_CONFIG: "",
    CODOXEAR_IDENTITY_CONFIG: "",
    CODOXEAR_COMPUTER_HOME: "/nonexistent-independent-client",
  });
  try {
    await ready(origin, process);
    assert.deepEqual(await (await fetch(origin + "/health")).json(), { ok: true, service: "static-client", accounts: false });
    assert.equal((await fetch(origin)).status, 200);
    assert.equal((await fetch(origin + "/api/hubs")).status, 404);
  } finally { await stop(process.child); }
});
test("two independent hub processes own separate accounts and survive sibling shutdown", async () => {
  const home = await mkdtemp(join(tmpdir(), "independent-components-"));
  const children: ReturnType<typeof start>[] = [];
  try {
    const origins: string[] = [];
    for (let i = 0; i < 2; i++) {
      const origin = "http://127.0.0.1:" + await port();
      origins.push(origin);
      const config = join(home, `hub-${i}.json`);
      await writeFile(config, JSON.stringify({
        origin, hubId: `hub-${i}`, independent: true,
        database: join(home, `hub-${i}.sqlite`), initialization: { token: "fixture-initialization-token-".repeat(4), expiresAt: Date.now() + 86400000 },
        listenPort: Number(new URL(origin).port), secureCookies: false,
      }));
      const child = start("src/hub/main.ts", {
        CODOXEAR_HUB_CONFIG: config,
        CODOXEAR_IDENTITY_CONFIG: "",
      });
      children.push(child);
      await ready(origin, child);
    }
    const credentials: string[] = [];
    for (let i = 0; i < 2; i++) {
      const store = new Store(join(home, `hub-${i}.sqlite.catalog`));
      try {
        const accounts = new Accounts(store, "fixture-secret".repeat(4), {async send(){throw new Error("disabled");}});
        credentials.push(accounts.finish({method:"google",connection:"google-fixture",subject:"same-person",tenant:null,email:null,name:"Fixture"}, "fixture").credential);
      } finally { store.close(); }
    }
    for (let i = 0; i < 2; i++) {
      const me = (credential: string) => fetch(origins[i]! + "/api/v1/me", {headers:{cookie:`codoxear_identity_hub-${i}=${credential}`}});
      assert.equal((await me(credentials[i]!)).status, 200);
      assert.equal((await me(credentials[1-i]!)).status, 401);
      assert.equal((await fetch(origins[i]!+"/api/v1/auth/password",{method:"POST",headers:{"content-type":"application/json"},body:"{}"})).status,404);
      const options = await (await fetch(origins[i]!+"/api/v1/auth/options")).json();
      assert.equal(options.setupRequired,true);
      assert.equal(options.password,undefined);
    }
    await stop(children[0]!.child);
    assert.equal((await fetch(origins[1]! + "/health")).status, 200);
  } finally {
    await Promise.all(children.map(item => stop(item.child)));
    await rm(home, { recursive: true, force: true });
  }
});
test("Computers sharing CLI authentication keep independent native session catalogs", async () => {
  const home = await mkdtemp(join(tmpdir(), "computer-namespaces-"));
  const a = new NativeRuntime(home, home, join(home, "computer-a"));
  const b = new NativeRuntime(home, home, join(home, "computer-b"));
  try {
    const id = "broker-" + "a".repeat(32);
    await writeFile(join(a.directory, id + ".json"), JSON.stringify({
      version: 1, session_id: id, agent_backend: "codex", thread_id: null,
      broker_pid: 0, pid: 0, cwd: home, start_ts: 1, updated_ts: 1,
      log_path: null, alias: "Archived A session", readiness: "exited",
      busy: false, queue_len: 0,
    }));
    assert.equal((await a.request("/api/sessions")).sessions.length, 1);
    assert.equal((await b.request("/api/sessions")).sessions.length, 0);
    await assert.rejects(b.request(`/api/sessions/${id}/messages/tail`), /Unknown native session/);
    assert.equal(a.home, b.home);
    assert.notEqual(a.directory, b.directory);
  } finally {
    a.close(); b.close();
    await rm(home, { recursive: true, force: true });
  }
});
