import * as CodoxearModal from "./app_modal.js";
import * as CodoxearSessionHelpers from "./app_session_helpers.js";
import { createAgentSettingsEditor } from "../shared/agent-settings.js";


// Details/diagnostics modal authority. Owns every piece of Details/diagnostics
  // state that used to live as app.js locals (return-focus element and copy text)
  // plus the diag Copy conversation / Copy details click behavior, show/hide modal
  // behavior, and the rendering decisions for failed-launch (local recovery rows,
  // no API), live sessions (fetch /diagnostics, ignore stale responses), and the
  // error path.
  //
  // Pure helpers (sessionLaunchFailed) come from CodoxearSessionHelpers;
  // modal focus/isolation helpers come from CodoxearModal. Everything
  // that touches app-level runtime state (selected session, session index, API,
  // clipboard, toasts, recovery-text helpers, DOM element factory, modal
  // open/close coordination) is injected through createDiagnosticsController(options)
  // so the controller has no hidden coupling to app.js globals and can be exercised
  // in a VM with fakes.



  const sessionLaunchFailed = CodoxearSessionHelpers.sessionLaunchFailed;
  const isModalTargetOpen = CodoxearModal.isModalTargetOpen;
  const focusModalSurface = CodoxearModal.focusModalSurface;
  const restoreModalFocus = CodoxearModal.restoreModalFocus;

  function requireFunction(value, name) {
    if (typeof value !== "function") throw new TypeError(`diagnostics controller dependency missing: ${name}`);
    return value;
  }

  function requireNode(value, name) {
    if (!value || typeof value !== "object" || !value.style) throw new TypeError(`diagnostics controller dependency missing: ${name}`);
    return value;
  }

  function requireString(value, name) {
    if (typeof value !== "string") throw new TypeError(`diagnostics controller dependency missing: ${name}`);
    return value;
  }

  function createDiagnosticsController(options = {}) {
    if (!options || typeof options !== "object") throw new TypeError("diagnostics controller dependency missing: options");

    // DOM nodes (created and owned by app.js).
    const diagBackdrop = requireNode(options.diagBackdrop, "diagBackdrop");
    const diagViewer = requireNode(options.diagViewer, "diagViewer");
    const diagContent = requireNode(options.diagContent, "diagContent");
    const diagStatus = requireNode(options.diagStatus, "diagStatus");
    const diagCloseBtn = requireNode(options.diagCloseBtn, "diagCloseBtn");
    const diagBtn = requireNode(options.diagBtn, "diagBtn");
    const diagCopyConversationBtn = requireNode(options.diagCopyConversationBtn, "diagCopyConversationBtn");
    const diagCopyBtn = requireNode(options.diagCopyBtn, "diagCopyBtn");

    // Copy details remains available within expanded technical details.
    diagCopyBtn.remove();
    diagCopyBtn.className = "agentDetailsAction";
    diagCopyBtn.textContent = "Copy details";

    // App-level runtime state accessors and effects.
    const sessionState = options.sessionState;
    if (!sessionState || typeof sessionState.get !== "function" || typeof sessionState.subscribe !== "function") throw new TypeError("diagnostics dependency missing: sessionState");
    const getSessionInfo = requireFunction(options.getSessionInfo, "getSessionInfo");
    const sessionCatalog = options.sessionCatalog;
    if (!sessionCatalog || typeof sessionCatalog.subscribe !== "function") throw new TypeError("diagnostics dependency missing: sessionCatalog");
    const refreshSessions = requireFunction(options.refreshSessions, "refreshSessions");
    const api = requireFunction(options.api, "api");
    const setToast = requireFunction(options.setToast, "setToast");
    const copyToClipboard = requireFunction(options.copyToClipboard, "copyToClipboard");
    const copyConversation = requireFunction(options.copyConversation, "copyConversation");
    const recoveryDetailsText = requireFunction(options.recoveryDetailsText, "recoveryDetailsText");
    const redactedLaunchErrorText = requireFunction(options.redactedLaunchErrorText, "redactedLaunchErrorText");
    const sessionLaunchLabel = requireFunction(options.sessionLaunchLabel, "sessionLaunchLabel");
    const sessionDisplayName = requireFunction(options.sessionDisplayName, "sessionDisplayName");
    const agentBackendDisplayName = requireFunction(options.agentBackendDisplayName, "agentBackendDisplayName");
    const diagnosticsProviderDisplay = requireFunction(options.diagnosticsProviderDisplay, "diagnosticsProviderDisplay");
    const diagnosticsCopyText = requireFunction(options.diagnosticsCopyText, "diagnosticsCopyText");
    const fmtTs = requireFunction(options.fmtTs, "fmtTs");
    const fmtRelativeAge = requireFunction(options.fmtRelativeAge, "fmtRelativeAge");
    const formatPriorityOffset = requireFunction(options.formatPriorityOffset, "formatPriorityOffset");
    const prepareModalOpen = requireFunction(options.prepareModalOpen, "prepareModalOpen");
    const afterModalVisibilityChanged = requireFunction(options.afterModalVisibilityChanged, "afterModalVisibilityChanged");
    const el = requireFunction(options.el, "el");
    const uiVersion = requireString(options.uiVersion, "uiVersion");

    const requestFrame = typeof options.requestFrame === "function" ? options.requestFrame : requestAnimationFrame;

    // Details/diagnostics state owned by this controller.
    let diagReturnFocusEl = null;
    let diagCopyText = "";
    let diagConversationCopyReady = false;
    let epoch = 0;
    let detailsBody = diagContent;
    let overviewBody = null;
    let contextBody = null;
    let technicalButton = null;
    diagCopyConversationBtn.className = "agentDetailsAction";
    diagCopyConversationBtn.textContent = "Copy conversation";
    const settingsEditor = createAgentSettingsEditor({
      api,
      sessionState,
      sessionCatalog,
      getSessionInfo,
      onSaved: async (sid) => {
        const current = epoch;
        await refreshSessions();
        if (epoch !== current || sessionState.get("selected") !== sid || !isModalTargetOpen(diagViewer)) return;
        const d = await api(`/api/sessions/${encodeURIComponent(sid)}/diagnostics`);
        if (epoch !== current || sessionState.get("selected") !== sid || !isModalTargetOpen(diagViewer)) return;
        detailsBody.replaceChildren();
        overviewBody.replaceChildren();
        contextBody.replaceChildren();
        renderLiveRows(sid, d);
      },
    });

    function resetActionButtonState() {
      diagCopyConversationBtn.disabled = true;
      diagCopyBtn.disabled = true;
      if (technicalButton) technicalButton.disabled = true;
    }

    function applyActionButtonState() {
      diagCopyConversationBtn.disabled = !diagConversationCopyReady;
      diagCopyBtn.disabled = !diagCopyText;
      if (technicalButton) technicalButton.disabled = !diagCopyText;
    }

    function addRowTo(content, rows, label, value, { mono = false } = {}) {
      const cleanLabel = String(label || "");
      const v = value == null || value === "" ? "Not available" : String(value);
      if (rows) rows.push([cleanLabel, v]);
      const row = el("div", { class: "detailsRow" });
      row.appendChild(el("div", { class: "detailsLabel", text: cleanLabel }));
      row.appendChild(el("div", { class: mono ? "detailsValue mono" : "detailsValue", text: v }));
      content.appendChild(row);
    }

    function renderFailedLaunchRows(sid, selectedInfo) {
      diagStatus.textContent = "";
      const addRecoveryRow = (label, value, opts = {}) => addRowTo(diagContent, null, label, value, opts);
      addRecoveryRow("Session", sid);
      addRecoveryRow("State", "launch failed");
      addRecoveryRow("Stage", selectedInfo.launch_stage || "-");
      addRecoveryRow("Error", redactedLaunchErrorText(selectedInfo.launch_error || "-"));
      addRecoveryRow("CWD", selectedInfo.cwd || "-", { mono: true });
      addRecoveryRow("Agent", agentBackendDisplayName(selectedInfo.agent_backend));
      addRecoveryRow("Provider", diagnosticsProviderDisplay(selectedInfo));
      addRecoveryRow("Model", selectedInfo.model || "-");
      addRecoveryRow("Reasoning", selectedInfo.reasoning_effort || "-");
      addRecoveryRow(
        "tmux",
        selectedInfo.tmux_session
          ? `${selectedInfo.tmux_session}${selectedInfo.tmux_window ? ":" + selectedInfo.tmux_window : ""}`
          : "-"
      );
      diagCopyText = recoveryDetailsText(sid, selectedInfo);
      diagConversationCopyReady = true;
      diagContent.appendChild(diagCopyConversationBtn);
      applyActionButtonState();
    }

    function renderLiveRows(sid, d) {
      diagStatus.textContent = "";
      const diagRows = [];
      const addOverview = (label, value) => addRowTo(overviewBody, diagRows, label, value);
      const addContext = (label, value) => addRowTo(contextBody, diagRows, label, value);
      const addRow = (label, value) => addRowTo(detailsBody, diagRows, label, value);
      addOverview("Backend", d ? agentBackendDisplayName(d.agent_backend) : null);
      overviewBody.appendChild(settingsEditor.providerElement);
      diagRows.push(["Provider", settingsEditor.confirmedProvider() || "Not available"]);
      addOverview("Status", d && d.lost ? "Disconnected" : d && typeof d.busy === "boolean" ? d.busy ? "Working" : "Idle" : null);
      addOverview("Queued messages", d && typeof d.queue_len === "number" ? d.queue_len : null);
      addOverview("Working directory", d && d.cwd);
      addOverview("Git branch", d && d.git_branch);
      const tok = d && d.token && typeof d.token === "object" ? d.token : null;
      const tokenNumber = value => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : null;
      if (tok) {
        addContext("Tokens in context", tokenNumber(tok.tokens_in_context));
        addContext("Context window", tokenNumber(tok.context_window));
        addContext("Remaining", typeof tok.percent_remaining === "number" && Number.isFinite(tok.percent_remaining) ? `${tok.percent_remaining}%` : null);
        addContext("Reserved tokens", tokenNumber(tok.reserved_tokens));
      } else contextBody.appendChild(el("p", { class: "agentSettingsHint", text: "No context usage reported yet." }));
      addRow("Session ID", d && d.session_id);
      addRow("Thread ID", d && d.thread_id);
      addRow("Log path", d && d.log_path);
      addRow("Broker process", d && d.broker_pid);
      addRow("Agent process", d && d.codex_pid);
      addRow("Transport", d && (d.transport || sessionLaunchLabel(d).replace("-owned", "")));
      addRow("Tmux session", d && d.tmux_session ? `${d.tmux_session}${d.tmux_window ? ":" + d.tmux_window : ""}` : null);
      addRow("Authentication", d && d.preferred_auth_method);
      addRow("Service tier", d && d.service_tier || "Standard");
      addRow("Started", d && typeof d.start_ts === "number" && d.start_ts > 0 ? fmtTs(d.start_ts) : null);
      addRow("Updated", d && typeof d.updated_ts === "number" && d.updated_ts > 0 ? fmtTs(d.updated_ts) : null);
      addRow("Priority adjustment", d && d.priority_offset);
      addRow("Time priority", d && d.time_priority);
      addRow("Base priority", d && d.base_priority);
      addRow("Final priority", d && d.final_priority);
      addRow("Dependency", d && d.dependency_session_id || "None");
      addRow("Snoozed until", d && typeof d.snooze_until === "number" && d.snooze_until > 0 ? fmtTs(d.snooze_until) : "Not snoozed");
      if (d && d.runtime) addRow("Runtime", d.runtime);
      if (d && d.native_session_id) addRow("Native session", d.native_session_id);
      if (d && typeof d.retained_records === "number") addRow("Retained records", d.retained_records);
      if (d && typeof d.retained_record_bytes === "number") addRow("Retained bytes", d.retained_record_bytes);
      const piBridge = d && d.pi_bridge_marker && typeof d.pi_bridge_marker === "object" ? d.pi_bridge_marker : null;
      if (piBridge) {
        const marker = piBridge.marker && typeof piBridge.marker === "object" ? piBridge.marker : null;
        const caps = piBridge.caps && typeof piBridge.caps === "object" ? piBridge.caps : null;
        const markerState = marker && marker.active ? "active" : marker && marker.present ? "invalid" : "missing";
        addRow("Pi bridge marker", markerState);
        addRow("Pi bridge PID", marker && typeof marker.pid === "number" ? String(marker.pid) : "-");
        if (caps) {
          const commands = Array.isArray(caps.command_names) ? caps.command_names.length : 0;
          const capability = caps.thinking_capable ? "thinking" : "no thinking capability";
          addRow("Pi bridge caps", `${capability}; ${commands} commands`);
        }
      }
      addRow("UI", uiVersion);
      // The settings widget owns the visible current values; the complete
      // diagnostics copy still includes the producer's reported values.
      diagRows.push(["Model", d && d.model || "Not reported"], ["Reasoning effort", d && d.reasoning_effort || "Not reported"]);
      detailsBody.appendChild(diagCopyBtn);
      diagCopyText = diagnosticsCopyText(sid, diagRows);
      diagConversationCopyReady = true;
      applyActionButtonState();
    }

    function showErrorState(e) {
      diagCopyText = "";
      diagConversationCopyReady = false;
      resetActionButtonState();
      diagStatus.textContent = `Could not load agent details: ${e && e.message ? e.message : "unknown error"}`;
    }

    async function show({ opener = null } = {}) {
      const sid = sessionState.get("selected");
      if (!sid) return;
      const current = ++epoch;
      settingsEditor.close();
      diagReturnFocusEl = opener instanceof HTMLElement ? opener : document.activeElement instanceof HTMLElement ? document.activeElement : null;
      prepareModalOpen();
      diagContent.innerHTML = "";
      diagCopyText = "";
      diagConversationCopyReady = false;
      resetActionButtonState();
      diagStatus.textContent = "Loading...";
      diagBackdrop.style.display = "block";
      diagViewer.style.display = "flex";
      afterModalVisibilityChanged();
      focusModalSurface(diagViewer, requestFrame);
      const selectedInfo = getSessionInfo(sid) || null;
      if (sessionLaunchFailed(selectedInfo)) {
        detailsBody = diagContent;
        renderFailedLaunchRows(sid, selectedInfo);
        diagContent.appendChild(diagCopyConversationBtn);
        diagContent.appendChild(diagCopyBtn);
        return;
      }
      const settingsSection = el("section", { class: "agentSettingsSection" });
      settingsSection.appendChild(el("h2", { class: "agentDetailsName", text: sessionDisplayName(selectedInfo) || "Agent" }));
      settingsSection.appendChild(settingsEditor.element);
      diagContent.appendChild(settingsSection);
      const overview = el("section", { class: "agentDetailsSection", "aria-label": "Session" });
      overview.appendChild(el("h3", { text: "Session" }));
      overviewBody = el("div", { class: "agentOverviewRows" });
      overview.appendChild(overviewBody);
      diagContent.appendChild(overview);
      const context = el("section", { class: "agentDetailsSection", "aria-label": "Context usage" });
      context.appendChild(el("h3", { text: "Context usage" }));
      contextBody = el("div", { class: "agentContextRows" });
      context.appendChild(contextBody);
      diagContent.appendChild(context);
      diagContent.appendChild(diagCopyConversationBtn);
      const diagnostics = el("section", { class: "agentDiagnostics", "aria-label": "Technical details" });
      technicalButton = el("button", { id: "diagTechnicalBtn", class: "agentDetailsAction", type: "button", text: "Show technical details", "aria-expanded": "false", "aria-controls": "diagTechnicalRows" });
      technicalButton.disabled = true;
      diagnostics.appendChild(technicalButton);
      detailsBody = el("div", { id: "diagTechnicalRows", class: "agentDiagnosticsRows", hidden: true });
      diagnostics.appendChild(detailsBody);
      technicalButton.onclick = () => {
        detailsBody.hidden = !detailsBody.hidden;
        technicalButton.textContent = detailsBody.hidden ? "Show technical details" : "Hide technical details";
        technicalButton.setAttribute("aria-expanded", String(!detailsBody.hidden));
      };
      diagContent.appendChild(diagnostics);
      settingsEditor.open(sid);
      try {
        const d = await api(`/api/sessions/${sid}/diagnostics`);
        if (epoch !== current || sessionState.get("selected") !== sid || !isModalTargetOpen(diagViewer)) return;
        renderLiveRows(sid, d);
      } catch (e) {
        if (epoch !== current || sessionState.get("selected") !== sid || !isModalTargetOpen(diagViewer)) return;
        showErrorState(e);
      }
    }

    function hide({ restoreFocus = true } = {}) {
      epoch++;
      settingsEditor.close();
      const wasOpen = isModalTargetOpen(diagViewer);
      const focusTarget = diagReturnFocusEl;
      diagReturnFocusEl = null;
      diagBackdrop.style.display = "none";
      diagViewer.style.display = "none";
      afterModalVisibilityChanged();
      if (restoreFocus && wasOpen) restoreModalFocus(focusTarget, () => isModalTargetOpen(diagViewer), requestFrame);
    }

    async function onCopyConversationClick(e) {
      if (e && typeof e.preventDefault === "function") {
        e.preventDefault();
        e.stopPropagation();
      }
      if (!diagConversationCopyReady) {
        setToast("details not loaded");
        return;
      }
      diagCopyConversationBtn.disabled = true;
      try {
        await copyConversation();
      } finally {
        applyActionButtonState();
      }
    }

    async function onCopyClick(e) {
      if (e && typeof e.preventDefault === "function") {
        e.preventDefault();
        e.stopPropagation();
      }
      if (!diagCopyText) {
        setToast("details not loaded");
        return;
      }
      try {
        await copyToClipboard(diagCopyText);
        setToast("Copied details");
      } catch (err) {
        setToast(`copy failed: ${err && err.message ? err.message : "unknown error"}`);
      }
    }

    function syncAvailability() {
      diagBtn.disabled = !sessionState.get("selected");
      if (isModalTargetOpen(diagViewer)) hide({ restoreFocus: false });
    }
    const unsubscribeSelected = sessionState.subscribe("selected", syncAvailability);
    syncAvailability();

    function dispose() {
      unsubscribeSelected();
      epoch++;
      settingsEditor.dispose();
      diagReturnFocusEl = null;
      diagCopyText = "";
      diagConversationCopyReady = false;
      resetActionButtonState();
    }

    return Object.freeze({
      show,
      hide,
      onCopyConversationClick,
      onCopyClick,
      syncAvailability,
      dispose,
    });
  }

export { createDiagnosticsController };
