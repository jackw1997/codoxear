// Credentials stay in this installation's IndexedDB. They are never put in
// URLs, localStorage, screenshots, or a Codoxear account service.
export interface HubLogin {
  id: string;
  accountKey: string;
  active?: boolean;
  selectionId?: string;
  origin: string;
  hubId: string;
  name: string;
  role?: "owner" | "admin" | "member" | null;
  accountId: string;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  pushSession?: string;
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
  activeList: () => activeVault.activeList(),
  isActive: (id: string) => activeVault.isActive(id),
  isSelectionActive: (id: string, generation: string) =>
    activeVault.isSelectionActive(id, generation),
  activate: (id: string) => activeVault.activate(id),
  updateTokens: (login: HubLogin, generation: string) =>
    activeVault.updateTokens(login, generation),
  removeIfSelection: (id: string, generation: string) =>
    activeVault.removeIfSelection(id, generation),
};

// The generation fences removal/replacement of a credential. Every saved
// credential remains connected, including multiple identities on one Hub.
export const selectionId = (login: HubLogin) =>
  login.selectionId ?? "initial:" + login.id;
export function hubScope(login: Pick<HubLogin, "origin" | "hubId">) {
  const bytes = new TextEncoder().encode(
    JSON.stringify([login.origin, login.hubId]),
  );
  return (
    "hub-" +
    btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "")
  );
}
async function activeTransaction(
  work: (rows: HubLogin[], store: IDBObjectStore) => boolean,
): Promise<boolean> {
  const db = await database();
  return new Promise((resolve, reject) => {
    const tx = db.transaction("credentials", "readwrite"),
      store = tx.objectStore("credentials"),
      request = store.getAll();
    let result = false;
    request.onsuccess = () => {
      try {
        result = work(request.result, store);
      } catch (error) {
        tx.abort();
        reject(error);
      }
    };
    tx.oncomplete = () => resolve(result);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () =>
      reject(tx.error ?? new Error("Credential update failed"));
  });
}
export const activeVault = {
  activeList: () => vault.list(),
  isActive: async (id: string) => !!(await vault.get(id)),
  isSelectionActive: async (id: string, generation: string) =>
    (await vault.list()).some(
      (row) => row.id === id && selectionId(row) === generation,
    ),
  activate: async (id: string) => {
    const generation = crypto.randomUUID();
    const ok = await activeTransaction((rows, store) => {
      const target = rows.find((row) => row.id === id);
      if (!target) return false;
      store.put({ ...target, selectionId: generation }, target.id);
      return true;
    });
    if (!ok) throw new Error("This identity is no longer saved");
  },
  removeIfSelection: (id: string, generation: string) =>
    activeTransaction((rows, store) => {
      if (!rows.some((row) => row.id === id && selectionId(row) === generation))
        return false;
      store.delete(id);
      return true;
    }),
  updateTokens: (login: HubLogin, generation: string) =>
    activeTransaction((rows, store) => {
      const current = rows.find(
        (row) => row.id === login.id && selectionId(row) === generation,
      );
      if (!current) return false;
      store.put(
        {
          ...current,
          accessToken: login.accessToken,
          refreshToken: login.refreshToken,
          expiresAt: login.expiresAt,
        },
        current.id,
      );
      return true;
    }),
};
