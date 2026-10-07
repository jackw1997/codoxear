import {
  defaultsFor,
  providersFor,
  modelsFor,
  effortsFor,
  launchOptions,
  type Backend,
  type Catalog,
  type LaunchOptions,
} from "./agent-options.js";

export type Placement = {
  computerId: string;
  computerName: string;
  hubName: string;
  hubId?: string;
  origin?: string;
  loginId?: string;
};
export type AgentSelection = {
  name: string;
  backend: Backend;
  launch?: LaunchOptions;
};
export type ResumeCandidate = {
  session_id: string;
  alias?: string;
  first_user_message?: string;
};
export type CreationOptions = {
  loadResumeCandidates?: (
    placement: Placement,
    backend: Backend,
    cwd: string,
    signal: AbortSignal,
  ) => Promise<{ sessions: ResumeCandidate[] }>;
  loadDefaults?: (
    placement: Placement,
    signal: AbortSignal,
  ) => Promise<Catalog>;
  initialComputerId?: string;
  initialBackend?: Backend;
  initialName?: string;
  initialCwd?: string;
  initialHint?: string;
};
const escape = (value: unknown) =>
  String(value ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const labels: Record<string, string> = {
  __custom_api__: "Custom API",
  xhigh: "Extra high",
  max: "Maximum",
  ultra: "Ultra",
  off: "Off",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  auto: "Auto",
};

/** One form serves account, workspace and independent-client creation. */
export function agentCreationDialog(
  placements: Placement[],
  proceed: (placement: Placement, selection: AgentSelection) => Promise<void>,
  options: CreationOptions = {},
) {
  const dialog = document.createElement("dialog");
  const previousFocus = document.activeElement as HTMLElement | null;
  dialog.className = "account-dialog agent-creation";
  dialog.setAttribute("aria-label", "New agent");
  dialog.innerHTML = `<form><header><h2>New agent</h2><button type="button" aria-label="Close">×</button></header><div class="agent-creation-body"><label>Agent name<input name="name" required maxlength="120" placeholder="What are you working on?" autofocus></label><label>Computer &amp; hub<select name="placement" aria-label="Computer &amp; hub">${placements.map((p, i) => `<option value="${i}">${escape(p.computerName)} · ${escape(p.hubName)}</option>`).join("")}</select></label><label>Runtime<select name="backend" aria-label="Runtime"><option value="pi">Pi</option><option value="codex">Codex</option><option value="cc">Claude Code</option></select></label><label>Start<select name="start" aria-label="Start"><option value="new">New session</option><option value="resume">Resume saved session</option></select></label><div data-resume hidden><label>Session working directory<input name="resumeCwd" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Absolute directory on this computer"></label><label>Saved sessions<select name="resumeCandidate" aria-label="Saved sessions"><option value="">Enter a session ID below</option></select></label><button type="button" data-find-resume>Find saved sessions</button><p class="directory-hint" data-resume-status role="status"></p><label>Session ID<input name="resumeSessionId" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Backend session ID"></label><p class="directory-hint">Continue a saved session on the selected computer and runtime. Enter its backend session ID and original working directory. Private API keys and environment variables must be entered again when needed. Complete runtime setup and trust this directory in the CLI beforehand. A session already running cannot be resumed here.</p></div><p class="directory-hint" data-catalog-status role="status"></p><div class="agent-runtime-fields"><label>Provider<select name="provider" aria-label="Provider"></select></label><div data-provider-config hidden><label data-api-url>API URL<input name="apiUrl" type="url" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="https://your-provider.example/v1"></label><label>API key<input name="apiKey" type="password" maxlength="8192" autocomplete="off" spellcheck="false" placeholder="Provider API key"></label><label data-api-kind hidden>API compatibility<select name="api" aria-label="API compatibility"><option value="openai-completions">OpenAI Chat Completions</option><option value="openai-responses">OpenAI Responses</option><option value="anthropic-messages">Anthropic Messages</option></select></label><label data-image-support class="checkField" hidden><input name="imageSupport" type="checkbox"><span>Image support</span></label><p class="directory-hint" data-provider-hint></p></div><label>Model<select name="model" aria-label="Model"></select></label><label data-custom hidden>Custom model<input name="customModel" maxlength="200" autocomplete="off" spellcheck="false" placeholder="Model ID"></label><label data-effort>Reasoning<select name="effort" aria-label="Reasoning"></select></label><details><summary>More</summary><div data-fast hidden><label class="checkField"><input name="fast" type="checkbox"><span>Fast mode</span></label></div><label>Working directory<input name="cwd" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="Computer’s workspace"></label><details><summary>Advanced</summary><label data-command hidden>Claude command override<input name="command" maxlength="4096" autocomplete="off" spellcheck="false" placeholder="claude or /path/to/claude"></label><fieldset><legend>Environment variables</legend><div data-env-rows></div><button type="button" data-add-env>Add variable</button></fieldset></details></details></div><p class="directory-error" role="alert"></p>${placements.length ? "" : '<p class="directory-hint">Add a computer in Hubs &amp; computers to create an agent.</p>'}</div><footer><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Create agent</button></footer></form>`;
  const select = (name: string) =>
    dialog.querySelector<HTMLSelectElement>(`select[name=${name}]`)!;
  const input = (name: string) =>
    dialog.querySelector<HTMLInputElement>(`input[name=${name}]`)!;
  const form = dialog.querySelector("form")!;
  const button = dialog.querySelector<HTMLButtonElement>("[type=submit]")!;
  const status = dialog.querySelector<HTMLElement>("[data-catalog-status]")!;
  const alert = dialog.querySelector<HTMLElement>("[role=alert]")!;
  if (options.initialHint) {
    const hint = document.createElement("p");
    hint.className = "directory-hint";
    hint.textContent = options.initialHint;
    dialog.querySelector(".agent-creation-body")!.prepend(hint);
  }
  alert.id = "agent-creation-error";
  alert.setAttribute("aria-atomic", "true");
  let invalidField: HTMLInputElement | HTMLSelectElement | undefined;
  const clearError = () => {
    alert.textContent = "";
    invalidField?.removeAttribute("aria-invalid");
    invalidField?.removeAttribute("aria-describedby");
    invalidField = undefined;
  };
  const fieldError = (
    field: HTMLInputElement | HTMLSelectElement,
    message: string,
  ) => {
    invalidField = field;
    field.setAttribute("aria-invalid", "true");
    field.setAttribute("aria-describedby", alert.id);
    field.focus();
    throw new Error(message);
  };
  form.addEventListener("input", clearError);
  let catalog: Catalog = {},
    loading = false,
    submitting = false,
    request: AbortController | undefined;
  const backend = () => select("backend").value as Backend;
  const defaults = () => defaultsFor(catalog, backend());
  const selectedModel = () =>
    select("model").value === "__custom__"
      ? input("customModel").value
      : select("model").value;
  const setOptions = (
    node: HTMLSelectElement,
    choices: string[],
    first: string,
    custom = false,
  ) => {
    node.innerHTML = `<option value="" disabled>${escape(first)}</option>${choices
      .filter((v) => v !== "default")
      .map(
        (v) =>
          `<option value="${escape(v)}">${escape(labels[v] ?? v)}</option>`,
      )
      .join("")}${custom ? '<option value="__custom__">Custom…</option>' : ""}`;
  };
  let resumeRequest: AbortController | undefined;
  const clearResumeCandidates = () => {
    resumeRequest?.abort();
    select("resumeCandidate").innerHTML =
      '<option value="">Enter a session ID below</option>';
    dialog.querySelector<HTMLElement>("[data-resume-status]")!.textContent = "";
    dialog.querySelector<HTMLButtonElement>("[data-find-resume]")!.disabled =
      false;
  };
  const findResume =
    dialog.querySelector<HTMLButtonElement>("[data-find-resume]")!;
  findResume.onclick = async () => {
    clearResumeCandidates();
    const placement = placements[Number(select("placement").value)];
    const cwd = input("resumeCwd").value.trim();
    const message = dialog.querySelector<HTMLElement>("[data-resume-status]")!;
    if (!cwd.startsWith("/")) {
      message.textContent =
        "Enter the original absolute working directory first.";
      input("resumeCwd").focus();
      return;
    }
    if (!placement || !options.loadResumeCandidates) {
      message.textContent =
        "Session listing is unavailable. Enter the backend session ID.";
      return;
    }
    const pending = new AbortController();
    resumeRequest = pending;
    findResume.disabled = true;
    message.textContent = "Looking for saved sessions…";
    try {
      const result = await options.loadResumeCandidates(
        placement,
        backend(),
        cwd,
        pending.signal,
      );
      if (resumeRequest !== pending || pending.signal.aborted) return;
      select("resumeCandidate").innerHTML += result.sessions
        .map(
          (row) =>
            `<option value="${escape(row.session_id)}">${escape(row.alias || row.first_user_message || row.session_id)}</option>`,
        )
        .join("");
      message.textContent = result.sessions.length
        ? "Choose a saved session, or enter its ID below."
        : "No saved sessions found for this directory and runtime. You can enter a session ID below.";
    } catch (error) {
      if (resumeRequest !== pending || pending.signal.aborted) return;
      message.textContent = `Session listing unavailable. Enter the backend session ID. ${error instanceof Error ? error.message : ""}`;
    } finally {
      if (resumeRequest === pending) findResume.disabled = false;
    }
  };
  select("resumeCandidate").onchange = () => {
    input("resumeSessionId").value = select("resumeCandidate").value;
  };
  input("resumeCwd").addEventListener("input", clearResumeCandidates);
  const resuming = () => select("start").value === "resume";
  const updateStart = () => {
    dialog.querySelector<HTMLElement>("[data-resume]")!.hidden = !resuming();
    input("resumeSessionId").required = resuming();
    input("resumeCwd").required = resuming();
    input("cwd").disabled = resuming();
    dialog.querySelector("h2")!.textContent = resuming()
      ? "Resume agent"
      : "New agent";
    dialog.setAttribute(
      "aria-label",
      resuming() ? "Resume agent" : "New agent",
    );
    updateButton();
  };
  const updateButton = () => {
    // Computer configuration replaces these choices atomically. Do not allow
    // edits that the pending response would immediately overwrite.
    const pendingChoices = loading || submitting;
    select("backend").disabled = pendingChoices;
    const runtimeFields = dialog.querySelector<HTMLElement>(".agent-runtime-fields")!;
    runtimeFields.setAttribute("aria-busy", String(loading));
    for (const control of runtimeFields.querySelectorAll<
      HTMLInputElement | HTMLSelectElement | HTMLButtonElement
    >("input, select, button"))
      control.disabled = pendingChoices;
    input("cwd").disabled = pendingChoices || resuming();
    button.disabled = !placements.length || loading || submitting;
    button.textContent = submitting
      ? resuming()
        ? "Resuming agent…"
        : "Creating agent…"
      : loading
        ? "Loading choices…"
        : resuming()
          ? "Resume agent"
          : "Create agent";
  };
  const updateEffort = () => {
    const prior = select("effort").value;
    const efforts = effortsFor(
      defaults(),
      select("provider").value,
      selectedModel(),
    );
    setOptions(select("effort"), efforts, "Choose a reasoning level");
    select("effort").value = "";
    const configured = defaults().reasoning_effort;
    const sameConfiguredModel =
      select("provider").value ===
        (defaults().provider_choice ?? defaults().model_provider) &&
      selectedModel() === defaults().model;
    if (efforts.includes(prior)) select("effort").value = prior;
    else if (sameConfiguredModel && configured && efforts.includes(configured))
      select("effort").value = configured;
    else if (efforts.length === 1 && efforts[0] === "off")
      select("effort").value = "off";
    select("effort").required = !!efforts.length;
    dialog.querySelector<HTMLElement>("[data-effort]")!.hidden =
      !efforts.length;
    dialog.querySelector<HTMLElement>("[data-fast]")!.hidden =
      backend() === "pi";
  };
  const updateApiHint = () => {
    const anthropic =
      backend() === "cc" ||
      (backend() === "pi" && select("api").value === "anthropic-messages");
    input("apiUrl").placeholder = anthropic
      ? "https://your-provider.example"
      : "https://your-provider.example/v1";
  };
  const updateModel = () => {
    updateApiHint();
    const provider = select("provider").value;
    const customApi = provider === "__custom_api__";
    dialog.querySelector<HTMLElement>("[data-provider-config]")!.hidden =
      !customApi;
    dialog.querySelector<HTMLElement>("[data-api-url]")!.hidden = !customApi;
    dialog.querySelector<HTMLElement>("[data-api-kind]")!.hidden = !(
      customApi && backend() === "pi"
    );
    dialog.querySelector<HTMLElement>("[data-image-support]")!.hidden = !(
      customApi && backend() === "pi"
    );
    input("apiUrl").required = customApi;
    input("apiKey").required = customApi;
    dialog.querySelector<HTMLElement>("[data-provider-hint]")!.textContent =
      customApi
        ? backend() === "cc"
          ? "Use an Anthropic Messages compatible endpoint."
          : backend() === "codex"
            ? "Use an OpenAI Responses compatible endpoint."
            : "Choose the API supported by your endpoint."
        : "";
    setOptions(
      select("model"),
      modelsFor(defaults(), provider),
      "Choose a model",
      true,
    );
    select("model").value = "";
    const configuredProvider =
      defaults().provider_choice ?? defaults().model_provider;
    if (customApi) select("model").value = "__custom__";
    else if (
      provider === configuredProvider &&
      defaults().model &&
      modelsFor(defaults(), provider).includes(defaults().model!)
    )
      select("model").value = defaults().model!;
    select("model").required = true;
    input("customModel").value = "";
    input("customModel").required = customApi;
    dialog.querySelector<HTMLElement>("[data-custom]")!.hidden = !customApi;
    select("effort").value = "";
    updateEffort();
  };
  const clearProvider = () => {
    input("apiUrl").value = "";
    input("apiKey").value = "";
    input("imageSupport").checked = false;
    select("api").value = "openai-completions";
  };
  const updateRuntime = () => {
    clearProvider();
    input("command").value = "";
    dialog.querySelector("[data-env-rows]")!.replaceChildren();
    dialog.querySelector<HTMLElement>("[data-command]")!.hidden =
      backend() !== "cc";
    setOptions(
      select("provider"),
      providersFor(defaults(), backend()),
      "Choose a provider",
    );
    select("provider").value = "";
    select("provider").required = true;
    const configured = defaults().provider_choice ?? defaults().model_provider;
    if (configured && providersFor(defaults(), backend()).includes(configured))
      select("provider").value = configured;
    input("fast").checked = false;
    updateModel();
  };
  async function load() {
    request?.abort();
    const pending = new AbortController();
    request = pending;
    catalog = {};
    loading = true;
    clearError();
    status.textContent = "Loading choices from this computer…";
    updateRuntime();
    updateButton();
    const placement = placements[Number(select("placement").value)];
    try {
      const loaded =
        placement && options.loadDefaults
          ? await options.loadDefaults(placement, pending.signal)
          : {};
      if (request !== pending || pending.signal.aborted) return;
      catalog = loaded;
      status.textContent = placement
        ? "Provider and model choices were read from this computer’s configuration."
        : "";
    } catch (error) {
      if (request !== pending || pending.signal.aborted) return;
      status.textContent = `Computer choices could not be loaded. ${error instanceof Error ? error.message : "Try another computer."}`;
    } finally {
      if (request === pending && !pending.signal.aborted) {
        loading = false;
        updateRuntime();
        updateButton();
      }
    }
  }
  select("start").onchange = updateStart;
  select("placement").onchange = () => {
    clearResumeCandidates();
    input("resumeSessionId").value = "";
    input("resumeCwd").value = "";
    input("cwd").value = "";
    void load();
  };
  select("backend").onchange = () => {
    clearResumeCandidates();
    input("resumeSessionId").value = "";
    updateRuntime();
  };
  select("provider").onchange = () => {
    clearProvider();
    updateModel();
  };
  dialog.querySelector<HTMLButtonElement>("[data-add-env]")!.onclick = () => {
    const row = document.createElement("div");
    row.className = "agent-env-row";
    row.innerHTML = `<label>Name<input data-env-key aria-label="Variable name" maxlength="200" autocomplete="off" spellcheck="false" placeholder="VARIABLE_NAME"></label><label>Value<input data-env-value type="password" aria-label="Variable value" maxlength="8192" autocomplete="off" spellcheck="false"></label><button type="button" aria-label="Remove variable">×</button>`;
    row.querySelector("button")!.onclick = () => {
      const next = row.nextElementSibling ?? row.previousElementSibling;
      row.remove();
      (
        next?.querySelector<HTMLInputElement>("input") ??
        dialog.querySelector<HTMLButtonElement>("[data-add-env]")
      )?.focus();
    };
    dialog.querySelector("[data-env-rows]")!.append(row);
    row.querySelector("input")!.focus();
  };
  select("model").onchange = () => {
    const custom = select("model").value === "__custom__";
    dialog.querySelector<HTMLElement>("[data-custom]")!.hidden = !custom;
    input("customModel").required = custom;
    updateEffort();
    if (custom) input("customModel").focus();
  };
  select("api").onchange = updateApiHint;
  input("customModel").oninput = updateEffort;
  form.onsubmit = async (event) => {
    event.preventDefault();
    if (button.disabled) return;
    const placement = placements[Number(select("placement").value)];
    if (!placement) return;
    clearError();
    try {
      if (!input("name").value.trim())
        fieldError(input("name"), "Enter an agent name.");
      if (!select("provider").value)
        fieldError(select("provider"), "Choose a provider.");
      if (!select("model").value)
        fieldError(select("model"), "Choose a model.");
      if (select("model").value === "__custom__" && !selectedModel().trim())
        fieldError(input("customModel"), "Enter a custom model ID.");
      if (resuming()) {
        if (!input("resumeSessionId").value.trim())
          fieldError(
            input("resumeSessionId"),
            "Enter the saved backend session ID.",
          );
        if (!input("resumeCwd").value.trim().startsWith("/"))
          fieldError(
            input("resumeCwd"),
            "Enter the session’s absolute working directory on this computer.",
          );
      }
      const envVars: Record<string, string> = {};
      for (const row of dialog.querySelectorAll(".agent-env-row")) {
        const key = row
          .querySelector<HTMLInputElement>("[data-env-key]")!
          .value.trim();
        const value =
          row.querySelector<HTMLInputElement>("[data-env-value]")!.value;
        if (!key && !value) continue;
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
          fieldError(
            row.querySelector<HTMLInputElement>("[data-env-key]")!,
            "Enter a valid environment variable name.",
          );
        if (Object.hasOwn(envVars, key))
          fieldError(
            row.querySelector<HTMLInputElement>("[data-env-key]")!,
            "Environment variable names must be unique.",
          );
        Object.defineProperty(envVars, key, { value, enumerable: true });
      }
      const launch = launchOptions(backend(), defaults(), {
        provider: select("provider").value,
        model: selectedModel(),
        effort: select("effort").value,
        fast: input("fast").checked,
        cwd: resuming() ? input("resumeCwd").value : input("cwd").value,
        apiUrl: input("apiUrl").value,
        apiKey: input("apiKey").value,
        api: select("api").value as
          "openai-completions" | "openai-responses" | "anthropic-messages",
        imageSupport: input("imageSupport").checked,
        envVars,
        command: input("command").value,
      });
      if (resuming())
        launch.resume_session_id = input("resumeSessionId").value.trim();
      submitting = true;
      updateButton();
      form.setAttribute("aria-busy", "true");
      status.textContent = resuming() ? "Resuming agent…" : "Creating agent…";
      for (const control of form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >("input, select, button"))
        control.disabled = true;
      await proceed(placement, {
        name: input("name").value.trim(),
        backend: backend(),
        ...(Object.keys(launch).length ? { launch } : {}),
      });
      dialog.close();
    } catch (error) {
      alert.textContent =
        error instanceof Error ? error.message : "Unable to create agent.";
    } finally {
      submitting = false;
      form.removeAttribute("aria-busy");
      for (const control of form.querySelectorAll<
        HTMLInputElement | HTMLSelectElement | HTMLButtonElement
      >("input, select, button"))
        control.disabled = false;
      if (dialog.open) status.textContent = "";
      updateStart();
    }
  };
  const close = () => {
    if (!submitting) dialog.close();
  };
  dialog.querySelector<HTMLButtonElement>("[aria-label=Close]")!.onclick =
    close;
  dialog.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = close;
  dialog.addEventListener("keydown", (event) => {
    // CloseWatcher can emit a noncancelable cancel after repeated Escape.
    // Consume the key before its native close action reaches this dialog.
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (event.key !== "Tab") return;
    const controls = [
      ...dialog.querySelectorAll<HTMLElement>(
        "button, input, select, summary, [tabindex]",
      ),
    ].filter(
      (node) =>
        node.tabIndex >= 0 &&
        !node.matches(":disabled") &&
        node.getClientRects().length,
    );
    const first = controls[0],
      last = controls.at(-1);
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last?.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first?.focus();
    }
  });
  dialog.addEventListener("cancel", (event) => {
    event.preventDefault();
  });
  dialog.addEventListener("close", () => {
    request?.abort();
    resumeRequest?.abort();
    form.reset();
    dialog.querySelector("[data-env-rows]")!.replaceChildren();
    dialog.remove();
    previousFocus?.focus();
  });
  const index = placements.findIndex(
    (p) => p.computerId === options.initialComputerId,
  );
  if (index >= 0) select("placement").value = String(index);
  select("backend").value = options.initialBackend ?? "pi";
  input("name").value = options.initialName ?? "";
  input("cwd").value = options.initialCwd ?? "";
  input("resumeCwd").value = options.initialCwd ?? "";
  updateStart();
  document.body.append(dialog);
  dialog.showModal();
  void load();
  return dialog;
}
