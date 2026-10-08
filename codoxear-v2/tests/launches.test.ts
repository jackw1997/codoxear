import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerLaunches } from "../src/computer/launches.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
const operation = {
  op: "create",
  agentId: "agent",
  backend: "pi",
  name: "Example",
} as const;
test("launch receipts survive lost replies/restart, reject duplicates, and stay within their attachment", async () => {
  const home = mkdtempSync(join(tmpdir(), "launch-receipts-")),
    path = join(home, "receipts.sqlite");
  let journal = new ComputerLaunches(path, "hub/computer/1"),
    launches = 0;
  try {
    const execute = async () => {
      launches++;
      return { localId: "local", brokerPid: 101 };
    };
    // The caller loses this reply. Later reconciliation reads the committed result.
    await journal.create(operation, execute);
    journal.close();
    journal = new ComputerLaunches(path, "hub/computer/1");
    assert.deepEqual(journal.status("agent"), {
      state: "ready",
      result: { localId: "local", brokerPid: 101 },
    });
    await assert.rejects(
      journal.create(operation, execute),
      /already recorded/,
    );
    assert.equal(launches, 1);
    const transferred = new ComputerLaunches(path, "hub/computer/2");
    try {
      assert.deepEqual(transferred.status("agent"), { state: "unknown" });
    } finally {
      transferred.close();
    }
  } finally {
    journal.close();
    rmSync(home, { recursive: true });
  }
});
test("uncertain and concurrent launches are never automatically retried, including prototype-like IDs", async () => {
  const journal = new ComputerLaunches(":memory:", "binding");
  let release!: () => void,
    launches = 0;
  try {
    const execute = async () => {
      launches++;
      await new Promise<void>((r) => {
        release = r;
      });
      throw new Error("reply lost after dispatch");
    };
    const first = journal.create(operation, execute);
    assert.deepEqual(journal.status("agent"), { state: "unknown" });
    await assert.rejects(
      journal.create(operation, execute),
      /already recorded/,
    );
    release();
    await assert.rejects(first, /reply lost/);
    await assert.rejects(
      journal.create(operation, execute),
      /already recorded/,
    );
    assert.equal(launches, 1);
    assert.deepEqual(journal.status("constructor"), { state: "unknown" });
    await journal.create({ ...operation, agentId: "__proto__" }, async () => ({
      localId: "safe",
    }));
    assert.deepEqual(journal.status("__proto__"), {
      state: "ready",
      result: { localId: "safe" },
    });
  } finally {
    journal.close();
  }
});
