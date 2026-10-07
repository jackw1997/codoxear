/** An open client can outlive a deployment. Offer a reload without discarding work. */
export function installClientUpdates() {
  const current = (window as Window & { CODOXEAR_ASSET_VERSION?: string }).CODOXEAR_ASSET_VERSION;
  if (!current) return;
  let checking = false;
  let notice: HTMLElement | undefined;
  async function check() {
    if (checking || document.visibilityState === "hidden") return;
    checking = true;
    try {
      const response = await fetch("/client-release.json", { cache: "no-store", signal: AbortSignal.timeout(5000) });
      if (!response.ok) return;
      const release = await response.json() as { version?: unknown };
      if (typeof release.version !== "string" || !/^[a-f0-9]{16}$/.test(release.version) || release.version === current || notice) return;
      notice = document.createElement("aside");
      notice.className = "clientUpdateNotice";
      notice.setAttribute("role", "status");
      const message = document.createElement("span");
      message.textContent = "A Codoxear update is available.";
      const reload = document.createElement("button");
      reload.type = "button";
      reload.className = "primary";
      reload.textContent = "Reload";
      reload.onclick = () => location.reload();
      notice.append(message, reload);
      document.body.append(notice);
    } catch {
      // A version check never interrupts a customer's Hub connection or draft.
    } finally {
      checking = false;
    }
  }
  const interval = setInterval(() => void check(), 60000);
  const visible = () => void check();
  document.addEventListener("visibilitychange", visible);
  window.addEventListener("pageshow", visible);
  window.addEventListener("focus", visible);
  void check();
  return () => {
    clearInterval(interval);
    document.removeEventListener("visibilitychange", visible);
    window.removeEventListener("pageshow", visible);
    window.removeEventListener("focus", visible);
    notice?.remove();
  };
}
