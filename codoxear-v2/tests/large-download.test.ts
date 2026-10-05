import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, createReadStream } from "node:fs";
import { mkdtemp, mkdir, open, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { createHash } from "node:crypto";
import { WebSocket, WebSocketServer } from "ws";
import { NativeHttpTarget } from "../src/computer/native/http.js";
import type { NativeRuntime } from "../src/computer/native/runtime.js";
import { HttpMux } from "../src/protocol/http-mux.js";
import { COMPUTER_WINDOW, type Bytes } from "../src/protocol/http-frames.js";

assert.ok(existsSync("/.dockerenv"), "Run download acceptance in Docker");

async function digest(body: Bytes) {
  const hash = createHash("sha256");
  let bytes = 0;
  for await (const chunk of body) {
    bytes += chunk.byteLength;
    hash.update(chunk);
  }
  return { bytes, sha256: hash.digest("hex") };
}

test(
  "native downloads larger than the upload limit stream intact with bounded buffers, ranges and cancellation",
  { timeout: 120000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "native-large-download-"));
    const workspace = join(home, "workspace");
    await mkdir(workspace);
    const filename = join(workspace, "large.bin");
    const size = 257 * 1024 * 1024 + 37;
    const ending = Buffer.from("Codoxear download end");
    const file = await open(filename, "wx", 0o600);
    try {
      await file.truncate(size);
      await file.write(Buffer.from("Codoxear download start"), 0, 23, 0);
      await file.write(ending, 0, ending.length, size - ending.length);
    } finally {
      await file.close();
    }
    const expected = await digest(createReadStream(filename));
    const id = "broker-" + "e".repeat(32);
    const runtime = {
      home,
      stateHome: home,
      async request(path: string) {
        return path === "/api/sessions"
          ? { sessions: [{ session_id: id, cwd: workspace }] }
          : { ok: true };
      },
      async completions() {
        return [];
      },
    } as unknown as NativeRuntime;
    const target = new NativeHttpTarget(runtime, workspace);
    const server = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await once(server, "listening");
    const address = server.address();
    assert.ok(address && typeof address !== "string");
    const connected = once(server, "connection");
    const client = new WebSocket("ws://127.0.0.1:" + address.port);
    await once(client, "open");
    const [accepted] = (await connected) as [WebSocket];
    const reader = new HttpMux(client, "large-download");
    const computer = new HttpMux(accepted, "large-download", (request) =>
      target.execute(request),
    );
    const path = `/api/sessions/${id}/file/download?path=large.bin`;
    try {
      const response = await reader.request({
        method: "GET",
        path,
        headers: {},
      });
      assert.equal(response.status, 200);
      assert.equal(Number(response.headers["content-length"]), size);
      const hash = createHash("sha256");
      let received = 0,
        checkedConcurrentRequest = false;
      for await (const chunk of response.body) {
        received += chunk.byteLength;
        hash.update(chunk);
        if (!checkedConcurrentRequest && received > 8 * 1024 * 1024) {
          const state = await reader.request({
            method: "GET",
            path: `/api/sessions/${id}/messages/tail`,
            headers: {},
          });
          assert.equal(state.status, 200);
          await digest(state.body);
          checkedConcurrentRequest = true;
        }
      }
      assert.equal(checkedConcurrentRequest, true);
      assert.deepEqual(
        { bytes: received, sha256: hash.digest("hex") },
        expected,
      );
      assert.ok(reader.metrics().highWaterBytes <= COMPUTER_WINDOW);
      assert.ok(computer.metrics().highWaterBytes <= COMPUTER_WINDOW);

      const range = await reader.request({
        method: "GET",
        path,
        headers: { range: `bytes=${size - ending.length}-${size - 1}` },
      });
      assert.equal(range.status, 206);
      assert.equal(
        range.headers["content-range"],
        `bytes ${size - ending.length}-${size - 1}/${size}`,
      );
      assert.deepEqual(
        await digest(range.body),
        await digest(
          (async function* () {
            yield ending;
          })(),
        ),
      );

      const abort = new AbortController();
      const cancelled = await reader.request(
        { method: "GET", path, headers: {} },
        undefined,
        abort.signal,
      );
      abort.abort();
      await assert.rejects(digest(cancelled.body));
      const after = await reader.request({ method: "HEAD", path, headers: {} });
      assert.equal(after.status, 200);
      assert.equal((await digest(after.body)).bytes, 0);
    } finally {
      reader.close();
      computer.close();
      client.terminate();
      accepted.terminate();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      target.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
