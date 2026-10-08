import { appearance } from "../shared/ui.js";
import { esc, message, loginHeading } from "./views.js";
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
  const providers = options.providers.filter(
    (provider: any) =>
      providerName(provider.method) &&
      options.loginMethods.allowedMethods.includes(provider.method),
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
  root.innerHTML = `${loginHeading(title, location.origin)}${me ? `<p>Signed in as <strong>${esc(me.name)}</strong> · ${esc(me.hubRole === "owner" ? "Owner" : me.hubRole === "admin" ? "Admin" : me.hubRole === "member" ? "Member" : "Not a member")}</p>` : `<p class="connectionHint">${registering ? "Create your account with Google or Feishu." : "Continue with Google or Feishu. Your first sign-in creates your account."}</p>`}<div class="connectionMethods">${providers.map((provider: any) => `<a class="connectionProvider" href="/auth/${encodeURIComponent(provider.id)}/start?${new URLSearchParams({ ...(fresh && !continuation && query.get("initialize") !== "1" ? { link: "1" } : {}), ...(continuation ? { continue: continuation } : {}) })}">${fresh && !continuation && query.get("initialize") !== "1" ? "Link" : "Continue with"} ${providerName(provider.method)}${provider.name ? " · " + esc(provider.name) : ""}</a>`).join("")}</div>${providers.length ? "" : '<p class="connectionHint" role="status">Google and Feishu sign-in are not configured on this hub. Ask the hub owner to enable a sign-in provider.</p>'}<p class="connectionHint">To join a Hub, open the invitation link shared by its Owner or Admin, choose your sign-in identity, then select Join Hub. Computer access requires a separate Owner or Admin allowlist grant.</p>${me ? '<section class="connectionStack connectionSection" id="identities"></section><button data-signout>Sign out of this hub</button>' : `<p class="connectionHint">${registering ? "Already have an account?" : "New to this hub?"} <a href="${esc(toggle.pathname + toggle.search)}">${registering ? "Sign in" : "Create an account"}</a></p>`}<p role="alert" class="connectionError"></p>`;
  if (options.setupRequired) {
    const hint = document.createElement("p");
    hint.className = "connectionHint";
    hint.textContent =
      query.get("initialize") === "1"
        ? "Sign in to initialize this Hub as its first owner using the private deployment link."
        : "This Hub is awaiting initialization. The administrator must use its private initialization link.";
    root.querySelector("[role=alert]")!.before(hint);
  }
  if (!me) return;
  if (
    me &&
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
  list.innerHTML = `<h2>Linked accounts</h2>${identities.map((identity: any) => `<div class="connectionRow"><span class="connectionRowText"><strong>${providerName(identity.method)}</strong></span><button data-unlink="${esc(identity.id)}" ${fresh ? "" : "disabled"}>Unlink</button></div>`).join("")}`;
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
