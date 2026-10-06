import {
  invitationFields,
  wireInvitationFields,
  invitationBody,
} from "../shared/invitation-form.js";
import { attachCommand, computerSetup } from "./computer-setup.js";
import { vault, type HubLogin } from "./vault.js";
import { connectHub, identitySettingsUrl } from "./login.js";
import { ConnectionPages, esc, icon, field, submit, message } from "./views.js";
import { workspaceAccessFields, workspaceRootFields, bindWorkspaceGrant, workspaceGrantBody, type WorkspaceReview } from "../shared/workspace-access.js";
type Computer = {
  id: string;
  name: string;
  ownerId: string;
  ownerName?: string;
  policy: string | null;
  effectivePolicy: string;
  online: boolean;
};
type Group = { key: string; logins: HubLogin[] };
type HubInfo = {
  id: string;
  name: string;
  ownerId: string;
  policy: string | null;
};
let current: ConnectionPages | undefined;
async function api(
  login: HubLogin,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const r = await fetch("/api/client/hubs/" + login.id + path, {
    method,
    signal: AbortSignal.timeout(12000),
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const data = await r.json();
  if (!r.ok) throw new Error(data.error ?? "Hub operation failed");
  return data;
}
export function openConnections(
  changed: () => Promise<void>,
  forgotten: () => void,
) {
  current?.close();
  const page = new ConnectionPages();
  current = page;
  const expanded = new Set<string>();
  const home = () => void list().catch(page.error);
  async function list() {
    const logins = await vault.list();
    if (!page.element.isConnected) return;
    const groups: Group[] = [];
    for (const login of logins) {
      const key = login.origin + "|" + login.hubId;
      let group = groups.find((g) => g.key === key);
      if (!group) {
        group = { key, logins: [] };
        groups.push(group);
      }
      group.logins.push(login);
    }
    const root = page.render(
      "Hubs & computers",
      groups.length
        ? `<div class="connectionList">${groups.map((g, index) => `<details class="connectionHub" data-hub="${index}" ${expanded.has(g.key) ? "open" : ""}><summary>${icon("hub")}<span class="connectionRowText"><strong>${esc(g.logins[0]!.name)}</strong><span class="connectionHint">${esc(g.logins[0]!.origin)}</span></span>${icon("chevron", "connectionChevron")}</summary><div class="connectionHubContent"><p class="connectionHint" role="status">Loading computers…</p></div></details>`).join("")}</div>`
        : `<div class="connectionEmpty">${icon("hub")}<h2>No hubs yet</h2><p class="connectionHint">Add your first hub to connect your computers and agents.</p></div>`,
      page.close,
      `<button data-add-hub class="primary">${icon("plus")}Add hub</button>`,
    );
    root.querySelector<HTMLButtonElement>("[data-add-hub]")!.onclick = addHub;
    for (const details of root.querySelectorAll<HTMLDetailsElement>(
      "[data-hub]",
    )) {
      const group = groups[Number(details.dataset.hub)]!;
      let loading = false,
        loaded = false;
      const load = async () => {
        if (loading || loaded) return;
        loading = true;
        const box = details.querySelector<HTMLElement>(
          ".connectionHubContent",
        )!;
        const results = await Promise.all(
          group.logins.map(async (login) => {
            try {
              const [hubs, computers] = await Promise.all([
                api(login, "/api/hubs"),
                api(login, "/api/v1/computers"),
              ]);
              return {
                login,
                hub: hubs[0] as HubInfo,
                computers: computers as Computer[],
              };
            } catch (e) {
              return { login, error: message(e) };
            }
          }),
        );
        if (!box.isConnected) return;
        loading = false;
        const good = results.filter((r) => r.hub);
        const owner = good.find((r) => r.hub!.ownerId === r.login.accountId);
        const machines = new Map<
          string,
          { computer: Computer; login: HubLogin }
        >();
        for (const result of good)
          for (const computer of result.computers!) {
            if (
              !machines.has(computer.id) ||
              computer.ownerId === result.login.accountId
            )
              machines.set(computer.id, { computer, login: result.login });
          }
        box.innerHTML = `<div class="connectionHubTools"><button data-add-computer ${owner ? "" : "disabled"}>${icon("plus")}Add computer</button><button data-hub-settings>Hub settings</button></div>${good.length ? (machines.size ? `<div class="connectionComputers">${[...machines.values()].map(({ computer: c }) => `<button class="connectionComputer" data-computer="${esc(c.id)}">${icon("computer")}<span class="connectionRowText"><strong>${esc(c.name)}</strong><span class="connectionHint">${c.online ? "Online" : "Offline"}${c.ownerName ? " · " + esc(c.ownerName) : ""}</span></span>${icon("chevron")}</button>`).join("")}</div>` : '<p class="connectionHint">No computers in this hub yet.</p>') : `<p class="connectionError">${esc(results[0]?.error ?? "Hub unavailable")}</p><button data-retry>Retry</button>`}${!owner && good.length ? '<p class="connectionHint">Only the hub owner can add computers.</p>' : ""}`;
        loaded = !!good.length;
        box.querySelector<HTMLButtonElement>("[data-hub-settings]")!.onclick =
          () => settings(group, owner?.hub ?? good[0]?.hub);
        if (owner)
          box.querySelector<HTMLButtonElement>("[data-add-computer]")!.onclick =
            () => addComputer(owner.login, owner.hub!);
        box
          .querySelector<HTMLButtonElement>("[data-retry]")
          ?.addEventListener("click", () => void load().catch(page.error));
        for (const button of box.querySelectorAll<HTMLButtonElement>(
          "[data-computer]",
        ))
          button.onclick = () => {
            const selected = machines.get(button.dataset.computer!)!;
            computerPage(selected.login, selected.computer);
          };
      };
      details.ontoggle = () => {
        if (details.open) {
          expanded.add(group.key);
          void load().catch(page.error);
        } else expanded.delete(group.key);
      };
      if (details.open) void load().catch(page.error);
    }
  }
  function addHub() {
    const root = page.render(
      "Add hub",
      `<form class="connectionForm"><p class="connectionHint">Enter the address of the hub you want to use.</p>${field("Hub address", '<input name="origin" type="text" inputmode="url" autocomplete="url" placeholder="https://hub.example.com" required>')}<div class="connectionActions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Connect hub</button></div><p role="status" class="connectionStatus"></p></form>`,
      home,
    );
    root.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = home;
    submit(
      root.querySelector("form")!,
      async (data) => {
        root.querySelector("[role=status]")!.textContent =
          "Complete sign-in in the hub window.";
        await connectHub(String(data.get("origin")));
        await changed();
        home();
      },
      (e) => {
        root.querySelector("[role=status]")!.textContent = "";
        page.error(e);
      },
    );
  }
  function addComputer(login: HubLogin, hub: HubInfo) {
    const root = page.render(
      "Add computer",
      `<form class="connectionForm"><div class="connectionRow">${icon("hub")}<span class="connectionRowText"><strong>${esc(hub.name)}</strong><span class="connectionHint">${esc(login.origin)}</span></span></div>${field("Computer name", '<input name="name" type="text" autocomplete="off" placeholder="e.g. My laptop" maxlength="120" required>')}<p class="connectionHint">After adding it, pair the computer with this hub.</p><div class="connectionActions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Add computer</button></div></form>`,
      home,
    );
    root.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = home;
    submit(
      root.querySelector("form")!,
      async (data) => {
        const result = await api(login, "/api/hubs/" + hub.id + "/computers", {
          name: data.get("name"),
          ownerId: login.accountId,
        });
        expanded.add(login.origin + "|" + login.hubId);
        await changed();
        pairing(login, result.computer, result.pairing);
      },
      page.error,
    );
  }
  function pairing(
    login: HubLogin,
    computer: Computer,
    value?: { code: string; expiresAt?: number } | null,
  ) {
    const root = page.render(
      "Pair computer",
      `<div class="connectionForm"><h2>${esc(computer.name)}</h2><p class="connectionHint">Use this code when attaching the computer to ${esc(login.name)}. It is single-use and expires in 15 minutes.</p><div class="connectionCode connectionPairCode" data-code>${esc(value?.code ?? "")}</div><div class="connectionActions"><button data-copy ${value?.code ? "" : "disabled"}>Copy code</button><button data-renew>New code</button><button class="primary" data-done>Done</button></div><p class="connectionStatus" role="status"></p><section class="connectionSection"><h2>Attach on your computer</h2><p class="connectionHint">After installing Codoxear Computer, run this from its folder on your computer:</p><pre class="connectionCode" data-command></pre><div class="connectionActions"><button data-copy-command>Copy attach command</button><button data-setup>Setup guide</button></div><p class="connectionHint">Enter your workspace directory when prompted. Then start Computer:</p><pre class="connectionCode">npm run computer -- start</pre><p class="connectionHint">Keep it running. This computer will appear Online in the hub list.</p></section></div>`,
      home,
    );
    const version = page.version;
    root.querySelector<HTMLButtonElement>("[data-setup]")!.onclick = () =>
      page.render("Computer setup", computerSetup(), () =>
        pairing(login, computer, value),
      );
    root.querySelector<HTMLButtonElement>("[data-copy-command]")!.onclick =
      () => {
        if (!value?.code) return;
        void navigator.clipboard
          .writeText(attachCommand(login.origin, value.code))
          .then(() => {
            if (page.version === version)
              root.querySelector("[role=status]")!.textContent =
                "Attach command copied";
          })
          .catch(page.error);
      };
    const show = (v: { code: string; expiresAt?: number }) => {
      if (page.version !== version || !root.isConnected) return;
      value = v;
      root.querySelector("[data-code]")!.textContent = v.code;
      root.querySelector("[data-command]")!.textContent = attachCommand(
        login.origin,
        v.code,
      );
      root.querySelector<HTMLButtonElement>("[data-copy]")!.disabled = false;
    };
    root.querySelector<HTMLButtonElement>("[data-copy]")!.onclick = () => {
      void navigator.clipboard
        .writeText(root.querySelector("[data-code]")!.textContent ?? "")
        .then(() => {
          root.querySelector("[role=status]")!.textContent = "Code copied";
        })
        .catch(page.error);
    };
    root.querySelector<HTMLButtonElement>("[data-renew]")!.onclick = () => {
      void api(login, "/api/computers/" + computer.id + "/pairing", {})
        .then(show)
        .catch(page.error);
    };
    root.querySelector<HTMLButtonElement>("[data-done]")!.onclick = home;
    if (value?.code) show(value);
    else
      void api(login, "/api/computers/" + computer.id + "/pairing", {})
        .then(show)
        .catch(page.error);
  }
  function computerPage(login: HubLogin, c: Computer) {
    const owner = c.ownerId === login.accountId;
    const root = page.render(
      c.name,
      `<div class="connectionForm"><dl class="connectionFact"><dt>Hub</dt><dd>${esc(login.name)}</dd><dt>Status</dt><dd>${c.online ? "Online" : "Offline"}</dd><dt>Owner</dt><dd>${esc(c.ownerName ?? "You")}</dd></dl>${owner ? `<div class="connectionActions"><button data-pair>Pair computer</button><button data-access>Manage access</button><button data-import ${c.online ? "" : "disabled"}>Import local session</button></div>` : '<p class="connectionHint">Contact the computer owner to change access.</p>'}</div>`,
      home,
    );
    root.querySelector<HTMLButtonElement>("[data-import]")?.addEventListener("click", () => void importSession(login, c).catch(page.error));
    root
      .querySelector<HTMLButtonElement>("[data-pair]")
      ?.addEventListener("click", () => pairing(login, c));
    root
      .querySelector<HTMLButtonElement>("[data-access]")
      ?.addEventListener(
        "click",
        () =>
          void accessPage(page, login, "computer", c.id, c.policy, () =>
            computerPage(login, c),
          ),
      );
  }
  async function importSession(login: HubLogin, computer: Computer) {
    page.render("Import a local session", '<p class="connectionHint" role="status">Finding local sessions…</p>', () => computerPage(login, computer));
    const version = page.version;
    const sessions = await api(login, "/api/computers/" + computer.id + "/discovered") as Array<{session_id: string; agent_backend: string; alias?: string}>;
    if (!page.element.isConnected || version !== page.version) return;
    if (!sessions.length) {
      page.render("Import a local session", '<p class="connectionHint" role="status">No unpublished local sessions were found.</p>', () => computerPage(login, computer));
      return;
    }
    const root = page.render("Import a local session", `<form class="connectionForm"><p class="connectionHint">Publish this session and its existing history to people with access to this computer.</p>${field("Local session", `<select name="localId">${sessions.map(s => `<option value="${esc(s.session_id)}">${esc(s.alias || s.session_id)} · ${esc(s.agent_backend)}</option>`).join("")}</select>`)}${field("Agent name", '<input name="name" required maxlength="120" autocomplete="off">')}<div class="connectionActions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Import session</button></div><p class="connectionStatus" role="status"></p></form>`, () => computerPage(login, computer));
    root.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () => computerPage(login, computer);
    submit(root.querySelector("form")!, async data => {
      await api(login, "/api/computers/" + computer.id + "/import", {localId: data.get("localId"), name: data.get("name")});
      await changed();
      page.close();
    }, page.error);
  }
  function settings(group: Group, hub?: HubInfo) {
    const first = group.logins[0]!,
      owner = group.logins.find((l) => l.accountId === hub?.ownerId);
    const root = page.render(
      "Hub settings",
      `<div class="connectionStack"><div><h2>${esc(hub?.name ?? first.name)}</h2><p class="connectionHint">${esc(first.origin)}</p></div>${owner ? '<div class="connectionActions"><button data-access>Manage hub access</button></div>' : ""}<section class="connectionSection"><h2>Sign-ins on this device</h2>${group.logins.map((l) => `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(l.identity.name)}</strong><span class="connectionHint">${esc(l.identity.method)}</span></span><button data-identities="${l.id}">Sign-in methods</button><button data-forget="${l.id}">Disconnect</button></div>`).join("")}</section><div class="connectionActions"><button data-signin>Add sign-in</button><button data-invite>Accept invitation</button></div></div>`,
      home,
    );
    if (owner)
      root.querySelector<HTMLButtonElement>("[data-access]")!.onclick = () =>
        void accessPage(page, owner, "hub", owner.hubId, hub!.policy, () =>
          settings(group, hub),
        );
    root.querySelector<HTMLButtonElement>("[data-signin]")!.onclick = () => {
      void connectHub(first.origin).then(changed).then(home).catch(page.error);
    };
    root.querySelector<HTMLButtonElement>("[data-invite]")!.onclick = () =>
      invitation(group, () => settings(group, hub));
    for (const b of root.querySelectorAll<HTMLButtonElement>(
      "[data-identities]",
    ))
      b.onclick = () => {
        const login = group.logins.find((l) => l.id === b.dataset.identities)!;
        window.open(
          identitySettingsUrl(login),
          "codoxear-identity-settings",
          "popup,width=560,height=740",
        );
      };
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-forget]"))
      b.onclick = () => {
        const login = group.logins.find((l) => l.id === b.dataset.forget)!;
        const view = page.render(
          "Disconnect hub",
          `<div class="connectionForm"><p>Remove the saved ${esc(login.identity.method)} sign-in for ${esc(login.name)} from this device?</p><p class="connectionHint">Your hub, computers and agents will remain available.</p><div class="connectionActions"><button data-cancel>Cancel</button><button class="primary" data-confirm>Disconnect</button></div></div>`,
          () => settings(group, hub),
        );
        view.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () =>
          settings(group, hub);
        view.querySelector<HTMLButtonElement>("[data-confirm]")!.onclick =
          () => {
            void (async () => {
              const removed = await fetch("/api/client/push/disconnect/" + encodeURIComponent(login.id), { method: "POST" });
              if (!removed.ok) throw new Error("Hub disconnect failed");
              forgotten();
              await changed();
              home();
            })().catch(page.error);
          };
      };
  }
  function invitation(group: Group, back: () => void) {
    const root = page.render(
      "Accept invitation",
      `<form class="connectionForm">${field("Sign-in", `<select name="login">${group.logins.map((l) => `<option value="${l.id}">${esc(l.identity.name)} · ${esc(l.identity.method)}</option>`).join("")}</select>`)}${field("Invitation code", '<input name="token" type="text" required autocomplete="off">')}<div class="connectionActions"><button class="primary" type="submit">Accept invitation</button></div><p role="status" class="connectionStatus"></p></form>`,
      back,
    );
    submit(
      root.querySelector("form")!,
      async (data) => {
        await api(
          group.logins.find((l) => l.id === data.get("login"))!,
          "/api/v1/invitations/accept",
          { token: data.get("token") },
        );
        await changed();
        home();
      },
      page.error,
    );
  }
  home();
  return page;
}
async function accessPage(
  page: ConnectionPages,
  login: HubLogin,
  kind: "hub" | "computer",
  id: string,
  policy: string | null,
  back: () => void,
) {
  const root = page.render(
      "Manage access",
      '<p class="connectionHint" role="status">Loading access…</p>',
      back,
    ),
    version = page.version,
    path = "/api/resources/" + kind + "/" + id;
  try {
    const [members, resources] = await Promise.all([
      api(login, path + "/members"),
      api(login, kind === "hub" ? "/api/hubs" : "/api/v1/computers"),
    ]);
    policy =
      resources.find((resource: any) => resource.id === id)?.policy ?? null;
    const workspace: WorkspaceReview | null = kind === "computer" ? await api(login, `/api/computers/${id}/workspace`).catch(() => null) : null;
    if (page.version !== version || !root.isConnected) return;
    page.render(
      "Manage access",
      `<div class="connectionStack"><section class="connectionStack"><h2>Members</h2>${members.map((m: any) => `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(m.name ?? m.email)}</strong><span class="connectionHint">${esc(m.role)}</span></span><button data-remove="${esc(m.userId)}">Remove access</button></div>`).join("") || '<p class="connectionHint">No invited members.</p>'}</section><form data-invite class="connectionForm connectionSection"><h2>Invite someone</h2>${invitationFields()}${field("Role", '<select name="role"><option value="viewer">Viewer</option><option value="operator">Operator</option></select>')}<div class="connectionActions"><button type="submit">Create invitation</button></div><output class="connectionCode" hidden></output></form><form data-policy class="connectionForm connectionSection"><h2>After access is removed</h2><p class="connectionHint">A hub policy takes precedence over the computer policy.</p>${field("Existing agents", `<select name="policy"><option value="">${kind === "hub" ? "Follow computer policy" : "Default (no access)"}</option><option value="retain">Retain access</option><option value="read_only">Read only</option><option value="none">No access</option></select>`)}<div class="connectionActions"><button class="primary" type="submit">Save policy</button></div><p role="status" class="connectionStatus"></p></form></div>`,
      back,
    );
    if (workspace) {
      const section = document.createElement("section");
      section.className = "connectionStack";
      section.innerHTML = workspaceRootFields(workspace) + members.map((m: any) => workspaceAccessFields(m, workspace)).join("");
      root.querySelector(".connectionStack")!.append(section);
      for (const form of section.querySelectorAll<HTMLFormElement>(".workspace-form")) {
        const member = members.find((m: any) => m.userId === form.dataset.member);
        bindWorkspaceGrant(form, member);
        submit(form, async data => {
          const body = workspaceGrantBody(data);
          await api(login, `/api/computers/${id}/workspace-access/${form.dataset.member}`, body, "PUT");
          member.workspaceGrants = [...(member.workspaceGrants ?? []).filter((g: any) => g.workspaceId !== body.workspaceId), ...(body.access ? [body] : [])];
          form.querySelector("[role=status]")!.textContent = "Workspace access saved";
        }, page.error);
      }
      submit(section.querySelector<HTMLFormElement>(".workspace-root-form")!, async data => {
        await api(login, `/api/computers/${id}/workspace`, {name: data.get("name"), path: data.get("path")}, "PUT");
        await accessPage(page, login, kind, id, policy, back);
      }, page.error);
      for (const button of section.querySelectorAll<HTMLButtonElement>("[data-remove-workspace]")) button.onclick = () => {
        void api(login, `/api/computers/${id}/workspace`, {id: button.dataset.removeWorkspace, remove: true}, "PUT").then(() => accessPage(page, login, kind, id, policy, back)).catch(page.error);
      };
    }
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-remove]"))
      b.onclick = () => {
        void api(
          login,
          path + "/members/" + b.dataset.remove,
          undefined,
          "DELETE",
        )
          .then(() => b.closest(".connectionRow")?.remove())
          .catch(page.error);
      };
    const invite = root.querySelector<HTMLFormElement>("[data-invite]")!;
    wireInvitationFields(invite);
    submit(
      invite,
      async (data) => {
        const result = await api(
          login,
          path + "/invitations",
          invitationBody(data),
        );
        const output = invite.querySelector("output")!;
        output.hidden = false;
        output.textContent = "Invitation code: " + result.token;
      },
      page.error,
    );
    const settings = root.querySelector<HTMLFormElement>("[data-policy]")!;
    settings.querySelector<HTMLSelectElement>("select")!.value = policy ?? "";
    submit(
      settings,
      async (data) => {
        await api(
          login,
          path + "/policy",
          { policy: data.get("policy") || null },
          "PUT",
        );
        settings.querySelector("[role=status]")!.textContent = "Policy saved";
      },
      page.error,
    );
  } catch (e) {
    page.error(e);
  }
}
export async function openAgentAccess(agent: any) {
  current?.close();
  const page = new ConnectionPages();
  current = page;
  page.render(
    "Agent access",
    '<p class="connectionHint">Loading access…</p>',
    page.close,
  );
  try {
    const login = await vault.get(agent.loginId);
    if (!login) throw new Error("Sign in to this hub again.");
    const computers = await api(login, "/api/v1/computers");
    if (!page.element.isConnected) return;
    const computer = computers.find((c: Computer) => c.id === agent.computerId);
    const owner = computer?.ownerId === login.accountId;
    const agentId = agent.agentId ?? agent.id;
    const shares = owner
      ? await api(login, `/api/agents/${agentId}/shares`)
      : null;
    if (!page.element.isConnected) return;
    const shareSection = shares
      ? `<section class="connectionSection connectionStack"><h2>Share this agent</h2><p class="connectionHint">Share with a hub member without granting access to other agents or creating new ones. Saving replaces any retained access to this agent. Computer membership still grants its existing access.</p>${shares.members.map((m: any) => `<form class="connectionForm" data-agent-share="${esc(m.userId)}"><h3>${esc(m.name)}</h3><p class="connectionHint" data-current-access>Current access: ${esc(m.access.reason)}.</p>${field(`Shared access for ${m.name}`, `<select name="role" aria-label="${esc(`Shared access for ${m.name}`)}"><option value="">No shared access</option><option value="viewer">Viewer</option><option value="operator">Operator</option></select>`)}<div class="connectionActions"><button type="submit">Save agent access</button></div><p class="connectionStatus" role="status"></p></form>`).join("") || '<p class="connectionHint">Invite someone to the hub first in Hubs & computers → Hub settings.</p>'}</section>`
      : "";
    const root = page.render(
      "Agent access",
      `<dl class="connectionFact"><dt>Agent</dt><dd>${esc(agent.name)}</dd><dt>Computer</dt><dd>${esc(agent.computerName)}</dd><dt>Hub</dt><dd>${esc(agent.hubName)}</dd></dl>${computer?.ownerId === login.accountId ? '<div class="connectionActions"><button data-access>Manage computer access</button></div>' : '<p class="connectionHint">Contact the computer owner to change access.</p>'}${shareSection}`,
      page.close,
    );
    for (const form of root.querySelectorAll<HTMLFormElement>(
      "[data-agent-share]",
    )) {
      const member = shares.members.find(
        (m: any) => m.userId === form.dataset.agentShare,
      );
      form.querySelector<HTMLSelectElement>("select")!.value =
        member.role ?? "";
      submit(
        form,
        async (data) => {
          form.querySelector("[role=status]")!.textContent = "";
          const result = await api(
            login,
            `/api/agents/${agentId}/shares/${member.userId}`,
            { role: data.get("role") || null },
            "PUT",
          );
          form.querySelector("[data-current-access]")!.textContent =
            `Current access: ${result.access.reason}.`;
          form.querySelector("[role=status]")!.textContent =
            "Agent access saved";
        },
        page.error,
      );
    }
    root.querySelector<HTMLButtonElement>("[data-access]")?.addEventListener(
      "click",
      () =>
        void accessPage(
          page,
          login,
          "computer",
          agent.computerId,
          computer.policy,
          () => {
            page.close();
            void openAgentAccess(agent);
          },
        ),
    );
  } catch (e) {
    page.error(e);
  }
}
