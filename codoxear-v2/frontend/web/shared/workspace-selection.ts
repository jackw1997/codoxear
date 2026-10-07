import { notifyFileAccessContext } from "../legacy/app_file_access_context.js";
type Agent = { id: string; workspaceGrants?: Array<{workspaceId: string}> };
let agents: Agent[] = [];
const choices = new Map<string, string>();
export function selectedWorkspace(id: string | null) {
  const grants = agents.find(a => a.id === id)?.workspaceGrants ?? [];
  if (!id || !grants.length) return undefined;
  const chosen = choices.get(id);
  return grants.find(g => g.workspaceId === chosen)?.workspaceId ?? grants.find(g => g.workspaceId === "default")?.workspaceId ?? grants[0]!.workspaceId;
}
export function workspaceAccessContext(id: string | null) {
  return JSON.stringify(agents.find(a => a.id === id)?.workspaceGrants?.find(g => g.workspaceId === selectedWorkspace(id)) ?? null);
}
function render() {
  const id = new URLSearchParams(location.hash.slice(1)).get("session");
  const grants = agents.find(a => a.id === id)?.workspaceGrants ?? [];
  let label = document.querySelector<HTMLLabelElement>("[data-workspace-selection]");
  if (grants.length < 2) { label?.remove(); return; }
  if (!label) {
    label = document.createElement("label"); label.dataset.workspaceSelection = "";
    label.textContent = "Approved workspace";
    const select = document.createElement("select"); select.setAttribute("aria-label", "Approved workspace");
    select.addEventListener("change", () => { const current = new URLSearchParams(location.hash.slice(1)).get("session"); if (current) { choices.set(current, select.value); notifyFileAccessContext(current); } });
    label.append(select);
    document.querySelector(".sidebar footer")?.append(label);
  }
  const select = label.querySelector("select")!;
  select.replaceChildren(...grants.map(g => { const option = document.createElement("option"); option.value = g.workspaceId; option.textContent = g.workspaceId === "default" ? "Default workspace" : g.workspaceId; return option; }));
  select.value = selectedWorkspace(id) ?? "default";
}
export function updateWorkspaceSelection(value: Agent[]) {
  const previous = new Map(agents.map(a => [a.id, workspaceAccessContext(a.id)]));
  agents = value;
  for (const id of new Set([...previous.keys(), ...agents.map(a => a.id)])) if (previous.get(id) !== workspaceAccessContext(id)) notifyFileAccessContext(id);
  render();
}
window.addEventListener("hashchange", render);
