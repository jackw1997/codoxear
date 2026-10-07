import {
  agentCreationDialog,
  type Placement,
  type AgentSelection,
} from "../shared/agent-creation.js";
import type { Backend } from "../shared/agent-options.js";

async function request(path: string, init: RequestInit = {}) {
  const response = await fetch(path, init);
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Computer unavailable");
  return value;
}

/** v2 owns creation; the established conversation still owns its mounted shell. */
export function createNewSessionDialogController(options: {
  sessionState: { get(key: string): string | null };
  sessionCatalog: {
    get(
      key: string,
    ): Map<string, { codoxear_computer_id?: string; agent_backend?: Backend }>;
  };
}) {
  const viewer = document.createElement("div");
  viewer.style.display = "none";
  let dialog: HTMLDialogElement | undefined,
    opening = false,
    disposed = false;
  async function open(
    initial: { cwd?: string; likeSession?: { agent_backend?: Backend } } = {},
  ) {
    if (opening || dialog?.open || disposed) return;
    opening = true;
    try {
      const directory = await request("/api/client/directory");
      if (disposed) return;
      const id = options.sessionState.get("selected");
      const current = id
        ? options.sessionCatalog.get("sessionIndex").get(id)
        : undefined;
      dialog = agentCreationDialog(
        directory.placements,
        async (placement: Placement, values: AgentSelection) => {
          const result = await request(
            `/api/sessions?__placement=${encodeURIComponent(placement.loginId + "~" + placement.computerId)}`,
            {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: values.name,
                agent_backend: values.backend,
                ...values.launch,
                create_in_tmux: false,
              }),
            },
          );
          if (!result.session_id)
            throw new Error(
              "Launch result unknown. Check the computer before creating again.",
            );
          location.hash = "session=" + encodeURIComponent(result.session_id);
        },
        {
          loadResumeCandidates: (placement, backend, cwd, signal) =>
            request(
              `/api/client/hubs/${encodeURIComponent(placement.loginId!)}/api/computers/${encodeURIComponent(placement.computerId)}/resume-candidates?backend=${encodeURIComponent(backend)}&cwd=${encodeURIComponent(cwd)}`,
              { signal, cache: "no-store" },
            ),
          loadDefaults: (placement, signal) =>
            request(
              `/api/client/hubs/${encodeURIComponent(placement.loginId!)}/api/computers/${encodeURIComponent(placement.computerId)}/launch-defaults`,
              { signal, cache: "no-store" },
            ),
          ...(current?.codoxear_computer_id
            ? { initialComputerId: current.codoxear_computer_id }
            : {}),
          initialBackend:
            initial.likeSession?.agent_backend ??
            current?.agent_backend ??
            "pi",
          ...(initial.cwd ? { initialCwd: initial.cwd } : {}),
        },
      );
    } catch (error) {
      if (disposed) return;
      dialog = agentCreationDialog([], async () => {});
      dialog.querySelector<HTMLElement>("[role=alert]")!.textContent =
        error instanceof Error ? error.message : "Unable to load computers.";
    } finally {
      opening = false;
    }
  }
  return Object.freeze({
    viewer,
    open,
    close: () => dialog?.close(),
    isOpen: () => opening || !!dialog?.open,
    closeMenus() {},
    applyMenus() {},
    refreshDefaults() {},
    dispose() {
      disposed = true;
      dialog?.close();
    },
  });
}
