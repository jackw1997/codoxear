import {
  appearance,
  brand,
  shell,
  placementDialog,
  escapeHtml,
} from "../shared/ui.js";
void appearance();
/** The portal contains no access/refresh/provider tokens. Authentication uses its HTTPOnly cookie. */
function accountPortal() {
  let reauthenticate =
    new URLSearchParams(location.search).get("reauth") === "1";
  const main = document.querySelector<HTMLElement>("#main")!,
    status = document.querySelector<HTMLElement>("#status")!;
  const esc = (v: unknown) =>
    String(v ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c]!,
    );
  const act = (fn: (event: Event) => Promise<void>) => (event: Event) => {
    event.preventDefault();
    status.textContent = "";
    void fn(event).catch((e) => (status.textContent = e.message));
  };
  async function api(
    path: string,
    body?: unknown,
    method = body === undefined ? "GET" : "POST",
  ): Promise<any> {
    const response = await fetch(path, {
      method,
      credentials: "same-origin",
      ...(body === undefined
        ? {}
        : {
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          }),
    });
    const value = await response.json();
    if (!response.ok)
      throw Object.assign(new Error(value.error ?? "Request failed"), {
        status: response.status,
      });
    return value;
  }
  function resume() {
    const value = new URLSearchParams(location.search).get("continue");
    if (value?.startsWith("/oauth/authorize?")) {
      const url = new URL(value, location.origin);
      if (url.origin === location.origin) {
        location.assign(url.href);
        return true;
      }
    }
    return false;
  }
  function download(name: string, value: unknown) {
    const url = URL.createObjectURL(
        new Blob([JSON.stringify(value, null, 2)], {
          type: "application/json",
        }),
      ),
      link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  async function render() {
    let me: any;
    try {
      me = await api("/api/v1/me");
    } catch (e) {
      if ((e as { status: number }).status !== 401) throw e;
    }
    const options = await api("/api/v1/auth/options");
    const providers = options.providers.filter((p: any) =>
      ["google", "feishu"].includes(p.method),
    );
    const providerLabel = (method: string) =>
      method === "google" ? "Google" : "Feishu";
    if (!me || reauthenticate) {
      main.className = "account-login";
      main.innerHTML =
        '<div class="account-brand">' +
        brand +
        '</div><h1>Sign in to Codoxear</h1><p class="directory-hint">Your first sign-in creates your account. Your agents, wherever you work.</p>' +
        providers
          .map(
            (p: any) =>
              '<p><a href="/auth/' +
              encodeURIComponent(p.id) +
              "/start" +
              (new URLSearchParams(location.search).get("continue")
                ? "?continue=" +
                  encodeURIComponent(
                    new URLSearchParams(location.search).get("continue")!,
                  )
                : "") +
              '">Sign in with ' +
              esc(providerLabel(p.method)) +
              "</a></p>",
          )
          .join("") +
        (providers.length
          ? ""
          : "<p>No sign-in provider is configured. Contact the administrator.</p>");
      return;
    }
    if (resume()) return;
    if (!new URLSearchParams(location.search).has("settings")) {
      main.className = "";
      const directory = await api("/api/v1/me/agents");
      shell(main, {
        name: me.name,
        email: me.email,
        issuer: location.origin,
        agents: directory.agents,
        currentHub: "workspace",
        onNew: () => {
          placementDialog(directory.placements, async (placement, values) => {
            const agent = await api(
              `/gateway/hubs/${encodeURIComponent(placement.hubId)}/api/computers/${encodeURIComponent(placement.computerId)}/agents`,
              values,
            );
            if (agent.state !== "ready" || !agent.localId)
              throw new Error(
                "Agent launch is " +
                  agent.state +
                  ". Check its settings before retrying.",
              );
            location.assign(
              "/workspace/#session=" + encodeURIComponent(agent.id),
            );
          });
        },
      });
      return;
    }
    main.className = "account-settings";
    const hubs = await api("/api/v1/me/hubs"),
      computers = await api("/api/v1/me/computers");
    main.innerHTML =
      '<header><a href="/">← Agents</a><strong>Settings</strong><button id="logout">Sign out</button></header><nav class="settings-tabs"><a href="#infrastructure">Hubs &amp; Computers</a><a href="#account">Account</a></nav><h1 id="infrastructure">Hubs &amp; Computers</h1><p class="directory-hint">Manage where your agents run and who can access them.</p><h2>Your hubs</h2>' +
      hubs
        .map(
          (h: any) =>
            "<article><strong>" +
            esc(h.name) +
            "</strong><p>" +
            esc(
              h.access === "allowed"
                ? "Access available"
                : "Sign in with the required method to open this hub",
            ) +
            "</p>" +
            (h.origin
              ? '<a href="' +
                (h.access === "allowed"
                  ? "/workspace/"
                  : "/?reauth=1&settings=1") +
                '">Open agents</a>'
              : "Hub endpoint is not registered") +
            (h.ownerId === me.id
              ? '<details><summary>Hub service configuration</summary><form class="register" data-hub="' +
                esc(h.id) +
                '"><label>Public HTTPS origin<input name="origin" type="url" required value="' +
                esc(h.origin ?? "") +
                '"></label><p>Downloading a new configuration replaces this hub’s service credential. Install it on the hub process.</p><button>Download new hub configuration</button></form></details>' +
                '<details><summary>Required sign-in method</summary><form class="requirement" data-hub="' +
                esc(h.id) +
                '"><p>Sign in with the proposed method first. The current owner must satisfy the new rule before it can be saved.</p><label>Required method<select name="method" aria-label="Required method">' +
                ["any", ...new Set(providers.map((p: any) => p.method))]
                  .map(
                    (m) =>
                      '<option value="' +
                      m +
                      '"' +
                      ((h.loginRequirement?.method ?? "any") === m
                        ? " selected"
                        : "") +
                      ">" +
                      esc(m === "any" ? "Any linked method" : m) +
                      "</option>",
                  )
                  .join("") +
                '</select></label><label>Provider connection (optional)<input name="connection" value="' +
                esc(h.loginRequirement?.connection ?? "") +
                '"></label><label>Tenant ID (optional)<input name="tenant" value="' +
                esc(h.loginRequirement?.tenant ?? "") +
                '"></label><label>Maximum sign-in age in seconds<input name="maxAgeSeconds" type="number" min="60" max="86400" required value="' +
                esc(h.loginRequirement?.maxAgeSeconds ?? 3600) +
                '"></label><button>Save sign-in requirement</button></form></details>' +
                '<details><summary>Admit an existing computer</summary><form class="admission" data-hub="' +
                esc(h.id) +
                '"><p>The computer owner must already be a member of this hub. This permission expires in five minutes and applies only to this computer.</p><label>Computer ID<input name="computerId" required></label><button>Create admission</button><label>Admission token<input name="token" readonly></label></form></details>'
              : "") +
            (h.ownerId === me.id
              ? '<details><summary>Add a computer</summary><form class="add-computer" data-hub="' +
                esc(h.id) +
                '"><label>Computer name<input name="name" required maxlength="120"></label><button>Add computer</button><p class="directory-hint" role="status"></p></form></details>'
              : "") +
            "</article>",
        )
        .join("") +
      '<details><summary>Create a hub</summary><form id="new-hub"><label>Hub name<input name="name" required maxlength="120"></label><button>Create hub</button></form></details>' +
      (computers.length
        ? "<h2>Computers</h2>" +
          computers
            .map(
              (c: any) =>
                '<section class="computer-setting"><h3>' +
                esc(c.name) +
                "</h3><p>Computer ID: <code>" +
                esc(c.id) +
                '</code></p><p class="directory-hint">' +
                esc(c.hubName) +
                " · " +
                (c.ownerId === me.id
                  ? "You own this computer"
                  : "Shared with you") +
                "</p>" +
                (c.ownerId === me.id
                  ? '<details><summary>Move to another hub</summary><form class="transfer" data-computer="' +
                    esc(c.id) +
                    '"><p>Moving disconnects the current hub and removes previous computer memberships. Re-enroll the Computer locally afterward. Local agents keep running.</p><label>Target hub<select name="targetHubId" aria-label="Target hub">' +
                    hubs
                      .filter((h: any) => h.id !== c.hubId)
                      .map(
                        (h: any) =>
                          '<option value="' +
                          esc(h.id) +
                          '">' +
                          esc(h.name) +
                          "</option>",
                      )
                      .join("") +
                    '</select></label><label>Target owner admission token<input name="admissionToken" autocomplete="off"></label><p>No admission token is needed when you own the target hub.</p><label><input type="checkbox" name="exposeHistory"> Publish existing agents and history in the target hub</label><button>Move computer and disconnect old hub</button></form></details>'
                  : "") +
                "</section>",
            )
            .join("")
        : "") +
      '<h2 id="account">Account</h2><p>' +
      esc(me.name) +
      " · " +
      esc(me.email) +
      "</p><h3>Login methods</h3><div>" +
      me.identities
        .map(
          (i: any) =>
            "<p>" +
            esc(i.method) +
            " · " +
            esc(i.subject) +
            ' <button class="unlink" data-identity="' +
            esc(i.id) +
            '">Remove</button></p>',
        )
        .join("") +
      "</div><p>Linking requires a sign-in within the last five minutes and verification of the new identity. Matching email addresses never merge accounts.</p>" +
      providers
        .map(
          (p: any) =>
            '<p><a href="/auth/' +
            encodeURIComponent(p.id) +
            '/start?link=1">Link ' +
            esc(providerLabel(p.method)) +
            " (" +
            esc(p.id) +
            ")</a></p>",
        )
        .join("");
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "form.add-computer",
    )) {
      form.onsubmit = act(async () => {
        const result = await api(
          "/api/v1/hubs/" + form.dataset.hub + "/computers",
          { name: new FormData(form).get("name") },
        );
        const registered = hubs.find((h: any) => h.id === form.dataset.hub);
        download("codoxear-computer.json", {
          version: 1,
          hubUrl: registered?.origin,
          hubId: form.dataset.hub,
          computerId: result.computer.id,
          enrollment: result.enrollment,
          runtime: "native",
          workspacePath: "/REPLACE_WITH_YOUR_WORKSPACE",
        });
        status.textContent =
          "Computer created. Set the workspace path in the private configuration, then enroll Codoxear Computer within five minutes.";
        await render();
      });
    }
    document.querySelector<HTMLElement>("#logout")!.onclick = act(async () => {
      await api("/api/v1/auth/logout", {});
      location.assign("/");
    });
    document.querySelector<HTMLFormElement>("#new-hub")!.onsubmit = act(
      async (e) => {
        await api("/api/v1/hubs", {
          name: new FormData(e.target as HTMLFormElement).get("name"),
        });
        await render();
      },
    );
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "form.register",
    ))
      form.onsubmit = act(async () => {
        const origin = String(new FormData(form).get("origin")).replace(
          /\/$/,
          "",
        );
        const value = await api(
          "/api/v1/hubs/" + form.dataset.hub + "/register",
          { origin },
        );
        download("codoxear-hub.json", {
          ...value,
          identityUrl: location.origin,
          database: "./hub.sqlite",
          listenHost: "127.0.0.1",
          listenPort: 17430,
          secureCookies: origin.startsWith("https:"),
        });
        status.textContent =
          "Private hub configuration downloaded. Keep it private and install it on that hub.";
        await render();
      });
    for (const button of document.querySelectorAll<HTMLButtonElement>(
      ".unlink",
    ))
      button.onclick = act(async () => {
        await api(
          "/api/v1/me/identities/" + button.dataset.identity,
          undefined,
          "DELETE",
        );
        await render();
      });
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "form.requirement",
    ))
      form.onsubmit = act(async () => {
        const data = new FormData(form),
          method = String(data.get("method"));
        await api(
          "/api/v1/hubs/" + form.dataset.hub + "/auth-requirement",
          {
            rule:
              method === "any"
                ? null
                : {
                    method,
                    maxAgeSeconds: Number(data.get("maxAgeSeconds")),
                    ...(data.get("connection")
                      ? { connection: data.get("connection") }
                      : {}),
                    ...(data.get("tenant")
                      ? { tenant: data.get("tenant") }
                      : {}),
                  },
          },
          "PUT",
        );
        await render();
        status.textContent =
          "Sign-in requirement saved. It applies to every hub request.";
      });
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "form.admission",
    ))
      form.onsubmit = act(async () => {
        const result = await api(
          "/api/v1/hubs/" + form.dataset.hub + "/admissions",
          { computerId: new FormData(form).get("computerId") },
        );
        (form.elements.namedItem("token") as HTMLInputElement).value =
          result.token;
        status.textContent =
          "Share this admission token privately with the computer owner. It expires in five minutes.";
      });
    for (const form of document.querySelectorAll<HTMLFormElement>(
      "form.transfer",
    ))
      form.onsubmit = act(async () => {
        const value = new FormData(form);
        await api("/api/v1/computers/" + form.dataset.computer + "/transfer", {
          targetHubId: value.get("targetHubId"),
          exposeHistory: value.has("exposeHistory"),
          admissionToken: value.get("admissionToken") || undefined,
        });
        await render();
        status.textContent =
          "Computer moved. Open the target hub for a new enrollment code, then detach and re-enroll locally.";
      });
  }
  void render().catch((e) => (status.textContent = e.message));
}

accountPortal();
