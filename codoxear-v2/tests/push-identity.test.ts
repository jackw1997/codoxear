import test from "node:test";
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { vault, type HubLogin } from "../frontend/web/client/vault.js";
import { installPushEvents, pushInstallations, notificationSubscription } from "../frontend/web/client/push.js";

assert.ok(existsSync("/.dockerenv"), "Run in Docker");

test("removed Hub identities cannot display, open or renew notifications", async (t) => {
  const login: HubLogin = {
    id: "alice", accountKey: "alice-scope", origin: "https://hub.test", hubId: "hub",
    name: "Work", accountId: "alice-account", accessToken: "access",
    refreshToken: "refresh", expiresAt: Date.now() + 60_000,
    identity: { name: "Alice", method: "feishu", key: "key" },
  };
  const scope = "https://client.test/push/alice/";
  const record = { loginId: login.id, computerId: "computer", installationId: "installation",
    scope, vapidPublicKey: "public", endpoint: "https://push.test/device", sessionMarker: login.id };
  const hint = { id: "a".repeat(64), localId: "local", kind: "completion", occurredAt: Date.now(),
    version: 1, hubId: "hub", userId: login.accountId, clientId: login.id, installationId: "installation",
    computerId: "computer", agentId: "agent", binding: 1, subscriptionTag: "b".repeat(64) };
  let saved = true, calls = 0, shown = 0, opened = 0, closed = 0;
  let removedDuringAuthorization = false, replacedDuringAuthorization = false;
  const handlers = new Map<string, (event: any) => void>();
  const previousNotification = Object.getOwnPropertyDescriptor(globalThis, "Notification");
  Object.defineProperty(globalThis, "Notification", { configurable: true, value: { permission: "granted" } });
  t.after(() => {
    if (previousNotification) Object.defineProperty(globalThis, "Notification", previousNotification);
    else Reflect.deleteProperty(globalThis, "Notification");
  });
  t.mock.method(vault, "get", async () => saved ? { ...login } : undefined);
  t.mock.method(vault, "isActive", async () => saved);
  t.mock.method(pushInstallations, "get", async () => record);
  t.mock.method(pushInstallations, "list", async () => [record]);
  t.mock.method(pushInstallations, "put", async () => undefined);
  const worker = {
    location: { origin: "https://client.test" },
    addEventListener: (name: string, callback: (event: any) => void) => handlers.set(name, callback),
    registration: {
      scope,
      showNotification: async () => { shown++; },
      getNotifications: async () => [{ data: { hint }, close: () => { closed++; } }],
      pushManager: { getSubscription: async () => ({ toJSON: () => ({ endpoint: record.endpoint }) }) },
    },
    clients: { matchAll: async () => [], openWindow: async () => { opened++; } },
  } as unknown as ServiceWorkerGlobalScope;
  const hub = async () => {
    calls++;
    if (removedDuringAuthorization) saved = false;
    if (replacedDuringAuthorization) login.selectionId = "new-selection";
    return Response.json({ ok: true });
  };
  installPushEvents(worker, hub);
  async function dispatch(name: string, data: object = {}) {
    const work: Promise<unknown>[] = [];
    handlers.get(name)!({ ...data, waitUntil: (value: Promise<unknown>) => work.push(value) });
    await Promise.all(work);
  }
  const push = () => dispatch("push", { data: { json: () => hint } });
  const click = () => dispatch("notificationclick", { notification: { data: { hint }, close() {} } });
  await push();
  assert.equal(shown, 1, "saved identity receives its authorized notification");
  await click();
  assert.equal(opened, 1);
  const callsBeforeRemoval = calls;
  saved = false;
  await push();
  await click();
  await dispatch("pushsubscriptionchange");
  assert.equal(calls, callsBeforeRemoval, "removed identity makes no authorization or renewal request");
  assert.equal(shown, 1);
  assert.equal(opened, 1);
  assert.equal((await notificationSubscription(new Request("https://client.test/api/notifications"), login, "computer", hub, "https://client.test")).status, 409);
  await dispatch("message", { data: { type: "codoxear-identity-changed" } });
  assert.equal(closed, 1, "removal closes already visible notifications for removed identities");
  saved = true;
  removedDuringAuthorization = true;
  await push();
  assert.equal(shown, 1, "removal during remote authorization fences its late response");
  saved = true;
  await click();
  assert.equal(opened, 1, "late notification click cannot restore a removed identity");
  saved = true; removedDuringAuthorization = false; replacedDuringAuthorization = true;
  await push();
  assert.equal(shown, 1, "credential replacement still rejects the previous incarnation response");
});
