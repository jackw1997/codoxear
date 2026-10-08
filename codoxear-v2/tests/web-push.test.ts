import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { createServer } from "node:http";
import { once } from "node:events";
import { createECDH, randomBytes, createHmac, createDecipheriv } from "node:crypto";
import { importJWK, jwtVerify } from "jose";
import webpush from "web-push";
import Fastify from "fastify";
import { WebPushProvider } from "../src/hub/web-push.js";
import { NotificationInbox, subscriptionTag, type Subscription } from "../src/hub/notifications.js";
import { registerPushRoutes } from "../src/hub/web-push-routes.js";
import { DomainError } from "../src/contracts/model.js";
assert.ok(existsSync("/.dockerenv"), "Run in Docker");
const keys = webpush.generateVAPIDKeys(), config = { ...keys, subject: "mailto:push@example.invalid" };
const receiver = createECDH("prime256v1"); receiver.generateKeys();
const auth = randomBytes(16);
const browser = (endpoint: string) => ({ endpoint, expirationTime: null, keys: { p256dh: receiver.getPublicKey().toString("base64url"), auth: auth.toString("base64url") } });
const subscription = (endpoint: string): Subscription => ({ userId: "alice", sessionId: "session", computerId: "computer", installationId: "installation", clientId: "login", binding: 1, provider: "web-push", browser: browser(endpoint), token: JSON.stringify(browser(endpoint)), scope: "scoped" });
const hint = () => ({ id: "a".repeat(64), localId: "local", kind: "completion" as const, occurredAt: Date.now(), computerId: "computer", hubId: "hub", agentId: "agent", binding: 1 });
function decrypt(body: Buffer) {
  const salt = body.subarray(0, 16), keyLength = body[20]!, sender = body.subarray(21, 21 + keyLength), ciphertext = body.subarray(21 + keyLength);
  assert.equal(keyLength, 65); assert.ok(body.readUInt32BE(16) > ciphertext.length);
  const extract = (key: Buffer, value: Buffer) => createHmac("sha256", key).update(value).digest();
  const expand = (key: Buffer, info: Buffer, length: number) => extract(key, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
  const prkKey = extract(auth, receiver.computeSecret(sender));
  const ikm = expand(prkKey, Buffer.concat([Buffer.from("WebPush: info\0"), receiver.getPublicKey(), sender]), 32);
  const prk = extract(salt, ikm), cek = expand(prk, Buffer.from("Content-Encoding: aes128gcm\0"), 16), nonce = expand(prk, Buffer.from("Content-Encoding: nonce\0"), 12);
  const decipher = createDecipheriv("aes-128-gcm", cek, nonce); decipher.setAuthTag(ciphertext.subarray(-16));
  const clear = Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
  assert.equal(clear.at(-1), 2); return JSON.parse(clear.subarray(0, -1).toString());
}
test("encrypted delivery decrypts independently and VAPID signs the exact provider audience", async () => {
  let received: unknown, status = 201;
  const server = createServer(async (req, res) => {
    try {
      assert.equal(req.method, "POST"); assert.equal(req.headers["content-encoding"], "aes128gcm");
      const parts: Buffer[] = []; for await (const chunk of req) parts.push(Buffer.from(chunk));
      const body = Buffer.concat(parts); assert.ok(!body.includes(Buffer.from("local"))); received = decrypt(body);
      const authorization = String(req.headers.authorization); assert.match(authorization, /^vapid t=.+, k=/);
      const token = authorization.slice(8).split(",")[0]!;
      const publicKey = Buffer.from(keys.publicKey, "base64url");
      const verified = await jwtVerify(token, await importJWK({ kty: "EC", crv: "P-256", x: publicKey.subarray(1,33).toString("base64url"), y: publicKey.subarray(33).toString("base64url") }, "ES256"), { audience: origin });
      assert.equal(verified.payload.sub, config.subject); assert.ok(verified.payload.exp! < Date.now()/1000 + 24*3600);
      res.writeHead(status); res.end();
    } catch (error) { res.writeHead(500); res.end(String(error)); }
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  const origin = "http://127.0.0.1:" + (server.address() as {port: number}).port, endpoint = origin + "/push";
  const provider = new WebPushProvider(config, fetch, new Set([origin]));
  try {
    const event = hint(); assert.equal(await provider.send(subscription(endpoint), event), "sent");
    assert.deepEqual(received, { ...event, version: 1, userId: "alice", clientId: "login", installationId: "installation", subscriptionTag: subscriptionTag(subscription(endpoint).token) });
    status = 410; assert.equal(await provider.send(subscription(endpoint), hint()), "invalid-token");
    status = 503; await assert.rejects(provider.send(subscription(endpoint), hint()), /unavailable/);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
test("registration rejects private endpoints, malformed keys and mismatched VAPID credentials", () => {
  const provider = new WebPushProvider(config);
  for (const endpoint of ["http://127.0.0.1/push", "https://localhost/push", "https://169.254.169.254/push", "https://fcm.googleapis.com:444/push", "https://fcm.googleapis.com.evil.test/push", "https://user:secret@fcm.googleapis.com/push", "https://fcm.googleapis.com/push#fragment"]) assert.throws(() => provider.validate(browser(endpoint)));
  assert.doesNotThrow(() => provider.validate(browser("https://fcm.googleapis.com/wp/device")));
  assert.throws(() => provider.validate({ ...browser("https://fcm.googleapis.com/wp/device"), keys: { p256dh: Buffer.alloc(65).toString("base64url"), auth: auth.toString("base64url") } }));
  assert.throws(() => new WebPushProvider({ ...config, privateKey: webpush.generateVAPIDKeys().privateKey }), /does not match/);
});
test("durable subscription fences session, client, binding, token rotation and revocation on browser authorization", async () => {
  let allow = true;
  const inbox = new NotificationInbox(":memory:", "hub", async () => { if (!allow) throw new DomainError(403, "forbidden", "revoked"); });
  const sub = subscription("https://fcm.googleapis.com/wp/device"); inbox.subscribe(sub);
  const authorize = (session = "session", binding = 1, client = "login", tag = subscriptionTag(sub.token)) => inbox.authorizeHint("alice", session, "installation", "computer", "agent", binding, client, tag);
  try {
    assert.deepEqual(await authorize(), { ok: true });
    await assert.rejects(authorize("another")); await assert.rejects(authorize("session", 2)); await assert.rejects(authorize("session", 1, "another"));
    inbox.subscribe({ ...sub, token: "rotated" }); await assert.rejects(authorize());
    allow = false; await assert.rejects(authorize("session",1,"login",subscriptionTag("rotated")));
    inbox.unsubscribeSession("alice", "another"); assert.equal(inbox.counts().subscriptions, 1);
    inbox.unsubscribeSession("alice", "session"); assert.equal(inbox.counts().subscriptions, 0);
  } finally { inbox.close(); }
});
test("HTTP subscription API masks capabilities, binds current account and refuses stale computer attachment", async () => {
  const provider = new WebPushProvider(config), inbox = new NotificationInbox(":memory:", "hub", async () => {} , provider), app = Fastify();
  app.setErrorHandler((e, _r, reply) => reply.code(e instanceof DomainError ? e.status : 400).send({ error: "rejected" }));
  const call = async <T>(_r: unknown, op: string): Promise<T> => ({ "me": {id: "alice"}, "notification-subject": {userId: "alice", sessionId: "session", binding: 1}, "notification-session": {id: "alice", sessionId: "session"} }[op as "me"] as T);
  registerPushRoutes(app, inbox, call, "https://hub.test", "hub");
  try {
    const sub = subscription("https://fcm.googleapis.com/wp/device"), input = { provider: "web-push", computerId: "computer", installationId: "installation", clientId: "login", subscription: sub.browser };
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/push/subscriptions", payload: input })).statusCode, 200);
    const publicConfig = (await app.inject({ method: "GET", url: "/api/v1/push/subscriptions" })).body;
    assert.ok(!publicConfig.includes(config.privateKey)); assert.ok(!publicConfig.includes(auth.toString("base64url"))); assert.ok(!publicConfig.includes("/wp/device"));
    const authorization = { computerId: "computer", installationId: "installation", clientId: "login", agentId: "agent", binding: 1, subscriptionTag: subscriptionTag(sub.token) };
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/push/authorize", payload: authorization })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/push/authorize", payload: {...authorization,binding: 2} })).statusCode, 403);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/push/subscriptions", payload: {...input,userId:"victim"} })).statusCode, 400);
    assert.equal((await app.inject({ method: "DELETE", url: "/api/v1/push/subscriptions" })).statusCode, 200);
    assert.equal((await app.inject({ method: "POST", url: "/api/v1/push/authorize", payload: authorization })).statusCode, 403);
  } finally { await app.close(); inbox.close(); }
});
