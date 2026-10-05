import { stylesheet, agentRows, escapeHtml, placementDialog } from "./ui.js";
export async function attachAgentNavigation({
  conversationCache,
  clearAccountStorage,
}) {
  stylesheet("/appearance/shell.css");
  const context = JSON.parse(
    document.getElementById("codoxear-connection-context").textContent,
  );
  const sidebar = document.querySelector(".sidebar");
  if (!sidebar) return;
  document.body.classList.add("directory-workspace");
  const nav = document.createElement("section");
  nav.className = "directory-workspace-nav";
  nav.innerHTML = `<div class="directory-tools"><a class="directory-new" href="/?new=1&computer=${encodeURIComponent(context.computerId)}">+ New agent</a><label class="directory-search"><input type="search" aria-label="Search agents" placeholder="Search agents"></label></div><nav class="directory-list" aria-label="Your agents"></nav><footer class="directory-footer"><a href="${escapeHtml(context.issuer)}/?settings=1">Settings</a><button type="button" data-agent-settings>Agent settings</button><button type="button" data-workspace-appearance>Appearance</button></footer><p class="directory-hint" role="status"></p>`;
  sidebar.insertBefore(nav, sidebar.querySelector("footer"));
  let placements = [],
    agents = [],
    disposed = false,
    timer,
    rendered = "";
  const current = () =>
    agents.find(
      (a) =>
        a.id === new URLSearchParams(location.hash.slice(1)).get("session"),
    );
  const render = () => {
    const q = nav.querySelector("input").value.toLowerCase();
    const html = agentRows(
      agents.filter((a) =>
        (a.name + " " + a.computerName + " " + a.hubName)
          .toLowerCase()
          .includes(q),
      ),
      current()?.id,
      "workspace",
    );
    if (html !== rendered) {
      nav.querySelector(".directory-list").innerHTML = html;
      rendered = html;
    }
  };
  nav.querySelector("input").oninput = render;
  nav.querySelector("[data-agent-settings]").onclick = () => {
    const a = current();
    if (a)
      location.assign(
        context.issuer +
          "/agent-settings/?settings=" +
          encodeURIComponent(a.id),
      );
  };
  // The original Settings owns appearance inside the workspace.
  nav.querySelector("[data-workspace-appearance]").onclick = () =>
    document.querySelector("#settingsBtnSide")?.click();
  nav.addEventListener("click", (event) => {
    const link = event.target.closest("[data-directory-agent]");
    if (
      !link ||
      event.ctrlKey ||
      event.metaKey ||
      event.shiftKey ||
      event.button
    )
      return;
    const a = agents.find((a) => a.id === link.dataset.directoryAgent);
    if (!a?.localId || a.state !== "ready") return;
    event.preventDefault();
    if (document.querySelector("[data-storage-full]")) return;
    location.hash = "session=" + encodeURIComponent(a.id);
  });
  async function refresh() {
    try {
      const r = await fetch("/api/agent-directory");
      if ([401, 403].includes(r.status)) {
        conversationCache.clear();
        clearAccountStorage();
        location.replace("/auth/start");
        return;
      }
      if (!r.ok)
        throw new Error(
          "Unable to refresh agents. Sign in again if your access changed.",
        );
      const d = await r.json();
      if (disposed) return;
      const selected = current();
      const lost = selected && !d.agents.some((a) => a.id === selected.id);
      for (const old of agents)
        if (d.agents.find((a) => a.id === old.id)?.access !== old.access)
          conversationCache.delete(old.id);
      conversationCache.setDirectory(d.agents);
      agents = d.agents;
      placements = d.placements;
      if (lost) {
        conversationCache.clear();
        location.replace("/workspace/");
        return;
      }
      updateLinks();
      nav.querySelector("[role=status]").textContent = "";
    } catch (error) {
      if (!disposed)
        nav.querySelector("[role=status]").textContent = error.message;
    }
  }
  const newLink = nav.querySelector(".directory-new");
  newLink.href = "#new-agent";
  newLink.onclick = (event) => {
    event.preventDefault();
    placementDialog(placements, async (placement, values) => {
      const r = await fetch(
        `/gateway/hubs/${encodeURIComponent(placement.hubId)}/api/computers/${encodeURIComponent(placement.computerId)}/agents`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(values),
        },
      );
      const agent = await r.json();
      if (!r.ok) throw new Error(agent.error ?? "Unable to create agent");
      if (agent.state !== "ready" || !agent.localId)
        throw new Error(
          "Agent launch is " +
            agent.state +
            ". Check its settings before retrying.",
        );
      await refresh();
      location.hash = "session=" + encodeURIComponent(agent.id);
    });
  };
  const updateLinks = render;
  addEventListener("hashchange", updateLinks);
  addEventListener(
    "beforeunload",
    () => {
      disposed = true;
      clearInterval(timer);
      removeEventListener("hashchange", updateLinks);
    },
    { once: true },
  );
  await refresh();
  timer = setInterval(refresh, 5000);
}
