import { createAllowedComputer } from "../scripts/testing/authorized-fixtures.js";
import "../scripts/testing/frontend-artifact.js";
import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { z } from "zod";
import { resolveSchemaReferences } from "../scripts/openapi-schemas.js";
import { Store } from "../src/persistence/store.js";
import {
  createHub,
  passwordHash,
} from "../src/domain/commands.js";
import { independentAuthority } from "../src/hub/independent.js";
import { createHubApp } from "../src/hub/app.js";
import { HubSessions } from "../src/hub/sessions.js";
import { Tunnels } from "../src/protocol/tunnels.js";
import { createComputerApi } from "../src/computer/api.js";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { NativeHttpTarget } from "../src/computer/native/http.js";
import { relayContract } from "../src/protocol/inventory.js";
import { backendGateway } from "../scripts/backend-gateway.js";

assert.ok(
  existsSync("/.dockerenv"),
  "Protocol producer acceptance runs in Docker only",
);
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check: () => Promise<boolean> | boolean) {
  const deadline = Date.now() + 30000;
  while (!(await check())) {
    if (Date.now() > deadline) throw Error("Native protocol fixture timed out");
    await wait(50);
  }
}
const docs: Record<string, any> = {};
async function document(name: string) {
  return (docs[name] ??= resolveSchemaReferences(JSON.parse(
    await readFile(`protocol/${name}.openapi.json`, "utf8"),
  )));
}
const namespace = "/api/v1/computers/{computerId}";
function validate(schema: any, value: unknown, label: string) {
  assert.ok(
    schema && Object.keys(schema).length,
    label + " has a concrete schema",
  );
  const parsed = z.fromJSONSchema(schema).safeParse(value);
  assert.ok(
    parsed.success,
    label + ": " + (parsed.success ? "" : JSON.stringify(parsed.error.issues)),
  );
}

test("every established relay route publishes typed JSON, binary/document or SSE output with faithful method semantics", async () => {
  for (const name of ["hub", "identity", "internal", "relay"]) {
    const published = await document(name);
    for (const [path, methods] of Object.entries(published.paths)) {
      for (const [method, operation] of Object.entries(
        methods as Record<string, any>,
      )) {
        assert.notEqual(
          operation["x-schema-status"],
          "producer-specific response; no invented field schema",
          `${name} ${method} ${path} declares its output shape or transport`,
        );
        for (const [status, response] of Object.entries(
          operation.responses,
        ) as [string, any][]) {
          for (const [contentType, content] of Object.entries(
            response.content ?? {},
          ) as [string, any][]) {
            assert.ok(
              Object.keys(content.schema).length,
              `${name} ${method} ${path} ${status} ${contentType} has a concrete published schema`,
            );
            if (Number(status) >= 400)
              assert.equal(
                contentType,
                "application/json",
                "Static asset failures retain structured JSON errors",
              );
          }
        }
      }
    }
  }
  const dispatcher = (await document("internal")).paths["/internal/call"].post[
    "x-dispatch-operation-schemas"
  ];
  assert.equal(Object.keys(dispatcher).length, 24);
  for (const [op, value] of Object.entries(dispatcher) as [string, any][])
    assert.ok(
      Object.keys(value.args).length && Object.keys(value.response).length,
      `${op} publishes parsed args and unwrapped success`,
    );
  const spec = await document("relay");
  for (const endpoint of relayContract()) {
    const operation =
      spec.paths[namespace + endpoint.path][endpoint.method.toLowerCase()];
    assert.notEqual(
      operation["x-schema-status"],
      "producer-specific response; no invented field schema",
      endpoint.method + " " + endpoint.path,
    );
    if (endpoint.method === "HEAD")
      for (const response of Object.values(operation.responses) as any[])
        assert.equal(response.content, undefined, "HEAD has no body");
    else if (endpoint.events) {
      const response = operation.responses[200];
      assert.equal(response.content["text/event-stream"].schema.type, "string");
      assert.ok(Object.keys(response["x-sse-event-schemas"]).length);
    } else if (
      endpoint.contentType === "*/*" ||
      endpoint.contentType === "video/mp2t"
    ) {
      assert.equal(
        operation.responses[200].content[endpoint.contentType].schema.format,
        "binary",
      );
      assert.equal(
        operation.responses[304].content,
        undefined,
        "304 has no body",
      );
      assert.ok(operation.responses[206].headers["Content-Range"]);
      assert.ok(
        operation.responses[416].content["application/json"].schema,
        "416 permits structured syntax errors as well as empty range errors",
      );
    } else
      assert.ok(
        Object.keys(
          operation.responses[200].content[
            endpoint.contentType ?? "application/json"
          ].schema,
        ).length,
      );
  }
  const upload =
    spec.paths[namespace + "/api/sessions/{localId}/inject_file"].post
      .requestBody.content;
  assert.ok(
    upload["multipart/form-data"] && upload["application/json"],
    "upload supports actual binary form and JSON variants",
  );
  const limits = JSON.parse(await readFile("protocol/limits.json", "utf8"));
  assert.equal(limits.native.maxUploadFileBytes, 64 * 1024 * 1024);
  assert.equal(limits.native.maxFileWriteUtf8Bytes, 2 * 1024 * 1024);
});

test(
  "published native producer schemas validate actual installed Pi, independent Hub, workspace, queue, upload and streamed media responses",
  { timeout: 120000 },
  async () => {
    const home = await mkdtemp(join(tmpdir(), "protocol-native-")),
      workspace = join(home, "workspace"),
      nativeHome = join(home, "native"),
      computerHome = join(home, "computer");
    await mkdir(workspace);
    await mkdir(nativeHome);
    const origin = "http://127.0.0.1:19917",
      store = new Store(join(home, "hub.sqlite"));
    const created = store.change((s) => {
      s.users.push({
        id: "owner",
        email: "owner@protocol.invalid",
        name: "Owner",
        disabled: false,
        passwordHash: passwordHash("fixture-password"),
      });
      return createAllowedComputer(
        s,
        "owner",
        createHub(s, "owner", "Protocol Hub").id,
        "Protocol Computer",
        "owner",
      );
    });
    const local = await independentAuthority({
      origin,
      hubId: created.computer.hubId,
      store,
      otpKey: "protocol-fixture-otp".repeat(4),
      secureCookies: false,
    });
    const login = local.authority.accounts.password(
      "owner@protocol.invalid",
      "fixture-password",
      "schema-browser",
    );
    const bearer = await local.authority.tokens.issue(
      login.session,
      origin,
      "identity_access",
    );
    const sessions = new HubSessions(join(home, "sessions.sqlite")),
      tunnels = new Tunnels();
    const hub = await createHubApp({
      origin,
      authority: local.client,
      localIdentity: local.identity,
      sessions,
      tunnels,
      secureCookies: false,
    });
    await hub.listen({ host: "127.0.0.1", port: 19917 });
    const gateway = await backendGateway(0),
      api = createComputerApi(computerHome),
      runtime = new NativeRuntime(nativeHome, workspace, computerHome),
      target = new NativeHttpTarget(runtime, workspace);
    await api.attach({
      version: 1,
      hubUrl: origin,
      hubId: created.computer.hubId,
      computerId: created.computer.id,
      credential: created.credential,
      binding: 1,
      runtime: "native",
      workspacePath: workspace,
      nativeHome,
      nativeStateHome: computerHome,
    });
    const service = api.service(),
      observations: Array<{
        operation: string;
        method: string;
        status: number;
        transport: string;
      }> = [];
    let id: string | undefined,
      agentId: string | undefined,
      passed = false;
    const actual = (path: string) =>
      path
        .replace("{computerId}", created.computer.id)
        .replace("{localId}", id ?? "missing")
        .replace("{filename}", "a-0.ts")
        .replace(
          "{id}",
          path.startsWith("/api/agents/")
            ? (agentId ?? "missing")
            : created.computer.id,
        );
    async function request(
      path: string,
      method = "GET",
      body?: unknown,
      status = 200,
      headers: Record<string, string> = {},
    ) {
      const barePath = path.split("?")[0]!;
      const hubSpec = await document("hub");
      const spec = hubSpec.paths[barePath]?.[method.toLowerCase()]
        ? hubSpec
        : await document("relay");
      const documented = spec.paths[barePath]?.[method.toLowerCase()];
      assert.ok(documented, method + " " + path + " is published");
      if (body !== undefined && !(body instanceof FormData))
        validate(
          documented.requestBody.content["application/json"].schema,
          body,
          "request " + method + " " + path,
        );
      const response = await fetch(origin + actual(path), {
        method,
        headers: {
          authorization: "Bearer " + bearer,
          ...(body !== undefined && !(body instanceof FormData)
            ? { "content-type": "application/json" }
            : {}),
          ...headers,
        },
        ...(body !== undefined
          ? { body: body instanceof FormData ? body : JSON.stringify(body) }
          : {}),
        signal: AbortSignal.timeout(30000),
      });
      assert.equal(
        response.status,
        status,
        method +
          " " +
          path +
          " " +
          (await (response.status !== status
            ? response.text()
            : Promise.resolve(""))),
      );
      assert.ok(documented.responses[status], "actual status is documented");
      const bytes = Buffer.from(await response.arrayBuffer());
      const contentType = response.headers.get("content-type") ?? "";
      let data: any;
      if (method === "HEAD" || status === 304) {
        assert.equal(bytes.length, 0);
        assert.equal(documented.responses[status].content, undefined);
      } else if (bytes.length && contentType.includes("application/json")) {
        data = JSON.parse(bytes.toString());
        validate(
          documented.responses[status].content["application/json"].schema,
          data,
          "response " + method + " " + path,
        );
      } else if (bytes.length) {
        const schema = Object.values(
          documented.responses[status].content ?? {},
        )[0] as any;
        validate(schema?.schema, bytes.toString(), "stream " + path);
      }
      observations.push({
        operation: path.split("?")[0]!,
        method,
        status,
        transport: "Computer → independent Hub → HTTP client",
      });
      return { response, bytes, data };
    }
    const session = (action: string) =>
      namespace + "/api/sessions/{localId}/" + action;
    async function rejectedRequest(path: string, body: unknown) {
      const operation = (await document("relay")).paths[path].post;
      assert.equal(
        z
          .fromJSONSchema(
            operation.requestBody.content["application/json"].schema,
          )
          .safeParse(body).success,
        false,
        "published schema rejects malformed input",
      );
      const response = await fetch(origin + actual(path), {
        method: "POST",
        headers: {
          authorization: "Bearer " + bearer,
          "content-type": "application/json",
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(10000),
      });
      assert.equal(response.status, 400);
      validate(
        operation.responses[400].content["application/json"].schema,
        await response.json(),
        "actual malformed-input error",
      );
      observations.push({
        operation: path,
        method: "POST",
        status: 400,
        transport: "Schema + Computer/Hub rejection",
      });
    }
    async function stream(
      path: string,
      eventName: string,
      component = "relay",
    ) {
      const controller = new AbortController(),
        timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetch(origin + actual(path), {
          headers: { authorization: "Bearer " + bearer },
          signal: controller.signal,
        });
        assert.equal(response.status, 200);
        assert.ok(
          response.headers.get("content-type")?.startsWith("text/event-stream"),
        );
        const reader = response.body!.getReader();
        let text = "";
        while (!text.includes("event: " + eventName + "\n")) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          text += Buffer.from(chunk.value!).toString();
        }
        while (
          !text
            .slice(text.indexOf("event: " + eventName + "\n"))
            .includes("\n\n")
        ) {
          const chunk = await reader.read();
          assert.equal(chunk.done, false);
          text += Buffer.from(chunk.value!).toString();
        }
        const frame = text
          .slice(text.indexOf("event: " + eventName + "\n"))
          .split("\n\n")[0]!;
        const value = JSON.parse(
          frame
            .split("\n")
            .find((row) => row.startsWith("data: "))!
            .slice(6),
        );
        const spec = await document(component);
        validate(
          spec.paths[path].get.responses[200]["x-sse-event-schemas"][eventName],
          value,
          "SSE " + eventName,
        );
        observations.push({
          operation: path,
          method: "GET",
          status: 200,
          transport: "SSE " + eventName,
        });
        await reader.cancel();
        return value;
      } finally {
        controller.abort();
        clearTimeout(timeout);
      }
    }
    try {
      process.env.PI_BIN ??= existsSync("/opt/codoxear-tools/node/bin/pi")
        ? "/opt/codoxear-tools/node/bin/pi"
        : "pi";
      await service.start();
      await until(() =>
        tunnels.supports(created.computer.id, "workspace-capabilities-v2"),
      );
      await request(namespace + "/api/sessions");
      const launch = await request(namespace + "/api/sessions", "POST", {
        agent_backend: "pi",
        name: "Protocol native Pi",
        cwd: workspace,
        model: "PrivateModel",
        reasoning_effort: "off",
        provider_config: {
          base_url: gateway.origin + "/v1",
          api_key: "fixture-private-key",
          api: "openai-completions",
        },
      });
      id = launch.data.session_id;
      agentId = launch.data.agent_id;
      await until(
        async () =>
          (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
          "ready",
      );
      await request(namespace + "/api/sessions");
      await request("/api/agent-directory");
      await request("/api/computers/{id}/agents");
      await request("/api/agents/{id}/access");
      await request("/api/agents/{id}/reconcile", "POST");
      await request("/api/agents/{id}/messages");
      await request("/workspace/api/me");
      const browserCatalog = await request("/workspace/api/sessions");
      assert.equal(browserCatalog.data.sessions[0].session_id, agentId);
      await request(namespace + "/api/notifications/harmony");
      await request("/api/computers/{id}/discovered");
      await request("/api/computers/{id}/launch-defaults");
      await request("/api/computers/{id}/workspace");
      await request("/api/computers/{id}/workspace", "PUT", {
        id: "default",
        name: "Protocol roots",
        path: workspace,
      });
      await request(
        "/api/computers/{id}/resume-candidates?backend=pi&cwd=" +
          encodeURIComponent(workspace),
      );
      for (const action of [
        "tail",
        "diagnostics",
        "unread",
        "draft",
        "attachments",
        "unattended",
      ])
        await request(session(action));
      await request(session("draft"), "POST", {
        text: "Private unsent protocol draft",
      });
      await request(session("draft"));
      await rejectedRequest(session("draft"), { text: 42 });
      await rejectedRequest(namespace + "/api/settings/voice", {
        tts_enabled_for_final_response: "yes",
      });
      await rejectedRequest(session("queue/update"), {
        id: "missing",
        text: "test",
        version: -1,
      });
      await request(session("edit"), "POST", {
        name: "Protocol native Pi renamed",
        priority_offset: 0.1,
        snooze_until: null,
        dependency_session_id: null,
      });
      await request(session("rename"), "POST", { name: "Protocol native Pi" });
      await request(session("unattended"), "POST", {
        enabled: false,
        request: "Protocol unattended",
        cooldown_minutes: 2,
        remaining_injections: 3,
      });
      await runtime.queueControl(id!, "enqueue", {
        id: "local-unknown",
        text: "Never dispatch uncertain protocol fixture",
        commit_unknown: true,
      });
      await request(session("queue"));
      const enqueued = await request(session("enqueue"), "POST", {
        text: "Editable remote protocol prompt",
      });
      const item = enqueued.data.items.find(
        (row: any) => row.origin === "remote",
      );
      assert.ok(item);
      const changed = await request(session("queue/update"), "POST", {
        id: item.id,
        text: "Updated protocol prompt",
        version: item.version,
      });
      await request(
        session("queue/move"),
        "POST",
        {
          id: item.id,
          to_index: 1,
          version: changed.data.items.find((row: any) => row.id === item.id)
            .version,
        },
        409,
      );
      await request(session("queue/delete"), "POST", {
        id: item.id,
        version: changed.data.items.find((row: any) => row.id === item.id)
          .version,
      });
      await runtime.queueControl(id!, "queue/delete", {
        id: "local-unknown",
        allow_commit_unknown: true,
      });
      gateway.holdNext("/chat/completions", "Protocol busy queue editing");
      await request(session("send"), "POST", {
        text: "Protocol busy queue editing",
      });
      await until(
        async () =>
          gateway.requests.some((row) => row.held) &&
          (await runtime.request(`/api/sessions/${id}/state`)).busy,
      );
      const pending = await request(session("enqueue"), "POST", {
        text: "Pending protocol queue move",
      });
      const pendingItem = pending.data.items[0];
      const reordered = await request(session("queue/move"), "POST", {
        id: pendingItem.id,
        to_index: 0,
        version: pendingItem.version,
      });
      await request(session("queue/delete"), "POST", {
        id: pendingItem.id,
        version: reordered.data.items[0].version,
      });
      await request(session("interrupt"), "POST", {});
      await until(
        async () => !(await runtime.request(`/api/sessions/${id}/state`)).busy,
      );
      await writeFile(join(workspace, "file.txt"), "native schema original\n");
      const png = Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aVfQAAAAASUVORK5CYII=",
        "base64",
      );
      await writeFile(join(workspace, "image.png"), png);
      await writeFile(join(workspace, "binary.dat"), Buffer.from([0, 1, 2]));
      await request(session("file/list"));
      await request(session("file/search?q=file"));
      const read = await request(session("file/read?path=file.txt"));
      await request(session("file/inspect"), "POST", { path: "file.txt" });
      await request(session("file/inspect-batch"), "POST", {
        paths: ["file.txt", "missing.txt", "binary.dat"],
      });
      await request(session("file/write"), "POST", {
        path: "file.txt",
        text: "native schema saved\n",
        version: read.data.version,
      });
      await request(session("file/read?path=binary.dat"));
      await request(session("file/read?path=image.png"));
      await request(session("file/image-dimensions?path=image.png"));
      const binary = await request(session("file/blob?path=image.png"));
      assert.deepEqual(binary.bytes, png);
      await request(
        session("file/blob?path=image.png"),
        "GET",
        undefined,
        206,
        { range: "bytes=0-7" },
      );
      await request(session("file/blob?path=image.png"), "HEAD");
      await request(
        session("file/blob?path=image.png"),
        "GET",
        undefined,
        304,
        { "if-none-match": binary.response.headers.get("etag")! },
      );
      await request(
        session("file/blob?path=image.png"),
        "GET",
        undefined,
        416,
        { range: "bytes=99999-" },
      );
      await request(
        session("file/blob?path=image.png"),
        "GET",
        undefined,
        416,
        { range: "garbage" },
      );
      await request(session("file/download?path=binary.dat"));
      const ffmpeg = process.env.FFMPEG_BIN ?? "ffmpeg";
      execFileSync(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "color=c=red:s=16x16:d=0.2",
        "-c:v",
        "libx264",
        "-pix_fmt",
        "yuv420p",
        "-y",
        join(workspace, "clip.mp4"),
      ]);
      await request(session("file/read?path=clip.mp4"));
      const preview = await request(
        session("file/video_preview?path=clip.mp4"),
      );
      assert.equal(preview.response.headers.get("content-type"), "video/mp4");
      assert.ok(preview.bytes.length);
      await mkdir(join(computerHome, "audio"), { recursive: true });
      execFileSync(ffmpeg, [
        "-hide_banner",
        "-loglevel",
        "error",
        "-f",
        "lavfi",
        "-i",
        "sine=frequency=440:duration=0.2",
        "-c:a",
        "aac",
        "-f",
        "mpegts",
        "-y",
        join(computerHome, "audio", "a-0.ts"),
      ]);
      const segment = await request(
        namespace + "/api/audio/segments/{filename}",
      );
      assert.equal(segment.response.headers.get("content-type"), "video/mp2t");
      assert.ok(segment.bytes.length);
      await request(namespace + "/api/audio/segments/{filename}", "HEAD");
      await request(
        session("file/read?path=missing.txt"),
        "GET",
        undefined,
        404,
      );
      await request(
        session("file/write"),
        "POST",
        { path: "file.txt", text: "stale", version: read.data.version },
        409,
      );
      execFileSync("git", ["init", "-q", workspace]);
      execFileSync("git", ["-C", workspace, "add", "file.txt"]);
      execFileSync("git", [
        "-C",
        workspace,
        "-c",
        "user.name=Fixture",
        "-c",
        "user.email=fixture@protocol.invalid",
        "commit",
        "-qm",
        "fixture",
      ]);
      await writeFile(join(workspace, "file.txt"), "changed native schema\n");
      await request(session("git/changed_files"));
      await request(session("git/diff?path=file.txt"));
      await request(session("git/file_versions?path=file.txt"));
      await request(session("inject_file"), "POST", {
        filename: "schema.txt",
        data_b64: Buffer.from("attachment schema bytes").toString("base64"),
      });
      const form = new FormData();
      form.set("image", new Blob([png], { type: "image/png" }), "schema.png");
      const injected = await request(session("inject_image"), "POST", form);
      assert.equal(injected.data.attachments.length, 2);
      await request(session("attachments/delete"), "POST", {
        id: injected.data.attachments[0].id,
      });
      await request(session("pending_attachment/clear"), "POST", {});
      await request(session("attachments/clear"), "POST", {});
      await request(session("send"), "POST", {
        text: "Protocol schema representative completion",
      });
      await until(async () =>
        (
          await runtime.request(`/api/sessions/${id}/messages/tail`)
        ).events.some((event: any) =>
          event.text.includes("PRIVATE_PROVIDER_OK"),
        ),
      );
      for (const action of [
        "messages/tail",
        "messages/history",
        "messages/window?cursor=" + id + ":0",
        "messages/export",
        "search?q=PRIVATE_PROVIDER_OK",
        "unread",
      ])
        await request(session(action));
      const transcript = await request(session("messages/tail"));
      await request(session("read"), "POST", {
        event_id: transcript.data.events.at(-1).message_id,
      });
      await stream(session("live"), "message");
      await stream(session("messages/live"), "message");
      await stream("/api/agents/{id}/live", "snapshot", "hub");
      const feed = await request(namespace + "/api/notifications/feed?since=0");
      assert.ok(feed.data.items.length);
      assert.equal(
        feed.data.items[0].session_display_name,
        "Protocol native Pi",
      );
      const nativeFeed = await target.execute({
        method: "GET",
        path: "/api/notifications/feed",
        headers: {},
        body: (async function* () {})(),
        signal: new AbortController().signal,
      });
      const chunks: Buffer[] = [];
      for await (const chunk of nativeFeed.body)
        chunks.push(Buffer.from(chunk));
      const nativeData = JSON.parse(Buffer.concat(chunks).toString());
      validate(
        (await document("relay")).paths[namespace + "/api/notifications/feed"]
          .get.responses[200].content["application/json"].schema,
        nativeData,
        "direct Computer nonempty notification feed",
      );
      for (const action of ["text", "state"])
        await request(
          namespace +
            "/api/notifications/" +
            action +
            "?message_id=" +
            feed.data.items[0].message_id,
        );
      for (const path of [
        "/api/settings/voice",
        "/api/settings/unattended-prompt",
      ])
        await request(namespace + path);
      await request(namespace + "/api/settings/voice", "POST", {
        tts_enabled_for_final_response: false,
        tts_api_key: "fixture-tts-key",
      });
      await request(namespace + "/api/settings/unattended-prompt", "POST", {
        prompt: "Protocol custom unattended prompt",
      });
      await request(namespace + "/api/audio/listener", "POST", {
        client_id: "protocol-listener",
        enabled: true,
      });
      const hls = await request(namespace + "/api/audio/live.m3u8");
      assert.ok(hls.bytes.toString().startsWith("#EXTM3U"));
      await request(namespace + "/api/audio/listener", "POST", {
        client_id: "protocol-listener",
        enabled: false,
      });
      await request(
        namespace + "/api/cwd-suggest?path=" + encodeURIComponent(workspace),
      );
      await request(
        namespace +
          "/api/session_resume_candidates?agent_backend=pi&cwd=" +
          encodeURIComponent(workspace),
      );
      gateway.holdNext("/chat/completions", "Protocol held interrupt");
      await request(session("send"), "POST", {
        text: "Protocol held interrupt",
      });
      await until(() => gateway.requests.some((row) => row.held));
      await request(session("interrupt"), "POST", {});
      await request(session("commit_unknown_send/clear"), "POST", {});
      passed = true;
    } finally {
      await mkdir("artifacts", { recursive: true });
      await writeFile(
        "artifacts/protocol-native-conformance-results.json",
        JSON.stringify(
          {
            passed,
            engine: "installed Pi 1.0.0 native PTY",
            schemaSource: "standalone protocol/*.openapi.json",
            observations,
            limits: [
              "Backend usage and child telemetry allow documented producer extensions.",
              "One representative native backend; no claim of exhaustive external CLI/provider variants.",
              "Media acceptance validates an actual FFmpeg video preview, MPEG-TS segment streaming and the HLS document; live TTS synthesis has separate native-media acceptance.",
            ],
          },
          null,
          2,
        ),
      );
      await service.stop();
      target.close();
      if (id)
        await runtime
          .request(`/api/sessions/${id}/delete`, "POST", {})
          .catch(() => {});
      runtime.close();
      tunnels.close();
      await hub.close();
      await local.identity.close();
      sessions.close();
      store.close();
      await gateway.close();
      await rm(home, { recursive: true, force: true });
    }
  },
);
