/** Docker-only native acceptance: real OAR Pi SDK, deterministic local model HTTP. */
import assert from "node:assert/strict";
import { createServer, type ServerResponse } from "node:http";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ManagedRuntime } from "../src/computer/managed/runtime.js";
import { OarFactory } from "../src/computer/managed/factory.js";

assert.ok(existsSync("/.dockerenv"), "Native acceptance must run inside Docker");
assert.ok(Number(process.versions.node.split(".")[0]) >= 24, "OAR requires Node 24");
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));
async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean, label: string) {
  const deadline = Date.now() + 30_000;
  let value: T;
  do {
    value = await read();
    if (ready(value)) return value;
    await delay(50);
  } while (Date.now() < deadline);
  throw Error(`Timed out waiting for ${label}: ${JSON.stringify(value!)}`);
}
type ProcessInfo = { pid: number; parent: number; identity: string; rssBytes: number };
async function processes(): Promise<ProcessInfo[]> {
  const result: ProcessInfo[] = [];
  for (const name of await readdir("/proc")) {
    if (!/^\d+$/.test(name)) continue;
    try {
      const stat = await readFile(`/proc/${name}/stat`, "utf8");
      const fields = stat.slice(stat.lastIndexOf(")") + 2).trim().split(/\s+/);
      const status = await readFile(`/proc/${name}/status`, "utf8");
      result.push({ pid: Number(name), parent: Number(fields[1]), identity: `${name}:${fields[19]}`, rssBytes: Number(status.match(/^VmRSS:\s+(\d+)/m)?.[1] ?? 0) * 1024 });
    } catch { /* A process may exit between proc reads. */ }
  }
  return result;
}
function descendants(all: ProcessInfo[]) {
  const ids = new Set([process.pid]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of all) if (ids.has(row.parent) && !ids.has(row.pid)) { ids.add(row.pid); changed = true; }
  }
  return all.filter((row) => row.pid !== process.pid && ids.has(row.pid));
}
const baseline = new Set(descendants(await processes()).map((row) => row.identity));
const owned = new Set<string>();
const measurements: unknown[] = [];
async function measure(stage: string) {
  const all = await processes();
  const children = descendants(all).filter((row) => !baseline.has(row.identity));
  for (const row of children) owned.add(row.identity);
  const cgroup: Record<string, string> = {};
  for (const name of ["memory.current", "memory.peak", "memory.max", "memory.swap.max", "pids.current", "pids.max"]) {
    try { cgroup[name] = (await readFile(`/sys/fs/cgroup/${name}`, "utf8")).trim(); } catch {}
  }
  measurements.push({ stage, cgroup, controllerRssBytes: all.find((row) => row.pid === process.pid)?.rssBytes, descendantsRssBytes: children.reduce((sum, row) => sum + row.rssBytes, 0), descendantIdentities: children.map((row) => row.identity) });
  return children;
}

const proof = "native-oar-tool-proof";
let requests = 0, toolOffered = false, sawToolResult = false, resumedWithHistory = false;
let holdStarted = false, holdClosed = false;
const providerErrors: string[] = [];
const nativeDiagnostics: unknown[] = [];
let stage = "fixture-setup";
const actualFactory = new OarFactory();
const diagnosticFactory = {
  async open(input: Parameters<OarFactory["open"]>[0]) {
    const session = await actualFactory.open(input);
    return {
      ...session,
      rawEvents(observer: Parameters<typeof session.rawEvents>[0], cursor?: Parameters<typeof session.rawEvents>[1]) {
        return session.rawEvents((record) => {
          nativeDiagnostics.push(record);
          if (nativeDiagnostics.length > 20) nativeDiagnostics.shift();
          observer(record);
        }, cursor);
      },
      async prompt(...args: Parameters<typeof session.prompt>) {
        try { return await session.prompt(...args); }
        catch (error) {
          nativeDiagnostics.push({ rpcError: error instanceof Error ? error.message : String(error) });
          throw error;
        }
      },
    };
  },
};
function sse(res: ServerResponse, delta: unknown, finish: string | null = null) {
  res.write(`data: ${JSON.stringify({ id: "chatcmpl-fixture", object: "chat.completion.chunk", created: 1, model: "native-fixture", choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`);
}
function finish(res: ServerResponse, text: string) {
  sse(res, { role: "assistant", content: text });
  sse(res, {}, "stop");
  res.end("data: [DONE]\n\n");
}
const provider = createServer((req, res) => {
  void (async () => {
    assert.equal(req.url, "/v1/chat/completions");
    assert.equal(req.headers.authorization, "Bearer fixture-only-key");
    let raw = "";
    for await (const chunk of req) {
      raw += chunk;
      assert.ok(Buffer.byteLength(raw) < 4 * 1024 * 1024);
    }
    const body = JSON.parse(raw);
    assert.equal(body.model, "native-fixture");
    assert.equal(body.stream, true);
    const messages = body.messages as Array<{ role: string; content: unknown }>;
    const user = messages.filter((message) => message.role === "user").at(-1);
    const text = JSON.stringify(user?.content);
    requests++;
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
    if (text.includes("interrupt-fixture")) {
      holdStarted = true;
      res.on("close", () => { holdClosed = true; });
      sse(res, { role: "assistant", content: "stream is held until interrupted" });
      return;
    }
    if (text.includes("cold-resume-fixture")) {
      resumedWithHistory = messages.some((message) => message.role === "assistant" && JSON.stringify(message.content).includes("tool completed"));
      finish(res, "cold resume proof");
      return;
    }
    if (!toolOffered) {
      assert.ok(Array.isArray(body.tools) && body.tools.some((tool: any) => tool.function?.name === "write"), "Pi's real write tool must be advertised");
      toolOffered = true;
      sse(res, { role: "assistant", tool_calls: [{ index: 0, id: "native-write-1", type: "function", function: { name: "write", arguments: JSON.stringify({ path: "native-proof.txt", content: proof }) } }] });
      sse(res, {}, "tool_calls");
      res.end("data: [DONE]\n\n");
      return;
    }
    sawToolResult = messages.some((message) => message.role === "tool");
    assert.ok(sawToolResult, "Native tool result must return to the provider");
    finish(res, "tool completed; native hello");
  })().catch((error) => {
    providerErrors.push(error instanceof Error ? error.message : String(error));
    if (!res.headersSent) res.writeHead(500);
    res.end();
  });
});
await new Promise<void>((resolve) => provider.listen(0, "127.0.0.1", resolve));
const address = provider.address();
assert.ok(address && typeof address !== "string");
const root = await mkdtemp(join(tmpdir(), "managed-native-"));
const workspace = join(root, "workspace");
await mkdir(workspace);
let clock = Date.now();
const configuration = { databasePath: join(root, "state", "managed.sqlite"), home: join(root, "home"), stateHome: join(root, "state"), workspace, factory: diagnosticFactory, permissionPolicy: "locally-trusted" as const, maxResident: 1, idleMs: 60_000, now: () => clock };
await mkdir(configuration.home);
let runtime = new ManagedRuntime(configuration); // Production OarFactory; no runtime mock.
let localId = "";
let nativeId: unknown;
const state = () => runtime.queueControl(localId, "state") as Promise<Record<string, unknown>>;
try {
  await measure("baseline");
  stage = "create";
  const created = await runtime.executeWithReceipt({ op: "create", agentId: "native-agent", backend: "pi", name: "Native acceptance", launch: { cwd: workspace, model: "native-fixture", reasoning_effort: "off", provider_config: { base_url: `http://127.0.0.1:${address.port}/v1`, api_key: "fixture-only-key", api: "openai-completions" } } }, "native-create") as { localId: string };
  localId = created.localId;
  nativeId = (await state()).thread_id;
  assert.equal(typeof nativeId, "string");
  assert.ok((await measure("opened")).length > 0, "Real OAR worker must be resident");
  stage = "first-send";
  await runtime.executeWithReceipt({ op: "send", agentId: "native-agent", localId, text: "write-fixture: write native-proof.txt, then greet me" }, "native-send");
  await until(state, (value) => value.runtime_state === "idle", "native write and turn completion");
  assert.equal(await readFile(join(workspace, "native-proof.txt"), "utf8"), proof);
  const messages = await runtime.execute({ op: "messages", agentId: "native-agent", localId }) as { messages: Array<{ text: string }> };
  assert.ok(messages.messages.some((message) => message.text.includes("native hello")));
  assert.ok(sawToolResult);
  const firstStream = (await state()).stream_id;
  await measure("first-completed");
  stage = "quiesce";
  clock += 60_001;
  await runtime.quiesceIdle();
  assert.equal((await state()).resident, false);
  await until(processes, (all) => !all.some((row) => owned.has(row.identity)), "quiesced worker descendants to exit");
  await measure("quiesced");
  await runtime.close();
  runtime = new ManagedRuntime(configuration);
  stage = "cold-resume";
  await runtime.executeWithReceipt({ op: "send", agentId: "native-agent", localId, text: "cold-resume-fixture: continue the same conversation" }, "native-resume");
  await until(state, (value) => value.runtime_state === "idle", "cold resumed completion");
  assert.equal((await state()).thread_id, nativeId);
  assert.notEqual((await state()).stream_id, firstStream);
  assert.ok(resumedWithHistory, "Native SDK resume must include persisted prior assistant history");
  await measure("resumed");
  stage = "interrupt-send";
  await runtime.executeWithReceipt({ op: "send", agentId: "native-agent", localId, text: "interrupt-fixture: hold this stream" }, "native-hold");
  await until(async () => holdStarted, Boolean, "held native provider stream");
  assert.equal((await state()).busy, true);
  const interrupted = await runtime.executeWithReceipt({ op: "interrupt", agentId: "native-agent", localId }, "native-interrupt") as { interrupted: boolean };
  assert.equal(interrupted.interrupted, true);
  await until(state, (value) => value.runtime_state === "idle", "aborted native turn");
  await until(async () => holdClosed, Boolean, "provider connection cancellation");
  await measure("interrupted");
  assert.deepEqual(providerErrors, []);
  await runtime.close();
  await until(processes, (all) => !all.some((row) => owned.has(row.identity)), "closed owned process descendants");
  await measure("closed");
  console.log(JSON.stringify({ ok: true, runtime: "real @botiverse/oar Pi SDK", requests, nativeIdentityPreserved: true, toolWriteVerified: true, nativeHistoryResumed: true, interruptVerified: true, ownedDescendantsReclaimed: true, measurements }, null, 2));
} catch (error) {
  // This fixture starts with an empty private HOME and only a fake API key.
  // Never enable these raw diagnostics in a deployment with private credentials.
  console.error(JSON.stringify({ failedStage: stage, error: error instanceof Error ? error.message : String(error), providerErrors, requests, toolOffered, sawToolResult, nativeDiagnostics, measurements }, null, 2).replaceAll("fixture-only-key", "<fixture-key>"));
  throw error;
} finally {
  await runtime.close();
  provider.closeAllConnections();
  await new Promise<void>((resolve) => provider.close(() => resolve()));
  await rm(root, { recursive: true, force: true });
}
