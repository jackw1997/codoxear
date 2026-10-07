import { installSessionDiscovery } from "./session-discovery.js";
import { ensureClientTransport } from "./transport-ready.js";
import {
  createApplicationController,
  configureAppUrlResolver,
} from "../legacy/app_application.js";
import { configureTailCacheFactory } from "../legacy/app_transcript.js";
import { configureSessionAccessCheck } from "../legacy/app_session_lifecycle.js";
import { clearAccountStorage } from "../workspace/storage.js";
import { conversationCache } from "../workspace/cache.js";
import { vault } from "./vault.js";
import { esc, loginHeading } from "./views.js";
import { openConnections, openAgentAccess } from "./connections.js";
import { stylesheet } from "../shared/ui.js";
import {
  selectedWorkspace,
  updateWorkspaceSelection,
  workspaceAccessContext,
} from "../shared/workspace-selection.js";
import { configureFileAccessContext } from "../legacy/app_file_access_context.js";
async function startClient() {
  let switching = false;
  navigator.serviceWorker.addEventListener("message", (event) => {
    if (event.data?.type !== "codoxear-identity-changed" || switching) return;
    switching = true;
    conversationCache.clear();
    clearAccountStorage();
    history.replaceState(null, "", location.pathname + location.search);
    location.reload();
  });
  configureFileAccessContext(workspaceAccessContext);
  stylesheet("/agent-creation.css");
  await ensureClientTransport();
  let directory: any = { agents: [], placements: [] };
  let placement = "";
  configureAppUrlResolver((path: string, base: URL) => {
    const url = new URL(path.replace(/^\//, ""), base);
    const session =
      /^\/api\/sessions\/([^/]+)\//.exec(url.pathname)?.[1] ??
      new URLSearchParams(location.hash.slice(1)).get("session");
    const workspace = selectedWorkspace(
      session ? decodeURIComponent(session) : null,
    );
    if (
      workspace &&
      /\/api\/sessions\/[^/]+\/(?:file\/|git\/|inject_|send|attachments|pending_attachment)/.test(
        url.pathname,
      )
    )
      url.searchParams.set("workspace_id", workspace);
    if (url.pathname === "/api/sessions") {
      const source = url.searchParams.get("__source");
      const selected =
        source ?? new URLSearchParams(location.hash.slice(1)).get("session");
      url.searchParams.delete("__source");
      const agent = directory.agents.find((a: any) => a.id === selected);
      const target = agent
        ? agent.loginId + "~" + agent.computerId
        : source
          ? "unavailable"
          : placement;
      if (target) url.searchParams.set("__placement", target);
    }
    if (
      url.pathname.startsWith("/api/") &&
      !url.pathname.startsWith("/api/sessions")
    ) {
      const id = new URLSearchParams(location.hash.slice(1)).get("session");
      if (id) url.searchParams.set("__agent", id);
    }
    return url.href;
  });
  configureTailCacheFactory(() => conversationCache);
  configureSessionAccessCheck(async (id: string) => {
    const r = await fetch(
      "/api/sessions/" + encodeURIComponent(id) + "/access",
    );
    if (!r.ok) {
      conversationCache.delete(id);
      throw Object.assign(
        new Error(
          "Agent access is no longer available. Check Hubs & computers.",
        ),
        { status: r.status },
      );
    }
  });
  const controller = createApplicationController({
    windowTarget: window,
    documentTarget: document,
    navigatorTarget: navigator,
    EventSource,
    AbortController,
    renderAuthentication(root: HTMLElement, onAuthed: () => void) {
      conversationCache.clear();
      clearAccountStorage();
      directory = { agents: [], placements: [] };
      placement = "";
      const button = document.createElement("button");
      button.textContent = "Connect a hub";
      button.onclick = () => {
        onAuthed();
        installControls();
        openConnections(refresh, () => {
          conversationCache.clear();
          clearAccountStorage();
        });
      };
      const wrap = document.createElement("div");
      wrap.className = "connectionLoginWrap";
      const panel = document.createElement("section");
      panel.className = "connectionLogin";
      panel.setAttribute("aria-label", "Connect to your agents");
      panel.innerHTML =
        loginHeading(
          "Connect to your agents",
          "Hub connections removed from this device.",
        ) +
        '<p class="connectionHint">Connect a hub to pick up where you left off.</p>';
      button.className = "primary";
      panel.append(button);
      wrap.append(panel);
      root.append(wrap);
    },
  });
  installSessionDiscovery(() =>
    openConnections(refresh, () => {
      conversationCache.clear();
      clearAccountStorage();
    }),
  );
  controller.renderApp();
  async function refresh() {
    const response = await fetch("/api/client/directory");
    if (!response.ok)
      throw new Error("Hub identity changed; retry the directory");
    directory = await response.json();
    updateWorkspaceSelection(directory.agents);
    conversationCache.setDirectory(directory.agents);
    const chosen =
      directory.placements.find(
        (p: any) => p.loginId + "~" + p.computerId === placement,
      ) ?? directory.placements[0];
    placement = chosen ? chosen.loginId + "~" + chosen.computerId : "";
    const status = document.getElementById("clientHubStatus");
    if (status)
      status.textContent =
        directory.errors
          ?.map((e: any) => e.name + ": " + e.message)
          .join("; ") ?? "";
  }
  function installControls() {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = "Hubs & computers";
    button.onclick = () => {
      openConnections(refresh, () => {
        conversationCache.clear();
        clearAccountStorage();
      });
    };
    document.querySelector(".sidebar footer")!.append(button);
    const settings = document.createElement("button");
    settings.type = "button";
    settings.textContent = "Agent access";
    settings.onclick = () => {
      const id = new URLSearchParams(location.hash.slice(1)).get("session");
      const agent = directory.agents.find((a: any) => a.id === id);
      if (agent) {
        void openAgentAccess(agent);
      }
    };
    document.querySelector("#editViewer .formBody")?.append(settings);
  }
  installControls();
  await refresh();
  setInterval(() => {
    void refresh().catch(() => {});
  }, 5000);
  if (!(await vault.list()).length)
    openConnections(refresh, () => {
      conversationCache.clear();
      clearAccountStorage();
    });
}

void startClient().catch((error: unknown) => {
  const detail = {
    message:
      error instanceof Error
        ? error.message
        : "Codoxear could not start. Reload this page to retry.",
    source: "",
    lineno: 0,
    colno: 0,
    stack: "",
    time: Date.now(),
  };
  const startupWindow = window as Window & {
    __codoxearLoadError?: typeof detail;
    __codoxearRenderLoadErrorFallback?: (failure: typeof detail) => void;
  };
  startupWindow.__codoxearLoadError = detail;
  startupWindow.__codoxearRenderLoadErrorFallback?.(detail);
});
