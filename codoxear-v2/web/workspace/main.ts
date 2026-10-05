import {
  createApplicationController,
  configureAppUrlResolver,
} from "../legacy/app_application.js";
import { configureTailCacheFactory } from "../legacy/app_transcript.js";
import { configureSessionAccessCheck } from "../legacy/app_session_lifecycle.js";
import { conversationCache } from "./cache.js";
import { clearAccountStorage } from "./storage.js";
if (!location.pathname.startsWith("/workspace/")) {
  const context = JSON.parse(
    document.getElementById("codoxear-connection-context")!.textContent!,
  );
  const directory = await (await fetch("/api/agent-directory")).json();
  const localId = new URLSearchParams(location.hash.slice(1)).get("session");
  const agent = directory.agents.find(
    (a: { computerId: string; localId: string }) =>
      a.computerId === context.computerId && a.localId === localId,
  );
  location.replace(
    "/workspace/" + (agent ? "#session=" + encodeURIComponent(agent.id) : ""),
  );
  await new Promise(() => {});
}
const connectionContext = JSON.parse(
  document.getElementById("codoxear-connection-context")!.textContent!,
);
if (location.origin !== connectionContext.issuer) {
  location.replace(connectionContext.issuer + "/workspace/" + location.hash);
  await new Promise(() => {});
}
configureTailCacheFactory(() => conversationCache);
configureSessionAccessCheck(async (id: string) => {
  const response = await fetch(
    `/workspace/api/sessions/${encodeURIComponent(id)}/access`,
    { cache: "no-store" },
  );
  if (!response.ok) {
    conversationCache.delete(id);
    throw Object.assign(
      new Error(
        "Agent access could not be confirmed. Refresh or sign in again.",
      ),
      { status: response.status },
    );
  }
});
if (location.pathname.startsWith("/workspace/"))
  configureAppUrlResolver((path: string, base: URL) => {
    const url = new URL(path.replace(/^\//, ""), base);
    if (
      url.pathname.startsWith("/workspace/api/") &&
      !/^\/workspace\/api\/(sessions|me)$/.test(url.pathname) &&
      !url.pathname.startsWith("/workspace/api/sessions/")
    ) {
      const agent = new URLSearchParams(location.hash.slice(1)).get("session");
      if (agent) url.searchParams.set("__agent", agent);
    }
    return url.href;
  });
const controller = createApplicationController({
  windowTarget: window,
  documentTarget: document,
  navigatorTarget: navigator,
  EventSource,
  AbortController,
  renderAuthentication(root: HTMLElement) {
    conversationCache.clear();
    clearAccountStorage();
    const box = document.createElement("section");
    box.className = "loginWrap";
    const content = document.createElement("div");
    content.className = "login";
    const title = document.createElement("h1");
    title.textContent = "Sign in to Codoxear";
    const link = document.createElement("a");
    link.href = "/auth/start";
    link.textContent = "Continue with your Codoxear account";
    content.append(title, link);
    box.append(content);
    root.replaceChildren(box);
  },
});
try {
  await controller.api("/api/me");
  controller.renderApp();
  // @ts-expect-error Shared navigation is JavaScript; runtime services stay TypeScript.
  const { attachAgentNavigation } = await import("../shared/workspace.js");
  await attachAgentNavigation({ conversationCache, clearAccountStorage });
} catch (error) {
  if (
    error &&
    typeof error === "object" &&
    "status" in error &&
    error.status === 401
  )
    controller.renderLogin(() => {});
  else {
    const message = document.createElement("p");
    message.role = "alert";
    message.textContent =
      error instanceof Error ? error.message : "Unable to open this workspace";
    document.getElementById("root")?.replaceChildren(message);
  }
}
