import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import Fastify from "fastify";
import { registerDownloads, type DownloadOptions } from "../src/hub/downloads.js";
import { DomainError } from "../src/contracts/model.js";
import type { Tunnels } from "../src/protocol/tunnels.js";
assert.ok(existsSync("/.dockerenv"), "Run download acceptance in Docker");

async function fixture(slow = false) {
  const app = Fastify();
  let time = Date.now(), allowed = true, requests = 0, revoked = false;
  const decision = { actorId: "alice" };
  app.setErrorHandler((error, _request, reply) => reply.code(error instanceof DomainError ? error.status : 400).send({ error: error instanceof Error ? error.message : String(error) }));
  const options: DownloadOptions = {
    origin: "https://hub.example.invalid",
    now: () => time,
    call: async <T>(_r: unknown, operation: string, args?: Record<string, unknown>): Promise<T> => {
      if (operation === "authorize") return { agent: { id: "agent", localId: "local", computerId: "computer" } } as T;
      if (operation === "notification-subject") return { userId: "alice", sessionId: "session", binding: 1 } as T;
      assert.equal(operation, "relay");
      assert.ok(String(args!.path).startsWith("/api/sessions/local/file/download?"));
      return decision as T;
    },
    authorize: async () => {
      if (!allowed) throw new DomainError(403, "revoked", "Access revoked");
      return revoked ? { actorId: "bob" } : decision;
    },
    tunnels: {
      supports: () => true,
      http: async (_id: string, request: { path: string }, _body: unknown, signal: AbortSignal) => {
        requests++;
        assert.ok(request.path.includes("path="));
        return { status: 200, headers: { "content-type": "application/octet-stream", "content-length": slow ? "14" : "7", "content-disposition": 'attachment; filename="test.bin"' }, body: (async function* () {
          yield Buffer.from("payload");
          if (slow) {
            await new Promise<void>((resolve, reject) => {
              const abort = () => {clearTimeout(timer); reject(signal.reason);};
              const timer = setTimeout(() => {signal.removeEventListener("abort",abort);resolve();},3000);
              signal.addEventListener("abort",abort,{once:true});
              if(signal.aborted) abort();
            });
            yield Buffer.from("payload");
          }
        })() };
      },
    } as unknown as Tunnels,
  };
  await registerDownloads(app, options);
  async function prepare(query = "path=test.bin") {
    return app.inject({ method: "POST", url: "/api/v1/downloads/prepare", headers: { origin: "https://client.example.invalid" }, payload: { agentId: "agent", query } });
  }
  async function consume(ticket: string, origin = "https://client.example.invalid") {
    return app.inject({ method: "POST", url: "/api/v1/downloads/consume", headers: { origin, "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams({ ticket }).toString() });
  }
  return { app, prepare, consume, advance: () => { time += 120_001; }, revoke: () => { allowed = false; }, change: () => { revoked = true; }, requests: () => requests };
}

test("download handoff preserves attachment and uses a one-use body credential", async () => {
  const f = await fixture();
  try {
    const prepared = await f.prepare("path=test.bin&path_token=ZmlsZQ&git_path=1&workspace_id=root");
    assert.equal(prepared.statusCode, 200);
    const handoff = prepared.json();
    assert.equal(handoff.action, "https://hub.example.invalid/api/v1/downloads/consume");
    assert.ok(!handoff.action.includes(handoff.ticket));
    const responses = await Promise.all([f.consume(handoff.ticket), f.consume(handoff.ticket)]);
    assert.deepEqual(responses.map(r => r.statusCode).sort(), [200, 410]);
    const success = responses.find(r => r.statusCode === 200)!;
    assert.equal(success.body, "payload");
    assert.equal(success.headers["content-length"], "7");
    assert.match(String(success.headers["content-disposition"]), /^attachment/);
    assert.equal(f.requests(), 1);
  } finally { await f.app.close(); }
});

test("handoff rejects wrong origin, duplicate queries and unrelated operations", async () => {
  const f = await fixture();
  try {
    for (const query of ["path=a&path=b", "path=a&workspace_id=x&workspace_id=y", "path=a&git_path=0", "path=a&operation=delete", "path=a&path_token="])
      assert.equal((await f.prepare(query)).statusCode, 400);
    const { ticket } = (await f.prepare()).json();
    assert.equal((await f.consume(ticket, "https://other.example.invalid")).statusCode, 403);
    assert.equal((await f.consume(ticket)).statusCode, 200);
  } finally { await f.app.close(); }
});

test("expiration and current session or actor revocation fence prepared downloads", async () => {
  for (const change of ["advance", "revoke", "change"] as const) {
    const f = await fixture();
    try {
      const { ticket } = (await f.prepare()).json();
      f[change]();
      assert.equal((await f.consume(ticket)).statusCode, change === "advance" ? 410 : 403);
      assert.equal(f.requests(), 0);
    } finally { await f.app.close(); }
  }
});

test("an already-open browser handoff stream terminates after current access is revoked", async () => {
  const f = await fixture(true);
  try {
    const address = await f.app.listen({host:"127.0.0.1",port:0});
    const {ticket} = (await f.prepare()).json();
    const response = await fetch(address+"/api/v1/downloads/consume",{method:"POST",headers:{origin:"null","content-type":"application/x-www-form-urlencoded"},body:new URLSearchParams({ticket})});
    assert.equal(response.status,200);
    const reader=response.body!.getReader();
    assert.equal(Buffer.from((await reader.read()).value!).toString(),"payload");
    f.revoke();
    await assert.rejects(reader.read());
    assert.equal(f.requests(),1);
  } finally {await f.app.close();}
});
