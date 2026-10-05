import assert from "node:assert/strict";
import { test } from "node:test";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  symlink,
  rm,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { requireSecureFilePlatform } from "../src/computer/native/workspace/files.js";
import { DomainError } from "../src/contracts/model.js";
import { NativeHttpTarget } from "../src/computer/native/http.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { emptyBody } from "../src/protocol/http-frames.js";
const id = "broker-" + "a".repeat(32);
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "native-http-"));
  const workspace = join(home, "workspace");
  await mkdir(workspace);
  const runtime = {
    home,
    stateHome: home,
    async request(path: string) {
      if (path === "/api/sessions")
        return { sessions: [{ session_id: id, cwd: workspace }] };
      return { ok: true };
    },
    async completions() {
      return [];
    },
  } as unknown as NativeRuntime;
  const target = new NativeHttpTarget(runtime, workspace);
  async function call(
    path: string,
    method = "GET",
    body?: unknown,
    scope?: "read" | "write",
    headers: Record<string, string> = {},
  ) {
    const bytes =
      body === undefined
        ? emptyBody
        : (async function* () {
            yield Buffer.from(JSON.stringify(body));
          })();
    const result = await target.execute({
      method: method as "GET" | "POST" | "HEAD",
      path,
      headers,
      body: bytes,
      signal: new AbortController().signal,
      ...(scope
        ? {
            actorId: "reader",
            workspace: { id: "default" as const, access: scope },
          }
        : {}),
    });
    const chunks = [];
    for await (const chunk of result.body) chunks.push(Buffer.from(chunk));
    const content = Buffer.concat(chunks);
    return { ...result, content, json: () => JSON.parse(content.toString()) };
  }
  return {
    home,
    workspace,
    target,
    runtime,
    call,
    async close() {
      target.close();
      await rm(home, { recursive: true, force: true });
    },
  };
}

test("Native file reads and compare-and-save preserve bytes and reject stale versions", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "file.txt"), "original");
    const read = await f.call(`/api/sessions/${id}/file/read?path=file.txt`);
    assert.equal(read.status, 200);
    assert.equal(read.json().text, "original");
    const version = read.json().version;
    const saved = await f.call(`/api/sessions/${id}/file/write`, "POST", {
      path: "file.txt",
      text: "edited",
      version,
    });
    assert.equal(saved.status, 200);
    assert.equal(
      await readFile(join(f.workspace, "file.txt"), "utf8"),
      "edited",
    );
    const stale = await f.call(`/api/sessions/${id}/file/write`, "POST", {
      path: "file.txt",
      text: "lost",
      version,
    });
    assert.equal(stale.status, 409);
    assert.equal(
      await readFile(join(f.workspace, "file.txt"), "utf8"),
      "edited",
    );
  } finally {
    await f.close();
  }
});

test("Workspace grants reject symlink traversal, writes without write grants, mismatched sessions and repository history", async () => {
  const f = await fixture();
  try {
    await writeFile(join(f.workspace, "safe.txt"), "safe");
    await writeFile(join(f.home, "secret.txt"), "secret");
    await symlink(join(f.home, "secret.txt"), join(f.workspace, "link"));
    const base = `/api/sessions/${id}/file`;
    assert.equal(
      (
        await f.call(base + "/read?path=safe.txt", "GET", undefined, "read")
      ).json().editable,
      false,
    );
    assert.equal(
      (
        await f.call(
          base + "/write",
          "POST",
          { path: "safe.txt", text: "no" },
          "read",
        )
      ).status,
      403,
    );
    for (const path of ["../secret.txt", join(f.home, "secret.txt"), "link"])
      for (const action of ["read", "download", "blob"])
        assert.equal(
          (
            await f.call(
              `${base}/${action}?path=${encodeURIComponent(path)}`,
              "GET",
              undefined,
              "read",
            )
          ).status,
          403,
        );
    assert.equal(
      (
        await f.call(
          base + "/inspect",
          "POST",
          { path: "safe.txt", session_id: "different" },
          "read",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          base + "/inspect",
          "POST",
          { path: "safe.txt", git_path: true },
          "read",
        )
      ).status,
      403,
    );
    assert.equal(
      (
        await f.call(
          `/api/sessions/${id}/git/changed_files`,
          "GET",
          undefined,
          "read",
        )
      ).status,
      403,
    );
    const listed = await f.call(base + "/list", "GET", undefined, "read");
    assert.deepEqual(listed.json().files, ["safe.txt"]);
  } finally {
    await f.close();
  }
});

test("Downloads stream ranges with byte-identical content and conditional responses", async () => {
  const f = await fixture();
  try {
    const data = Buffer.from([0, 1, 2, 3, 4, 5]);
    await writeFile(join(f.workspace, "bytes.bin"), data);
    const path = `/api/sessions/${id}/file/download?path=bytes.bin`;
    const downloaded = await f.call(path);
    assert.deepEqual(downloaded.content, data);
    assert.match(downloaded.headers["content-disposition"]!, /attachment/);
    const ranged = await f.call(path, "GET", undefined, undefined, {
      range: "bytes=1-3",
    });
    assert.equal(ranged.status, 206);
    assert.deepEqual(ranged.content, data.subarray(1, 4));
    assert.equal(ranged.headers["content-range"], "bytes 1-3/6");
    const cached = await f.call(path, "GET", undefined, undefined, {
      "if-none-match": downloaded.headers.etag!,
    });
    assert.equal(cached.status, 304);
    assert.equal(cached.content.length, 0);
  } finally {
    await f.close();
  }
});

test("Owner Git changed files, diff and versions use native Git while grants deny history", async () => {
  const f = await fixture();
  try {
    for (const args of [
      ["init"],
      ["config", "user.name", "Fixture"],
      ["config", "user.email", "fixture@example.invalid"],
    ])
      execFileSync("git", args, { cwd: f.workspace, stdio: "ignore" });
    await writeFile(join(f.workspace, "tracked.txt"), "before\n");
    execFileSync("git", ["add", "."], { cwd: f.workspace });
    execFileSync("git", ["commit", "-m", "fixture"], {
      cwd: f.workspace,
      stdio: "ignore",
    });
    await writeFile(join(f.workspace, "tracked.txt"), "after\n");
    await writeFile(join(f.workspace, "untracked.txt"), "new");
    const base = `/api/sessions/${id}/git`;
    const changed = await f.call(base + "/changed_files");
    assert.equal(changed.status, 200);
    assert.deepEqual(changed.json().files, ["tracked.txt", "untracked.txt"]);
    const diff = await f.call(base + "/diff?path=tracked.txt&head=1");
    assert.match(diff.json().diff, /-before/);
    assert.match(diff.json().diff, /\+after/);
    const versions = await f.call(base + "/file_versions?path=tracked.txt");
    assert.equal(versions.json().base_text, "before\n");
    assert.equal(versions.json().current_text, "after\n");
    await symlink("tracked.txt", join(f.workspace, "shortcut"));
    const link = await f.call(base + "/file_versions?path=shortcut");
    assert.equal(link.status, 200);
    assert.equal(link.json().current_text, "tracked.txt");
  } finally {
    await f.close();
  }
});

test("Voice settings redact secrets and preserve existing keys when a blank key is posted", async () => {
  const f = await fixture();
  try {
    const first = await f.call("/api/settings/voice", "POST", {
      tts_api_key: "fixture-secret",
      tts_base_url: "http://localhost:1234/v1",
    });
    assert.equal(first.json().tts_api_key, "");
    assert.equal(first.json().has_tts_api_key, true);
    const second = await f.call("/api/settings/voice", "POST", {
      tts_api_key: "",
      tts_enabled_for_narration: true,
    });
    assert.equal(second.json().has_tts_api_key, true);
    assert.equal(
      (
        await f.call("/api/settings/voice", "POST", { tts_api_key_clear: true })
      ).json().has_tts_api_key,
      false,
    );
  } finally {
    await f.close();
  }
});

test("Raw byte filenames roundtrip through tokens without changing their bytes", async () => {
  const f = await fixture();
  try {
    const raw = Buffer.concat([
      Buffer.from(f.workspace + "/odd-"),
      Buffer.from([255]),
      Buffer.from(".txt"),
    ]);
    await writeFile(raw, "raw filename");
    const listed = await f.call(`/api/sessions/${id}/file/list`);
    const entry = listed.json().entries[0];
    assert.equal(entry.non_utf8_path, true);
    assert.match(entry.api_path, /^codoxear-git-path-bytes-v1:/);
    const read = await f.call(
      `/api/sessions/${id}/file/read?path=${encodeURIComponent(entry.path)}&path_token=${encodeURIComponent(entry.api_path)}`,
    );
    assert.equal(read.status, 200);
    assert.equal(read.json().text, "raw filename");
    const downloaded = await f.call(
      `/api/sessions/${id}/file/download?path=${encodeURIComponent(entry.path)}&path_token=${encodeURIComponent(entry.api_path)}`,
    );
    assert.equal(downloaded.content.toString(), "raw filename");
  } finally {
    await f.close();
  }
});

test("UTF-8 replacement views remain readable but cannot overwrite undecodable originals", async () => {
  const f = await fixture();
  try {
    await writeFile(
      join(f.workspace, "legacy.txt"),
      Buffer.from([104, 105, 255]),
    );
    const read = await f.call(`/api/sessions/${id}/file/read?path=legacy.txt`);
    assert.equal(read.status, 200);
    assert.equal(read.json().editable, false);
    assert.equal(read.json().text, "hi\ufffd");
    const update = await f.call(`/api/sessions/${id}/file/write`, "POST", {
      path: "legacy.txt",
      text: "lossy",
      version: read.json().version,
    });
    assert.equal(update.status, 400);
    assert.deepEqual(
      await readFile(join(f.workspace, "legacy.txt")),
      Buffer.from([104, 105, 255]),
    );
  } finally {
    await f.close();
  }
});

test("Owner Git preserves raw filename tokens across status, versions and diff", async () => {
  const f = await fixture();
  try {
    const run = (...args: string[]) =>
      execFileSync("git", ["-C", f.workspace, ...args]);
    run("init");
    run("config", "user.name", "Fixture");
    run("config", "user.email", "fixture@example.invalid");
    const raw = Buffer.concat([
      Buffer.from(f.workspace + "/odd-"),
      Buffer.from([255]),
      Buffer.from(".txt"),
    ]);
    await writeFile(raw, "before\n");
    run("add", "--all");
    run("commit", "-m", "fixture");
    await writeFile(raw, "after\n");
    const status = await f.call(`/api/sessions/${id}/git/changed_files`);
    const entry = status.json().entries[0];
    assert.equal(entry.non_utf8_path, true);
    assert.equal(entry.additions, 1);
    const q = `?path=${encodeURIComponent(entry.path)}&path_token=${encodeURIComponent(entry.api_path)}`;
    const versions = await f.call(`/api/sessions/${id}/git/file_versions${q}`);
    assert.equal(versions.status, 200);
    assert.equal(versions.json().base_text, "before\n");
    assert.equal(versions.json().current_text, "after\n");
    const diff = await f.call(`/api/sessions/${id}/git/diff${q}`);
    assert.equal(diff.status, 200);
    assert.match(diff.json().diff, /\+after/);
    assert.match(diff.json().diff, /-before/);
  } finally {
    await f.close();
  }
});

test("Directory suggestions honor prefixes and unattended prompt reset restores the default", async () => {
  const f = await fixture();
  try {
    await mkdir(join(f.workspace, "alpha"));
    await mkdir(join(f.workspace, "beta"));
    const dirs = await f.call(
      `/api/cwd-suggest?path=${encodeURIComponent(f.workspace)}&prefix=al`,
    );
    assert.deepEqual(dirs.json().directories, [
      { name: "alpha", path: join(f.workspace, "alpha") },
    ]);
    const initial = await f.call("/api/settings/unattended-prompt");
    assert.match(
      initial.json().prompt,
      /Unattended-mode operating constitution/,
    );
    const changed = await f.call("/api/settings/unattended-prompt", "POST", {
      prompt: "Saved policy",
    });
    assert.equal(changed.json().prompt, "Saved policy");
    const reset = await f.call("/api/settings/unattended-prompt", "POST", {
      prompt: "",
    });
    assert.equal(reset.json().prompt, initial.json().default_prompt);
  } finally {
    await f.close();
  }
});

test("Notification feed, text and state resolve the matching native completion", async () => {
  const f = await fixture();
  try {
    const message = "event-second",
      notification = createHash("sha256")
        .update(id + message)
        .digest("hex");
    f.runtime.completions = async () => [
      { id: notification, localId: id, kind: "completion", occurredAt: 123000 },
    ];
    const request = f.runtime.request.bind(f.runtime);
    f.runtime.request = async (path: string, method = "GET", body?: unknown) =>
      path.includes("messages/tail")
        ? {
            events: [
              {
                message_id: "event-first",
                role: "assistant",
                text: "Wrong same timestamp",
                ts: 123,
              },
              {
                message_id: message,
                role: "assistant",
                text: "Correct completion",
                message_class: "final_response",
                ts: 123,
              },
            ],
          }
        : request(path, method, body);
    const feed = await f.call("/api/notifications/feed?since=0");
    assert.equal(feed.json().items[0].notification_text, "Correct completion");
    for (const route of ["text", "state"]) {
      const response = await f.call(
        `/api/notifications/${route}?message_id=${notification}`,
      );
      assert.equal(response.status, 200);
      assert.equal(response.json().text, "Correct completion");
    }
    assert.equal(
      (await f.call("/api/notifications/text?message_id=missing")).status,
      404,
    );
  } finally {
    await f.close();
  }
});

test("JSON attachments stage byte-identical private files and reject invalid payloads", async () => {
  const f = await fixture();
  try {
    const original = f.runtime.request.bind(f.runtime);
    let staged: any;
    f.runtime.request = async (
      path: string,
      method = "GET",
      body?: unknown,
    ) => {
      if (path.endsWith("inject_file")) {
        staged = body;
        return { ok: true };
      }
      return original(path, method, body);
    };
    const response = await f.call(`/api/sessions/${id}/inject_file`, "POST", {
      filename: "../proof.txt",
      data_b64: Buffer.from("attached bytes").toString("base64"),
    });
    assert.equal(response.status, 200);
    assert.equal(staged.name, "proof.txt");
    assert.deepEqual(
      await readFile(staged.path),
      Buffer.from("attached bytes"),
    );
    assert.ok(staged.path.startsWith(join(f.home, "uploads", id) + "/"));
    assert.equal(
      (await f.call(`/api/sessions/${id}/inject_file`, "POST", null)).status,
      400,
    );
    assert.equal(
      (
        await f.call(`/api/sessions/${id}/inject_file`, "POST", {
          filename: "x",
          data_b64: "",
        })
      ).status,
      400,
    );
  } finally {
    await f.close();
  }
});

test("Secure file platform gate reports unsupported hosts explicitly", () => {
  assert.doesNotThrow(() => requireSecureFilePlatform("linux"));
  for (const platform of ["darwin", "win32"] as const)
    assert.throws(
      () => requireSecureFilePlatform(platform),
      (error: unknown) =>
        error instanceof DomainError &&
        error.status === 501 &&
        error.code === "unsupported_platform" &&
        /requires Linux/.test(error.message),
    );
});

test("Non-repository Git feedback identifies the reason used by the file menu", async () => {
  const f = await fixture();
  try {
    const response = await f.call(`/api/sessions/${id}/git/changed_files`);
    assert.equal(response.status, 409);
    assert.match(response.json().error, /not a git repository/i);
  } finally {
    await f.close();
  }
});

test("Unsupported-platform file requests return actionable 501 rather than missing-file errors", async () => {
  const f = await fixture();
  const descriptor = Object.getOwnPropertyDescriptor(process, "platform")!;
  try {
    await writeFile(join(f.workspace, "proof.txt"), "bytes");
    Object.defineProperty(process, "platform", {
      ...descriptor,
      value: "darwin",
    });
    const read = await f.call(`/api/sessions/${id}/file/read?path=proof.txt`);
    assert.equal(read.status, 501);
    assert.equal(read.json().code, "unsupported_platform");
    assert.match(read.json().error, /requires Linux/);
    const batch = await f.call(
      `/api/sessions/${id}/file/inspect-batch`,
      "POST",
      { paths: ["proof.txt"] },
    );
    assert.equal(batch.status, 501);
    const suggest = await f.call(
      `/api/cwd-suggest?path=${encodeURIComponent(f.workspace)}`,
    );
    assert.equal(suggest.status, 501);
  } finally {
    Object.defineProperty(process, "platform", descriptor);
    await f.close();
  }
});

test("Git text versions reject binary working files without returning lossy content", async () => {
  const f = await fixture();
  try {
    execFileSync("git", ["-C", f.workspace, "init"], { stdio: "ignore" });
    await writeFile(join(f.workspace, "binary.bin"), Buffer.from([1, 0, 2]));
    const result = await f.call(
      `/api/sessions/${id}/git/file_versions?path=binary.bin`,
    );
    assert.equal(result.status, 400);
    assert.match(result.json().error, /binary file/i);
  } finally {
    await f.close();
  }
});

test("Native PTY file and image uploads retain browser staging metadata across acknowledgement, list and delete", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-upload-")),
    workspace = join(home, "workspace"),
    command = join(home, "fixture-codex");
  await mkdir(workspace);
  await writeFile(
    command,
    `#!${process.execPath}\nprocess.stdout.write('100% context left ? for shortcuts\\n');process.stdin.resume();\n`,
    { mode: 0o755 },
  );
  const prior = process.env.CODEX_BIN,
    control = process.env.CODOXEAR_NATIVE_CODEX_LIVE_CONTROL;
  process.env.CODEX_BIN = command;
  process.env.CODOXEAR_NATIVE_CODEX_LIVE_CONTROL = "0";
  const runtime = new NativeRuntime(home, workspace),
    target = new NativeHttpTarget(runtime, workspace);
  let localId: string | undefined;
  const call = async (path: string, method = "GET", value?: unknown) => {
    const response = await target.execute({
      path,
      method: method as "GET" | "POST",
      headers: { "content-type": "application/json" },
      signal: new AbortController().signal,
      body:
        value === undefined
          ? emptyBody
          : (async function* () {
              yield Buffer.from(JSON.stringify(value));
            })(),
    });
    const chunks: Buffer[] = [];
    for await (const chunk of response.body) chunks.push(Buffer.from(chunk));
    return {
      status: response.status,
      data: JSON.parse(Buffer.concat(chunks).toString()),
    };
  };
  try {
    const launch = (await runtime.execute({
      op: "create",
      agentId: "upload-agent",
      backend: "codex",
      name: "Upload fixture",
      launch: {
        cwd: workspace,
        model: "Fixture",
        provider_config: {
          base_url: "http://fixture.invalid/v1",
          api_key: "fixture-key",
        },
      },
    })) as any;
    localId = launch.localId;
    const bytes = Buffer.from("browser upload bytes"),
      png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVfQAAAAASUVORK5CYII=",
        "base64",
      );
    for (const [route, name, data] of [
      ["inject_file", "browser-upload.txt", bytes],
      ["inject_image", "browser-image.png", png],
    ] as const) {
      const ack = await call(`/api/sessions/${localId}/${route}`, "POST", {
        filename: name,
        data_b64: data.toString("base64"),
      });
      assert.equal(ack.status, 200);
      assert.equal(ack.data.ok, true);
      const attachment = ack.data.attachments.at(-1);
      assert.equal(attachment.filename, name);
      assert.equal(attachment.display_name, name);
      assert.equal(attachment.size, data.length);
      assert.ok(attachment.created_ts > 0);
      assert.deepEqual(await readFile(attachment.path), data);
      assert.ok(
        attachment.path.startsWith(join(home, "uploads", localId!) + "/"),
      );
    }
    const staged = await call(`/api/sessions/${localId}/attachments`);
    assert.equal(staged.data.attachments.length, 2);
    assert.equal(staged.data.attachments[0].filename, "browser-upload.txt");
    assert.equal(staged.data.attachments[1].filename, "browser-image.png");
    assert.equal(staged.data.attachments[1].kind, "image");
    assert.equal(staged.data.attachments[1].content_type, "image/png");
    const removed = await call(
      `/api/sessions/${localId}/attachments/delete`,
      "POST",
      { id: staged.data.attachments[0].id },
    );
    assert.equal(removed.status, 200);
    assert.equal(removed.data.attachments.length, 1);
    const state = await runtime.request(`/api/sessions/${localId}/state`);
    assert.equal(state.attachments[0].filename, "browser-image.png");
    assert.equal(state.attachments[0].size, png.length);
  } finally {
    if (localId)
      await runtime
        .request(`/api/sessions/${localId}/delete`, "POST", {})
        .catch(() => {});
    target.close();
    runtime.close();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
    if (control === undefined)
      delete process.env.CODOXEAR_NATIVE_CODEX_LIVE_CONTROL;
    else process.env.CODOXEAR_NATIVE_CODEX_LIVE_CONTROL = control;
    await rm(home, { recursive: true, force: true });
  }
});
