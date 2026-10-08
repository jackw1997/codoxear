import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeRuntime } from "../src/computer/native/runtime.js";
import { unattendedIdleAllowsInjection } from "../src/computer/native/workspace/unattended.js";
import type { ChatEvent } from "../src/computer/native/types.js";
assert.ok(existsSync("/.dockerenv"), "Run native acceptance in Docker");

test("session metadata edits persist, project priority and never dispatch a conversation send", async () => {
  const home = await mkdtemp(join(tmpdir(), "native-sidebar-"));
  let runtime = new NativeRuntime(home, home);
  const a = "broker-" + "a".repeat(32),
    b = "broker-" + "b".repeat(32);
  try {
    for (const id of [a, b])
      await writeFile(
        join(runtime.directory, id + ".json"),
        JSON.stringify({
          version: 1,
          session_id: id,
          agent_backend: "codex",
          alias: "Original",
          start_ts: Date.now() / 1000,
          readiness: "exited",
          log_path: null,
          busy: false,
        }),
      );
    const until = Date.now() / 1000 + 600;
    const edited = await runtime.request(`/api/sessions/${a}/edit`, "POST", {
      name: "  New   title ",
      priority_offset: -0.5,
      snooze_until: until,
      dependency_session_id: b,
    });
    assert.deepEqual(edited, {
      ok: true,
      alias: "New title",
      priority_offset: -0.5,
      snooze_until: until,
      dependency_session_id: b,
    });
    runtime.close();
    runtime = new NativeRuntime(home, home);
    let row = (await runtime.request("/api/sessions")).sessions.find(
      (row: any) => row.session_id === a,
    );
    assert.equal(row.alias, "New title");
    assert.equal(row.blocked, true);
    assert.equal(row.snoozed, true);
    assert.equal(row.final_priority, 0);
    for (const body of [
      { name: "Bad", dependency_session_id: a },
      { name: "Bad", dependency_session_id: "missing" },
      { name: "Bad", priority_offset: 2 },
      { name: "Bad", snooze_until: true },
      { text: "this must never be sent" },
    ])
      await assert.rejects(
        runtime.request(`/api/sessions/${a}/edit`, "POST", body),
      );
    assert.equal(
      (await runtime.request(`/api/sessions/${a}/messages/tail`)).events.length,
      0,
    );
    await runtime.request(`/api/sessions/${a}/edit`, "POST", {
      name: "New title",
      priority_offset: -0.5,
      snooze_until: 1,
      dependency_session_id: b,
    });
    await unlink(join(runtime.directory, b + ".json"));
    row = (await runtime.request("/api/sessions")).sessions[0];
    assert.equal(row.dependency_session_id, null);
    assert.equal(row.snooze_until, null);
    assert.equal(row.blocked, false);
    assert.equal(row.snoozed, false);
    assert.ok(row.final_priority > 0.49 && row.final_priority <= 0.5);
    await runtime.request(`/api/sessions/${a}/rename`, "POST", {
      name: "Renamed",
    });
    row = (await runtime.request("/api/sessions")).sessions[0];
    assert.equal(row.alias, "Renamed");
    assert.equal(row.priority_offset, -0.5);
  } finally {
    runtime.close();
    await rm(home, { recursive: true, force: true });
  }
});

test("unattended requires an idle final assistant turn and respects injection cooldown", () => {
  const now = 1_000_000;
  const final: ChatEvent = {
    role: "assistant",
    text: "Done",
    ts: (now - 60_000) / 1000,
    message_id: "final",
    message_class: "final_response",
  };
  assert.equal(unattendedIdleAllowsInjection([], 1, 0, now), false);
  assert.equal(
    unattendedIdleAllowsInjection([{ ...final, ts: now / 1000 }], 1, 0, now),
    false,
  );
  assert.equal(unattendedIdleAllowsInjection([final], 1, 0, now), true);
  assert.equal(
    unattendedIdleAllowsInjection([final], 1, now - 59_999, now),
    false,
  );
  assert.equal(
    unattendedIdleAllowsInjection(
      [final, { ...final, role: "user", ts: now / 1000 }],
      1,
      0,
      now,
    ),
    false,
  );
  const { message_class: _class, ...unfinished } = final;
  assert.equal(unattendedIdleAllowsInjection([unfinished], 1, 0, now), false);
});
