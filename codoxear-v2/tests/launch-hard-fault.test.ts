import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { fork } from "node:child_process";
import { once } from "node:events";
import { ComputerLaunches } from "../src/computer/launches.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { prepareNativeLaunchFixture, processIdentity, type NativeProcessIdentity } from "./support/native-launch-fixture.js";
assert.ok(existsSync("/.dockerenv"), "Run process hard-fault acceptance in Docker");
const wait = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const executables = {
  pi: process.env.PI_BIN ?? "/opt/codoxear-tools/node/bin/pi",
  codex: process.env.CODEX_BIN ?? "/opt/codoxear-tools/node/bin/codex",
  cc: process.env.CLAUDE_BIN ?? "/tools/claude",
};
async function stopped(pid: number) {
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    try {
      const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
      if (stat.slice(stat.lastIndexOf(") ") + 2).startsWith("Z ")) return;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    await wait(20);
  }
  assert.fail(`Owned process ${pid} did not exit`);
}
for (const backend of ["pi", "codex", "cc"] as const) {
  for (const boundary of ["before-dispatch", "before-receipt", "after-receipt"] as const) {
    test(`installed ${backend === "cc" ? "Claude" : backend} launch survives Computer SIGKILL at ${boundary} without replay`, { timeout: 60000, concurrency: false }, async () => {
      assert.ok(existsSync(executables[backend]), `Install the actual ${backend} CLI before running hard-fault acceptance`);
      const home = await mkdtemp(join(tmpdir(), `launch-hard-fault-${backend}-`));
      await prepareNativeLaunchFixture(home, backend);
      const child = fork("tests/support/launch-fault-child.ts", [], {
        execArgv: ["--import", "tsx"],
        env: { ...process.env, PI_BIN: executables.pi, CODEX_BIN: executables.codex, CLAUDE_BIN: executables.cc, IS_SANDBOX: "1", CODOXEAR_LAUNCH_FIXTURE_HOME: home, CODOXEAR_LAUNCH_FIXTURE_BOUNDARY: boundary, CODOXEAR_LAUNCH_FIXTURE_BACKEND: backend },
        stdio: ["ignore", "ignore", "pipe", "ipc"],
      });
      let errors = "";
      child.stderr!.on("data", chunk => errors += chunk);
      const runtime = new NativeRuntime(home, join(home, "workspace"));
      let journal: ComputerLaunches | undefined;
      try {
        const reached = await new Promise<{ phase: string; result?: { localId: string; brokerPid: number }; native?: NativeProcessIdentity }>((resolve, reject) => {
          const timer = setTimeout(() => reject(Error("Boundary not reached: " + errors)), 40000);
          child.once("message", value => { clearTimeout(timer); resolve(value as any); });
          child.once("exit", code => { clearTimeout(timer); reject(Error("Child exited " + code + ": " + errors)); });
        });
        assert.equal(reached.phase, boundary);
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        journal = new ComputerLaunches(join(home, "launches.sqlite"), "hub/computer/1");
        assert.deepEqual(journal.status("fault-agent"), boundary === "after-receipt" ? { state: "ready", result: reached.result } : { state: "unknown" });
        let replayed = false;
        await assert.rejects(journal.create({ op: "create", agentId: "fault-agent", backend, name: "Replay" }, async () => { replayed = true; return { localId: "unexpected" }; }), /already recorded/);
        assert.equal(replayed, false);
        const catalog = await runtime.request("/api/sessions");
        assert.equal(catalog.sessions.length, boundary === "before-dispatch" ? 0 : 1);
        if (reached.result) {
          const state = await runtime.request(`/api/sessions/${reached.result.localId}/state`);
          assert.equal(state.agent_backend, backend);
          assert.equal(state.broker_pid, reached.result.brokerPid);
          assert.equal(state.readiness, "ready");
          assert.ok(reached.native);
          assert.deepEqual(processIdentity(state.pid), reached.native, "Recovery must retain the existing native CLI incarnation");
          assert.ok(reached.native.command.some(value => value.includes(backend === "cc" ? "claude" : backend)), "The native process must execute the installed backend");
          assert.equal((await runtime.request("/api/sessions")).sessions.length, 1, "Receipt inspection must not create another native session");
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
        for (const row of (await runtime.request("/api/sessions")).sessions) {
          await runtime.request(`/api/sessions/${row.session_id}`, "DELETE");
          await stopped(row.pid);
          await stopped(row.broker_pid);
        }
        runtime.close();
        journal?.close();
        await rm(home, { recursive: true, force: true });
      }
    });
  }
}
