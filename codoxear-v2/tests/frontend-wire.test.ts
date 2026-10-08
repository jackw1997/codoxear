import test from "node:test";
import assert from "node:assert/strict";
import { PushHint as BackendPush } from "../src/contracts/web-push.js";
import { NOTIFICATION_TTL as backendTTL } from "../src/protocol/notifications.js";
import { PushHint as FrontendPush, NOTIFICATION_TTL as frontendTTL } from "../frontend/web/shared/push-contract.js";

test("independently built frontend accepts the backend push wire payload and rejects invalid identity", () => {
  const payload = BackendPush.parse({
    version: 1, id: "a".repeat(64), localId: "managed-example", kind: "completion",
    occurredAt: 123, hubId: "hub-a", userId: "owner", clientId: "browser",
    installationId: "phone", computerId: "computer-b", agentId: "child",
    binding: 2, subscriptionTag: "b".repeat(64),
  });
  assert.deepEqual(FrontendPush.parse(JSON.parse(JSON.stringify(payload))), payload);
  assert.equal(frontendTTL, backendTTL);
  for (const change of [{ binding: 0 }, { version: 2 }, { computerId: "../other" }, { subscriptionTag: "bad" }, { unexpected: true }]) {
    assert.equal(BackendPush.safeParse({ ...payload, ...change }).success, false);
    assert.equal(FrontendPush.safeParse({ ...payload, ...change }).success, false);
  }
});
