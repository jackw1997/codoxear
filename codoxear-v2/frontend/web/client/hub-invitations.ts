import { canonicalOrigin } from "../../shared/context.js";
import { vault, type HubLogin } from "./vault.js";
import { connectHub } from "./login.js";
import { ConnectionPages, esc, field } from "./views.js";
export type PendingInvitation = { origin: string; token: string; error?: string };
const storageKey = "codoxear.pending-hub-invitation";
export function invitationLink(origin: string, token: string) {
  const url = new URL("/", location.origin);
  url.searchParams.set("hub", canonicalOrigin(origin));
  url.hash = new URLSearchParams({ invite: token }).toString();
  return url.href;
}
export function captureHubInvitation(): PendingInvitation | null {
  const url = new URL(location.href);
  const token = new URLSearchParams(url.hash.slice(1)).get("invite");
  try {
    if (token) {
      const pending = { origin: canonicalOrigin(url.searchParams.get("hub") ?? ""), token };
      sessionStorage.setItem(storageKey, JSON.stringify(pending));
      url.hash = "";
      history.replaceState(null, "", url);
      return pending;
    }
    const saved = JSON.parse(sessionStorage.getItem(storageKey) ?? "null");
    return saved?.token ? { origin: canonicalOrigin(saved.origin), token: String(saved.token) } : null;
  } catch {
    if (token) { url.hash = ""; history.replaceState(null, "", url); return { origin: "", token, error: "Invalid invitation link: the Hub address is missing or invalid." }; }
    return null;
  }
}
async function accountApi(login: HubLogin, path: string, body?: unknown) {
  const response = await fetch("/api/client/hubs/" + encodeURIComponent(login.id) + path, {
    method: body === undefined ? "GET" : "POST",
    signal: AbortSignal.timeout(12000),
    ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
  });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error ?? "Invitation operation failed");
  return value;
}
export async function openHubInvitation(pending: PendingInvitation, changed: () => Promise<void>, viewHub: () => void = () => {}) {
  const page = new ConnectionPages();
  const close = () => { sessionStorage.removeItem(storageKey); page.close(); };
  const path = "/api/invitation-links/" + encodeURIComponent(pending.token);
  let selected = "";
  async function render() {
    if (pending.error) throw new Error(pending.error);
    page.render("Hub invitation", '<div class="connectionStack"><p role="status">Loading invitation…</p><p role="alert" class="connectionError"></p></div>', close);
    const version = page.version;
    const publicGet = async (route: string) => {
      const response = await fetch(pending.origin + route, { credentials: "omit", redirect: "error", signal: AbortSignal.timeout(12000) });
      const value = await response.json();
      if (!response.ok) throw new Error(value.error ?? "Unable to load invitation");
      return value;
    };
    const [invite, options, saved] = await Promise.all([publicGet(path), publicGet("/api/v1/auth/options"), vault.list()]);
    if (page.version !== version || !page.element.isConnected) return;
    if (canonicalOrigin(invite.hub.origin) !== pending.origin) throw new Error("Invitation Hub address does not match this link.");
    const identities = saved.filter(login => login.origin === pending.origin && login.hubId === invite.hub.id);
    const accounts = await Promise.all(identities.map(async login => ({ login, me: await accountApi(login, "/api/v1/me").catch(() => null) })));
    if (page.version !== version || !page.element.isConnected) return;
    const available = accounts.filter(account => account.me);
    if (!available.some(account => account.login.id === selected)) selected = available.find(account => !account.me.hubRole)?.login.id ?? available[0]?.login.id ?? "";
    const current = available.find(account => account.login.id === selected);
    const providers = options.providers.filter((provider: any) => ["google", "feishu"].includes(provider.method) && options.loginMethods.allowedMethods.includes(provider.method));
    const pendingStatus = invite.status === "pending";
    const statusLabel = ({ accepted: "already used", authority_changed: "no longer valid", revoked: "revoked", expired: "expired" } as Record<string, string>)[invite.status] ?? "no longer valid";
    const root = page.render("Hub invitation", `<section class="connectionStack"><h2>${esc(invite.hub.name)}</h2><p class="connectionHint">${esc(pending.origin)}</p><p>Invitation role: <strong>Member</strong></p><p>Expires: ${esc(new Date(invite.expiresAt).toLocaleString())}</p><p class="connectionHint">This link is for one person. Anyone with the link can join once as Member. Joining does not grant Computer or workspace access. A manager grants access separately.</p>${!pendingStatus ? `<p role="status">This invitation is ${esc(statusLabel)}.</p>` : `${available.length ? field("Sign-in identity", `<select name="identity" aria-label="Sign-in identity">${available.map(account => `<option value="${esc(account.login.id)}" ${account.login.id === selected ? "selected" : ""}>${esc(account.login.identity.name)} · ${esc(account.login.identity.method)}</option>`).join("")}</select>`) : ""}${current?.me.hubRole ? '<p role="status">Already a Hub member. Use another identity to join with this invitation.</p>' : current ? '<button class="primary" data-join>Join Hub</button>' : '<p>Choose a sign-in provider, then review and explicitly join.</p>'}<h3>${available.length ? "Use another identity" : "Sign in"}</h3>${providers.map((provider: any) => `<button data-provider="${esc(provider.id)}">Continue with ${provider.method === "google" ? "Google" : "Feishu"}</button>`).join("")}${providers.length ? "" : '<p>No allowed sign-in providers are available.</p>'}`}<p role="alert" class="connectionError"></p><p role="status" data-result></p></section>`, close);
    const select = root.querySelector<HTMLSelectElement>("select[name=identity]");
    if (select) select.onchange = () => { selected = select.value; void render().catch(page.error); };
    for (const button of root.querySelectorAll<HTMLButtonElement>("[data-provider]")) button.onclick = () => {
      button.disabled = true;
      void connectHub(pending.origin, button.dataset.provider).then(async login => {
        if (!page.element.isConnected) return;
        selected = login.id;
        await changed();
        await render();
      }).catch(error => { if (page.element.isConnected) { button.disabled = false; page.error(error); } });
    };
    const join = root.querySelector<HTMLButtonElement>("[data-join]");
    if (join && current) join.onclick = () => {
      join.disabled = true;
      void accountApi(current.login, path + "/accept", {}).then(async () => {
        sessionStorage.removeItem(storageKey);
        await changed();
        if (page.element.isConnected && page.version === version + 1) {
          const done = page.render("Joined Hub", `<div class="connectionStack"><p role="status">Joined as Member. Computer access requires a separate grant.</p><button class="primary" data-view-hub>View Hub</button></div>`, close);
          done.querySelector<HTMLButtonElement>("[data-view-hub]")!.onclick = () => { close(); viewHub(); };
        }
      }).catch(error => { if (page.element.isConnected) { join.disabled = false; page.error(error); } });
    };
  }
  try { await render(); } catch (error) {
    page.render("Hub invitation", '<div class="connectionStack"><p role="alert" class="connectionError"></p></div>', close);
    page.error(error);
  }
  return page;
}
