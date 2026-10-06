import { esc, field, message, submit } from "./views.js";

type Computer = {
  id: string;
  name: string;
  canCreate?: boolean;
  online?: boolean;
};
type Request = (path: string, body?: unknown, method?: string) => Promise<any>;

/** Owns the delegation controls, request state and status text for one parent. */
export function delegationSection(computers: Computer[]) {
  const eligible = computers.filter((computer) => computer.canCreate);
  return `<section class="connectionSection connectionStack" data-delegation><h2>Subagents on your computers</h2>
    <p class="connectionHint">Allow this agent and its subagents to create and control agents on selected computers in this Hub. Access expires automatically and uses your current permissions. Disabling access prevents further delegated actions; existing children stay available in your agent list.</p>
    <form class="connectionForm" data-delegation-form><fieldset class="connectionDelegationTargets"><legend>Allowed computers</legend>
    ${eligible.map((computer) => `<label class="connectionDelegationTarget"><input type="checkbox" name="targetComputerIds" value="${esc(computer.id)}"><span>${esc(computer.name)}${computer.online ? "" : " · Offline"}</span></label>`).join("") || '<p class="connectionHint">You need permission to create agents on at least one computer.</p>'}
    </fieldset>${field("Access duration", '<select name="ttlSeconds"><option value="900">15 minutes</option><option value="1800">30 minutes</option><option value="3600">1 hour</option></select>')}
    <div class="connectionActions"><button class="primary" type="submit" ${eligible.length ? "" : "disabled"}>Enable subagents</button><button type="button" data-delegation-revoke>Disable access</button></div>
    <p class="connectionStatus" role="status" data-delegation-status>Checking subagent access…</p><p class="connectionError" role="alert" data-delegation-error></p></form></section>`;
}

export function bindDelegation(
  root: HTMLElement,
  agentId: string,
  request: Request,
) {
  const section = root.querySelector<HTMLElement>("[data-delegation]");
  if (!section) return () => {};
  const form = section.querySelector<HTMLFormElement>("form")!;
  const status = section.querySelector<HTMLElement>(
    "[data-delegation-status]",
  )!;
  const error = section.querySelector<HTMLElement>("[data-delegation-error]")!;
  const revoke = section.querySelector<HTMLButtonElement>(
    "[data-delegation-revoke]",
  )!;
  const enable = form.querySelector<HTMLButtonElement>(
    'button[type="submit"]',
  )!;
  const path = `/api/agents/${encodeURIComponent(agentId)}/delegation-grants`;
  let generation = 0;
  let selectionEdited = false;
  let disposed = false,
    mutating = false,
    checking = false;
  let expiry: ReturnType<typeof setTimeout> | undefined;
  form.addEventListener("change", () => {
    selectionEdited = true;
  });
  const alive = (version: number) =>
    !disposed && section.isConnected && version === generation;
  const report = (failure: unknown) => {
    if (!disposed && section.isConnected) error.textContent = message(failure);
  };
  const show = (value: any, restoreSelection = false) => {
    if (expiry) clearTimeout(expiry);
    if (value.authorizationUnknown || value.connectionUnknown) {
      status.textContent = value.authorizationUnknown
        ? "Subagent authorization could not be checked. Current access is unknown."
        : "The Computer connection could not be checked. Tool availability is unknown.";
      return;
    }
    // Never display a token or treat a successful launch as installed tools.
    const active =
      value.installed === true &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > Date.now();
    const authorized =
      (active || value.authorized === true) &&
      typeof value.expiresAt === "number" &&
      value.expiresAt > Date.now();
    status.textContent = active
      ? `Subagent access enabled until ${new Date(value.expiresAt).toLocaleTimeString()}.`
      : authorized
        ? `Subagent access is authorized until ${new Date(value.expiresAt).toLocaleTimeString()}, but the tool is not currently active. Resume this agent or check its Computer connection.`
        : "Subagent access is disabled or expired.";
    if (authorized) {
      expiry = setTimeout(
        () => {
          if (!disposed && section.isConnected && !mutating)
            show({ installed: false });
        },
        Math.min(3600005, Math.max(1, value.expiresAt - Date.now() + 5)),
      );
    }
    if (
      authorized &&
      restoreSelection &&
      !selectionEdited &&
      Array.isArray(value.targetComputerIds)
    ) {
      for (const checkbox of form.querySelectorAll<HTMLInputElement>(
        'input[type="checkbox"]',
      ))
        checkbox.checked = value.targetComputerIds.includes(checkbox.value);
    }
  };
  const refresh = () => {
    if (
      disposed ||
      !section.isConnected ||
      document.hidden ||
      mutating ||
      checking
    )
      return;
    const initial = ++generation;
    checking = true;
    void request(path)
      .then((value) => {
        if (alive(initial)) {
          error.textContent = "";
          show(value, true);
        }
      })
      .catch((failure) => {
        if (alive(initial)) {
          status.textContent = "Subagent access could not be checked.";
          report(failure);
        }
      })
      .finally(() => {
        checking = false;
      });
  };
  refresh();
  const poll = setInterval(refresh, 30000);
  document.addEventListener("visibilitychange", refresh);
  submit(
    form,
    async (data) => {
      const version = ++generation;
      const targets = data.getAll("targetComputerIds").map(String);
      if (!targets.length) throw Error("Select at least one computer.");
      mutating = true;
      if (expiry) clearTimeout(expiry);
      error.textContent = "";
      status.textContent = "Installing subagent access…";
      revoke.disabled = true;
      try {
        const result = await request(path, {
          targetComputerIds: targets,
          ttlSeconds: Number(data.get("ttlSeconds")),
        });
        if (!alive(version)) return;
        if (result.installed !== true)
          throw Error(
            "Tool installation was not confirmed. Check access status before retrying.",
          );
        show(result);
      } catch (failure) {
        if (alive(version)) {
          status.textContent =
            "Access change was not confirmed. Reopen Agent access to check its status.";
          throw failure;
        }
      } finally {
        mutating = false;
        if (alive(version)) revoke.disabled = false;
      }
    },
    report,
  );
  revoke.onclick = () => {
    if (revoke.disabled) return;
    const version = ++generation;
    mutating = true;
    if (expiry) clearTimeout(expiry);
    revoke.disabled = true;
    enable.disabled = true;
    error.textContent = "";
    status.textContent = "Disabling subagent access…";
    void request(path, undefined, "DELETE")
      .then(() => {
        if (alive(version)) show({ installed: false });
      })
      .catch((failure) => {
        if (alive(version)) {
          status.textContent =
            "Disable request was not confirmed. Reopen Agent access to check its status.";
          report(failure);
        }
      })
      .finally(() => {
        mutating = false;
        if (alive(version)) {
          revoke.disabled = false;
          enable.disabled = !form.querySelector(
            'input[name="targetComputerIds"]',
          );
        }
      });
  };
  return () => {
    disposed = true;
    generation++;
    clearInterval(poll);
    if (expiry) clearTimeout(expiry);
    document.removeEventListener("visibilitychange", refresh);
  };
}
