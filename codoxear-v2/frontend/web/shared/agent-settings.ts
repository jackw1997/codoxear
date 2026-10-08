import { discoveredEfforts, type ProviderCatalog, type ProviderModel } from "./agent-options.js";
import { mountDropdown, createButton } from "../ui/index.js";

export type AgentSettings = {
  model: string | null; reasoning_effort: string | null; provider: string | null;
  editable: boolean; reason: string | null; catalog: ProviderCatalog | null;
};
type Store = { get(field: string): unknown; subscribe(field: string, listener: () => void): () => void };
type Api = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<any>;

/** The displayed model/effort are owned dropdowns; explicit drafts commit together. */
export function createAgentSettingsEditor(options: {
  api: Api; sessionState: Store; sessionCatalog: Store;
  getSessionInfo: (sid: string) => { codoxear_actions?: string[] } | null;
  onSaved: (sid: string) => Promise<void>;
}) {
  const element = document.createElement("section");
  element.className = "agentSettings";
  element.setAttribute("aria-label", "Agent settings");
  element.innerHTML = `<form><label class="agentSettingRow"><span class="agentSettingLabel">Model</span><select id="diagModelSelect" name="model" aria-label="Model"></select></label><label class="agentSettingRow"><span class="agentSettingLabel">Reasoning effort</span><select id="diagEffortSelect" name="effort" aria-label="Reasoning effort"></select></label><div class="agentSettingsDiscover"></div><p class="agentSettingsHint" data-effort-hint></p><div class="agentSettingsActions" hidden></div></form><p class="agentSettingsHint" id="diagSettingsStatus" role="status" aria-live="polite"></p><p class="agentSettingsError" id="diagSettingsError" role="alert"></p>`;
  const form = element.querySelector("form")!;
  const model = element.querySelector<HTMLSelectElement>("[name=model]")!;
  const effort = element.querySelector<HTMLSelectElement>("[name=effort]")!;
  const modelDropdown = mountDropdown(model, { label: "Model", variant: "inline", placeholder: "Loading…" });
  const effortDropdown = mountDropdown(effort, { label: "Reasoning effort", variant: "inline", placeholder: "Loading…" });
  modelDropdown.trigger.id = "diagCurrentModel";
  effortDropdown.trigger.id = "diagCurrentEffort";
  const discover = createButton({ text: "Discover models", variant: "ghost" });
  const reload = createButton({ text: "Reload settings" });
  const apply = createButton({ text: "Apply change", type: "submit", variant: "primary" });
  const cancel = createButton({ text: "Cancel change" });
  const actions = element.querySelector<HTMLElement>(".agentSettingsActions")!;
  actions.append(apply, cancel);
  element.querySelector(".agentSettingsDiscover")!.append(discover);
  element.append(reload);
  const hint = element.querySelector<HTMLElement>("[data-effort-hint]")!;
  const status = element.querySelector<HTMLElement>("#diagSettingsStatus")!;
  const error = element.querySelector<HTMLElement>("#diagSettingsError")!;
  const providerElement = document.createElement("div");
  providerElement.className = "detailsRow";
  const providerLabel = document.createElement("div"); providerLabel.className = "detailsLabel"; providerLabel.textContent = "Provider";
  const providerValue = document.createElement("div"); providerValue.className = "detailsValue";
  providerElement.append(providerLabel, providerValue);
  let sid: string | null = null, generation = 0;
  let request: AbortController | undefined;
  let snapshot: AgentSettings | undefined, catalog: ProviderCatalog | null = null;
  let applying = false, pending = false, uncertain = false, discovered = false, availabilityMessage = "";
  const active = (id: string, epoch: number) => sid === id && generation === epoch && options.sessionState.get("selected") === id;
  const busy = () => ["running", "sending", "turnOpen"].some(field => !!options.sessionState.get(field));
  const readOnly = () => {
    const info = sid ? options.getSessionInfo(sid) : null;
    return !info || Array.isArray(info.codoxear_actions) && !info.codoxear_actions.includes("send");
  };
  const selectedModel = (): ProviderModel | undefined => catalog?.models.find(row => row.id === model.value);
  const levels = () => discoveredEfforts({}, selectedModel());
  const draftEffort = () => selectedModel()?.supports_reasoning === false ? null : effort.value || null;
  const changed = () => !!snapshot && (model.value !== snapshot.model || draftEffort() !== snapshot.reasoning_effort);
  function choices(node: HTMLSelectElement, values: string[], selected: string | null, placeholder: string) {
    node.replaceChildren();
    const prompt = new Option(placeholder, ""); prompt.disabled = true; node.add(prompt);
    for (const value of [...new Set(values)].filter(value => value && value !== "default")) node.add(new Option(value, value));
    node.value = selected && values.includes(selected) ? selected : "";
  }
  function populateEffort(selected: string | null) {
    const entry = selectedModel(), available = levels(), advertised = entry?.supported_reasoning_efforts ?? [];
    choices(effort, [...new Set([...available, ...advertised, ...(selected && entry?.supports_reasoning !== false ? [selected] : [])])], selected, entry?.supports_reasoning === false ? "Not supported" : "Choose reasoning effort");
    for (const option of effort.options) if (option.value && !available.includes(option.value)) option.disabled = true;
    hint.textContent = entry?.supports_reasoning === false ? "This model does not support reasoning effort."
      : advertised.some(value => !available.includes(value)) ? "Disabled levels are advertised but cannot be submitted exactly by this runtime."
      : !available.length ? "Reasoning levels are unknown. Discover models to check this provider." : "";
    updateAvailability();
  }
  function populate(draft?: { model: string; effort: string | null }) {
    const models = catalog?.models.map(row => row.id) ?? [];
    if (snapshot?.model && !models.includes(snapshot.model)) models.unshift(snapshot.model);
    choices(model, models, draft?.model ?? snapshot?.model ?? null, "Choose model");
    providerValue.textContent = snapshot?.provider || "Not available";
    populateEffort(draft ? draft.effort : snapshot?.reasoning_effort ?? null);
  }
  function updateAvailability() {
    const unavailable = !sid || pending || uncertain || readOnly() || busy() || !snapshot?.editable;
    model.disabled = unavailable;
    effort.disabled = unavailable || !levels().length;
    discover.disabled = !sid || pending || readOnly() || busy() || !snapshot?.provider;
    discover.setAttribute("aria-description", `Discover models from saved provider: ${snapshot?.provider || "unknown"}`);
    reload.hidden = !uncertain && !error.textContent; reload.disabled = pending;
    actions.hidden = !changed() && !applying;
    apply.disabled = unavailable || !model.value || !changed() || !(selectedModel()?.supports_reasoning === false || !!effort.value && levels().includes(effort.value));
    cancel.disabled = pending;
    apply.textContent = applying ? "Applying…" : "Apply change";
    element.setAttribute("aria-busy", String(pending));
    modelDropdown.refresh(); effortDropdown.refresh();
    if (!pending && !uncertain) {
      const message = readOnly() ? "Read-only access: agent settings cannot be changed." : busy() ? "Wait for the agent to finish before changing settings."
        : snapshot && !snapshot.editable ? snapshot.reason || "This agent cannot change settings here." : changed() ? "Unsaved settings. Apply change to confirm, or cancel." : "";
      if (message || status.textContent === availabilityMessage) status.textContent = message;
      availabilityMessage = message;
    }
  }
  async function load(preserveDraft = false) {
    if (!sid) return;
    const id = sid, epoch = ++generation, draft = preserveDraft ? { model: model.value, effort: draftEffort() } : undefined;
    request?.abort(); const controller = new AbortController(); request = controller;
    pending = true; error.textContent = ""; status.textContent = "Loading agent settings…"; updateAvailability();
    try {
      const result: AgentSettings = await options.api(`/api/sessions/${encodeURIComponent(id)}/settings`, { signal: controller.signal });
      if (!active(id, epoch)) return;
      snapshot = result; catalog = result.catalog; discovered = !!catalog?.metadata_available || (catalog?.models.length ?? 0) > 1;
      uncertain = false; status.textContent = ""; populate(draft);
    } catch (cause) {
      if (!active(id, epoch) || controller.signal.aborted) return;
      snapshot = undefined; providerValue.textContent = "Not available";
      error.textContent = `Could not load agent settings: ${cause instanceof Error ? cause.message : "unknown error"}`; status.textContent = "";
    } finally { if (active(id, epoch)) { pending = false; updateAvailability(); } }
  }
  async function discoverModels(reopen = false) {
    if (!sid || discover.disabled) return;
    const id = sid, epoch = generation, draft = { model: model.value, effort: draftEffort() };
    const controller = new AbortController(); request = controller;
    pending = true; error.textContent = ""; status.textContent = "Discovering models from the saved provider…"; updateAvailability();
    try {
      const result: ProviderCatalog = await options.api(`/api/sessions/${encodeURIComponent(id)}/provider-models`, { signal: controller.signal });
      if (!active(id, epoch)) return;
      catalog = result; discovered = true; populate(draft);
      status.textContent = result.models.length ? "Models discovered." : "No models returned by this provider.";
    } catch (cause) {
      if (!active(id, epoch) || controller.signal.aborted) return;
      error.textContent = `Model discovery failed: ${cause instanceof Error ? cause.message : "unknown error"}`; status.textContent = "";
    } finally { if (active(id, epoch)) { pending = false; updateAvailability(); if (reopen) modelDropdown.open(); } }
  }
  discover.onclick = () => void discoverModels(true);
  // Opening the displayed model is an explicit discovery action for older saved profiles.
  const discoverOnOpen = () => { if (!discovered && !pending && snapshot?.provider) void discoverModels(true); };
  modelDropdown.trigger.addEventListener("click", discoverOnOpen);
  modelDropdown.trigger.addEventListener("keydown", event => { if (["ArrowDown", "ArrowUp", "Enter", " "].includes(event.key)) discoverOnOpen(); });
  model.onchange = () => { error.textContent = ""; status.textContent = ""; populateEffort(effort.value || snapshot?.reasoning_effort || null); };
  effort.onchange = () => { error.textContent = ""; status.textContent = ""; updateAvailability(); };
  cancel.onclick = () => { if (pending) return; error.textContent = ""; status.textContent = ""; populate(); modelDropdown.trigger.focus(); };
  reload.onclick = () => void load();
  form.onsubmit = async event => {
    event.preventDefault(); updateAvailability(); if (!sid || apply.disabled) return;
    const id = sid, epoch = generation, body = { model: model.value, reasoning_effort: draftEffort() };
    const controller = new AbortController(); request = controller;
    applying = true; pending = true; error.textContent = ""; status.textContent = "Applying agent settings…"; updateAvailability();
    try {
      const result = await options.api(`/api/sessions/${encodeURIComponent(id)}/settings`, { method: "POST", body, signal: controller.signal });
      if (!active(id, epoch)) return;
      if (result.accepted !== true || result.model !== body.model || result.reasoning_effort !== body.reasoning_effort) throw new Error("The agent did not confirm these settings. Reload settings before retrying.");
      const confirmed: AgentSettings = await options.api(`/api/sessions/${encodeURIComponent(id)}/settings`, { signal: controller.signal });
      if (!active(id, epoch)) return;
      if (confirmed.model !== body.model || confirmed.reasoning_effort !== body.reasoning_effort) throw new Error("The saved settings could not be confirmed. Reload settings before retrying.");
      snapshot = confirmed; populate(); pending = false; status.textContent = "Agent settings saved."; updateAvailability();
      void options.onSaved(id).catch(() => { if (active(id, epoch) && !pending && !changed()) status.textContent = "Settings saved. Reopen Details to refresh session information."; });
    } catch (cause) {
      if (!active(id, epoch) || controller.signal.aborted) return;
      uncertain = true; error.textContent = `${cause instanceof Error ? cause.message : "Could not apply settings."} Reload settings to confirm current values.`; status.textContent = "";
    } finally { if (active(id, epoch)) { applying = false; pending = false; updateAvailability(); if (!changed() && !model.disabled) modelDropdown.trigger.focus(); } }
  };
  function close() {
    sid = null; generation++; request?.abort(); request = undefined; snapshot = undefined; catalog = null;
    applying = false; pending = false; uncertain = false; discovered = false; modelDropdown.close(); effortDropdown.close();
  }
  let wasBusy = busy();
  const syncRuntime = () => {
    if (sid && options.sessionState.get("selected") !== sid) { close(); return; }
    const now = busy(); if (sid && wasBusy && !now && snapshot && !snapshot.editable && !pending) void load(true);
    wasBusy = now; updateAvailability();
  };
  const unsubscribe = [...["selected", "running", "sending", "turnOpen"].map(field => options.sessionState.subscribe(field, syncRuntime)), options.sessionCatalog.subscribe("sessionIndex", updateAvailability)];
  return Object.freeze({ element, providerElement, confirmedProvider: () => snapshot?.provider ?? null,
    open(id: string) { close(); sid = id; wasBusy = busy(); choices(model, [], null, "Loading…"); choices(effort, [], null, "Loading…"); status.textContent = ""; error.textContent = ""; providerValue.textContent = "Loading…"; void load(); },
    close, dispose() { close(); for (const stop of unsubscribe) stop(); modelDropdown.destroy(); effortDropdown.destroy(); element.remove(); providerElement.remove(); },
  });
}
