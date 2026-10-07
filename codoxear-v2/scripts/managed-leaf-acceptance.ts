/** Docker-only real managed Codex/Claude CLIs against fixture provider APIs.
 * Run: node --import tsx scripts/managed-leaf-acceptance.ts [codex|cc]
 * This checks text/interrupt, not native tool execution or real provider access. */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../src/computer/managed/runtime.js";
import { OarFactory } from "../src/computer/managed/factory.js";
import { backendGateway } from "./backend-gateway.js";

assert.ok(existsSync("/.dockerenv"), "Leaf native acceptance runs only in Docker");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "OAR requires Node 24");
const selection = process.argv[2];
if (selection && selection !== "codex" && selection !== "cc") throw Error("Choose codex or cc");
const backends = selection ? [selection] as Array<"codex" | "cc"> : ["codex", "cc"] as const;
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean, label: string) {
  const end = Date.now() + 60_000;
  while (!(await check())) {
    if (Date.now() > end) throw Error(`Timed out: ${label}`);
    await sleep(100);
  }
}
type Proc = { pid: number; parent: number; identity: string; rss: number };
async function processes() {
  const rows: Proc[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const status = await readFile(`/proc/${name}/status`, "utf8");
      rows.push({ pid: Number(name), parent: Number(fields[1]), identity: `${name}:${fields[19]}`, rss: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
    } catch {}
  }
  return rows;
}
function descendants(rows: Proc[]) {
  const ids = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  return rows.filter((row) => row.pid !== process.pid && ids.has(row.pid));
}
const results: unknown[] = [];
let allPassed = true;
for (const backend of backends) {
  const root = await mkdtemp(join(tmpdir(), `managed-leaf-${backend}-`));
  const home = join(root, "home"), workspace = join(root, "workspace");
  await mkdir(home); await mkdir(workspace);
  // No user's config or credentials are mounted/read. This is local test consent.
  if (backend === "cc") {
    await mkdir(join(home, ".claude"));
    await writeFile(join(home, ".claude.json"), JSON.stringify({ hasCompletedOnboarding: true, bypassPermissionsModeAccepted: true, projects: { [workspace]: { hasTrustDialogAccepted: true } }, customApiKeyResponses: { approved: ["fixture-private-key"], rejected: [] } }), { mode: 0o600 });
  }
  const gateway = await backendGateway(0);
  const baseline = new Set(descendants(await processes()).map((row) => row.identity));
  const owned = new Set<string>();
  const measurements: unknown[] = [];
  const records: unknown[] = [];
  const actual = new OarFactory();
  const factory = {
    async open(input: Parameters<OarFactory["open"]>[0]) {
      const session = await actual.open(input);
      return {
        ...session,
        rawEvents(observer: Parameters<typeof session.rawEvents>[0], cursor?: Parameters<typeof session.rawEvents>[1]) {
          return session.rawEvents((record) => {
            records.push(record); if (records.length > 12) records.shift();
            observer(record);
          }, cursor);
        },
      };
    },
  };
  const runtime = new ManagedRuntime({ databasePath: join(root, "state", "managed.sqlite"), home, workspace, stateHome: join(root, "state"), factory, permissionPolicy: "locally-trusted", maxResident: 1, idleMs: 60_000 });
  async function sample(stage: string) {
    const rows = await processes();
    const children = descendants(rows).filter((row) => !baseline.has(row.identity));
    for (const child of children) owned.add(child.identity);
    const cgroup: Record<string, string> = {};
    for (const name of ["memory.current", "memory.peak", "memory.max", "memory.swap.max", "pids.current"]) {
      try { cgroup[name] = (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim(); } catch {}
    }
    measurements.push({ stage, cgroup, descendantsRssBytes: children.reduce((sum, row) => sum + row.rss, 0), descendantIdentities: children.map((row) => row.identity) });
  }
  let stage = "create", passed = false, failure: unknown;
  try {
    await sample("baseline");
    const { localId } = await runtime.executeWithReceipt({ op: "create", agentId: `leaf-${backend}`, backend, name: `Real managed ${backend}`, launch: { cwd: workspace, model: "PrivateModel", provider_config: { base_url: gateway.origin + (backend === "codex" ? "/v1" : ""), api_key: "fixture-private-key" } } }, `leaf-${backend}-create`) as { localId: string };
    const state = () => runtime.queueControl(localId, "state") as Promise<Record<string, unknown>>;
    await sample("opened");
    stage = "send";
    await runtime.executeWithReceipt({ op: "send", agentId: `leaf-${backend}`, localId, text: "Return the provider fixture acknowledgement." }, `leaf-${backend}-send`);
    await until(async () => {
      const history = await runtime.execute({ op: "messages", agentId: `leaf-${backend}`, localId });
      return JSON.stringify(history).includes("PRIVATE_PROVIDER_OK") && (await state()).runtime_state === "idle";
    }, `${backend} real CLI transcript and idle`);
    const routed = gateway.requests.filter((request) => request.model === "PrivateModel");
    assert.ok(routed.length && routed.every((request) => request.authorized), "Real CLI must route to the fixture with its fake key");
    await sample("completed");
    stage = "interrupt";
    const prompt = `Hold managed ${backend} inference for interruption`;
    gateway.holdNext(backend === "codex" ? "/responses" : "/messages", backend === "cc" ? prompt : undefined);
    await runtime.executeWithReceipt({ op: "send", agentId: `leaf-${backend}`, localId, text: prompt }, `leaf-${backend}-hold`);
    await until(() => gateway.requests.some((request) => request.held), `${backend} held inference`);
    assert.equal((await state()).busy, true);
    const interruption = await runtime.executeWithReceipt({ op: "interrupt", agentId: `leaf-${backend}`, localId }, `leaf-${backend}-interrupt`) as { interrupted: boolean };
    assert.equal(interruption.interrupted, true);
    await until(async () => (await state()).runtime_state === "idle", `${backend} native aborted completion`);
    await until(() => gateway.requests.some((request) => request.held && request.aborted), `${backend} provider connection cancellation`);
    await sample("interrupted");
    passed = true;
  } catch (error) {
    allPassed = false;
    failure = { stage, code: (error as { code?: unknown })?.code, message: error instanceof Error ? error.message : String(error), nativeRecords: records };
  } finally {
    await runtime.close();
    await until(async () => {
      const rows = await processes();
      return !rows.some((row) => owned.has(row.identity)) && !descendants(rows).some((row) => !baseline.has(row.identity));
    }, `${backend} owned CLI/worker cleanup`);
    await sample("closed");
    await gateway.close();
    await rm(root, { recursive: true, force: true });
  }
  results.push({ backend, passed, realNativeCli: true, textAndInterruptVerified: passed, toolExecutionVerified: false, ownedDescendantsReclaimed: true, fixtureRequests: gateway.requests, measurements, ...(failure ? { failure } : {}) });
}
console.log(JSON.stringify({ ok: allPassed, results }, null, 2).replaceAll("fixture-private-key", "<fixture-key>"));
if (!allPassed) process.exitCode = 1;
