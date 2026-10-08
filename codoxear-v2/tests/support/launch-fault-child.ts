import assert from "node:assert/strict";
import { NativeRuntime } from "../../src/computer/native/runtime.js";
import { ComputerLaunches } from "../../src/computer/launches.js";
import { join } from "node:path";
import { faultLaunch, processIdentity } from "./native-launch-fixture.js";
const home = process.env.CODOXEAR_LAUNCH_FIXTURE_HOME!;
const boundary = process.env.CODOXEAR_LAUNCH_FIXTURE_BOUNDARY!;
const backend = process.env.CODOXEAR_LAUNCH_FIXTURE_BACKEND;
assert.ok(backend === "pi" || backend === "codex" || backend === "cc");
const runtime = new NativeRuntime(home, join(home, "workspace"));
const journal = new ComputerLaunches(join(home, "launches.sqlite"), "hub/computer/1");
const pause = async (phase: string, result?: { localId: string; brokerPid: number }) => {
  let native;
  if (result) {
    const deadline = Date.now() + 30000;
    let state = await runtime.request(`/api/sessions/${result.localId}/state`);
    while (state.readiness !== "ready" && Date.now() < deadline) {
      assert.notEqual(state.readiness, "setup_required", state.setup_message);
      assert.notEqual(state.readiness, "exited", "Native CLI exited before fault boundary");
      await new Promise(resolve => setTimeout(resolve, 50));
      state = await runtime.request(`/api/sessions/${result.localId}/state`);
    }
    assert.equal(state.readiness, "ready", `Native ${backend} editor did not become ready`);
    native = processIdentity(state.pid);
  }
  process.send!({ phase, result, native });
  await new Promise<void>(resolve => process.once("message", () => resolve()));
};
const operation = { op: "create", agentId: "fault-agent", backend, name: "Launch fault" } as const;
const result = await journal.create(operation, async () => {
  if (boundary === "before-dispatch") await pause("before-dispatch");
  const launched = await runtime.createTerminal(backend, "Launch fault", faultLaunch);
  assert.equal(typeof launched.brokerPid, "number");
  const created = { localId: launched.localId, brokerPid: launched.brokerPid! };
  if (boundary === "before-receipt") await pause("before-receipt", created);
  return created;
});
assert.equal(typeof result.brokerPid, "number");
await pause("after-receipt", { localId: result.localId, brokerPid: result.brokerPid! });
