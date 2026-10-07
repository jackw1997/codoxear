import { boundedSet, storageNotice } from "../shared/local-storage.js";
// Existing workspace controllers consume this facade. Drafts, cursors and local
// recovery can never cross identity/account/hub/computer contexts.
function scoped(): Storage | null {
  try {
    const node = document.getElementById("codoxear-connection-context");
    if (!node) throw new Error("Missing workspace context");
    const context = JSON.parse(node.textContent ?? "");
    const prefix =
      JSON.stringify([
        "codoxear-v2",
        context.issuer,
        context.accountId,
        context.hubId,
        context.computerId,
      ]) + ":";
    const source = window.localStorage;
    const account = JSON.stringify([
      context.issuer,
      context.accountId,
      context.scopeId,
    ]);
    if (source.getItem("codoxear.ui.account") !== account) {
      clearAccountStorage();
      boundedSet(source, "codoxear.ui.account", account);
    }
    const keys = () =>
      Array.from({ length: source.length }, (_, i) => source.key(i)).filter(
        (k): k is string => !!k?.startsWith(prefix),
      );
    return {
      get length() {
        return keys().length;
      },
      key(index: number) {
        return keys()[index]?.slice(prefix.length) ?? null;
      },
      getItem(key: string) {
        return source.getItem(
          key.startsWith("codoxear.ui.") ? key : prefix + key,
        );
      },
      setItem(key: string, value: string) {
        try {
          boundedSet(
            source,
            key.startsWith("codoxear.ui.") ? key : prefix + key,
            value,
          );
          if (key.startsWith("codexweb.draft.") && !key.endsWith("server_ts"))
            storageNotice(false);
        } catch (error) {
          storageNotice(true);
          throw error;
        }
      },
      removeItem(key: string) {
        source.removeItem(key.startsWith("codoxear.ui.") ? key : prefix + key);
      },
      clear() {
        for (const key of keys()) source.removeItem(key);
      },
    };
  } catch {
    return null;
  }
}
export const optionalLocalStorage = scoped;
export function getItem(key: string) {
  try {
    return scoped()?.getItem(String(key)) ?? null;
  } catch {
    return null;
  }
}
export function setItem(key: string, value: string) {
  try {
    const store = scoped();
    if (!store) return false;
    store.setItem(String(key), String(value));
    return true;
  } catch {
    return false;
  }
}
export function removeItem(key: string) {
  try {
    const store = scoped();
    if (!store) return false;
    store.removeItem(String(key));
    return true;
  } catch {
    return false;
  }
}

export function clearAccountStorage() {
  try {
    for (const key of Object.keys(localStorage))
      if (key.startsWith('["codoxear-v2"')) localStorage.removeItem(key);
  } catch {}
}
if (typeof window !== "undefined")
  window.addEventListener("beforeunload", (event) => {
    if (document.querySelector("[data-storage-full]")) {
      event.preventDefault();
      event.returnValue = "";
    }
  });
