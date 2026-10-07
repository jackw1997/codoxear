import { appearance } from "../shared/ui.js";
import { esc, field, submit, message, loginHeading } from "./views.js";
const root = document.querySelector<HTMLElement>("#hubLogin")!;
const query = new URLSearchParams(location.search),
  continuation = query.get("continue");
const registering = location.pathname === "/register";
const providerName = (method: string) =>
  method === "google" ? "Google" : method === "feishu" ? "Feishu" : null;
async function api(
  path: string,
  body?: unknown,
  method = body === undefined ? "GET" : "POST",
) {
  const response = await fetch(path, {
    method,
    ...(body === undefined
      ? {}
      : {
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Sign-in failed");
  return value;
}
const theme = (await appearance()) as {
  applyTheme(state: { family: string; mode: string }): void;
};
const source = continuation
  ? new URL(continuation, location.origin).searchParams
  : query;
if (
  ["clay", "slate", "paper"].includes(source.get("theme") ?? "") &&
  ["system", "light", "dark"].includes(source.get("mode") ?? "")
)
  theme.applyTheme({ family: source.get("theme")!, mode: source.get("mode")! });
async function render() {
  root.setAttribute("aria-busy", "true");
  const options = await api("/api/v1/auth/options");
  let me: any = null;
  try {
    me = await api("/api/v1/me");
  } catch {}
  root.removeAttribute("aria-busy");
  const expectedAccount = query.get("account");
  if (me && expectedAccount && me.id !== expectedAccount) {
    root.innerHTML = `${loginHeading("Switch account", location.origin)}<p>Signed in as ${esc(me.name)}. Sign out before managing the selected account.</p><button class="primary" data-signout>Sign out</button><p role="alert" class="connectionError"></p>`;
    bindSignout();
    return;
  }
  const fresh = !!me && Date.now() - me.context.authenticatedAt < 300000;
  const providers = options.providers.filter((provider: any) =>
    providerName(provider.method),
  );
  const title = me
    ? continuation
      ? "Choose your account"
      : "Sign-in methods"
    : registering
      ? "Create your account"
      : "Codoxear login";
  document.title = title + " · Codoxear";
  root.setAttribute("aria-label", title);
  const toggle = new URL(registering ? "/login" : "/register", location.origin);
  toggle.search = location.search;
  root.innerHTML = `${loginHeading(title, location.origin)}${me ? `<p>Signed in as <strong>${esc(me.name)}</strong></p>` : `<p class="connectionHint">${registering ? "Create your account with Google or Feishu. Your device holds its own private sign-in key." : "Continue with Google or Feishu. Your first sign-in creates your account."}</p>`}<div class="connectionMethods">${providers.map((provider: any) => `<a class="connectionProvider" href="/auth/${encodeURIComponent(provider.id)}/start?${new URLSearchParams({ ...(fresh && !continuation ? { link: "1" } : {}), ...(continuation ? { continue: continuation } : {}) })}">${fresh && !continuation ? "Link" : "Continue with"} ${providerName(provider.method)}${provider.name ? " · " + esc(provider.name) : ""}</a>`).join("")}</div>${providers.length ? "" : '<p class="connectionHint" role="status">Google and Feishu sign-in are not configured on this hub. Ask the hub owner to enable a sign-in provider.</p>'}<p class="connectionHint">To access a hub or computer, accept an invitation from its owner in Hubs & computers → Hub settings → Accept invitation.</p>${me ? '<section class="connectionStack connectionSection" id="identities"></section><section class="connectionStack connectionSection" id="keys"></section><button data-signout>Sign out of this hub</button>' : `<p class="connectionHint">${registering ? "Already have an account?" : "New to this hub?"} <a href="${esc(toggle.pathname + toggle.search)}">${registering ? "Sign in" : "Create an account"}</a></p>`}<p role="alert" class="connectionError"></p>`;
  if (!me) return;
  if (options.setupRequired) {
    const setup = document.createElement("form");
    const setupHelp = options.organization?.tenantBindingRequired
      ? "The initial owner must sign in through this Hub’s Feishu app and enter the private setup code to bind its organization. Other members can connect after this setup."
      : "The initial owner can use the one-time setup code from the Hub administrator. Other members can continue and accept an invitation.";
    setup.className = "connectionForm connectionSection";
    setup.innerHTML = `<h2>Set up this Hub</h2><p class="connectionHint">${esc(setupHelp)}</p>${field("One-time setup code", '<input name="token" type="password" autocomplete="off" required>')}<button class="primary" type="submit">Set up this Hub</button>`;
    root.querySelector("[role=alert]")!.before(setup);
    submit(
      setup,
      async (data) => {
        await api("/api/v1/auth/setup", { token: data.get("token") });
        await render();
      },
      error,
    );
  }
  if (
    fresh &&
    query.get("reauth") !== "1" &&
    continuation?.startsWith("/oauth/authorize?") &&
    new URL(continuation, location.origin).origin === location.origin
  ) {
    const next = document.createElement("a");
    next.className = "connectionProvider";
    next.textContent = "Continue to Codoxear";
    next.href = continuation;
    root.querySelector("[role=alert]")!.before(next);
  }
  const identities = me.identities.filter((identity: any) =>
    providerName(identity.method),
  );
  const list = root.querySelector<HTMLElement>("#identities")!;
  list.hidden = !identities.length;
  list.innerHTML = `<h2>Linked accounts</h2>${identities.map((identity: any) => `<div class="connectionRow"><span class="connectionRowText"><strong>${providerName(identity.method)}</strong><span class="connectionHint">${esc(identity.subject)}${identity.tenant ? " · " + esc(identity.tenant) : ""}</span></span><button data-invitation="${esc(identity.id)}">Copy invitation details</button><button data-unlink="${esc(identity.id)}" ${fresh ? "" : "disabled"}>Unlink</button></div>`).join("")}`;
  for (const button of list.querySelectorAll<HTMLButtonElement>(
    "[data-invitation]",
  ))
    button.onclick = () => {
      const identity = identities.find(
        (item: any) => item.id === button.dataset.invitation,
      );
      const { method, connection, subject, tenant } = identity;
      void navigator.clipboard
        .writeText(
          JSON.stringify(
            { method, connection, subject, tenant: tenant ?? null },
            null,
            2,
          ),
        )
        .then(() => {
          button.textContent = "Copied";
        })
        .catch(error);
    };
  for (const button of list.querySelectorAll<HTMLButtonElement>(
    "[data-unlink]",
  ))
    button.onclick = () =>
      void api(
        "/api/v1/me/identities/" + encodeURIComponent(button.dataset.unlink!),
        undefined,
        "DELETE",
      )
        .then(render)
        .catch(error);
  const keys = await api("/api/v1/me/keys");
  const keyList = root.querySelector<HTMLElement>("#keys")!;
  keyList.innerHTML = `<h2>Device sign-in keys</h2><p class="connectionHint">Revoke a key to stop that device signing in again.${fresh ? "" : " Sign in again with Google or Feishu to revoke keys."}</p>${keys.map((key: any) => `<div class="connectionRow"><span class="connectionRowText"><strong>${esc(key.name)}</strong><span class="connectionHint">Created ${esc(new Date(key.createdAt).toLocaleDateString())}</span></span><button data-revoke="${esc(key.id)}" ${fresh ? "" : "disabled"}>Revoke</button></div>`).join("")}${keys.length ? "" : '<p class="connectionHint">Connect this hub from the Codoxear app to create a device key.</p>'}`;
  for (const button of keyList.querySelectorAll<HTMLButtonElement>(
    "[data-revoke]",
  ))
    button.onclick = () =>
      void api(
        "/api/v1/me/keys/" + encodeURIComponent(button.dataset.revoke!),
        undefined,
        "DELETE",
      )
        .then(render)
        .catch(error);
  bindSignout();
}
function bindSignout() {
  root.querySelector<HTMLButtonElement>("[data-signout]")!.onclick = () =>
    void api("/api/v1/auth/logout", {}).then(render).catch(error);
}
function error(value: unknown) {
  const target = root.querySelector("[role=alert]");
  if (target) target.textContent = message(value);
}
root.innerHTML =
  loginHeading(
    registering ? "Create your account" : "Codoxear login",
    location.origin,
  ) + '<p class="connectionHint" role="status">Loading sign-in…</p>';
void render().catch((value) => {
  root.removeAttribute("aria-busy");
  root.innerHTML =
    loginHeading("Unable to load sign-in", location.origin) +
    '<p role="alert" class="connectionError"></p><button class="primary" data-retry>Retry</button>';
  error(value);
  root.querySelector<HTMLButtonElement>("[data-retry]")!.onclick = () =>
    void render().catch(error);
});
