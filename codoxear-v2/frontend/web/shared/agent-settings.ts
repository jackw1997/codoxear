import { discoveredEfforts, type ProviderCatalog, type ProviderModel } from "./agent-options.js";

/** Browser-owned session settings protocol; catalogs come from this session's provider. */
export type AgentSettings = {
  model: string | null;
  reasoning_effort: string | null;
  provider: string | null;
  editable: boolean;
  reason: string | null;
  catalog: ProviderCatalog | null;
};
type Store = { get(field: string): unknown; subscribe(field: string, listener: () => void): () => void };
type Api = (path: string, options?: { method?: string; body?: unknown; signal?: AbortSignal }) => Promise<any>;

/** Owns settings DOM, requests, draft choices and store subscriptions. */
export function createAgentSettingsEditor(options: {
  api: Api;
  sessionState: Store;
  sessionCatalog: Store;
  getSessionInfo: (sid: string) => { codoxear_actions?: string[] } | null;
  onSaved: (sid: string) => Promise<void>;
}) {
  const element = document.createElement("section");
  element.className = "agentSettings";
  element.setAttribute("aria-label", "Agent settings");
  element.innerHTML = `<div class="agentSettingRow"><div><span class="agentSettingLabel">Model</span><div class="agentSettingCurrent" id="diagCurrentModel">Not reported</div></div><button type="button" id="diagChangeModel" data-change-model>Change model</button></div><div class="agentSettingRow"><div><span class="agentSettingLabel">Reasoning effort</span><div class="agentSettingCurrent" id="diagCurrentEffort">Not reported</div></div><button type="button" id="diagChangeEffort" data-change-effort>Change reasoning effort</button></div><form hidden><h3 data-editor-title>Change model</h3><p class="agentSettingsProvider" hidden></p><label data-model-field><select id="diagModelSelect" aria-label="Model" name="model"></select><input type="text" data-model-input aria-label="Model name" placeholder="Model name" autocomplete="off" spellcheck="false"></label><label data-effort-field hidden><select id="diagEffortSelect" aria-label="Reasoning effort" name="effort"></select></label><div class="agentSettingsDiscover"><button type="button" data-discover>Discover models</button></div><p class="agentSettingsHint" data-effort-hint></p><p class="agentSettingsHint" data-apply-hint></p><div class="agentSettingsActions"><button type="submit" class="primary" data-save>Apply change</button><button type="button" data-cancel>Cancel change</button></div></form><p class="agentSettingsHint" id="diagSettingsStatus" role="status" aria-live="polite" data-status></p><p class="agentSettingsError" id="diagSettingsError" role="alert" data-error></p><button type="button" data-reload hidden>Reload settings</button>`;

  const providerElement = document.createElement("div");
  providerElement.className = "detailsRow";
  const providerLabel = document.createElement("div");
  providerLabel.className = "detailsLabel";
  providerLabel.textContent = "Provider";
  const providerValue = document.createElement("div");
  providerValue.className = "detailsValue";
  providerValue.textContent = "Loading…";
  providerElement.append(providerLabel, providerValue);
  const form = element.querySelector("form")!;
  const model = element.querySelector<HTMLSelectElement>("[name=model]")!;
  const effort = element.querySelector<HTMLSelectElement>("[name=effort]")!;
  const modelInput = element.querySelector<HTMLInputElement>("[data-model-input]")!;
  const modelField = element.querySelector<HTMLElement>("[data-model-field]")!;
  const effortField = element.querySelector<HTMLElement>("[data-effort-field]")!;
  const editorTitle = element.querySelector<HTMLElement>("[data-editor-title]")!;
  const applyHint = element.querySelector<HTMLElement>("[data-apply-hint]")!;
  const provider = element.querySelector<HTMLElement>(".agentSettingsProvider")!;
  const hint = element.querySelector<HTMLElement>("[data-effort-hint]")!;
  const status = element.querySelector<HTMLElement>("[data-status]")!;
  const error = element.querySelector<HTMLElement>("[data-error]")!;
  const discover = element.querySelector<HTMLButtonElement>("[data-discover]")!;
  const reload = element.querySelector<HTMLButtonElement>("[data-reload]")!;
  const save = element.querySelector<HTMLButtonElement>("[data-save]")!;
  const cancel = element.querySelector<HTMLButtonElement>("[data-cancel]")!;
  const changeModel = element.querySelector<HTMLButtonElement>("[data-change-model]")!;
  const changeEffort = element.querySelector<HTMLButtonElement>("[data-change-effort]")!;
  const currentModel = element.querySelector<HTMLElement>("#diagCurrentModel")!;
  const currentEffort = element.querySelector<HTMLElement>("#diagCurrentEffort")!;
  let editing: "model" | "effort" | null = null;
  let sid: string | null = null, generation = 0;
  let request: AbortController | undefined;
  let snapshot: AgentSettings | undefined;
  let catalog: ProviderCatalog | null = null;
  let pending = false, uncertain = false;
  let availabilityMessage = "";
  const active = (id: string, epoch: number) => sid === id && generation === epoch && options.sessionState.get("selected") === id;
  const busy = () => ["running", "sending", "turnOpen"].some(field => !!options.sessionState.get(field));
  const readOnly = () => {
    const info = sid ? options.getSessionInfo(sid) : null;
    const actions = info?.codoxear_actions;
    return !info || Array.isArray(actions) && !actions.includes("send");
  };
  const choices = (node: HTMLSelectElement, values: string[], selected: string | null, prompt: string) => {
    node.replaceChildren();
    const empty = new Option(prompt, "");
    empty.disabled = true;
    node.add(empty);
    for (const value of [...new Set(values)].filter(value => value && value !== "default")) node.add(new Option(value, value));
    node.value = selected && values.includes(selected) ? selected : "";
  };
  const selectedModel = (): ProviderModel | undefined => catalog?.models.find(row => row.id === model.value);
  const levels = () => discoveredEfforts({}, selectedModel());
  const populateEffort = (selected: string | null) => {
    const known = selectedModel();
    const available = levels();
    const advertised = known?.supported_reasoning_efforts ?? [];
    const displayed = [...new Set([...available, ...advertised])];
    choices(effort, displayed, selected, "Choose thinking effort");
    for (const option of effort.options) if (option.value && !available.includes(option.value)) option.disabled = true;
    hint.textContent = known?.supports_reasoning === false
      ? "This model does not support thinking effort."
      : advertised.some(value => !available.includes(value)) ? "Disabled thinking efforts are advertised by this provider but cannot be submitted exactly by this runtime."
      : !available.length ? "Thinking effort choices are unavailable for this model. Discover models or reload settings." : "";
    updateAvailability();
  };
  const populate = (draft?: { model: string; effort: string }) => {
    const values = catalog?.models.map(row => row.id) ?? [];
    if (snapshot?.model && !values.includes(snapshot.model)) values.unshift(snapshot.model);
    choices(model, values, draft?.model ?? snapshot?.model ?? null, "Choose model");
    modelInput.value = model.value;
    provider.textContent = `Provider: ${snapshot?.provider || "Unknown"}`;
    providerValue.textContent = snapshot?.provider || "Not available";
    currentModel.textContent = snapshot?.model || "Not reported";
    currentEffort.textContent = snapshot?.reasoning_effort || (catalog?.models.find(row => row.id === snapshot?.model)?.supports_reasoning === false ? "Not supported" : "Not reported");
    populateEffort(draft?.effort ?? snapshot?.reasoning_effort ?? null);
  };
  function updateAvailability() {
    const unavailable = !sid || pending || uncertain || readOnly() || busy() || !snapshot?.editable;
    model.disabled = unavailable;
    modelInput.disabled = unavailable;
    effort.disabled = unavailable || !levels().length;
    discover.disabled = !sid || pending || readOnly() || busy() || !snapshot?.provider;
    reload.disabled = !sid || pending;
    changeModel.disabled = unavailable;
    changeEffort.disabled = unavailable || !levels().length;
    cancel.disabled = pending;
    reload.hidden = !error.textContent && !uncertain && !!snapshot?.editable;
    form.hidden = !editing;
    modelField.hidden = editing !== "model";
    effortField.hidden = editing !== "effort";
    editorTitle.textContent = editing === "effort" ? "Change reasoning effort" : "Change model";
    applyHint.textContent = editing === "model" ? (selectedModel()?.supports_reasoning === false ? "This model does not support reasoning effort; applying it clears that setting. Your current draft stays unchanged." : `Keeps reasoning effort ${snapshot?.reasoning_effort || "as reported by the agent"}. Your current draft stays unchanged.`) : model.value !== snapshot?.model ? `Applies model ${model.value} with the selected reasoning effort. Your current draft stays unchanged.` : "Applies to this session. Your current draft stays unchanged.";
    discover.setAttribute("aria-description", `Discover models from saved provider: ${snapshot?.provider || "unknown"}`);
    save.textContent = pending ? "Applying…" : "Apply change";
    const valid = !!model.value && (selectedModel()?.supports_reasoning === false || !!effort.value && (levels().includes(effort.value) || editing === "model" && !selectedModel() && effort.value === snapshot?.reasoning_effort));
    const changed = model.value !== snapshot?.model || (selectedModel()?.supports_reasoning === false ? null : effort.value) !== snapshot?.reasoning_effort;
    save.disabled = unavailable || !valid || !changed;
    if (editing === "model" && model.value && selectedModel()?.supports_reasoning !== false && levels().length && !effort.value) hint.textContent = "This model requires a compatible reasoning effort. Use Change reasoning effort above before applying.";
    element.setAttribute("aria-busy", String(pending));
    if (!pending && !uncertain) {
      const message = readOnly() ? "Read-only access: agent settings cannot be changed."
        : busy() ? "Wait for the agent to finish before changing settings."
        : snapshot && !snapshot.editable ? snapshot.reason || "This agent does not support changing settings here." : "";
      if (message || status.textContent === availabilityMessage) status.textContent = message;
      availabilityMessage = message;
    }
  }
  async function load(preserveDraft = false) {
    if (!sid) return;
    const id = sid, epoch = ++generation;
    const draft = preserveDraft ? { model: model.value, effort: effort.value } : undefined;
    request?.abort();
    const controller = new AbortController();
    request = controller;
    pending = true;
    error.textContent = "";
    status.textContent = "Loading agent settings…";
    updateAvailability();
    try {
      const result: AgentSettings = await options.api(`/api/sessions/${encodeURIComponent(id)}/settings`, { signal: controller.signal });
      if (!active(id, epoch)) return;
      snapshot = result;
      catalog = result.catalog;
      uncertain = false;
      status.textContent = "";
      populate(draft);
    } catch (cause) {
      if (!active(id, epoch) || controller.signal.aborted) return;
      snapshot = undefined;
      providerValue.textContent = "Not available";
      currentModel.textContent = "Unavailable";
      currentEffort.textContent = "Unavailable";
      error.textContent = `Could not load agent settings: ${cause instanceof Error ? cause.message : "unknown error"}`;
      status.textContent = "";
    } finally {
      if (active(id, epoch)) { pending = false; updateAvailability(); }
    }
  }
  discover.onclick = async () => {
    if (!sid || discover.disabled) return;
    const id = sid, epoch = generation, draft = { model: model.value, effort: effort.value };
    const controller = new AbortController();
    request = controller;
    pending = true;
    error.textContent = "";
    status.textContent = "Discovering models from this agent’s saved provider…";
    updateAvailability();
    try {
      const result: ProviderCatalog = await options.api(`/api/sessions/${encodeURIComponent(id)}/provider-models`, { signal: controller.signal });
      if (!active(id, epoch)) return;
      catalog = result;
      populate(draft);
      status.textContent = result.models.length ? `Models discovered. Choose ${editing === "effort" ? "a reasoning effort" : "a model"}, then Apply change.` : "No models were returned by this provider.";
    } catch (cause) {
      if (!active(id, epoch) || controller.signal.aborted) return;
      error.textContent = `Model discovery failed: ${cause instanceof Error ? cause.message : "unknown error"}`;
      status.textContent = "";
    } finally {
      if (active(id, epoch)) { pending = false; updateAvailability(); }
    }
  };
  form.onsubmit = async event => {
    event.preventDefault();
    updateAvailability();
    if (!sid || save.disabled) return;
    const id = sid, epoch = generation;
    const body = { model: model.value, reasoning_effort: selectedModel()?.supports_reasoning === false ? null : effort.value };
    const controller = new AbortController();
    request = controller;
    pending = true;
    error.textContent = "";
    status.textContent = "Saving agent settings…";
    updateAvailability();
    try {
      const result = await options.api(`/api/sessions/${encodeURIComponent(id)}/settings`, { method: "POST", body, signal: controller.signal });
      if (!active(id, epoch)) return;
      if (result.accepted !== true || result.model !== body.model || result.reasoning_effort !== body.reasoning_effort) throw new Error("The agent did not confirm the requested settings. Reload settings before trying again.");
      const confirmed: AgentSettings = await options.api(`/api/sessions/${encodeURIComponent(id)}/settings`, { signal: controller.signal });
      if (!active(id, epoch)) return;
      if (confirmed.model !== body.model || confirmed.reasoning_effort !== body.reasoning_effort) throw new Error("The saved settings could not be confirmed. Reload settings before trying again.");
      snapshot = confirmed;
      // Preserve deliberate discovery while updating authoritative current values.
      populate();
      editing = null;
      status.textContent = "Agent settings saved.";
      pending = false;
      updateAvailability();
      // Settings are already confirmed; a secondary catalog refresh cannot
      // delay completion or turn a successful save into an uncertain write.
      void options.onSaved(id).catch(() => {
        if (active(id, epoch) && !pending && !editing) status.textContent = "Agent settings saved. Reopen Details to refresh session information.";
      });
    } catch (cause) {
      if (!active(id, epoch) || controller.signal.aborted) return;
      // A network error after dispatch cannot establish whether the write committed.
      uncertain = true;
      error.textContent = `${cause instanceof Error ? cause.message : "Could not save settings."} Reload settings to confirm the current values.`;
      status.textContent = "";
    } finally {
      if (active(id, epoch)) { pending = false; updateAvailability(); if (!editing && !changeModel.disabled) changeModel.focus(); }
    }
  };
  model.onchange = () => { modelInput.value = model.value; error.textContent = ""; populateEffort(snapshot?.reasoning_effort ?? null); };
  modelInput.oninput = () => {
    const value = modelInput.value.trim();
    if (value && !Array.from(model.options).some(option => option.value === value)) model.add(new Option(value, value));
    model.value = value;
    error.textContent = "";
    populateEffort(snapshot?.reasoning_effort ?? null);
  };
  effort.onchange = () => { error.textContent = ""; updateAvailability(); };
  reload.onclick = () => void load();
  const begin = (control: HTMLSelectElement) => {
    if (pending || uncertain || readOnly() || busy() || !snapshot?.editable) return;
    const draft = editing ? { model: model.value, effort: effort.value } : undefined;
    editing = control === model ? "model" : "effort";
    error.textContent = "";
    status.textContent = "";
    populate(draft);
    updateAvailability();
    control.focus();
  };
  changeModel.onclick = () => begin(model);
  changeEffort.onclick = () => begin(effort);
  cancel.onclick = () => {
    if (pending) return;
    editing = null;
    error.textContent = "";
    populate();
    updateAvailability();
    changeModel.focus();
  };
  const close = () => {
    sid = null;
    generation++;
    request?.abort();
    request = undefined;
    snapshot = undefined;
    catalog = null;
    pending = false;
    uncertain = false;
    editing = null;
    form.hidden = true;
  };
  let wasBusy = busy();
  const syncRuntime = () => {
    if (sid && options.sessionState.get("selected") !== sid) { close(); return; }
    const nowBusy = busy();
    if (sid && wasBusy && !nowBusy && snapshot && !snapshot.editable && !pending) void load(true);
    wasBusy = nowBusy;
    updateAvailability();
  };
  const unsubscribe = [
    ...["selected", "running", "sending", "turnOpen"].map(field => options.sessionState.subscribe(field, syncRuntime)),
    options.sessionCatalog.subscribe("sessionIndex", updateAvailability),
  ];
  return Object.freeze({
    element,
    providerElement,
    confirmedProvider: () => snapshot?.provider ?? null,
    open(id: string) { close(); sid = id; wasBusy = busy(); choices(model, [], null, "Loading models…"); choices(effort, [], null, "Loading thinking effort…"); providerValue.textContent = "Loading…"; currentModel.textContent = "Loading…"; currentEffort.textContent = "Loading…"; provider.textContent = ""; hint.textContent = ""; void load(); },
    close,
    dispose() { close(); for (const stop of unsubscribe) stop(); element.remove(); providerElement.remove(); },
  });
}
