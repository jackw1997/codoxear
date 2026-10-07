import { agentCreationDialog } from "./agent-creation.js";
import { boundedSet, storageNotice } from "./local-storage.js";
export const escapeHtml = (value) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export const brand = `<svg class="sidebarLogo brandLogo" viewBox="130 92 284 328" aria-hidden="true"><path class="brandLogoPage" d="M142 104h172l88 88v216H142z" stroke-width="24" stroke-linejoin="round"/><path class="brandLogoFold" d="M314 104v88h88" stroke-width="24" stroke-linejoin="round"/><path class="brandLogoTerminal" d="m204 268 38 36-38 36M270 340h50" fill="none" stroke-width="24"/></svg><span>Codoxear</span>`;
export function stylesheet(path) {
  if (document.querySelector(`link[data-shared-style="${path}"]`)) return;
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = path;
  link.dataset.sharedStyle = path;
  document.head.append(link);
}
let theme;
export async function appearance() {
  if (theme) return theme;
  const modulePath = "/appearance/app_theme.js";
  const { createThemeController } = await import(/* @vite-ignore */ modulePath);
  theme = createThemeController({
    documentTarget: document,
    storageGetItem: (k) => localStorage.getItem(k),
    storageSetItem: (k, v) => {
      try {
        boundedSet(localStorage, k, v);
        return true;
      } catch {
        storageNotice(true);
        return false;
      }
    },
    storageRemoveItem: (k) => localStorage.removeItem(k),
    matchMedia: (q) => matchMedia(q),
    versionedAssetPath: (p) => "/appearance/" + p,
  });
  return theme;
}
export async function showAppearance() {
  const controller = await appearance();
  const dialog = document.createElement("dialog");
  dialog.className = "account-dialog";
  dialog.innerHTML = `<form method="dialog"><header><h2>Appearance</h2><button aria-label="Close appearance">×</button></header><label>Theme<select name="family" aria-label="Theme">${controller.families.map((f) => `<option value="${f}">${f[0].toUpperCase() + f.slice(1)}</option>`).join("")}</select></label><label>Color mode<select name="mode" aria-label="Color mode"><option value="system">System</option><option value="light">Light</option><option value="dark">Dark</option></select></label></form>`;
  const state = controller.get();
  dialog.querySelector("[name=family]").value = state.family;
  dialog.querySelector("[name=mode]").value = state.mode;
  dialog.addEventListener("change", () =>
    controller.applyTheme({
      family: dialog.querySelector("[name=family]").value,
      mode: dialog.querySelector("[name=mode]").value,
    }),
  );
  dialog.addEventListener("close", () => dialog.remove());
  document.body.append(dialog);
  dialog.showModal();
}
export function agentUrl(agent, currentHub = false) {
  if (currentHub === "workspace" && (!agent.localId || agent.state !== "ready"))
    return `/agent-settings/?settings=${encodeURIComponent(agent.id)}`;
  if (currentHub === "workspace" && agent.localId && agent.state === "ready")
    return `/workspace/#session=${encodeURIComponent(agent.id)}`;
  if (
    currentHub &&
    agent.origin === location.origin &&
    agent.localId &&
    agent.state === "ready"
  )
    return `/workspace/#session=${encodeURIComponent(agent.id)}`;
  return `${agent.origin}/auth/start?agent=${encodeURIComponent(agent.id)}`;
}
export function agentRows(agents, currentId = null, currentHub = false) {
  return agents
    .map(
      (a) =>
        `<a class="directory-agent${a.id === currentId ? " selected" : ""}" data-directory-agent="${escapeHtml(a.id)}" href="${escapeHtml(agentUrl(a, currentHub))}"${a.id === currentId ? ' aria-current="page"' : ""}><span class="directory-agent-title"><span class="directory-dot" aria-hidden="true"></span><strong>${escapeHtml(a.name)}</strong><span class="directory-backend">${escapeHtml(a.backend)}</span></span><span class="directory-agent-meta">${escapeHtml(a.computerName)} <span aria-hidden="true">·</span> ${escapeHtml(a.hubName)}</span>${a.access === "read_only" ? '<span class="directory-agent-meta">Read-only</span>' : ""}</a>`,
    )
    .join("");
}
export function shell(
  root,
  { name, email, issuer, agents, currentHub = false, onNew },
) {
  root.innerHTML = `<div class="account-shell"><aside class="account-sidebar" aria-label="Agents"><header class="account-brand">${brand}<button class="account-close" aria-label="Close agents">×</button></header><div class="directory-tools"><button class="directory-new" data-new-agent>+ <span>New agent</span></button><label class="directory-search"><input type="search" placeholder="Search agents" aria-label="Search agents"></label></div><nav class="directory-list" aria-label="Your agents">${agentRows(agents, null, currentHub) || '<p class="directory-hint">Your agents will appear here.</p>'}</nav><footer class="directory-footer"><a href="${escapeHtml(issuer)}/?settings=1">Settings</a><button data-appearance>Appearance</button><span class="directory-user" title="${escapeHtml(email)}">${escapeHtml(name)}</span></footer></aside><main class="account-main"><header class="account-topbar"><button class="account-menu" aria-label="Open agents">☰</button><span>Your agents</span><a href="${escapeHtml(issuer)}/?settings=1">Settings</a></header><div class="account-empty"><div class="account-mark">${brand}</div><h1>What would you like to work on?</h1><p>Continue with an agent, or start a new one.</p><button class="primary" data-new-agent>New agent</button></div></main></div>`;
  root.querySelectorAll("[data-new-agent]").forEach((b) => (b.onclick = onNew));
  root.querySelector("[data-appearance]").onclick = () => void showAppearance();
  root.querySelector(".account-menu").onclick = () =>
    root.querySelector(".account-shell").classList.add("agents-open");
  root.querySelector(".account-close").onclick = () =>
    root.querySelector(".account-shell").classList.remove("agents-open");
  root.querySelector('[aria-label="Search agents"]').oninput = (e) => {
    const q = e.target.value.toLowerCase();
    root
      .querySelectorAll("[data-directory-agent]")
      .forEach(
        (row) => (row.hidden = !row.textContent.toLowerCase().includes(q)),
      );
  };
}
export function placementDialog(placements, proceed, options = {}) {
  return agentCreationDialog(placements, proceed, {
    loadDefaults: async (placement, signal) => {
      const prefix =
        placement.origin === location.origin
          ? ""
          : `/gateway/hubs/${encodeURIComponent(placement.hubId)}`;
      const response = await fetch(
        `${prefix}/api/computers/${encodeURIComponent(placement.computerId)}/launch-defaults`,
        { signal, cache: "no-store" },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Computer unavailable");
      return value;
    },
    loadResumeCandidates: async (placement, backend, cwd, signal) => {
      const prefix =
        placement.origin === location.origin
          ? ""
          : `/gateway/hubs/${encodeURIComponent(placement.hubId)}`;
      const response = await fetch(
        `${prefix}/api/computers/${encodeURIComponent(placement.computerId)}/resume-candidates?backend=${encodeURIComponent(backend)}&cwd=${encodeURIComponent(cwd)}`,
        { signal, cache: "no-store" },
      );
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Computer unavailable");
      return value;
    },
    ...options,
  });
}
