import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connect } from "node:net";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import {
  backendCommand,
  startupState,
} from "../src/computer/native/backend.js";
import { readTranscript } from "../src/computer/native/logs.js";
import { socketPath } from "../src/computer/native/paths.js";
import type { BrokerLaunch } from "../src/computer/native/types.js";
process.env.CODOXEAR_NATIVE_CODEX_LIVE_CONTROL = "0";
assert.ok(
  existsSync("/.dockerenv"),
  "Native runtime behavior must be tested in Docker",
);
async function until<T>(
  fn: () => Promise<T | false>,
  timeout = 15000,
): Promise<T> {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    const result = await fn();
    if (result !== false) return result;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw Error("Condition timed out");
}
async function fixture() {
  const home = await mkdtemp(join(tmpdir(), "native-runtime-")),
    workspace = join(home, "workspace");
  await mkdir(workspace);
  const command = join(home, "fake-codex");
  await writeFile(
    command,
    `#!${process.execPath}
const fs=require('fs'),path=require('path');
const home=process.env.HOME,cwd=process.cwd();
const resume=process.argv.indexOf('resume');const id=resume<0?'native-'+process.pid:process.argv[resume+1];
const dir=path.join(home,'.codex','sessions');fs.mkdirSync(dir,{recursive:true});const log=path.join(dir,id+'.jsonl');
const fd=fs.openSync(log,'a');function row(type,payload){fs.writeSync(fd,JSON.stringify({type,payload,timestamp:new Date().toISOString()})+'\\n');}
if(fs.statSync(log).size===0)row('session_meta',{id,cwd});
process.stdout.write('100% context left ? for shortcuts\\n');if(process.stdin.isTTY)process.stdin.setRawMode(true);
let buffer='';process.stdin.on('data',data=>{buffer+=data.toString().replace(/\\x1b\\[(?:200|201)~/g,'');if(buffer.includes('\\x03')){buffer='';return;}if(!buffer.includes('\\r'))return;const text=buffer.split('\\r')[0];buffer='';row('event_msg',{type:'user_message',message:text});setTimeout(()=>{row('response_item',{type:'message',role:'assistant',phase:'final_answer',content:[{type:'output_text',text:'Native reply: '+text}]});row('event_msg',{type:'task_complete'});process.stdout.write('100% context left ? for shortcuts\\n');},80);});
`,
    { mode: 0o755 },
  );
  return { home, workspace, command };
}
test("native unattended waits for final-turn idle cooldown and injects an optional-request prompt once", async () => {
  const f = await fixture(),
    prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = f.command;
  const runtime = new NativeRuntime(f.home, f.workspace);
  let id: string | undefined;
  try {
    id = (
      (await runtime.execute({
        op: "create",
        agentId: "unattended-agent",
        backend: "codex",
        name: "Idle task",
        launch: {},
      })) as any
    ).localId;
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
          "ready" || false,
    );
    await runtime.request(`/api/sessions/${id}/unattended`, "POST", {
      enabled: true,
      remaining_injections: 1,
      cooldown_minutes: 1,
    });
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(
      (await runtime.request(`/api/sessions/${id}/messages/tail`)).events
        .length,
      0,
    );
    await runtime.request(`/api/sessions/${id}/send`, "POST", {
      text: "First user turn",
    });
    await until(
      async () =>
        (
          await runtime.request(`/api/sessions/${id}/messages/tail`)
        ).events.some((event: any) => event.role === "assistant") || false,
    );
    await new Promise((resolve) => setTimeout(resolve, 700));
    assert.equal(
      (await runtime.request(`/api/sessions/${id}/unattended`))
        .remaining_injections,
      1,
    );
    const state = await runtime.request(`/api/sessions/${id}/state`);
    // Age actual backend events to cross the one-minute idle boundary without
    // introducing a production timing override.
    const rows = readFileSync(state.log_path, "utf8")
      .trim()
      .split("\n")
      .map((line) => ({
        ...JSON.parse(line),
        timestamp: new Date(Date.now() - 120000).toISOString(),
      }));
    await writeFile(
      state.log_path,
      rows.map((row) => JSON.stringify(row)).join("\n") + "\n",
    );
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/unattended`))
          .remaining_injections === 0 || false,
    );
    const config = await runtime.request(`/api/sessions/${id}/unattended`);
    assert.equal(config.enabled, false);
    await until(
      async () =>
        (
          await runtime.request(`/api/sessions/${id}/messages/tail`)
        ).events.some(
          (event: any) =>
            event.role === "user" &&
            event.text.includes("Unattended-mode operating constitution"),
        ) || false,
    );
  } finally {
    if (id)
      await runtime.request(`/api/sessions/${id}`, "DELETE").catch(() => {});
    runtime.close();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
  }
});

test("detached native PTY survives runtime close/reopen, sends once and resumes native history", async () => {
  const f = await fixture();
  const prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = f.command;
  let runtime = new NativeRuntime(f.home, f.workspace),
    id: string | undefined,
    resumed: string | undefined;
  try {
    const launch = (await runtime.execute({
      op: "create",
      agentId: "account-agent",
      backend: "codex",
      name: "Native task",
      launch: {
        cwd: f.workspace,
        model: "PrivateModel",
        provider_config: {
          base_url: "http://private.test/v1",
          api_key: "private-secret",
        },
      },
    })) as any;
    id = launch.localId;
    assert.match(id!, /^broker-[a-f0-9]{32}$/);
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
          "ready" || false,
    );
    const state = await runtime.request(`/api/sessions/${id}/state`);
    assert.equal(state.broker_pid, launch.brokerPid);
    assert.ok(state.pid > 0);
    await runtime.request(`/api/sessions/${id}/send`, "POST", {
      text: "first turn",
      request_id: "once",
    });
    await runtime.request(`/api/sessions/${id}/send`, "POST", {
      text: "first turn",
      request_id: "once",
    });
    await until(async () => {
      const result = (await runtime.execute({
        op: "messages",
        agentId: "account-agent",
        localId: id!,
      })) as any;
      return result.messages.some(
        (m: any) => m.text === "Native reply: first turn",
      )
        ? result
        : false;
    });
    const transcript = (await runtime.execute({
      op: "messages",
      agentId: "account-agent",
      localId: id!,
    })) as any;
    assert.equal(
      transcript.messages.filter((m: any) => m.role === "user").length,
      1,
    );
    runtime.close();
    runtime = new NativeRuntime(f.home, f.workspace);
    const after = await runtime.request("/api/sessions");
    assert.equal(after.sessions[0].broker_pid, launch.brokerPid);
    const persisted = readFileSync(
      join(runtime.directory, id + ".json"),
      "utf8",
    );
    assert.equal(
      JSON.stringify(JSON.parse(persisted)).includes("private-secret"),
      false,
    );
    assert.equal(persisted.includes("provider_config"), false);
    const candidates = (await runtime.execute({
      op: "resume-candidates",
      backend: "codex",
      cwd: f.workspace,
    })) as any;
    assert.equal(candidates.sessions.length, 1);
    const nativeId = candidates.sessions[0].session_id;
    await assert.rejects(
      runtime.execute({
        op: "create",
        agentId: "other",
        backend: "codex",
        name: "Duplicate",
        launch: { cwd: f.workspace, resume_session_id: nativeId },
      }),
      /already running/,
    );
    await runtime.request(`/api/sessions/${id}/delete`, "POST", {});
    await until(
      async () => !existsSync(socketPath(runtime.stateHome, id!)) || false,
    );
    id = undefined;
    const resumedLaunch = (await runtime.execute({
      op: "create",
      agentId: "new-agent",
      backend: "codex",
      name: "Resumed",
      launch: { cwd: f.workspace, resume_session_id: nativeId },
    })) as any;
    resumed = resumedLaunch.localId;
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${resumed}/state`)).readiness ===
          "ready" || false,
    );
    const old = await runtime.request(`/api/sessions/${resumed}/messages/tail`);
    assert.ok(
      old.events.some((e: any) => e.text === "Native reply: first turn"),
    );
    await runtime.execute({
      op: "send",
      agentId: "new-agent",
      localId: resumed!,
      text: "second turn",
    });
    await until(async () => {
      const data = await runtime.request(
        `/api/sessions/${resumed}/messages/tail`,
      );
      return (
        data.events.some((e: any) => e.text === "Native reply: second turn") ||
        false
      );
    });
    const notifications = await runtime.completions(0);
    assert.ok(notifications.some((n) => n.localId === resumed));
    await assert.rejects(
      runtime.request("/api/sessions/123/state"),
      /Unsupported native/,
    );
  } finally {
    for (const session of [id, resumed])
      if (session)
        await runtime
          .request(`/api/sessions/${session}/delete`, "POST", {})
          .catch(() => {});
    runtime.close();
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
  }
});
test("native launch rejects invalid paths/resume and reserved environment before dispatch", async () => {
  const f = await fixture(),
    runtime = new NativeRuntime(f.home, f.workspace);
  try {
    for (const launch of [
      { cwd: "relative" },
      { cwd: "/missing/native/workspace" },
      { resume_session_id: "missing" },
      { env_vars: { HOME: "/elsewhere" } },
    ])
      await assert.rejects(
        runtime.execute({
          op: "create",
          agentId: "agent",
          backend: "codex",
          name: "Invalid",
          launch,
        }),
      );
    assert.deepEqual(readdirSync(runtime.directory), []);
  } finally {
    runtime.close();
  }
});
test("provider routing is child-local and Claude setup fails before dispatch", async () => {
  const f = await fixture();
  const input: BrokerLaunch = {
    home: f.home,
    cwd: f.workspace,
    backend: "codex",
    sessionId: "broker-" + "a".repeat(32),
    name: "Private",
    launch: {
      model: "PrivateModel",
      provider_config: {
        base_url: "https://gateway.test/v1",
        api_key: "private-key",
      },
    },
  };
  const plan = backendCommand(input);
  assert.equal(plan.env.CODOXEAR_PROVIDER_API_KEY, "private-key");
  assert.equal(
    plan.args.some((arg) => arg.includes("private-key")),
    false,
  );
  assert.ok(plan.args.includes('model_provider="codoxear_private"'));
  assert.throws(
    () =>
      backendCommand({
        ...input,
        launch: { ...input.launch, env_vars: { CODOXEAR_RESERVED: "bad" } },
      }),
    /cannot be overridden/,
  );
  assert.throws(
    () => backendCommand({ ...input, backend: "cc" }),
    /Claude Code setup required/,
  );
  await mkdir(join(f.home, ".claude"));
  const configPath = join(f.home, ".claude", ".claude.json");
  await writeFile(
    configPath,
    JSON.stringify({
      hasCompletedOnboarding: true,
      projects: { [f.workspace]: { hasTrustDialogAccepted: true } },
      customApiKeyResponses: { approved: ["private-key"] },
      bypassPermissionsModeAccepted: true,
    }),
  );
  const claude = backendCommand({ ...input, backend: "cc" });
  assert.equal(claude.env.ANTHROPIC_API_KEY, "private-key");
  assert.ok(claude.args.includes("--setting-sources"));
  assert.ok(claude.args.includes("project,local"));
  assert.throws(
    () =>
      backendCommand({
        ...input,
        backend: "cc",
        launch: {
          ...input.launch,
          provider_config: {
            base_url: "https://gateway.test",
            api_key: "different",
          },
        },
      }),
    /API key confirmation/,
  );
  assert.equal(
    startupState("cc", "\x1b[1mYes, I trust this folder").ready,
    false,
  );
  assert.match(
    startupState("cc", "Yes, I trust this folder").message!,
    /not sent/,
  );
  assert.equal(startupState("cc", "shift+tab to cycle").ready, true);
});
test("native transcript parser preserves tools/narration and final completion distinction", async () => {
  const f = await fixture(),
    log = join(f.home, "pi.jsonl");
  await writeFile(
    log,
    [
      { type: "session", id: "pi-id", cwd: f.workspace },
      {
        type: "message",
        timestamp: "2026-10-05T12:00:00Z",
        message: {
          role: "user",
          content: [{ type: "text", text: "Question" }],
        },
      },
      {
        type: "message",
        timestamp: "2026-10-05T12:00:01Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Checking" }],
          stopReason: "toolUse",
        },
      },
      {
        type: "message",
        timestamp: "2026-10-05T12:00:02Z",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Answer" }],
          stopReason: "stop",
          usage: { totalTokens: 12 },
        },
      },
    ]
      .map((row) => JSON.stringify(row))
      .join("\n"),
  );
  const transcript = readTranscript(log, "pi");
  assert.equal(transcript.busy, false);
  assert.deepEqual(
    transcript.events.map((e) => e.message_class),
    [undefined, "narration", "final_response"],
  );
  assert.equal(transcript.token.used, 12);
});

test("two PTYs in the same directory bind only their own descriptors and live cursors do not replay", async () => {
  const f = await fixture(),
    runtime = new NativeRuntime(f.home, f.workspace),
    prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = f.command;
  const ids: string[] = [];
  try {
    for (const name of ["First", "Second"]) {
      const result = (await runtime.execute({
        op: "create",
        agentId: name,
        backend: "codex",
        name,
      })) as any;
      ids.push(result.localId);
    }
    await until(async () => {
      const rows = (await runtime.request("/api/sessions")).sessions;
      return rows.length === 2 &&
        rows.every((row: any) => row.log_path && row.readiness === "ready")
        ? rows
        : false;
    });
    const rows = (await runtime.request("/api/sessions")).sessions;
    assert.notEqual(rows[0].thread_id, rows[1].thread_id);
    assert.notEqual(rows[0].log_path, rows[1].log_path);
    await runtime.request(`/api/sessions/${ids[0]}/send`, "POST", {
      text: "same text",
    });
    await until(async () => {
      const tail = await runtime.request(
        `/api/sessions/${ids[0]}/messages/tail`,
      );
      return tail.events.some((e: any) => e.role === "assistant")
        ? tail
        : false;
    });
    const first = await runtime.request(
      `/api/sessions/${ids[0]}/messages/tail`,
    );
    const second = await runtime.request(
      `/api/sessions/${ids[1]}/messages/tail`,
    );
    assert.equal(second.events.length, 0);
    const delta = await runtime.request(
      `/api/sessions/${ids[0]}/messages/live?after=${encodeURIComponent(first.live_cursor)}`,
    );
    assert.deepEqual(delta.events, []);
    assert.equal(
      (await runtime.request(`/api/sessions/${ids[0]}/unread`)).count,
      0,
    );
    await runtime.request(`/api/sessions/${ids[0]}/send`, "POST", {
      text: "same text",
    });
    await until(async () => {
      const tail = await runtime.request(
        `/api/sessions/${ids[0]}/messages/tail`,
      );
      return tail.events.filter((e: any) => e.role === "user").length === 2 &&
        tail.events.filter((e: any) => e.role === "assistant").length === 2
        ? tail
        : false;
    });
    const repeated = await runtime.request(
      `/api/sessions/${ids[0]}/messages/live?after=${encodeURIComponent(first.live_cursor)}`,
    );
    assert.equal(
      repeated.events.filter((e: any) => e.role === "user").length,
      1,
    );
    const unread = await runtime.request(`/api/sessions/${ids[0]}/unread`);
    assert.equal(unread.count, 2);
    await runtime.request(`/api/sessions/${ids[0]}/read`, "POST", {
      event_id: unread.last_unread_event_id,
    });
    assert.equal(
      (await runtime.request(`/api/sessions/${ids[0]}/unread`)).count,
      0,
    );
    const search = await runtime.request(
      `/api/sessions/${ids[0]}/search?q=same&limit=1`,
    );
    assert.equal(search.total, 4);
    assert.match(search.matches[0].before_byte, /^broker-/);
    const window = await runtime.request(
      `/api/sessions/${ids[0]}/messages/window?cursor=${search.matches[0].before_byte}&before=1&after=1`,
    );
    assert.equal(window.jumped_window, true);
    assert.ok(window.events.some((e: any) => e.text === "same text"));
  } finally {
    for (const id of ids)
      await runtime
        .request(`/api/sessions/${id}/delete`, "POST", {})
        .catch(() => {});
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
  }
});

test("long Computer state paths use private sockets and terminal attach/detach leaves PTY alive", async () => {
  const f = await fixture(),
    stateHome = join(
      f.home,
      ".local/share/codoxear-v2/computer",
      "deep".repeat(30),
    ),
    runtime = new NativeRuntime(f.home, f.workspace, stateHome),
    prior = process.env.CODEX_BIN;
  process.env.CODEX_BIN = f.command;
  let id: string | undefined;
  try {
    const launch = (await runtime.createTerminal("codex", "Terminal task", {
      cwd: f.workspace,
    })) as any;
    id = launch.localId;
    const path = socketPath(stateHome, id!);
    assert.ok(Buffer.byteLength(path) < 104);
    assert.equal(
      statSync(path.slice(0, path.lastIndexOf("/"))).mode & 0o777,
      0o700,
    );
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
          "ready" || false,
    );
    const socket = connect(path);
    await new Promise<void>((resolve, reject) => {
      socket.once("connect", resolve);
      socket.once("error", reject);
    });
    socket.write(JSON.stringify({ operation: "attach" }) + "\n");
    const output: string[] = [];
    socket.setEncoding("utf8");
    socket.on("data", (chunk) => output.push(String(chunk)));
    socket.write(
      JSON.stringify({ type: "input", data: "terminal turn\r" }) + "\n",
    );
    await until(async () => {
      const messages = await runtime.request(
        `/api/sessions/${id}/messages/tail`,
      );
      return (
        messages.events.some(
          (e: any) => e.text === "Native reply: terminal turn",
        ) || false
      );
    });
    assert.ok(output.length > 0);
    socket.end();
    await new Promise((resolve) => socket.once("close", resolve));
    assert.equal(
      (await runtime.request(`/api/sessions/${id}/state`)).pid > 0,
      true,
    );
    const reconnect = connect(path);
    await new Promise<void>((resolve, reject) => {
      reconnect.once("connect", resolve);
      reconnect.once("error", reject);
    });
    reconnect.write(JSON.stringify({ operation: "attach" }) + "\n");
    reconnect.resume();
    const ended = new Promise((resolve) => reconnect.once("end", resolve));
    await runtime.request(`/api/sessions/${id}/delete`, "POST", {});
    await ended;
    id = undefined;
  } finally {
    if (id)
      await runtime
        .request(`/api/sessions/${id}/delete`, "POST", {})
        .catch(() => {});
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
  }
});

test("Claude binds its predetermined session UUID after native log file descriptors close", async () => {
  const f = await fixture(),
    prior = process.env.CLAUDE_BIN;
  const command = join(f.home, "fake-claude");
  await writeFile(
    command,
    `#!${process.execPath}
const fs=require('fs'),path=require('path');
const id=process.argv[process.argv.indexOf('--session-id')+1],cwd=process.cwd();
const directory=path.join(process.env.CLAUDE_CONFIG_DIR||path.join(process.env.HOME,'.claude'),'projects','fixture');fs.mkdirSync(directory,{recursive:true});
process.stdout.write('? for shortcuts\\n');
process.stdin.on('data',()=>{const file=path.join(directory,id+'.jsonl');fs.appendFileSync(file,JSON.stringify({type:'assistant',sessionId:id,cwd,timestamp:new Date().toISOString(),message:{role:'assistant',content:[{type:'text',text:'Closed descriptor response'}],stop_reason:'end_turn'}})+'\\n');});
`,
    { mode: 0o755 },
  );
  process.env.CLAUDE_BIN = command;
  const runtime = new NativeRuntime(f.home, f.workspace);
  let id: string | undefined;
  try {
    const created = await runtime.createTerminal("cc", "Closed log fixture", {
      cwd: f.workspace,
    });
    id = created.localId;
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
        "ready",
    );
    await runtime.request(`/api/sessions/${id}/send`, "POST", {
      text: "response",
    });
    const bound = await until(async () => {
      const tail = await runtime.request(`/api/sessions/${id}/messages/tail`);
      return tail.events.some(
        (e: any) => e.text === "Closed descriptor response",
      )
        ? tail
        : false;
    });
    assert.equal(bound.transcript_state, "bound");
    assert.match(bound.thread_id, /^[a-f0-9]{8}-/);
  } finally {
    if (id)
      await runtime
        .request(`/api/sessions/${id}/delete`, "POST")
        .catch(() => {});
    if (prior === undefined) delete process.env.CLAUDE_BIN;
    else process.env.CLAUDE_BIN = prior;
  }
});

test("Codex native 0.160 editor is recognized after permissions are initialized", () => {
  assert.equal(
    startupState("codex", "OpenAI Codex loading Ask Codex to do anything")
      .ready,
    false,
  );
  assert.equal(
    startupState(
      "codex",
      "OpenAI Codex permissions: YOLO mode Ask Codex to do anything PrivateModel default",
    ).ready,
    true,
  );
  assert.equal(
    startupState(
      "codex",
      "trust this folder? Ask Codex to do anything permissions: YOLO mode",
    ).ready,
    false,
  );
});

test("Claude background Agent remains running until its producer task notification", async () => {
  const f = await fixture(),
    file = join(f.home, "background.jsonl");
  const rows = [
    {
      type: "assistant",
      message: {
        content: [
          {
            type: "tool_use",
            id: "call-1",
            name: "Agent",
            input: {
              description: "Background work",
              run_in_background: true,
              prompt: "task",
            },
          },
        ],
      },
    },
    {
      type: "user",
      message: {
        content: [
          {
            type: "tool_result",
            tool_use_id: "call-1",
            content: "Async agent launched. agentId: native-child",
          },
        ],
      },
    },
  ];
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(readTranscript(file, "cc").subagents[0].status, "running");
  rows.push({
    type: "user",
    message: {
      content: [
        {
          type: "text",
          text: "<task-notification><task-id>native-child</task-id><status>completed</status></task-notification>",
        },
      ],
    },
  } as any);
  await writeFile(file, rows.map((r) => JSON.stringify(r)).join("\n") + "\n");
  assert.equal(readTranscript(file, "cc").subagents[0].status, "completed");
});

test("Codex live reasoning usage delta follows only new native producer rows", async () => {
  const f = await fixture(),
    file = join(f.home, "usage.jsonl");
  await writeFile(
    file,
    [
      { type: "session_meta", payload: { id: "usage", cwd: f.workspace } },
      {
        type: "event_msg",
        payload: {
          type: "token_count",
          info: {
            last_token_usage: {
              input_tokens: 120,
              reasoning_output_tokens: 25,
            },
            model_context_window: 1000,
          },
        },
      },
    ]
      .map((r) => JSON.stringify(r))
      .join("\n"),
  );
  assert.equal(readTranscript(file, "codex", 1).delta.thinking_tokens, 25);
  assert.equal(readTranscript(file, "codex", 2).delta.thinking_tokens, 0);
  assert.equal(readTranscript(file, "codex").token.tokens_in_context, 120);
});

test("native file and image staging preserves browser attachment identity and actual size", async () => {
  const f = await fixture(),
    prior = process.env.CODEX_BIN,
    runtime = new NativeRuntime(f.home, f.workspace);
  process.env.CODEX_BIN = f.command;
  let id: string | undefined;
  try {
    id = (
      await runtime.createTerminal("codex", "Attachment fixture", {
        cwd: f.workspace,
      })
    ).localId;
    const path = join(f.home, "upload.bin");
    await writeFile(path, Buffer.from([1, 2, 3, 4, 5]));
    for (const kind of ["file", "image"]) {
      const staged = await runtime.request(
        `/api/sessions/${id}/inject_${kind}`,
        "POST",
        {
          path,
          name: "upload.bin",
          filename: "original.bin",
          display_name: "Browser attachment",
          size: 0,
          content_type:
            kind === "image" ? "image/png" : "application/octet-stream",
        },
      );
      assert.equal(staged.attachment.filename, "original.bin");
      assert.equal(staged.attachment.display_name, "Browser attachment");
      assert.equal(staged.attachment.size, 5);
      assert.equal(staged.attachment.kind, kind);
      assert.ok(staged.attachment.created_ts > 0);
      assert.equal(staged.pending_attachment, true);
      assert.equal(
        staged.attachments.at(-1).content_type,
        kind === "image" ? "image/png" : "application/octet-stream",
      );
    }
    const stored = await runtime.request(`/api/sessions/${id}/attachments`);
    assert.equal(stored.attachments.length, 2);
    assert.deepEqual(stored.staged_attachments, stored.attachments);
    assert.equal(stored.attachments[0].size, 5);
  } finally {
    if (id)
      await runtime
        .request(`/api/sessions/${id}/delete`, "POST")
        .catch(() => {});
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
  }
});

test("native Escape interruption keeps busy until producer acknowledges aborted turn", async () => {
  const f = await fixture(),
    prior = process.env.CODEX_BIN;
  const command = join(f.home, "fake-interrupt");
  await writeFile(
    command,
    `#!${process.execPath}
const fs=require('fs'),path=require('path');const directory=path.join(process.env.CODEX_HOME,'sessions');fs.mkdirSync(directory,{recursive:true});const file=path.join(directory,'rollout-interrupt.jsonl'),fd=fs.openSync(file,'a');function row(type,payload){fs.writeSync(fd,JSON.stringify({type,payload,timestamp:new Date().toISOString()})+'\\n');}
row('session_meta',{id:'interrupt-producer',cwd:process.cwd()});process.stdout.write('100% context left ? for shortcuts\\n');process.stdin.setRawMode(true);process.stdin.setEncoding('utf8');let started=false;process.stdin.on('data',data=>{if(data==='\\x1b'){setTimeout(()=>row('event_msg',{type:'turn_aborted'}),600);}else if(data.includes('\\r')&&!started){started=true;row('event_msg',{type:'user_message',message:'held turn'});row('event_msg',{type:'task_started'});}});
`,
    { mode: 0o755 },
  );
  process.env.CODEX_BIN = command;
  const runtime = new NativeRuntime(f.home, f.workspace);
  let id: string | undefined;
  try {
    id = (
      await runtime.createTerminal("codex", "Interrupt fixture", {
        cwd: f.workspace,
      })
    ).localId;
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/state`)).readiness ===
        "ready",
    );
    await runtime.request(`/api/sessions/${id}/send`, "POST", {
      text: "held turn",
    });
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/messages/tail`)).events
          .length > 0,
    );
    const requested = await runtime.request(
      `/api/sessions/${id}/interrupt`,
      "POST",
    );
    assert.equal(requested.interrupt_requested, true);
    assert.equal(
      (await runtime.request(`/api/sessions/${id}/state`)).busy,
      true,
    );
    await until(
      async () =>
        (await runtime.request(`/api/sessions/${id}/state`)).busy === false,
    );
    assert.ok(
      (await runtime.request(`/api/sessions/${id}/messages/tail`)).events.some(
        (e: any) => e.message_class === "error",
      ),
    );
  } finally {
    if (id)
      await runtime
        .request(`/api/sessions/${id}/delete`, "POST")
        .catch(() => {});
    if (prior === undefined) delete process.env.CODEX_BIN;
    else process.env.CODEX_BIN = prior;
  }
});
