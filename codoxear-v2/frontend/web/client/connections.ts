import { invitationLink } from "./hub-invitations.js";
import { attachCommand, computerSetup } from "./computer-setup.js";
import { delegationSection, bindDelegation } from "./delegation.js";
import { vault, type HubLogin } from "./vault.js";
import { connectHub } from "./login.js";
import { canonicalOrigin } from "../../shared/context.js";
import { ConnectionPages, esc, icon, field, submit, message } from "./views.js";
import {
  workspaceAccessFields,
  workspaceRootFields,
  bindWorkspaceGrant,
  workspaceGrantBody,
  type WorkspaceReview,
} from "../shared/workspace-access.js";
type Computer = {
  id: string;
  name: string;
  ownerId: string;
  ownerName?: string;
  policy: string | null;
  effectivePolicy: string;
  online: boolean;
  canManage?: boolean;
  canUse?: boolean;
  canRead?: boolean;
  canWrite?: boolean;
  canCreate?: boolean;
};
type Group = { key: string; logins: HubLogin[] };
type HubInfo = {
  id: string;
  name: string;
  ownerId: string;
  policy: string | null;
  role?: "owner" | "admin" | "member" | null;
};
const roleLabel = (role: HubLogin["role"]) =>
  role === "owner"
    ? "Owner"
    : role === "admin"
      ? "Admin"
      : role === "member"
        ? "Member"
        : "Not a member";
let current: ConnectionPages | undefined;
async function api(
  login: HubLogin,
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
  timeoutMs = 12000,
) {
  const r = await fetch("/api/client/hubs/" + login.id + path, {
    method,
    signal: AbortSignal.timeout(timeoutMs),
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
    root.querySelector<HTMLButtonElement>("[data-add-hub]")!.onclick = () =>
      void addHub().catch(page.error);
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
              const me = await api(login, "/api/v1/me");
              login.role = me.hubRole;
              const fallback: HubInfo = {
                id: login.hubId,
                name: login.name,
                ownerId: "",
                policy: null,
                role: me.hubRole,
              };
              if (!me.hubRole)
                return {
                  login,
                  hub: fallback,
                  computers: [] as Computer[],
                  notMember: true,
                };
              const [hubs, computers] = await Promise.all([
                api(login, "/api/hubs"),
                api(login, "/api/v1/computers"),
              ]);
              return {
                login,
                hub: { ...(hubs[0] ?? fallback), role: me.hubRole } as HubInfo,
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
        const owner = good.find((r) => r.login.role === "owner");
        const manager = owner ?? good.find((r) => r.login.role === "admin");
        const machines = new Map<
          string,
          {
            computer: Computer;
            login: HubLogin;
            writer: HubLogin|undefined;
            usable: boolean;
          }
        >();
        for (const result of good)
          for (const computer of result.computers!) {
            const previous = machines.get(computer.id);
            const prefer =
              !previous ||
              (computer.canManage && !previous.computer.canManage) ||
              (!previous.computer.canManage &&
                computer.canWrite &&
                !previous.computer.canWrite);
            machines.set(computer.id, {
              computer: prefer ? computer : previous!.computer,
              login: prefer ? result.login : previous!.login,
              writer:
                previous?.writer ??
                (computer.canWrite ? result.login : undefined),
              usable: !!previous?.usable || !!computer.canUse,
            });
          }
        box.innerHTML = `<section class="connectionSection"><h2>Hub identities</h2>${group.logins.map((login) => `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(login.identity.name)}</strong><span class="connectionHint">${esc(login.identity.method)} · <strong>${esc(roleLabel(login.role))}</strong></span></span><span class="connectionHint">${esc(results.find((result) => result.login.id === login.id)?.error ?? "Connected")}</span></div>`).join("")}<button data-add-identity>Add identity</button></section><div class="connectionHubTools"><button data-add-computer ${manager ? "" : "disabled"}>${icon("plus")}Add computer</button><button data-hub-settings>Hub settings</button></div>${good.length ? (machines.size ? `<div class="connectionComputers">${[...machines.values()].map(({ computer: c, usable }) => `<button class="connectionComputer" data-computer="${esc(c.id)}">${icon("computer")}<span class="connectionRowText"><strong>${esc(c.name)}</strong><span class="connectionHint">${c.online ? "Online" : "Offline"}${!usable ? " · Not allowlisted" : ""}${c.ownerName ? " · " + esc(c.ownerName) : ""}</span></span>${icon("chevron")}</button>`).join("")}</div>` : `<p class="connectionHint">${manager ? "No computers yet. Add a computer to get started." : good.some(result=>result.login.role)?"No computers are available to these identities. Ask a Hub owner or admin for allowlist access.":"Signed in, but not a Hub member. Open an invitation link from a Hub owner or admin."}</p>`) : `<p class="connectionError">${esc(results[0]?.error ?? "Hub unavailable")}</p><button data-retry>Retry</button>`}${!manager && good.length ? '<p class="connectionHint">A Hub owner or admin can add computers.</p>' : ""}`;
        box.querySelector<HTMLButtonElement>("[data-add-identity]")!.onclick =
          () => addIdentity(group.logins[0]!.origin);
        loaded = !!good.length;
        box.querySelector<HTMLButtonElement>("[data-hub-settings]")!.onclick =
          () => settings(group, manager?.hub ?? good[0]?.hub);
        if (manager)
          box.querySelector<HTMLButtonElement>("[data-add-computer]")!.onclick =
            () => addComputer(manager.login, manager.hub!);
        box
          .querySelector<HTMLButtonElement>("[data-retry]")
          ?.addEventListener("click", () => void load().catch(page.error));
        for (const button of box.querySelectorAll<HTMLButtonElement>(
          "[data-computer]",
        ))
          button.onclick = () => {
            const selected = machines.get(button.dataset.computer!)!;
            computerPage(selected.login, selected.computer, selected.writer);
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
  async function broadcastIdentityChange() {
    for (const registration of await navigator.serviceWorker.getRegistrations())
      registration.active?.postMessage({ type: "codoxear-identity-changed" });
  }
  function resetWorkspace() {
    forgotten();
    history.replaceState(null, "", location.pathname + location.search);
    page.close();
    location.reload();
  }
  async function finishConnect(login: HubLogin, previous: HubLogin[] = []) {
    const replaced = previous.find(
      (row) => row.id === login.id && row.selectionId !== login.selectionId,
    );
    if (replaced) {
      await broadcastIdentityChange();
      resetWorkspace();
      return;
    }
    await changed();
    home();
  }
  function addIdentity(origin: string) {
    void providerChoices(origin, home).catch(page.error);
  }
  async function providerChoices(origin: string, back: () => void) {
    const response = await fetch(origin + "/api/v1/auth/options", {
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(10000),
    });
    if (!response.ok)
      throw new Error("Unable to load this Hub's sign-in providers");
    const options = await response.json();
    const providers = options.providers.filter(
      (provider: any) =>
        ["google", "feishu"].includes(provider.method) &&
        options.loginMethods.allowedMethods.includes(provider.method),
    );
    const choice = page.render(
      "Sign in to Hub",
      `<p class="connectionHint">${esc(origin)}</p><div class="connectionStack">${providers.map((provider: any) => `<button class="primary" data-provider="${esc(provider.id)}">Continue with ${provider.method === "google" ? "Google" : "Feishu"}${provider.name ? " · " + esc(provider.name) : ""}</button>`).join("")}</div>${providers.length ? '<p class="connectionHint">Sign in with each identity you want to use. Accept a Hub invitation to become a member; computer access is granted separately.</p>' : '<p role="status">No sign-in providers are available. Ask the Hub owner to configure Google or Feishu.</p>'}${options.setupRequired ? '<p class="connectionHint">This Hub is awaiting its first owner. The administrator must open the private initialization link from the Hub deployment.</p>' : ""}`,
      back,
    );
    for (const button of choice.querySelectorAll<HTMLButtonElement>(
      "[data-provider]",
    ))
      button.onclick = () => {
        const previous = vault.list();
        void connectHub(origin, button.dataset.provider)
          .then(async (login) => finishConnect(login, await previous))
          .catch(page.error);
      };
  }
  async function addHub() {
    let preset = "";
    try {
      preset = canonicalOrigin(
        new URL(location.href).searchParams.get("hub") ?? "",
      );
    } catch {}
    const root = page.render(
      "Add hub",
      `<form class="connectionForm"><p class="connectionHint">Enter the address of the hub you want to use.</p>${field("Hub address", `<input name="origin" type="text" inputmode="url" autocomplete="url" placeholder="https://hub.example.com" value="${esc(preset)}" required>`)}<div class="connectionActions"><button type="button" data-cancel>Cancel</button><button class="primary" type="submit">Connect hub</button></div><p role="status" class="connectionStatus"></p></form>`,
      home,
    );
    root.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = home;
    submit(
      root.querySelector("form")!,
      async (data) => {
        let origin: string;
        try {
          origin = canonicalOrigin(
            String(data.get("origin")).trim().replace(/\/$/, ""),
          );
        } catch {
          throw new Error(
            "Enter a complete HTTPS hub address, such as https://hub.example.com.",
          );
        }
        await providerChoices(origin, () => void addHub().catch(page.error));
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
      `<div class="connectionForm"><h2>${esc(computer.name)}</h2><p class="connectionHint">Use this code when attaching the computer to ${esc(login.name)}. It is single-use and expires in 15 minutes.</p><div class="connectionCode connectionPairCode" data-code>${esc(value?.code ?? "")}</div><div class="connectionActions"><button data-copy ${value?.code ? "" : "disabled"}>Copy code</button><button data-renew>New code</button><button class="primary" data-done>Done</button></div><p class="connectionStatus" role="status"></p><section class="connectionSection"><h2>Attach on your computer</h2><p class="connectionHint">After installing Codoxear Computer, run this from its folder on your computer:</p><pre class="connectionCode" data-command></pre><div class="connectionActions"><button data-copy-command>Copy attach command</button><button data-setup>Setup guide</button></div><p class="connectionHint">Enter your workspace directory when prompted. Then start Computer:</p><pre class="connectionCode">node dist/server/computer/main.js start</pre><p class="connectionHint">Keep it running. This computer will appear Online in the hub list. Hub owners and admins also need an explicit allowlist grant before creating agents.</p></section></div>`,
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
  function computerPage(login: HubLogin, c: Computer, writer?: HubLogin) {
    const owner = !!c.canManage;
    const importLogin = writer ?? (c.canWrite ? login : undefined);
    const root = page.render(
      c.name,
      `<div class="connectionForm"><dl class="connectionFact"><dt>Hub</dt><dd>${esc(login.name)}</dd><dt>Status</dt><dd>${c.online ? "Online" : "Offline"}</dd><dt>Owner</dt><dd>${esc(c.ownerName ?? "Unavailable")}</dd></dl><div class="connectionActions">${owner ? "<button data-pair>Pair computer</button><button data-access>Manage access</button>" : ""}<button data-import ${c.online && importLogin ? "" : "disabled"}>Import local session</button></div>${!owner && !importLogin ? '<p class="connectionHint">Ask a Hub owner or admin for computer allowlist access.</p>' : ""}</div>`,
      home,
    );
    root
      .querySelector<HTMLButtonElement>("[data-import]")
      ?.addEventListener("click", () => {
        if (importLogin) void importSession(importLogin, c).catch(page.error);
      });
    root
      .querySelector<HTMLButtonElement>("[data-pair]")
      ?.addEventListener("click", () => pairing(login, c));
    root
      .querySelector<HTMLButtonElement>("[data-access]")
      ?.addEventListener(
        "click",
        () =>
          void allowlistPage(login, c, () => computerPage(login, c)).catch(
            page.error,
          ),
      );
  }
  async function importSession(login: HubLogin, computer: Computer) {
    page.render(
      "Import a local session",
      '<p class="connectionHint" role="status">Finding local sessions…</p>',
      () => computerPage(login, computer),
    );
    const version = page.version;
    const sessions = (await api(
      login,
      "/api/computers/" + computer.id + "/discovered",
    )) as Array<{ session_id: string; agent_backend: string; alias?: string }>;
    if (!page.element.isConnected || version !== page.version) return;
    if (!sessions.length) {
      page.render(
        "Import a local session",
        '<p class="connectionHint" role="status">No unpublished local sessions were found.</p>',
        () => computerPage(login, computer),
      );
      return;
    }
    const root = page.render(
      "Import a local session",
      `<form class="connectionForm"><p class="connectionHint">Publish this session and its existing history to people with access to this computer.</p>${field("Local session", `<select name="localId">${sessions.map((s) => `<option value="${esc(s.session_id)}">${esc(s.alias || s.session_id)} · ${esc(s.agent_backend)}</option>`).join("")}</select>`)}${field("Agent name", '<input name="name" required maxlength="120" autocomplete="off">')}<div class="connectionActions"><button type="button" data-cancel>Cancel</button><button type="submit" class="primary">Import session</button></div><p class="connectionStatus" role="status"></p></form>`,
      () => computerPage(login, computer),
    );
    root.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () =>
      computerPage(login, computer);
    submit(
      root.querySelector("form")!,
      async (data) => {
        await api(login, "/api/computers/" + computer.id + "/import", {
          localId: data.get("localId"),
          name: data.get("name"),
        });
        await changed();
        page.close();
      },
      page.error,
    );
  }
  function settings(group: Group, hub?: HubInfo) {
    const first = group.logins[0]!,
      owner = group.logins.find((l) => l.role === "owner"),
      manager = owner ?? group.logins.find((l) => l.role === "admin");
    const root = page.render(
      "Hub settings",
      `<div class="connectionStack">
        <div><h2>${esc(hub?.name ?? first.name)}</h2><p class="connectionHint">${esc(first.origin)}</p></div>
        ${manager ? `<section class="connectionSection">
          <h2>Hub administration</h2>
          <div class="connectionNavigation">
            <button data-access aria-label="Manage Hub members"><span class="connectionRowText"><strong>Manage Hub members</strong><span class="connectionHint">Invite people and manage their roles</span></span>${icon("chevron")}</button>
            ${owner ? `<button data-login-policy aria-label="Allowed sign-in types"><span class="connectionRowText"><strong>Allowed sign-in types</strong><span class="connectionHint">Choose which providers can sign in</span></span>${icon("chevron")}</button>` : ""}
          </div>
        </section>` : ""}
        <section class="connectionSection">
          <div class="connectionSectionHeader"><h2>Sign-ins on this device</h2><button class="primary" data-signin>${icon("plus")}Add sign-in</button></div>
          ${group.logins.map((l) => `<div class="connectionIdentity">
            <div class="connectionRowText"><strong>${esc(l.identity.name)}</strong><span class="connectionHint">${esc(l.identity.method)} · ${esc(roleLabel(l.role))}</span></div>
            <div class="connectionIdentityActions"><button data-identities="${l.id}">Sign-in methods</button><button class="connectionDestructive" data-forget="${l.id}">Disconnect</button></div>
          </div>`).join("")}
        </section>

      </div>`,
      home,
    );
    if (manager)
      root.querySelector<HTMLButtonElement>("[data-access]")!.onclick = () =>
        void hubMembers(manager, () => settings(group, hub)).catch(page.error);
    if (owner)
      root.querySelector<HTMLButtonElement>("[data-login-policy]")!.onclick =
        () =>
          void loginPolicy(
            owner,
            () => settings(group, hub),
            group.logins.filter((row) => row.role === "owner"),
          ).catch(page.error);
    root.querySelector<HTMLButtonElement>("[data-signin]")!.onclick = () =>
      addIdentity(first.origin);
    for (const b of root.querySelectorAll<HTMLButtonElement>(
      "[data-identities]",
    ))
      b.onclick = () => {
        const login = group.logins.find((l) => l.id === b.dataset.identities)!;
        void hubSignInMethods(login, () => settings(group, hub)).catch(
          page.error,
        );
      };
    for (const b of root.querySelectorAll<HTMLButtonElement>("[data-forget]"))
      b.onclick = () => {
        const login = group.logins.find((l) => l.id === b.dataset.forget)!;
        const view = page.render(
          "Disconnect hub",
          `<div class="connectionForm"><p>Remove the saved ${esc(login.identity.method)} sign-in for ${esc(login.name)} from this device?</p><p class="connectionHint">Sign in through this Hub’s configured provider to connect this identity again.</p><div class="connectionActions"><button data-cancel>Cancel</button><button class="primary" data-confirm>Disconnect</button></div></div>`,
          () => settings(group, hub),
        );
        view.querySelector<HTMLButtonElement>("[data-cancel]")!.onclick = () =>
          settings(group, hub);
        view.querySelector<HTMLButtonElement>("[data-confirm]")!.onclick =
          () => {
            void (async () => {
              const removed = await fetch(
                "/api/client/push/disconnect/" + encodeURIComponent(login.id),
                { method: "POST" },
              );
              if (!removed.ok) throw new Error("Hub disconnect failed");
              await broadcastIdentityChange();
              forgotten();
              await changed();
              home();
            })().catch(page.error);
          };
      };
  }
  async function hubMembers(login: HubLogin, back: () => void) {
    page.render("Hub members", '<p role="status">Loading members…</p>', back);
    const version = page.version;
    const path = "/api/v1/hubs/" + encodeURIComponent(login.hubId) + "/members";
    const data = await api(login, path);
    if (page.version !== version || !page.element.isConnected) return;
    const root = page.render(
      "Hub members",
      `<section class="connectionStack">${data.members.map((member: any) => `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(member.name)}</strong><span>${esc(roleLabel(member.role))}</span></span>${data.role === "owner" && member.role !== "owner" ? `<button data-role="${esc(member.userId)}" data-next="${member.role === "admin" ? "member" : "admin"}">${member.role === "admin" ? "Make member" : "Make admin"}</button>` : ""}${member.role !== "owner" && (data.role === "owner" || member.role === "member") ? `<button data-kick="${esc(member.userId)}">Remove member</button>` : ""}</div>`).join("")}</section><form class="connectionForm connectionSection"><h2>Invite to Hub</h2><p class="connectionHint">This link is for one person. Anyone with the link can join once as Member after signing in. Computer access and Admin promotion are separate.</p>${field("Invitation expiry", '<select name="expiresInHours"><option value="1">1 hour</option><option value="24" selected>24 hours</option><option value="168">7 days</option></select>')}<button type="submit">Create invitation link</button><div data-created hidden>${field("Invitation link", '<input aria-label="Invitation link" readonly data-private>')}<button type="button" data-copy-link>Copy invitation link</button></div></form><section class="connectionSection"><h2>Pending invitations</h2><div data-pending-invitations role="status">Loading invitations…</div></section><div class="connectionStack"><p role="alert" class="connectionError"></p></div>`,
      back,
    );
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      "[data-role]",
    ))
      button.onclick = () =>
        void api(
          login,
          path + "/" + encodeURIComponent(button.dataset.role!),
          { role: button.dataset.next },
          "PUT",
        )
          .then(() => hubMembers(login, back))
          .catch(page.error);
    for (const button of root.querySelectorAll<HTMLButtonElement>(
      "[data-kick]",
    ))
      button.onclick = () =>
        void api(
          login,
          path + "/" + encodeURIComponent(button.dataset.kick!),
          undefined,
          "DELETE",
        )
          .then(() => hubMembers(login, back))
          .catch(page.error);
    const form = root.querySelector<HTMLFormElement>("form")!;
    const invitationsPath = "/api/hubs/" + encodeURIComponent(login.hubId) + "/invitation-links";
    async function refreshInvitations() {
      const version = page.version;
      const result = await api(login, invitationsPath);
      if (page.version !== version || !root.isConnected) return;
      const target = root.querySelector<HTMLElement>("[data-pending-invitations]")!;
      const pending = result.invitations.filter((invite: any) => invite.status === "pending");
      target.innerHTML = pending.length ? pending.map((invite: any) => `<div class="connectionRow" data-pending-invitation="${esc(invite.id)}"><span class="connectionRowText"><strong>Member invitation</strong><span>Expires ${esc(new Date(invite.expiresAt).toLocaleString())}</span></span><button data-revoke="${esc(invite.id)}">Revoke invitation</button></div>`).join("") : "No pending invitations.";
      for (const button of target.querySelectorAll<HTMLButtonElement>("[data-revoke]")) button.onclick = () => {
        button.disabled = true;
        void api(login, invitationsPath + "/" + encodeURIComponent(button.dataset.revoke!), undefined, "DELETE").then(refreshInvitations).catch(error => { button.disabled = false; page.error(error); });
      };
    }
    void refreshInvitations().catch(page.error);
    submit(form, async values => {
      const version = page.version;
      const result = await api(login, invitationsPath, { expiresInHours: Number(values.get("expiresInHours")) });
      if (page.version !== version || !root.isConnected) return;
      const input = form.querySelector<HTMLInputElement>("[aria-label='Invitation link']")!;
      input.value = invitationLink(login.origin, result.token);
      form.querySelector<HTMLElement>("[data-created]")!.hidden = false;
      form.querySelector<HTMLButtonElement>("[data-copy-link]")!.onclick = () => void navigator.clipboard.writeText(input.value).catch(page.error);
      await refreshInvitations();
    }, page.error);
  }
  const allowlistPage = (
    login: HubLogin,
    computer: Computer,
    back: () => void,
  ) => computerAllowlistPage(page, login, computer, back, changed);
  async function loginPolicy(
    login: HubLogin,
    back: () => void,
    owners: HubLogin[] = [login],
  ) {
    page.render(
      "Allowed sign-in types",
      '<p role="status">Loading Hub policy…</p>',
      back,
    );
    const version = page.version;
    const path =
      "/api/v1/hubs/" + encodeURIComponent(login.hubId) + "/login-methods";
    let policy: any;
    for (const owner of owners) {
      try {
        policy = await api(owner, path);
        login = owner;
        break;
      } catch {}
    }
    if (!policy)
      throw new Error(
        "A valid owner identity is needed to change this Hub's sign-in types",
      );
    if (page.version !== version || !page.element.isConnected) return;
    const root = page.render(
      "Allowed sign-in types",
      `<form class="connectionForm"><p>Choose which provider types may sign in to this Hub. All saved identities of an allowed type remain connected.</p>${policy.availableMethods.map((method: string) => `<label class="connectionRow"><input type="checkbox" name="method" value="${esc(method)}" ${policy.allowedMethods.includes(method) ? "checked" : ""}><span>${esc(method === "google" ? "Google" : method === "feishu" ? "Feishu" : method)}</span></label>`).join("")}<p class="connectionHint">Keep a sign-in type available for your owner account. Sign in with another allowed owner identity before removing the type you are using.</p><button class="primary" type="submit">Save allowed types</button><p role="status" class="connectionStatus"></p></form>`,
      back,
    );
    submit(
      root.querySelector("form")!,
      async (data) => {
        const allowedMethods = data.getAll("method");
        if (!allowedMethods.length)
          throw new Error("Choose at least one sign-in type");
        let actor: HubLogin | undefined;
        for (const owner of owners.filter((row) =>
          allowedMethods.includes(row.identity.method),
        )) {
          try {
            await api(owner, path);
            actor = owner;
            break;
          } catch {}
        }
        if (!actor)
          throw new Error(
            "Sign in with an owner identity of a type you are keeping first",
          );
        await api(actor, path, { allowedMethods }, "PUT");
        await broadcastIdentityChange();
        forgotten();
        await changed();
        home();
      },
      page.error,
    );
  }
  async function hubSignInMethods(login: HubLogin, back: () => void) {
    page.render(
      "Sign-in methods",
      '<p class="connectionHint" role="status">Loading this Hub account…</p>',
      back,
    );
    const version = page.version;
    const me = await api(login, "/api/v1/me");
    if (page.version !== version || !page.element.isConnected) return;
    page.render("Sign-in methods", `<div class="connectionStack"><p>Signed in as <strong>${esc(me.name)}</strong> on ${esc(login.name)}.</p><section class="connectionSection"><h2>Linked accounts</h2>${me.identities.map((identity: any) => `<div class="connectionRow"><strong>${esc(identity.method === "google" ? "Google" : "Feishu")}</strong></div>`).join("")}</section><p class="connectionHint">To invite someone, a Hub owner or admin shares an invitation link from Hub members.</p></div>`, back);
  }
  home();
      },
      page.error,
    );
  }
  home();
  return page;
}
async function computerAllowlistPage(
  page: ConnectionPages,
  login: HubLogin,
  computer: Computer,
  back: () => void,
  changed: () => Promise<void> = async () => {},
) {
  page.render(
    "Computer allowlist",
    '<p role="status">Loading allowlist…</p>',
    back,
  );
  const version = page.version;
  const path =
    "/api/v1/computers/" + encodeURIComponent(computer.id) + "/allowlist";
  const [data, people] = await Promise.all([
    api(login, path),
    api(login, "/api/v1/hubs/" + login.hubId + "/members"),
  ]);
  if (page.version !== version || !page.element.isConnected) return;
  const root = page.render(
    "Computer allowlist",
    `<div><h2>${esc(computer.name)}</h2><p class="connectionHint">Everyone needs an explicit Computer access grant, including Hub owners and admins.</p></div>
    <section class="connectionSection"><h2>People with access</h2><div class="connectionMembers">${data.entries.map((entry: any) => `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(entry.name)}</strong><span class="connectionHint">${entry.access === "write" ? "Read and write" : "Read only"}</span></span><button class="connectionDestructive" data-remove-allowlist="${esc(entry.userId)}">Remove access</button></div>`).join("") || '<p class="connectionHint">No identities are allowlisted.</p>'}</div></section>
    <form class="connectionForm connectionSection">
      <h2>Grant or update access</h2>
      <div class="connectionFields">
        ${field("Hub member", `<select name="userId" aria-label="Hub member">${people.members.map((member: any) => `<option value="${esc(member.userId)}">${esc(member.name)} · ${esc(roleLabel(member.role))}</option>`).join("")}</select>`)}
        ${field("Computer access", '<select name="access" aria-label="Computer access"><option value="read">Read only</option><option value="write">Read and write</option></select>')}
      </div>
      <p class="connectionHint">Read only allows viewing agents. Read and write also allows creating agents and sending messages.</p>
      <div class="connectionActions"><button class="primary" type="submit">Grant computer access</button></div>
      <p role="status" class="connectionStatus"></p>
    </form>
    <section class="connectionSection"><div class="connectionNavigation"><button type="button" data-workspaces aria-label="Workspace permissions"><span class="connectionRowText"><strong>Workspace permissions</strong><span class="connectionHint">Manage access to files and workspace roots</span></span>${icon("chevron")}</button></div></section>`,
    back,
  );
  root.querySelector<HTMLButtonElement>("[data-workspaces]")!.onclick = () =>
    void workspacePermissionsPage(
      page,
      login,
      computer.id,
      () =>
        void computerAllowlistPage(page, login, computer, back, changed).catch(
          page.error,
        ),
    );
  for (const button of root.querySelectorAll<HTMLButtonElement>(
    "[data-remove-allowlist]",
  ))
    button.onclick = () =>
      void api(
        login,
        path + "/" + encodeURIComponent(button.dataset.removeAllowlist!),
        undefined,
        "DELETE",
      )
        .then(() => computerAllowlistPage(page, login, computer, back, changed))
        .catch(page.error);
  submit(
    root.querySelector("form")!,
    async (values) => {
      await api(
        login,
        path + "/" + encodeURIComponent(String(values.get("userId"))),
        { access: values.get("access") },
        "PUT",
      );
      await changed();
      await computerAllowlistPage(page, login, computer, back, changed);
    },
    page.error,
  );
}

async function workspacePermissionsPage(
  page: ConnectionPages,
  login: HubLogin,
  id: string,
  back: () => void,
) {
  const root = page.render(
      "Workspace permissions",
      '<p class="connectionHint" role="status">Loading workspace permissions…</p>',
      back,
    ),
    version = page.version;
  try {
    const [members, workspace]: [any[], WorkspaceReview] = await Promise.all([
      api(login, "/api/resources/computer/" + id + "/members"),
      api(login, `/api/computers/${id}/workspace`),
    ]);
    if (page.version !== version || !root.isConnected) return;
    page.render(
      "Workspace permissions",
      '<div class="connectionStack"></div>',
      back,
    );
    if (workspace) {
      const section = document.createElement("section");
      section.className = "connectionStack";
      section.innerHTML =
        workspaceRootFields(workspace) +
        members.map((m: any) => workspaceAccessFields(m, workspace)).join("");
      root.querySelector(".connectionStack")!.append(section);
      for (const form of section.querySelectorAll<HTMLFormElement>(
        ".workspace-form",
      )) {
        const member = members.find(
          (m: any) => m.userId === form.dataset.member,
        );
        bindWorkspaceGrant(form, member);
        submit(
          form,
          async (data) => {
            const body = workspaceGrantBody(data);
            await api(
              login,
              `/api/computers/${id}/workspace-access/${form.dataset.member}`,
              body,
              "PUT",
            );
            member.workspaceGrants = [
              ...(member.workspaceGrants ?? []).filter(
                (g: any) => g.workspaceId !== body.workspaceId,
              ),
              ...(body.access ? [body] : []),
            ];
            form.querySelector("[role=status]")!.textContent =
              "Workspace access saved";
          },
          page.error,
        );
      }
      submit(
        section.querySelector<HTMLFormElement>(".workspace-root-form")!,
        async (data) => {
          await api(
            login,
            `/api/computers/${id}/workspace`,
            { name: data.get("name"), path: data.get("path") },
            "PUT",
          );
          await workspacePermissionsPage(page, login, id, back);
        },
        page.error,
      );
      for (const button of section.querySelectorAll<HTMLButtonElement>(
        "[data-remove-workspace]",
      ))
        button.onclick = () => {
          void api(
            login,
            `/api/computers/${id}/workspace`,
            { id: button.dataset.removeWorkspace, remove: true },
            "PUT",
          )
            .then(() =>
              workspacePermissionsPage(page, login, id, back),
            )
            .catch(page.error);
        };
    }
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
    const agentId = agent.agentId ?? agent.id;
    const candidates = (
      await Promise.all(
        (agent.loginIds ?? [agent.loginId]).map((id: string) => vault.get(id)),
      )
    ).filter((login: HubLogin | undefined): login is HubLogin => !!login);
    if (!candidates.length) throw new Error("Sign in to this hub again.");
    let login: HubLogin | undefined,
      computers: Computer[] = [],
      computer: Computer | undefined,
      shares: any = null;
    for (const candidate of candidates) {
      try {
        const available = await api(candidate, "/api/v1/computers");
        const target = available.find(
          (value: Computer) => value.id === agent.computerId,
        );
        if (!login) {
          login = candidate;
          computers = available;
          computer = target;
        }
        // This read establishes a single owner's proof for subsequent writes.
        if (target?.canManage) {
          const authorized = await api(
            candidate,
            `/api/agents/${agentId}/shares`,
          );
          login = candidate;
          computers = available;
          computer = target;
          shares = authorized;
          break;
        }
      } catch {
        /* An unavailable proof does not hide other connected identities. */
      }
    }
    if (!login)
      throw new Error(
        "Hub access unavailable. Check your connection and retry.",
      );
    const authorizedLogin = login;
    if (!page.element.isConnected) return;
    const shareSection = shares
      ? `<section class="connectionSection connectionStack"><h2>Share this agent</h2><p class="connectionHint">Share with a hub member without granting access to other agents or creating new ones. Saving replaces any retained access to this agent. Computer membership still grants its existing access.</p>${shares.members.map((m: any) => `<form class="connectionForm" data-agent-share="${esc(m.userId)}"><h3>${esc(m.name)}</h3><p class="connectionHint" data-current-access>Current access: ${esc(m.access.reason)}.</p>${field(`Shared access for ${m.name}`, `<select name="role" aria-label="${esc(`Shared access for ${m.name}`)}"><option value="">No shared access</option><option value="viewer">Viewer</option><option value="operator">Operator</option></select>`)}<div class="connectionActions"><button type="submit">Save agent access</button></div><p class="connectionStatus" role="status"></p></form>`).join("") || '<p class="connectionHint">Invite someone to the hub first in Hubs & computers → Hub settings.</p>'}</section>`
      : "";
    const root = page.render(
      "Agent access",
      `<dl class="connectionFact"><dt>Agent</dt><dd>${esc(agent.name)}</dd><dt>Computer</dt><dd>${esc(agent.computerName)}</dd><dt>Hub</dt><dd>${esc(agent.hubName)}</dd></dl>${computer?.canManage ? '<div class="connectionActions"><button data-access>Manage computer access</button></div>' : '<p class="connectionHint">Ask a Hub owner or admin for computer allowlist access.</p>'}${delegationSection(computers)}${shareSection}`,
      page.close,
    );
    page.own(
      bindDelegation(root, agentId, (path, body, method) =>
        api(authorizedLogin, path, body, method, 45000),
      ),
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
            authorizedLogin,
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
        void computerAllowlistPage(page, authorizedLogin, computer!, () => {
          page.close();
          void openAgentAccess(agent);
        }),
    );
  } catch (e) {
    page.error(e);
  }
}
