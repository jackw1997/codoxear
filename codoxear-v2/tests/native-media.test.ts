import assert from "node:assert/strict";
import { test } from "node:test";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import type { NativeRuntime } from "../src/computer/native/runtime.js";
import { NativeHttpTarget } from "../src/computer/native/http.js";
import { emptyBody } from "../src/protocol/http-frames.js";
const id = "broker-" + "a".repeat(32),
  tool = process.env.FFMPEG_BIN ?? "ffmpeg";
function encoderAvailable() {
  try {
    execFileSync(tool, ["-version"], { stdio: "ignore", timeout: 10000 });
    return true;
  } catch {
    return false;
  }
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "native-media-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const now = Date.now() + 1000;
  const event = {
    role: "assistant",
    text: "Verified native voice output.",
    ts: now / 1000,
    message_class: "final_response",
    message_id: "fixture-message",
  };
  const runtime = {
    home,
    stateHome: home,
    async completions(since: number) {
      return since <= now
        ? [
            {
              id: "voice-fixture",
              localId: id,
              occurredAt: now,
              kind: "completion",
            },
          ]
        : [];
    },
    async request(path: string) {
      if (path === "/api/sessions")
        return { sessions: [{ session_id: id, cwd: workspace }] };
      return { events: [event] };
    },
  } as unknown as NativeRuntime;
  const target = new NativeHttpTarget(runtime, workspace);
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    headers: Record<string, string> = {},
  ) {
    const response = await target.execute({
      method: method as "GET" | "POST",
      path,
      headers,
      body:
        body === undefined
          ? emptyBody
          : (async function* () {
              yield Buffer.from(JSON.stringify(body));
            })(),
      signal: new AbortController().signal,
    });
    const chunks = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks);
    return { ...response, content, json: () => JSON.parse(content.toString()) };
  }
  return {
    home,
    workspace,
    target,
    event,
    call,
    async close() {
      target.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}
function wav() {
  const samples = 16000,
    bytes = Buffer.alloc(44 + samples * 2);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVE", 8);
  bytes.write("fmt ", 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i++)
    bytes.writeInt16LE(
      Math.round(1000 * Math.sin((i * 2 * Math.PI * 220) / 16000)),
      44 + i * 2,
    );
  return bytes;
}

test("Native image dimensions and original video routes retain file metadata", async () => {
  assert.ok(existsSync("/.dockerenv"), "Docker only");
  const f = await fixture();
  try {
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVfQAAAAASUVORK5CYII=",
      "base64",
    );
    await writeFile(join(f.workspace, "pixel.png"), image);
    const dimensions = await f.call(
      `/api/sessions/${id}/file/image-dimensions?path=pixel.png`,
    );
    assert.equal(dimensions.status, 200);
    assert.equal(dimensions.json().width, 1);
    assert.equal(dimensions.json().height, 1);
    const read = await f.call(`/api/sessions/${id}/file/read?path=pixel.png`);
    assert.equal(read.json().kind, "image");
    const blob = await f.call(read.json().image_url);
    assert.deepEqual(blob.content, image);
    const video = join(f.workspace, "clip.avi");
    if (encoderAvailable())
      execFileSync(tool, [
        "-nostdin",
        "-v",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=black:s=32x32:r=5",
        "-t",
        "0.5",
        "-c:v",
        "mpeg4",
        video,
      ]);
    else await writeFile(video, Buffer.from("fixture"));
    const described = await f.call(
      `/api/sessions/${id}/file/read?path=clip.avi`,
    );
    assert.equal(described.json().kind, "video");
    assert.equal(typeof described.json().video_preview_url, "string");
    const preview = await f.call(described.json().video_preview_url);
    if (encoderAvailable()) {
      assert.equal(preview.status, 200, preview.content.toString());
      assert.equal(preview.headers["content-type"], "video/mp4");
      assert.ok(preview.content.length > 100);
      assert.equal(preview.content.toString("ascii", 4, 8), "ftyp");
      const range = await f.call(
        described.json().video_preview_url,
        "GET",
        undefined,
        { range: "bytes=0-31" },
      );
      assert.equal(range.status, 206);
      assert.deepEqual(range.content, preview.content.subarray(0, 32));
      assert.equal(
        range.headers["content-range"],
        `bytes 0-31/${preview.content.length}`,
      );
    } else {
      assert.equal(preview.status, 503);
      assert.match(preview.json().error, /ffmpeg/);
    }
  } finally {
    await f.close();
  }
});

test("Native configured TTS produces actual HLS segments or reports the missing external encoder", async () => {
  assert.ok(existsSync("/.dockerenv"), "Docker only");
  const f = await fixture();
  let speechCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    assert.equal(request.headers.authorization, "Bearer fixture-tts-key");
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.match(body.input, /Verified native voice output/);
    speechCalls++;
    response.setHeader("content-type", "audio/wav");
    response.end(wav());
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    await f.call("/api/audio/listener", "POST", {
      client_id: "fixture-listener",
      enabled: true,
    });
    await f.call("/api/settings/voice", "POST", {
      tts_api_key: "fixture-tts-key",
      tts_base_url: `http://127.0.0.1:${port}/v1`,
    });
    let snapshot: any;
    const deadline = Date.now() + 15000;
    do {
      await setTimeout(100);
      snapshot = (await f.call("/api/settings/voice")).json();
    } while (
      Date.now() < deadline &&
      !snapshot.audio.segment_count &&
      !snapshot.audio.last_error
    );
    assert.equal(speechCalls, 1);
    assert.equal(snapshot.tts_api_key, "");
    if (encoderAvailable()) {
      assert.equal(snapshot.audio.last_error, null);
      assert.ok(snapshot.audio.segment_count > 0);
      const playlist = await f.call("/api/audio/live.m3u8");
      assert.equal(
        playlist.headers["content-type"],
        "application/vnd.apple.mpegurl",
      );
      assert.match(playlist.content.toString(), /#EXTINF:/);
      const segment = playlist.content
        .toString()
        .split("\n")
        .find((line: string) => line.startsWith("/api/audio/segments/"));
      assert.ok(segment);
      const streamed = await f.call(segment!);
      assert.equal(streamed.status, 200);
      assert.equal(streamed.headers["content-type"], "video/mp2t");
      assert.equal(streamed.content[0], 0x47);
    } else {
      assert.equal(snapshot.audio.segment_count, 0);
      assert.match(snapshot.audio.last_error, /ffmpeg/);
    }
  } finally {
    f.target.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});

test("Voice requires an active listener and uses the configured narration summarization and speech models", async () => {
  assert.ok(existsSync("/.dockerenv"), "Docker only");
  const f = await fixture();
  let summaryCalls = 0,
    speechCalls = 0;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    assert.equal(request.headers.authorization, "Bearer fixture-tts-key");
    if (request.url?.endsWith("/chat/completions")) {
      assert.equal(body.model, "fixture-summary-model");
      assert.match(body.messages[0].content, /15 words/);
      summaryCalls++;
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          choices: [{ message: { content: "Verified narrated progress." } }],
        }),
      );
    } else {
      assert.equal(body.model, "fixture-speech-model");
      assert.match(body.input, /Verified narrated progress/);
      speechCalls++;
      response.setHeader("content-type", "audio/wav");
      response.end(wav());
    }
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  try {
    const port = (server.address() as { port: number }).port;
    await f.call("/api/settings/voice", "POST", {
      tts_api_key: "fixture-tts-key",
      tts_base_url: `http://127.0.0.1:${port}/v1`,
      tts_enabled_for_final_response: false,
      tts_enabled_for_narration: true,
      summarization_model: "fixture-summary-model",
      tts_model: "fixture-speech-model",
    });
    f.event.message_class = "narration";
    f.event.text = "Concrete progress ".repeat(40);
    await setTimeout(1100);
    assert.equal(summaryCalls, 0);
    assert.equal(speechCalls, 0);
    await f.call("/api/audio/listener", "POST", {
      client_id: "narration-listener",
      enabled: true,
    });
    f.event.ts = Date.now() / 1000 + 0.5;
    f.event.message_id = "new-narration";
    const deadline = Date.now() + 15000;
    while (Date.now() < deadline && speechCalls < 1) await setTimeout(100);
    assert.equal(summaryCalls, 1);
    assert.equal(speechCalls, 1);
    await f.call("/api/audio/listener", "POST", {
      client_id: "narration-listener",
      enabled: false,
    });
    f.event.message_id = "paused-narration";
    f.event.ts = Date.now() / 1000 + 0.5;
    await setTimeout(1100);
    assert.equal(summaryCalls, 1);
    assert.equal(speechCalls, 1);
  } finally {
    f.target.close();
    server.closeAllConnections();
    await new Promise<void>((r) => server.close(() => r()));
    await f.close();
  }
});

test("Voice settings reject non-boolean toggles and mask fixture secrets after blank-key saves", async () => {
  assert.ok(existsSync("/.dockerenv"), "Docker only");
  const f = await fixture();
  try {
    assert.equal((await f.call("/api/settings/voice", "POST", { tts_api_key: "fixture-masking-secret", tts_enabled_for_narration: "false" })).status, 400);
    assert.equal((await f.call("/api/settings/voice")).json().has_tts_api_key, false);
    const saved = await f.call("/api/settings/voice", "POST", { tts_api_key: "fixture-masking-secret", injected_secret: "fixture-unrecognized-secret" });
    assert.equal(saved.status, 200);
    assert.equal(saved.json().tts_api_key, "");
    assert.equal(saved.json().has_tts_api_key, true);
    assert.ok(!saved.content.includes(Buffer.from("fixture-masking-secret")));
    assert.equal("injected_secret" in saved.json(), false);
    const kept = await f.call("/api/settings/voice", "POST", { tts_api_key: "" });
    assert.equal(kept.json().has_tts_api_key, true);
    const cleared = await f.call("/api/settings/voice", "POST", { tts_api_key_clear: true });
    assert.equal(cleared.json().has_tts_api_key, false);
  } finally { await f.close(); }
});

for (const stage of ["speech", "summary"] as const) {
  test(`Disabling the final listener aborts pending ${stage} without publishing stale audio`, async () => {
    assert.ok(existsSync("/.dockerenv"), "Docker only");
    const f = await fixture();
    let calls = 0, closed = false;
    const server = createServer(async (request, response) => {
      for await (const _chunk of request) {}
      calls++;
      assert.ok(request.headers.authorization === "Bearer fixture-cancel-key");
      assert.equal(request.url, stage === "summary" ? "/v1/chat/completions" : "/v1/audio/speech");
      response.once("close", () => { closed = true; });
    });
    await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
    try {
      const port = (server.address() as {port:number}).port;
      if (stage === "summary") f.event.text = "Concrete reported progress ".repeat(40);
      await f.call("/api/settings/voice", "POST", { tts_api_key: "fixture-cancel-key", tts_base_url: `http://127.0.0.1:${port}/v1` });
      await f.call("/api/audio/listener", "POST", {client_id:"cancel-listener",enabled:true});
      f.event.ts = Date.now()/1000 + 0.5;
      let deadline = Date.now()+15000;
      while (!calls && Date.now()<deadline) await setTimeout(50);
      assert.equal(calls, 1);
      await f.call("/api/audio/listener", "POST", {client_id:"cancel-listener",enabled:false});
      deadline = Date.now()+3000;
      while (!closed && Date.now()<deadline) await setTimeout(50);
      assert.equal(closed,true,"Provider connection must close promptly after listener opt-out");
      const snapshot = (await f.call("/api/settings/voice")).json();
      assert.equal(snapshot.audio.active_listener_count,0);
      assert.equal(snapshot.audio.segment_count,0);
      assert.equal(snapshot.audio.last_error,null);
      assert.ok(!(await f.call("/api/audio/live.m3u8")).content.includes(Buffer.from("#EXTINF:")));
    } finally {
      f.target.close(); server.closeAllConnections();
      await new Promise<void>(resolve => server.close(()=>resolve()));
      await f.close();
    }
  });
}
