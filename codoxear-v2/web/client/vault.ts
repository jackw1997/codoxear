// Credentials stay in this installation's IndexedDB. They are never put in
// URLs, localStorage, screenshots, or a Codoxear account service.
export interface HubLogin {
  id: string;
  accountKey: string;
  origin: string;
  hubId: string;
  name: string;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  identity: {
    name: string;
    method: string;
    key: string;
    identities?: unknown[];
  };
}
let opening: Promise<IDBDatabase> | undefined;
function database() {
  return (opening ??= new Promise((resolve, reject) => {
    const request = indexedDB.open("codoxear-client-identities", 1);
    request.onupgradeneeded = () =>
      request.result.createObjectStore("credentials");
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  }));
}
async function op<T>(
  mode: IDBTransactionMode,
  work: (s: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("credentials", mode);
    const r = work(tx.objectStore("credentials"));
    tx.oncomplete = () => resolve(r.result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}
export const vault = {
  list: () => op<HubLogin[]>("readonly", (s) => s.getAll()),
  get: (id: string) => op<HubLogin | undefined>("readonly", (s) => s.get(id)),
  put: (login: HubLogin) => op("readwrite", (s) => s.put(login, login.id)),
  remove: (id: string) => op("readwrite", (s) => s.delete(id)),
};
