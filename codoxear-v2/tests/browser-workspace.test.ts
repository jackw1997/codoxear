import test from "node:test";
import assert from "node:assert/strict";
import Fastify from "fastify";
import { browserWorkspace } from "../src/hub/browser-workspace.js";
import { AuthorityClient } from "../src/hub/authority-client.js";

test("workspace resolves global agents, forwards bodies, and rejects removed agents", async () => {
  const target = Fastify();
  target.get("/api/v1/computers/computer-a/api/sessions", async () => ({
    sessions: [{ session_id: "local-a", alias: "A" }],
  }));
  target.post(
    "/api/v1/computers/computer-a/api/sessions/local-a/edit",
    async (r) => r.body,
  );
  target.post(
    "/api/v1/computers/computer-a/api/sessions/local-a/send",
    async (r) => ({
      body: r.body,
      authorization: r.headers.authorization,
      cookie: r.headers.cookie ?? null,
    }),
  );
  target.get("/api/agents/agent-a/access", async () => ({
    access: { mode: "read_only" },
  }));
  target.post(
    "/api/v1/computers/computer-a/api/sessions/local-a/file/inspect",
    async (r) => r.body,
  );
  target.get(
    "/api/v1/computers/computer-a/api/sessions/local-a/file/read",
    async () => ({
      image_url: "/api/sessions/local-a/file/blob?path=image.png",
    }),
  );
  target.get(
    "/api/v1/computers/computer-a/api/audio/live.m3u8",
    async (_r, reply) =>
      reply
        .type("application/vnd.apple.mpegurl")
        .send(
          "#EXTM3U\n/api/v1/computers/computer-a/api/audio/segments/a.ts\n",
        ),
  );
  const origin = await target.listen({ host: "127.0.0.1", port: 0 });
  let agents = [
    {
      id: "agent-a",
      hubId: "hub-a",
      computerId: "computer-a",
      localId: "local-a",
      name: "Agent A",
      origin,
      state: "ready",
    },
  ];
  const authority = new AuthorityClient(
    "http://identity.invalid",
    "hub-entry",
    "credential",
    async (input) => {
      const path = new URL(String(input)).pathname;
      return Response.json(
        path === "/api/v1/me/agents"
          ? { agents }
          : { accessToken: "scoped-token", origin },
      );
    },
  );
  const app = Fastify();
  await browserWorkspace(app, authority, async () => ({
    accountId: "alice",
    token: "identity-token",
    scopeId: "scope",
  }));
  try {
    const catalog = await app.inject("/workspace/api/sessions");
    assert.equal(catalog.statusCode, 200);
    assert.equal(catalog.json().sessions[0].session_id, "agent-a");
    assert.equal(catalog.json().sessions[0].codoxear_computer_id, "computer-a");
    agents.push({ ...agents[0]!, id: "agent-b", localId: "local-b" });
    const edit = await app.inject({
      method: "POST",
      url: "/workspace/api/sessions/agent-a/edit",
      payload: {
        name: "Renamed",
        snooze_until: 12345,
        dependency_session_id: "agent-b",
      },
    });
    assert.equal(edit.statusCode, 200, edit.body);
    assert.deepEqual(edit.json(), {
      name: "Renamed",
      snooze_until: 12345,
      dependency_session_id: "local-b",
    });
    agents.push({
      ...agents[0]!,
      id: "agent-c",
      computerId: "computer-b",
      localId: "local-c",
    });
    for (const dependency of ["agent-c", "local-b", "removed-agent"])
      assert.equal(
        (
          await app.inject({
            method: "POST",
            url: "/workspace/api/sessions/agent-a/edit",
            payload: { dependency_session_id: dependency },
          })
        ).statusCode,
        403,
      );
    assert.equal(
      (
        await app.inject({
          method: "POST",
          url: "/workspace/api/sessions/agent-a/edit",
          payload: { dependency_session_id: null },
        })
      ).json().dependency_session_id,
      null,
    );
    const sent = await app.inject({
      method: "POST",
      url: "/workspace/api/sessions/agent-a/send",
      payload: { text: "hello" },
      headers: { Cookie: "private=never-forward" },
    });
    assert.equal(sent.statusCode, 200, sent.body);
    assert.deepEqual(sent.json(), {
      body: { text: "hello" },
      authorization: "Bearer scoped-token",
      cookie: null,
    });
    assert.equal(
      (await app.inject("/workspace/api/sessions/agent-a/access")).json().access
        .mode,
      "read_only",
    );
    const inspected = await app.inject({
      method: "POST",
      url: "/workspace/api/sessions/agent-a/file/inspect",
      payload: { session_id: "agent-a", path: "proof.txt" },
    });
    assert.deepEqual(inspected.json(), {
      session_id: "local-a",
      path: "proof.txt",
    });
    const wrong = await app.inject({
      method: "POST",
      url: "/workspace/api/sessions/agent-a/file/inspect",
      payload: { session_id: "other-agent", path: "proof.txt" },
    });
    assert.equal(wrong.statusCode, 403);
    assert.equal(
      (await app.inject("/workspace/api/sessions/agent-a/file/read")).json()
        .image_url,
      "/api/sessions/agent-a/file/blob?path=image.png",
    );
    assert.equal(
      (await app.inject("/workspace/api/audio/live.m3u8?__agent=agent-a")).body,
      "#EXTM3U\n/workspace/api/audio/segments/a.ts?__agent=agent-a\n",
    );
    agents = [];
    assert.equal(
      (await app.inject("/workspace/api/sessions/agent-a/send")).statusCode,
      404,
    );
  } finally {
    await app.close();
    await target.close();
  }
});

test("catalog distinguishes an unreachable computer from empty sessions and revalidates authorization", async () => {
  let fail = true;
  let revoke = false;
  let reads = 0;
  const target = Fastify();
  target.get("/api/v1/computers/computer-a/api/sessions", async (_r, reply) =>
    fail ? reply.code(503).send({error:"secret upstream detail"}) : {sessions:[]},
  );
  const origin = await target.listen({host:"127.0.0.1",port:0});
  const agents = [{id:"agent-a",hubId:"hub-a",computerId:"computer-a",computerName:"Laptop",localId:"local-a",name:"A",origin,state:"ready"}];
  const authority = new AuthorityClient("http://identity.invalid","hub-entry","credential",async (input) => {
    if (new URL(String(input)).pathname === "/api/v1/me/agents") {
      reads++;
      return Response.json({agents:revoke && reads % 2 === 0 ? [] : agents});
    }
    return Response.json({accessToken:"scoped-token",origin});
  });
  const app = Fastify();
  await browserWorkspace(app,authority,async()=>({accountId:"alice",token:"identity-token",scopeId:"scope"}));
  try {
    const failed = (await app.inject("/workspace/api/sessions")).json();
    assert.deepEqual(failed.sessions,[]);
    assert.deepEqual(failed.catalog_errors,[{computerId:"computer-a",computerName:"Laptop",message:"Computer is unreachable. Reconnect it and retry."}]);
    assert.deepEqual(failed.catalog_authorized_agents,[{session_id:"agent-a",computer_id:"computer-a"}]);
    fail=false;
    const empty=(await app.inject("/workspace/api/sessions")).json();
    assert.deepEqual(empty.sessions,[]);
    assert.deepEqual(empty.catalog_errors,[]);
    fail=true;revoke=true;
    const revoked=(await app.inject("/workspace/api/sessions")).json();
    assert.deepEqual(revoked.catalog_errors,[]);
    assert.deepEqual(revoked.catalog_authorized_agents,[]);
  } finally {await app.close();await target.close();}
});
