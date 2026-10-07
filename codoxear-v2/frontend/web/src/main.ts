import {
  invitationFields,
  wireInvitationFields,
  invitationBody,
} from "../shared/invitation-form.js";
import { appearance } from "../shared/ui.js";
import { workspaceAccessFields, workspaceRootFields, bindWorkspaceGrant, workspaceGrantBody, type WorkspaceReview } from "../shared/workspace-access.js";
void appearance();
import "./style.css";
import { api, ApiError } from "./api.js";
import type { Hub, Agent, Decision, Role } from "../shared/api-types.js";
import type { Message } from "../shared/api-types.js";

type User = { id: string; name: string; email: string };
type Computer = {
  id: string;
  hubId: string;
  ownerId: string;
  ownerName: string;
  name: string;
  policy: string | null;
  online: boolean;
  canCreate: boolean;
  membership: Role | null;
  effectivePolicy: { policy: string; source: string };
};
type AgentView = Agent & { access: Decision };
const root = document.querySelector<HTMLDivElement>("#app")!;
const esc = (v: unknown) =>
  String(v ?? "").replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ]!,
  );
const $ = <T extends HTMLElement = HTMLElement>(selector: string) =>
  document.querySelector<T>(selector)!;
let user: User | null = null,
  hubs: Hub[] = [],
  hub: Hub | null = null,
  computers: Computer[] = [],
  computer: Computer | null = null,
  agents: AgentView[] = [],
  agent: AgentView | null = null,
  stream: EventSource | null = null,
  generation = 0,
  development = false,
  view: "catalog" | "chat" | "manage" = "catalog";
let issuer = location.origin,
  centralLogin = false;
const sending = new Set<string>();
let timer: ReturnType<typeof setInterval> | undefined;
function toast(message: string) {
  $(".toast")?.remove();
  const div = document.createElement("div");
  div.className = "toast";
  div.role = "status";
  div.textContent = message;
  document.body.append(div);
  setTimeout(() => div.remove(), 6500);
}
function error(e: unknown) {
  if (e instanceof ApiError && e.status === 401) {
    void loginView();
    return;
  }
  toast(e instanceof Error ? e.message : "Operation failed");
}
function stopStream() {
  stream?.close();
  stream = null;
  generation++;
}
function draftKey() {
  return JSON.stringify([
    "codoxear-v2",
    issuer,
    user?.id,
    hub?.id,
    computer?.id,
    agent?.id,
    "draft",
  ]);
}
function saveDraft() {
  const field = $<HTMLTextAreaElement>("#prompt");
  if (field && agent) localStorage.setItem(draftKey(), field.value);
}
async function loginView() {
  stopStream();
  if (timer) clearInterval(timer);
  user = null;
  hub = null;
  computer = null;
  agent = null;
  root.classList.remove("navigation-open");
  const loginOptions = await api<{ central?: boolean; identityUrl?: string }>(
    "/api/auth/options",
  );
  if (loginOptions.central) {
    root.innerHTML =
      '<main class="login card"><div class="brand">CODOXEAR</div><h1>Your hub awaits.</h1><p>Sign in with your account to access this hub.</p><a href="/auth/start">Sign in to your account</a></main>';
    return;
  }
  root.innerHTML = `<main class="login card"><div class="brand">CODOXEAR</div><div class="eyebrow">Your computers. Your workspace.</div><h1>Welcome back.</h1><p class="muted">Sign in to your hubs and continue working with your agents.</p><div class="provider-grid"><button disabled>Feishu · not configured</button><button disabled>WeChat · not configured</button><button disabled>Email code · not configured</button><button disabled>Phone · not configured</button></div><div class="divider"></div><form id="login-form"><label>Email<input name="email" type="email" autocomplete="username" required></label><label>Password<input name="password" type="password" autocomplete="current-password" required></label><button class="primary" type="submit">Sign in</button><p id="login-error" class="error small" role="alert"></p></form><p class="small muted">Local account sign-in is available for operator-provisioned accounts. Social and one-time-code sign-in will appear when their integrations are ready.</p></main>`;
  $("#login-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const data = new FormData(event.currentTarget as HTMLFormElement);
    void api<{ user: User }>("/api/auth/login", "POST", {
      email: data.get("email"),
      password: data.get("password"),
    })
      .then(async (value) => {
        user = value.user;
        await shell();
      })
      .catch((e) => {
        $("#login-error").textContent = e.message;
      });
  });
}
async function shell() {
  stopStream();
  const options = await api<{
    development: boolean;
    central?: boolean;
    identityUrl?: string;
  }>("/api/auth/options");
  development = options.development;
  issuer = options.identityUrl ?? location.origin;
  root.innerHTML = `${development ? '<div id="test-banner">Isolated development environment · fixture agents produce synthetic replies, not model inference.</div>' : ""}<div class="layout"><aside class="sidebar" id="computer-navigation"><button class="mobile-only" data-action="close-navigation">Close computers</button><div class="brand">CODOXEAR</div><label>Your hub<select id="hub-select" aria-label="Your hub"></select></label><div class="row"><button data-action="create-hub">New hub</button><button data-action="accept-invite">Join</button></div><div><div class="row spread"><strong class="small">COMPUTERS</strong><button id="add-computer" data-action="add-computer" aria-label="Add computer">+</button></div><div id="computer-list"></div></div><div class="sidebar-footer"><p><strong>${esc(user!.name)}</strong><br><span class="small muted">${esc(user!.email)}</span></p><button data-action="logout">Sign out</button></div></aside><main class="main"><header class="topbar"><button class="mobile-only" data-action="navigation" aria-controls="computer-navigation" aria-expanded="false">Computers</button><h2 id="page-title">Your workspace</h2><div class="row"><button id="agents-tab" data-action="catalog">Agents</button><button id="manage-tab" data-action="manage">Manage access</button></div></header><div class="content" id="content"></div></main></div><dialog class="modal" id="modal"></dialog>`;
  centralLogin = !!options.central;
  if (options.central) {
    $("[data-action=create-hub]").outerHTML =
      `<a href="${esc(options.identityUrl)}">All hubs</a>`;
  }
  $("#modal").addEventListener("cancel", (e) => e.preventDefault());
  $("#hub-select").addEventListener("change", () => {
    saveDraft();
    stopStream();
    hub =
      hubs.find((h) => h.id === $<HTMLSelectElement>("#hub-select").value) ??
      null;
    computer = null;
    agent = null;
    view = "catalog";
    void refresh().catch(error);
  });
  root.addEventListener("click", handleClick);
  await refresh();
  if (timer) clearInterval(timer);
  timer = setInterval(() => void refresh(false).catch(error), 2500);
  const token = new URL(location.href).searchParams.get("invite");
  if (token) {
    inviteModal(token);
    history.replaceState({}, "", location.pathname);
  }
}
async function refresh(render = true) {
  if (!user) return;
  let epoch = generation;
  const next = await api<Hub[]>("/api/hubs");
  if (epoch !== generation || !user) return;
  hubs = next;
  hub = hubs.find((h) => h.id === hub?.id) ?? hubs[0] ?? null;
  $("#hub-select").innerHTML = hubs
    .map(
      (h) =>
        `<option value="${h.id}" ${h.id === hub?.id ? "selected" : ""}>${esc(h.name)}</option>`,
    )
    .join("");
  $("#add-computer").classList.toggle("hidden", hub?.ownerId !== user.id);
  if (!hub) {
    $("#computer-list").innerHTML = "";
    empty(
      "A place for your computers.",
      "Create your first hub, or accept an invitation to someone else’s.",
    );
    return;
  }
  const nextComputers = await api<Computer[]>(`/api/hubs/${hub.id}/computers`);
  if (epoch !== generation || !user) return;
  computers = nextComputers;
  const old = computer?.id;
  computer = computers.find((c) => c.id === old) ?? computers[0] ?? null;
  $("#computer-list").innerHTML =
    computers
      .map(
        (c) =>
          `<button class="nav-item" aria-current="${c.id === computer?.id}" data-computer="${c.id}"><span>${esc(c.name)}</span><span class="dot ${c.online ? "online" : ""}" title="${c.online ? "Online" : "Offline"}"></span></button>`,
      )
      .join("") || '<p class="small muted">No computers available.</p>';
  $("#page-title").textContent =
    `${hub.name}${computer ? " / " + computer.name : ""}`;
  if (old && old !== computer?.id) {
    stopStream();
    epoch = generation;
    agent = null;
    view = "catalog";
    render = true;
  }
  if (computer) {
    const listed = await api<AgentView[]>(
      `/api/computers/${computer.id}/agents`,
    );
    if (epoch !== generation || !user) return;
    agents = listed;
    if (agent) {
      const current = agents.find((a) => a.id === agent!.id);
      if (!current) {
        stopStream();
        agent = null;
        view = "catalog";
        render = true;
        toast("Access to this agent has been removed.");
      } else {
        agent = current;
        if (view === "chat") applyAccess(current.access);
      }
    }
  } else agents = [];
  if (render || view === "catalog") renderContent();
}
function empty(title: string, body: string) {
  $("#content").innerHTML =
    `<div class="empty"><div class="eyebrow">Your workspace</div><h2>${esc(title)}</h2><p class="muted">${esc(body)}</p></div>`;
}
function renderContent() {
  if (view === "manage") {
    void renderManage().catch(error);
    return;
  }
  if (view === "chat" && agent) {
    renderChat();
    return;
  }
  if (!computer) {
    empty(
      "Connect your first computer.",
      "The computer opens an outbound connection to its hub. Its private IP can stay private.",
    );
    return;
  }
  $("#content").innerHTML =
    `<div class="row spread"><div><div class="eyebrow">${computer.online ? "Computer online" : "Computer offline"}</div><h2>Agents</h2><p class="muted small">Owner: ${esc(computer.ownerName)} · After access removal: ${esc(computer.effectivePolicy.policy)} (${esc(computer.effectivePolicy.source)})</p></div>${centralLogin ? `<a target="_blank" rel="noopener" href="/api/v1/computers/${computer.id}/">Open workspace</a>` : ""}${centralLogin && computer.ownerId === user?.id ? `<button data-action="import-agent" ${computer.online ? "" : "disabled"}>Import local session</button>` : ""}<button class="primary" data-action="new-agent" ${computer.canCreate && computer.online ? "" : "disabled"}>New agent</button></div>${!computer.canCreate ? '<div class="notice">Creating an agent requires access to this hub and operator access to this computer. Retained agent access does not allow new agents.</div>' : ""}<div class="catalog">${agents.map((a) => `<button class="agent-card" data-agent="${a.id}"><span class="badge">${esc(a.backend)} · ${esc(a.access.mode)}</span><strong>${esc(a.name)}</strong><span class="small muted">${esc(a.state)} · ${esc(a.access.reason)}</span></button>`).join("")}</div>${agents.length ? "" : '<p class="muted">No agents available yet.</p>'}`;
}
function showModal(
  title: string,
  body: string,
  submitText: string,
  callback: (data: FormData) => Promise<void>,
) {
  const dialog = $<HTMLDialogElement>("#modal");
  dialog.innerHTML = `<form id="modal-form"><h2>${esc(title)}</h2>${body}<p id="modal-error" class="error small" role="alert"></p><div class="actions"><button type="button" data-action="close-modal">Cancel</button><button type="submit" class="primary">${esc(submitText)}</button></div></form>`;
  $("#modal-form").addEventListener("submit", (event) => {
    event.preventDefault();
    const form = event.currentTarget as HTMLFormElement,
      button = form.querySelector<HTMLButtonElement>("[type=submit]")!;
    button.disabled = true;
    void callback(new FormData(form))
      .then(() => dialog.close())
      .catch((e) => {
        $("#modal-error").textContent = e.message;
      })
      .finally(() => {
        button.disabled = false;
      });
  });
  dialog.showModal();
}
function inviteModal(token = "") {
  showModal(
    "Accept invitation",
    `<p class="small muted">Hub and computer invitations are separate. Use the account the owner invited.</p><label>Invitation token<input name="token" required value="${esc(token)}"></label>`,
    "Accept invitation",
    async (data) => {
      await api("/api/invitations/accept", "POST", {
        token: data.get("token"),
      });
      await refresh();
      toast("Invitation accepted.");
    },
  );
}
async function renderManage() {
  if (!hub || !user) return;
  const workspaceMembers = new Map<string, Parameters<typeof bindWorkspaceGrant>[1]>();
  const workspaceReviews = new Map<string, WorkspaceReview>();
  const epoch = generation;
  $("#content").innerHTML = "<p class=muted>Loading access settings…</p>";
  const resources = [
    { kind: "hub", value: hub },
    ...(computer ? [{ kind: "computer", value: computer }] : []),
  ];
  const cards = await Promise.all(
    resources.map(async ({ kind, value }) => {
      if (value.ownerId !== user!.id)
        return `<div class="card"><h3>${esc(value.name)}</h3><p class="muted">Only this ${kind}’s owner can manage its members and policy.</p></div>`;
      const members = await api<
        Array<{
          userId: string;
          name: string;
          email: string;
          role: string;
          workspaceAccess?: "read" | "write" | null;
          workspaceGrants?: Array<{workspaceId: string; access: string; paths?: string[]; git?: boolean; uploads?: boolean; transcode?: boolean}>;
        }>
      >(`/api/resources/${kind}/${value.id}/members`);
      const workspace =
        kind === "computer" && centralLogin
          ? await api<WorkspaceReview>(
              `/api/computers/${value.id}/workspace`,
            ).catch(() => ({ path: null }))
          : null;
      const workspaceForm = (member: (typeof members)[number]) =>
        kind === "computer" && centralLogin && workspace
          ? workspaceAccessFields(member, workspace)
          : "";
      for (const member of members) workspaceMembers.set(member.userId, member);
      if (workspace) workspaceReviews.set(value.id, workspace);
      return `<div class="card" data-resource="${kind}" data-resource-id="${value.id}"><div class="eyebrow">${kind} · you are the owner</div><h3>${esc(value.name)}</h3><form class="policy-form"><label>Existing agent access after computer removal<select name="policy">${[
        [
          "",
          "Use " + (kind === "hub" ? "computer rule" : "default (no access)"),
        ],
        ["retain", "Retain previous access"],
        ["read_only", "Read-only"],
        ["none", "No access"],
      ]
        .map(
          ([v, label]) =>
            `<option value="${v}" ${(value.policy ?? "") === v ? "selected" : ""}>${label}</option>`,
        )
        .join(
          "",
        )}</select></label><button type="submit">Save policy</button></form>${kind === "computer" ? '<p class="small muted">An explicitly configured hub policy overrides this computer rule.</p>' : ""}<div class="divider"></div><h3>Members</h3>${workspace ? `<p class="small muted">File grants cover ${workspace.path ? `<code>${esc(workspace.path)}</code>` : "the Computer’s configured workspace (reconnect to review its path)"}. Removing membership also removes file access.</p>` : ""}${members.map((m) => `<div class="member"><div><strong>${esc(m.name)}</strong><br><span class="small muted">${esc(m.email)} · ${esc(m.role)}</span></div><button class="danger" data-remove="${m.userId}">Remove</button></div>${workspaceForm(m)}`).join("") || '<p class="small muted">No invited members yet.</p>'}<form class="invite-form">${invitationFields()}<label>Access<select name="role"><option value="operator">Operator</option><option value="viewer">Viewer</option></select></label><button type="submit">Create invitation</button><div class="invite-result" role="status"></div></form>${members.length ? `<details><summary class="small">Transfer ownership</summary><form class="owner-form"><label>New owner<select name="ownerId">${members.map((m) => `<option value="${m.userId}">${esc(m.name)}</option>`).join("")}</select></label><button type="submit">Transfer ownership</button></form></details>` : ""}</div>`;
    }),
  );
  if (epoch !== generation || view !== "manage") return;
  $("#content").innerHTML =
    `<div class="eyebrow">Membership and ownership</div><h2>Manage access</h2><p class="muted">Each resource has one owner. Agent creation requires access to both levels.</p><div class="management">${cards.join("")}</div>`;
  document
    .querySelectorAll<HTMLFormElement>(".invite-form")
    .forEach(wireInvitationFields);
  for (const form of document.querySelectorAll<HTMLFormElement>(".workspace-form")) bindWorkspaceGrant(form, workspaceMembers.get(form.dataset.member!)!);
  for (const [id, review] of workspaceReviews) {
    const card = document.querySelector<HTMLElement>(`[data-resource-id="${id}"]`);
    if (!card) continue;
    const roots = document.createElement("section");
    roots.innerHTML = workspaceRootFields(review);
    card.append(roots);
    roots.querySelector("form")!.addEventListener("submit", event => {
      event.preventDefault();
      const data = new FormData(event.target as HTMLFormElement);
      void api(`/api/computers/${id}/workspace`, "PUT", {name: data.get("name"), path: data.get("path")}).then(renderManage).catch(error => toast(String(error)));
    });
    for (const button of roots.querySelectorAll<HTMLButtonElement>("[data-remove-workspace]")) button.onclick = () => {
      void api(`/api/computers/${id}/workspace`, "PUT", {id: button.dataset.removeWorkspace, remove: true}).then(renderManage).catch(error => toast(String(error)));
    };
  }
  document
    .querySelectorAll<HTMLFormElement>(
      ".policy-form,.invite-form,.owner-form,.workspace-form",
    )
    .forEach((form) =>
      form.addEventListener("submit", (event) => {
        event.preventDefault();
        const card = form.closest<HTMLElement>("[data-resource]")!,
          base = `/api/resources/${card.dataset.resource}/${card.dataset.resourceId}`,
          data = new FormData(form);
        void (async () => {
          if (form.classList.contains("workspace-form")) {
            const grant = workspaceGrantBody(data);
            await api(
              `/api/computers/${card.dataset.resourceId}/workspace-access/${form.dataset.member}`,
              "PUT",
              grant,
            );
            toast("Workspace access saved.");
            const member = workspaceMembers.get(form.dataset.member!)!;
            member.workspaceGrants = [...(member.workspaceGrants ?? []).filter(g => g.workspaceId !== grant.workspaceId), ...(grant.access ? [grant as unknown as NonNullable<typeof member.workspaceGrants>[number]] : [])];
          } else if (form.classList.contains("policy-form")) {
            await api(base + "/policy", "PUT", {
              policy: data.get("policy") || null,
            });
            await refresh(false);
            toast("Policy saved.");
          } else if (form.classList.contains("owner-form")) {
            if (
              !confirm(
                "Transfer ownership to this member? You will remain a member.",
              )
            )
              return;
            await api(base + "/owner", "POST", {
              ownerId: data.get("ownerId"),
            });
            await refresh();
            toast("Ownership transferred.");
          } else {
            const result = await api<{ token: string }>(
              base + "/invitations",
              "POST",
              invitationBody(data),
            );
            (form.querySelector(".invite-result") as HTMLElement).hidden =
              false;
            form.querySelector(".invite-result")!.innerHTML =
              `<p class="small">Share this invitation token with the invited person:</p><div class="invite-token">${esc(result.token)}</div>`;
          }
        })().catch(error);
      }),
    );
}
function applyAccess(access: Decision) {
  const status = $("#agent-access");
  if (!status) return;
  status.textContent = `${access.mode} · ${access.reason}`;
  const field = $<HTMLTextAreaElement>("#prompt");
  if (field) field.disabled = !access.actions.includes("send");
  const send = $<HTMLButtonElement>("#send");
  if (send)
    send.disabled =
      sending.has(draftKey()) ||
      !access.actions.includes("send") ||
      !!localStorage.getItem(draftKey() + ":unknown");
  const interrupt = $<HTMLButtonElement>("#interrupt");
  if (interrupt) interrupt.disabled = !access.actions.includes("interrupt");
}
function renderChat() {
  if (!agent) return;
  stopStream();
  const epoch = generation,
    selected = agent;
  if (centralLogin && selected.state !== "ready") {
    $("#content").innerHTML =
      `<h2>${esc(selected.name)}</h2><p role="status">The launch result is ${esc(selected.state)}. Check the Computer's saved result before creating another agent.</p><button data-action="reconcile-launch">Check launch result</button><p class="small muted">Checking never launches or resends anything. If no result was saved, the computer owner can inspect and import the local session.</p>`;
    return;
  }
  $("#content").innerHTML =
    `<div class="row spread"><div><div class="eyebrow">${esc(selected.backend)}${selected.backend === "fixture" ? " · synthetic test runtime" : ""}</div><h2>${esc(selected.name)}</h2><p id="agent-access" class="small muted"></p></div><button id="interrupt" data-action="interrupt">Interrupt</button></div><p id="connection-status" class="small muted status-line" role="status">Connecting…</p><div class="messages" id="messages" aria-live="polite"></div><form id="composer" class="composer"><label>Message<textarea id="prompt" placeholder="Continue the conversation…"></textarea></label><div id="send-warning"></div><div class="composer-actions"><span class="small muted">Drafts stay on this device until you send.</span><button id="send" class="primary" type="submit">Send</button></div></form>`;
  $<HTMLTextAreaElement>("#prompt").value =
    localStorage.getItem(draftKey()) ?? "";
  $("#prompt").addEventListener("input", saveDraft);
  const warning = () => {
    const unknown = !!localStorage.getItem(draftKey() + ":unknown");
    $("#send-warning").innerHTML = unknown
      ? '<div class="notice">The previous send has an unknown outcome. Check the conversation before deciding to send again. <button type="button" data-action="resolve-send">I checked — unlock sending</button></div>'
      : "";
    applyAccess(agent?.access ?? selected.access);
  };
  warning();
  $("#composer").addEventListener("submit", (event) => {
    event.preventDefault();
    if (
      sending.has(draftKey()) ||
      localStorage.getItem(draftKey() + ":unknown")
    )
      return;
    const field = $<HTMLTextAreaElement>("#prompt"),
      text = field.value.trim();
    if (!text) return;
    saveDraft();
    const key = draftKey();
    sending.add(key);
    localStorage.setItem(key + ":unknown", "true");
    $<HTMLButtonElement>("#send").disabled = true;
    void api(`/api/agents/${selected.id}/send`, "POST", { text })
      .then(() => {
        localStorage.removeItem(key + ":unknown");
        if (epoch !== generation) return;
        if (field.value.trim() === text) {
          field.value = "";
          localStorage.removeItem(key);
        }
        $("#connection-status").textContent = "Sent";
      })
      .catch((e) => {
        if (
          !(e instanceof ApiError) ||
          e.code === "outcome_unknown" ||
          (e.status >= 500 && e.code !== "not_dispatched")
        ) {
          localStorage.setItem(key + ":unknown", "true");
          if (epoch === generation) warning();
        } else {
          localStorage.removeItem(key + ":unknown");
          error(e);
        }
      })
      .finally(() => {
        sending.delete(key);
        if (epoch === generation) warning();
      });
  });
  stream = new EventSource(`/api/agents/${selected.id}/live`);
  stream.addEventListener("snapshot", (event) => {
    if (epoch !== generation) return;
    const data = JSON.parse((event as MessageEvent).data) as {
      messages: Message[];
    };
    const box = $("#messages"),
      nearBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 70;
    box.innerHTML =
      data.messages
        .map(
          (m) =>
            `<article class="message ${m.role}"><span class="role">${esc(m.role)}</span>${esc(m.text)}</article>`,
        )
        .join("") || '<p class="small muted">Start the conversation.</p>';
    if (nearBottom) box.scrollTop = box.scrollHeight;
    $("#connection-status").textContent = "Live";
  });
  stream.addEventListener("access", (event) => {
    if (epoch === generation) {
      const access = JSON.parse((event as MessageEvent).data) as Decision;
      if (agent) agent.access = access;
      applyAccess(access);
    }
  });
  stream.addEventListener("online", () => {
    if (epoch === generation) $("#connection-status").textContent = "Live";
  });
  stream.addEventListener("offline", () => {
    if (epoch === generation)
      $("#connection-status").textContent =
        "Computer unavailable. Your draft is safe.";
  });
  stream.addEventListener("access_lost", () => {
    saveDraft();
    stopStream();
    agent = null;
    view = "catalog";
    void refresh().catch(error);
    toast("Access to this agent was removed.");
  });
  stream.onerror = () => {
    if (epoch === generation)
      $("#connection-status").textContent = "Reconnecting…";
  };
}
function handleClick(event: MouseEvent) {
  const target = (event.target as HTMLElement).closest<HTMLElement>("button");
  if (!target || target.hasAttribute("disabled")) return;
  void (async () => {
    if (target.dataset.computer) {
      root.classList.remove("navigation-open");
      $("[data-action=navigation]").setAttribute("aria-expanded", "false");
      saveDraft();
      stopStream();
      computer =
        computers.find((c) => c.id === target.dataset.computer) ?? null;
      agent = null;
      view = "catalog";
      await refresh();
      return;
    }
    if (target.dataset.agent) {
      saveDraft();
      agent = agents.find((a) => a.id === target.dataset.agent) ?? null;
      view = "chat";
      renderContent();
      return;
    }
    if (target.dataset.remove) {
      const card = target.closest<HTMLElement>("[data-resource]")!;
      if (
        !confirm(
          "Remove this membership? Existing agent access will follow the hub or computer rule.",
        )
      )
        return;
      await api(
        `/api/resources/${card.dataset.resource}/${card.dataset.resourceId}/members/${target.dataset.remove}`,
        "DELETE",
      );
      await refresh();
      return;
    }
    switch (target.dataset.action) {
      case "reconcile-launch": {
        if (!agent) return;
        const selected = agent.id,
          epoch = generation;
        target.setAttribute("disabled", "");
        try {
          const result = await api<{ state: "unknown" | "ready" }>(
            `/api/agents/${selected}/reconcile`,
            "POST",
            {},
          );
          if (epoch !== generation || agent?.id !== selected) return;
          await refresh();
          toast(
            result.state === "ready"
              ? "Recovered the existing agent."
              : "No confirmed launch result yet. Ask the computer owner to inspect local sessions.",
          );
        } finally {
          target.removeAttribute("disabled");
        }
        break;
      }
      case "navigation":
        root.classList.add("navigation-open");
        target.setAttribute("aria-expanded", "true");
        $("[data-action=close-navigation]").focus();
        break;
      case "close-navigation":
        root.classList.remove("navigation-open");
        $("[data-action=navigation]").setAttribute("aria-expanded", "false");
        $("[data-action=navigation]").focus();
        break;
      case "logout":
        saveDraft();
        await api("/api/auth/logout", "POST");
        await loginView();
        break;
      case "catalog":
        saveDraft();
        stopStream();
        agent = null;
        view = "catalog";
        await refresh();
        break;
      case "manage":
        saveDraft();
        stopStream();
        view = "manage";
        await renderManage();
        break;
      case "close-modal":
        $<HTMLDialogElement>("#modal").close();
        break;
      case "accept-invite":
        inviteModal();
        break;
      case "create-hub":
        showModal(
          "Create a hub",
          '<label>Hub name<input name="name" required maxlength="120"></label>',
          "Create hub",
          async (data) => {
            hub = await api<Hub>("/api/hubs", "POST", {
              name: data.get("name"),
            });
            computer = null;
            agent = null;
            view = "catalog";
            await refresh();
          },
        );
        break;
      case "import-agent": {
        if (!computer) return;
        const selectedComputer = computer.id,
          epoch = generation;
        const sessions = await api<
          Array<{ session_id: string; agent_backend: string; alias?: string }>
        >(`/api/computers/${selectedComputer}/discovered`);
        if (epoch !== generation || computer?.id !== selectedComputer) return;
        if (!sessions.length) {
          toast("No unpublished local sessions were found.");
          break;
        }
        showModal(
          "Import a local session",
          `<p>This publishes the selected session and its existing history to members who have access to this computer.</p><label>Local session<select name="localId">${sessions.map((s) => `<option value="${esc(s.session_id)}">${esc(s.alias || s.session_id)} · ${esc(s.agent_backend)}</option>`).join("")}</select></label><label>Agent name<input name="name" required maxlength="120"></label>`,
          "Import session",
          async (data) => {
            if (computer?.id !== selectedComputer)
              throw new Error("Computer selection changed");
            await api(`/api/computers/${selectedComputer}/import`, "POST", {
              localId: data.get("localId"),
              name: data.get("name"),
            });
            await refresh();
          },
        );
        break;
      }
      case "add-computer":
        if (!hub) return;
        showModal(
          "Add a computer",
          '<label>Computer name<input name="name" required maxlength="120"></label><p class="small muted">You will own this computer. Download its private configuration and attach it with Codoxear Computer.</p>',
          "Add computer",
          async (data) => {
            const value = await api<{
              computer: { id: string; hubId: string };
              credential?: string;
              pairing?: { code: string } | null;
              identityUrl?: string;
            }>(`/api/hubs/${hub!.id}/computers`, "POST", {
              name: data.get("name"),
            });
            const config = {
              version: 1,
              hubUrl: location.origin,
              hubId: value.computer.hubId,
              computerId: value.computer.id,
              ...(value.pairing
                ? {
                    enrollment: {
                      identityUrl: value.identityUrl,
                      code: value.pairing.code,
                    },
                  }
                : { credential: value.credential }),
              runtime: development ? "fixture" : "native",
              ...(development
                ? {}
                : {
                    workspacePath: "/REPLACE_WITH_YOUR_WORKSPACE",
                  }),
            };
            const blob = new Blob([JSON.stringify(config, null, 2)], {
                type: "application/json",
              }),
              url = URL.createObjectURL(blob),
              a = document.createElement("a");
            a.href = url;
            a.download = "codoxear-computer.json";
            a.click();
            setTimeout(() => URL.revokeObjectURL(url), 1000);
            await refresh();
            toast(
              "Configuration downloaded. Keep it private; its pairing code expires in five minutes.",
            );
          },
        );
        break;
      case "new-agent":
        if (!computer) return;
        showModal(
          "Create an agent",
          `<label>Agent name<input name="name" required maxlength="120"></label><label>Runtime<select name="backend">${development ? '<option value="fixture">Fixture · synthetic test replies</option>' : '<option value="pi">Pi</option><option value="codex">Codex</option><option value="cc">Claude Code</option>'}</select></label>`,
          "Create agent",
          async (data) => {
            const created = await api<Agent>(
              `/api/computers/${computer!.id}/agents`,
              "POST",
              { name: data.get("name"), backend: data.get("backend") },
            );
            await refresh();
            agent = agents.find((a) => a.id === created.id) ?? null;
            view = "chat";
            renderContent();
          },
        );
        break;
      case "interrupt":
        if (agent) {
          await api(`/api/agents/${agent.id}/interrupt`, "POST", {});
          toast("Interrupt requested.");
        }
        break;
      case "resolve-send":
        if (sending.has(draftKey())) return;
        localStorage.removeItem(draftKey() + ":unknown");
        $("#send-warning").innerHTML = "";
        if (agent) applyAccess(agent.access);
        break;
    }
  })().catch(error);
}
try {
  user = await api<User>("/api/me");
  const options = await api<{ central?: boolean; identityUrl?: string }>(
    "/api/auth/options",
  );
  if (
    options.central &&
    !new URLSearchParams(location.search).has("settings")
  ) {
    // @ts-expect-error Shared presentation is JavaScript.
    const { startHub } = await import("../shared/hub.js");
    await startHub(root, user, options);
  } else {
    await shell();
    const settings = new URLSearchParams(location.search).get("settings");
    if (settings) {
      const all = await api<{ agents: Array<Agent & { computerId: string }> }>(
        "/api/agent-directory",
      );
      const selected = all.agents.find((a) => a.id === settings);
      if (selected) {
        computer =
          computers.find((c) => c.id === selected.computerId) ?? computer;
        await refresh();
        agent = agents.find((a) => a.id === settings) ?? null;
      }
      document.body.classList.add("agent-settings-page");
      view = "manage";
      await renderManage();
      $("#page-title").innerHTML =
        `<a href="${selected?.localId ? `/workspace/#session=${encodeURIComponent(selected.id)}` : "/"}">← Back to agent</a> · ${esc(selected?.name ?? "Agent")} settings`;
    }
  }
} catch {
  await loginView();
}
