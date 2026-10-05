import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ComputerDrafts } from "../src/computer/drafts.js";
import { emptyBody } from "../src/protocol/http-frames.js";
import { classifyRoute } from "../src/protocol/routes.js";
assert.ok(existsSync("/.dockerenv"), "Docker only");
test("personal drafts survive restart without leaking to another user, session or hub attachment", async () => {
  const dir = await mkdtemp(join(tmpdir(), "drafts-")),
    path = join(dir, "drafts.sqlite");
  let drafts = new ComputerDrafts(path, "hub1:computer1:binding1");
  try {
    drafts.write("alice", "same-local", "private Alice text");
    drafts.write("bob", "same-local", "private Bob text");
    assert.equal(drafts.read("alice", "same-local").text, "private Alice text");
    assert.equal(drafts.read("bob", "same-local").text, "private Bob text");
    assert.equal(drafts.read("alice", "another-local").text, "");
    drafts.close();
    drafts = new ComputerDrafts(path, "hub1:computer1:binding1");
    assert.equal(drafts.read("alice", "same-local").text, "private Alice text");
    drafts.write("alice", "same-local", "");
    assert.equal(drafts.read("alice", "same-local").text, "");
    assert.ok(drafts.timestamps("alice").get("same-local")! > 0);
    assert.equal(drafts.read("bob", "same-local").text, "private Bob text");
    drafts.close();
    drafts = new ComputerDrafts(path, "hub2:computer1:binding2");
    assert.equal(drafts.read("bob", "same-local").text, "");
  } finally {
    drafts.close();
    await rm(dir, { recursive: true });
  }
});
test("draft HTTP handling requires the tunnel actor; read-only agent access may save personal unsent text", async () => {
  const drafts = new ComputerDrafts(":memory:", "attachment"),
    signal = new AbortController().signal;
  const request = {
    method: "GET" as const,
    path: "/api/sessions/local/draft",
    headers: {},
    body: emptyBody,
    signal,
  };
  const data = Buffer.from(JSON.stringify({ text: "private" }));
  try {
    assert.equal((await drafts.handle(request))?.status, 403);
    const response = await drafts.handle({
      ...request,
      method: "POST",
      actorId: "alice",
      body: {
        async *[Symbol.asyncIterator]() {
          yield data;
        },
      },
    });
    assert.equal(response?.status, 200);
    const other = await drafts.handle({ ...request, actorId: "bob" });
    const chunks = [];
    for await (const chunk of other!.body) chunks.push(Buffer.from(chunk));
    assert.equal(JSON.parse(Buffer.concat(chunks).toString()).text, "");
    assert.equal(classifyRoute("POST", request.path).action, "read");
    assert.equal(
      await drafts.handle({ ...request, path: "/api/sessions/local/send" }),
      undefined,
    );
  } finally {
    drafts.close();
  }
});
