export const LOCAL_BUDGET = 100 * 1024;
const owned = (key: string) =>
  key.startsWith('["codoxear-v2"') || key.startsWith("codoxear.ui.");
export function localBytes(storage: Storage) {
  let bytes = 0;
  for (let i = 0; i < storage.length; i++) {
    const key = storage.key(i)!;
    if (owned(key))
      bytes += 2 * (key.length + (storage.getItem(key)?.length ?? 0));
  }
  return bytes;
}
export function boundedSet(storage: Storage, key: string, value: string) {
  const old = storage.getItem(key);
  const next =
    localBytes(storage) -
    (old === null ? 0 : 2 * (key.length + old.length)) +
    2 * (key.length + value.length);
  if (next > LOCAL_BUDGET)
    throw new DOMException(
      "Local draft and preference storage is full",
      "QuotaExceededError",
    );
  storage.setItem(key, value);
}
export function storageNotice(full: boolean) {
  if (typeof document === "undefined") return;
  const old = document.querySelector("[data-storage-full]");
  if (!full) {
    old?.remove();
    return;
  }
  if (old) return;
  const banner = document.createElement("div");
  banner.dataset.storageFull = "1";
  banner.role = "alert";
  banner.className = "storage-notice";
  banner.textContent =
    "Local storage is full (100 KB). Keep this page open. Shorten your draft or clear saved drafts before switching agents.";
  const button = document.createElement("button");
  button.textContent = "Clear saved drafts";
  button.onclick = () => {
    for (const key of Object.keys(localStorage))
      if (owned(key) && key.includes("codexweb.draft."))
        localStorage.removeItem(key);
    storageNotice(false);
    document
      .querySelector<HTMLTextAreaElement>('textarea[aria-label="Message"]')
      ?.dispatchEvent(new Event("input", { bubbles: true }));
  };
  banner.append(button);
  document.body.append(banner);
}
