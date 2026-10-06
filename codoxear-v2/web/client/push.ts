/// <reference lib="webworker" />
import { vault, type HubLogin } from "./vault.js";
import { PushHint } from "../../src/contracts/web-push.js";
import { NOTIFICATION_TTL } from "../../src/protocol/notifications.js";

export type PushInstallation = { loginId: string; computerId: string; installationId: string; scope: string; vapidPublicKey: string; endpoint: string; sessionMarker: string };
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return opening ??= new Promise((resolve, reject) => {
    const r = indexedDB.open("codoxear-client-push", 1);
    r.onupgradeneeded = () => r.result.createObjectStore("installations", { keyPath: ["loginId", "computerId"] });
    r.onsuccess = () => resolve(r.result); r.onerror = () => reject(r.error);
  });
}
async function operation<T>(mode: IDBTransactionMode, work: (s: IDBObjectStore) => IDBRequest<T>) {
  const db = await database();
  return new Promise<T>((resolve, reject) => {
    const tx = db.transaction("installations", mode), r = work(tx.objectStore("installations"));
    tx.oncomplete = () => resolve(r.result); tx.onerror = () => reject(tx.error); tx.onabort = () => reject(tx.error);
  });
}
export const pushInstallations = {
  list: () => operation<PushInstallation[]>("readonly", s => s.getAll()),
  get: (loginId: string, computerId: string) => operation<PushInstallation | undefined>("readonly", s => s.get([loginId, computerId])),
  put: (value: PushInstallation) => operation("readwrite", s => s.put(value)),
  remove: (loginId: string, computerId: string) => operation("readwrite", s => s.delete([loginId, computerId])),
};
type HubFetch = (login: HubLogin, path: string, init?: RequestInit) => Promise<Response>;
const post = (value: unknown): RequestInit => ({ method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(value), signal: AbortSignal.timeout(8000) });
export async function disconnectPush(login: HubLogin, hub: HubFetch, worker: ServiceWorkerGlobalScope) {
  // Removing the saved account first fences concurrent push and notification clicks.
  await vault.remove(login.id);
  const installations = (await pushInstallations.list()).filter(i => i.loginId === login.id);
  for (const i of installations) await pushInstallations.remove(i.loginId, i.computerId);
  const registrations = await worker.registration.getNotifications();
  for (const n of registrations) if (n.data?.hint?.clientId === login.id) n.close();
  await hub(login, "/api/v1/push/subscriptions", { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});
  for (const client of await worker.clients.matchAll({ type: "window", includeUncontrolled: true }))
    client.postMessage({ type: "codoxear-push-disconnected", scopes: [...new Set(installations.map(i => i.scope))] });
}
export async function notificationSubscription(request: Request, login: HubLogin, computerId: string, hub: HubFetch, clientOrigin: string) {
  const response = await hub(login, "/api/v1/push/subscriptions", { signal: AbortSignal.timeout(8000) });
  if (!response.ok) return response;
  const state = await response.json();
  let record = await pushInstallations.get(login.id, computerId);
  if (record && record.sessionMarker !== (login.pushSession ?? login.id)) {
    await hub(login, "/api/v1/push/subscriptions/" + record.installationId + "/" + computerId, { method: "DELETE", signal: AbortSignal.timeout(5000) });
    await pushInstallations.remove(login.id, computerId); record = undefined;
  }
  if (!record) {
    record = { loginId: login.id, computerId, installationId: crypto.randomUUID(), scope: new URL("/push/" + encodeURIComponent(login.id) + "/", clientOrigin).href, vapidPublicKey: state.vapid_public_key, endpoint: "", sessionMarker: login.pushSession ?? login.id };
    await pushInstallations.put(record);
  }
  if (request.method === "POST") {
    const input = await request.json();
    if (input.enabled === false) {
      const result = await hub(login, "/api/v1/push/subscriptions/" + record.installationId + "/" + computerId, { method: "DELETE", signal: AbortSignal.timeout(8000) });
      if (!result.ok) return result;
      record.endpoint = ""; await pushInstallations.put(record);
    } else {
      if (!input.subscription) return Response.json({ error: "Browser subscription required" }, { status: 400 });
      const result = await hub(login, "/api/v1/push/subscriptions", post({ provider: "web-push", computerId, installationId: record.installationId, clientId: login.id, subscription: input.subscription }));
      if (!result.ok) return result;
      record.endpoint = input.subscription.endpoint; record.vapidPublicKey = state.vapid_public_key;
      await pushInstallations.put(record);
      state.subscriptions = [...state.subscriptions.filter((s: any) => s.installationId !== record!.installationId || s.computerId !== computerId), { installationId: record.installationId, computerId, provider: "web-push" }];
    }
  }
  const latest = await vault.get(login.id);
  if (!latest || (latest.pushSession ?? latest.id) !== record.sessionMarker) {
    await hub(login, "/api/v1/push/subscriptions/" + record.installationId + "/" + computerId, { method: "DELETE", signal: AbortSignal.timeout(5000) }).catch(() => {});
    if ((await pushInstallations.get(login.id, computerId))?.installationId === record.installationId) await pushInstallations.remove(login.id, computerId);
    return Response.json({ error: "Hub sign-in removed or replaced" }, { status: 401 });
  }
  return Response.json({ vapid_public_key: state.vapid_public_key, push_scope: record.scope, push_worker: "/client-worker.js?push=" + encodeURIComponent(login.id), account_scope: login.accountKey + "~" + computerId, installation_id: record.installationId, subscriptions: state.subscriptions.filter((s: any) => s.computerId === computerId && s.installationId === record!.installationId).map((s: any) => ({ ...s, endpoint: record!.endpoint, notifications_enabled: !!record!.endpoint })) });
}
export function installPushEvents(worker: ServiceWorkerGlobalScope, hub: HubFetch) {
  const authorize = async (input: unknown) => {
    const hint = PushHint.parse(input);
    if (hint.occurredAt <= Date.now() - NOTIFICATION_TTL || hint.occurredAt > Date.now() + 60000) throw new Error("Expired notification");
    const login = await vault.get(hint.clientId), record = await pushInstallations.get(hint.clientId, hint.computerId);
    if (!login || login.accountId !== hint.userId || login.hubId !== hint.hubId || !record || record.sessionMarker !== (login.pushSession ?? login.id) || record.installationId !== hint.installationId || record.scope !== worker.registration.scope || !record.endpoint) throw new Error("Notification account scope changed");
    const result = await hub(login, "/api/v1/push/authorize", post({ computerId: hint.computerId, installationId: hint.installationId, clientId: hint.clientId, agentId: hint.agentId, binding: hint.binding, subscriptionTag: hint.subscriptionTag }));
    if (!result.ok) throw new Error("Notification access lost");
    const latest = await vault.get(login.id), current = await pushInstallations.get(login.id, hint.computerId);
    if (!latest || (latest.pushSession ?? latest.id) !== record.sessionMarker || latest.accountId !== login.accountId || latest.hubId !== login.hubId || latest.origin !== login.origin || current?.installationId !== record.installationId || current.endpoint !== record.endpoint) throw new Error("Notification account changed");
    return { hint, login };
  };
  worker.addEventListener("push", event => event.waitUntil((async () => {
    try {
      const { hint } = await authorize(event.data?.json());
      if (Notification.permission !== "granted") return;
      await worker.registration.showNotification(hint.kind === "attention" ? "Agent needs attention" : "Agent finished", { body: "Open Codoxear to view the agent.", tag: [hint.hubId, hint.userId, hint.computerId, hint.id].join(":"), data: { hint } });
    } catch { /* Missing identity, expired hint, or access loss fails closed. */ }
  })()));
  worker.addEventListener("notificationclick", event => {
    event.notification.close();
    event.waitUntil((async () => {
      try {
        const { hint, login } = await authorize(event.notification.data?.hint);
        const target = new URL("/", worker.location.origin); target.hash = new URLSearchParams({ session: login.accountKey + "~" + hint.agentId }).toString();
        const clients = await worker.clients.matchAll({ type: "window", includeUncontrolled: true });
        const current = clients.find(client => new URL(client.url).origin === target.origin && new URL(client.url).pathname === "/");
        if (current) { await current.navigate(target.href); await current.focus(); } else await worker.clients.openWindow(target.href);
      } catch { /* A stale notification cannot restore access or navigate externally. */ }
    })());
  });
  worker.addEventListener("pushsubscriptionchange", event => {
    event.waitUntil((async () => {
      const records = (await pushInstallations.list()).filter(i => i.scope === worker.registration.scope);
      const subscription = await worker.registration.pushManager.getSubscription();
      for (const record of records) {
        const login = await vault.get(record.loginId); if (!login || record.sessionMarker !== (login.pushSession ?? login.id)) { await pushInstallations.remove(record.loginId, record.computerId); continue; }
        const result = subscription ? await hub(login, "/api/v1/push/subscriptions", post({ provider: "web-push", computerId: record.computerId, installationId: record.installationId, clientId: login.id, subscription: subscription.toJSON() })) : await hub(login, "/api/v1/push/subscriptions/" + record.installationId + "/" + record.computerId, { method: "DELETE" });
        if (result.ok) { record.endpoint = subscription?.endpoint ?? ""; await pushInstallations.put(record); }
      }
    })().catch(() => {}));
  });
}
