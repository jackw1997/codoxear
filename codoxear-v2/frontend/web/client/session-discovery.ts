import { configureSessionDiscoveryObserver } from "../legacy/app_session_refresh.js";

/** The catalog owns discovery status; empty list presentation never infers it. */
export function installSessionDiscovery(connect: () => void) {
  let state: any = { state: "loading" };
  let retry: () => Promise<unknown> = async () => {};
  let panel: HTMLElement | undefined;
  const render = () => {
    const wrap = document.querySelector<HTMLElement>(".sessions");
    const hint = document.querySelector<HTMLElement>(".sidebarEmptyHint");
    const chatCopy = document.querySelector<HTMLElement>(".chatEmptyCopy");
    const text =
      state.state === "loading"
        ? "Discovering sessions…"
        : state.state === "signed_out"
          ? "Connect a hub to discover sessions."
          : state.state === "unavailable"
            ? "Session discovery unavailable."
            : state.state === "partial"
              ? "Some sessions could not be discovered."
              : "No sessions yet";
    if (hint && hint.textContent !== text) hint.textContent = text;
    const emptyText =
      state.state === "ready"
        ? "Start a session to begin a conversation."
        : text;
    if (chatCopy && chatCopy.textContent !== emptyText)
      chatCopy.textContent = emptyText;
    const host = wrap ?? hint?.parentElement;
    if (!host) return;
    if (state.state === "ready") {
      panel?.remove();
      panel = undefined;
      return;
    }
    if (!panel) {
      panel = document.createElement("div");
      panel.className = "sessionDiscoveryStatus muted";
      panel.setAttribute("role", "status");
      host.prepend(panel);
    }
    if (!panel.isConnected) host.prepend(panel);
    const summary =
      (state.errors ?? [])
        .map((e: any) => [e.name, e.message].filter(Boolean).join(": "))
        .join(" ") || text;
    if (panel.dataset.summary === summary) return;
    panel.dataset.summary = summary;
    panel.replaceChildren();
    const message = document.createElement("p");
    message.textContent = summary;
    const reconnect = document.createElement("button");
    reconnect.type = "button";
    reconnect.textContent = "Hubs & computers";
    reconnect.onclick = connect;
    const again = document.createElement("button");
    again.type = "button";
    again.textContent = "Retry discovery";
    again.onclick = async () => {
      again.disabled = true;
      try {
        await retry();
      } catch {
      } finally {
        again.disabled = false;
      }
    };
    panel.append(message);
    if (state.state !== "loading") panel.append(reconnect, again);
  };
  configureSessionDiscoveryObserver(
    (next: any, refresh: () => Promise<unknown>) => {
      state = next;
      retry = refresh;
      render();
    },
  );
  const observer = new MutationObserver(render);
  observer.observe(document.body, { childList: true, subtree: true });
  render();
  return () => {
    observer.disconnect();
    configureSessionDiscoveryObserver(null);
    panel?.remove();
  };
}
