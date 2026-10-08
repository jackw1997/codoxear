import { vault, type HubLogin } from "./vault.js";
import { canonicalOrigin } from "../../shared/context.js";
const random = () =>
  btoa(String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))))
    .replaceAll("+", "-")
    .replaceAll("/", "_")
    .replaceAll("=", "");
export async function connectHub(
  value: string,
  connection?: string,
): Promise<HubLogin> {
  let origin: string;
  try {
    origin = canonicalOrigin(value.trim().replace(/\/$/, ""));
  } catch {
    throw new Error(
      "Enter a complete HTTPS hub address, such as https://hub.example.com.",
    );
  }
  const tokens = await authorizeProvider(origin, connection);
  return saveHubLogin(origin, tokens);
}

export async function authorizeProvider(origin: string, connection?: string) {
  canonicalOrigin(origin);
  // Open synchronously from the user's click, then perform discovery and PKCE.
  const popup = window.open(
    "about:blank",
    "codoxear-hub-login",
    "popup,width=560,height=740",
  );
  if (!popup) throw new Error("Allow the sign-in popup for this hub");
  const state = random(),
    verifier = random();
  const callback = location.origin + "/auth-callback";
  try {
    const challenge = btoa(
      String.fromCharCode(
        ...new Uint8Array(
          await crypto.subtle.digest(
            "SHA-256",
            new TextEncoder().encode(verifier),
          ),
        ),
      ),
    )
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
    const code = await new Promise<string>((resolve, reject) => {
      const timer = setTimeout(
        () => done(new Error("Hub sign-in expired")),
        600000,
      );
      const closed = setInterval(() => {
        if (popup.closed) done(new Error("Hub sign-in cancelled"));
      }, 500);
      function done(error: Error | null, value?: string) {
        clearTimeout(timer);
        clearInterval(closed);
        removeEventListener("message", message);
        if (error) reject(error);
        else resolve(value!);
      }
      function message(event: MessageEvent) {
        if (
          event.origin !== location.origin ||
          event.source !== popup ||
          event.data?.type !== "codoxear-login" ||
          event.data.state !== state
        )
          return;
        if (event.data.issuer !== origin) {
          done(
            new Error(
              "Login issuer mismatch: rejected cross-hub authorization response",
            ),
          );
          return;
        }
        event.data.code
          ? done(null, event.data.code)
          : done(new Error("Hub sign-in rejected"));
      }
      addEventListener("message", message);
      const authorize =
        "/oauth/authorize?" +
        new URLSearchParams({
          client_id: "codoxear-web",
          redirect_uri: callback,
          response_type: "code",
          code_challenge: challenge,
          code_challenge_method: "S256",
          state,
          theme: document.documentElement.dataset.theme ?? "clay",
          mode: localStorage.getItem("codoxear.ui.theme.mode") ?? "system",
        });
      popup.location.href = connection
        ? origin +
          "/auth/" +
          encodeURIComponent(connection) +
          "/start?" +
          new URLSearchParams({ continue: authorize })
        : origin + "/login?" + new URLSearchParams({ continue: authorize });
    });
    const res = await fetch(origin + "/oauth/token", {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        grant_type: "authorization_code",
        client_id: "codoxear-web",
        redirect_uri: callback,
        code,
        code_verifier: verifier,
        installation_id: "web",
      }),
    });
    const tokens = await res.json();
    if (!res.ok) throw new Error(tokens.error ?? "Hub rejected sign-in");
    return tokens;
  } finally {
    popup.close();
  }
}

export async function saveHubLogin(
  origin: string,
  tokens: any,
): Promise<HubLogin> {
  const headers = { Authorization: "Bearer " + tokens.access_token };
  const [userRes, metaRes, hubsRes] = await Promise.all([
    fetch(origin + "/api/v1/me", {
      credentials: "omit",
      redirect: "error",
      headers,
    }),
    fetch(origin + "/api/v1/meta", { credentials: "omit", redirect: "error" }),
    fetch(origin + "/api/v1/me/hubs", {
      credentials: "omit",
      redirect: "error",
      headers,
    }),
  ]);
  const [me, meta, hubs] = await Promise.all([
    userRes.json(),
    metaRes.json(),
    hubsRes.json(),
  ]);
  if (
    !userRes.ok ||
    !metaRes.ok ||
    !hubsRes.ok ||
    meta.issuer !== origin ||
    !meta.independent
  )
    throw new Error("Hub rejected account discovery");
  const sameAccount = (await vault.list()).filter(
    (login) => login.origin === origin && login.accountId === me.id,
  );
  const identityKey = me.context.identityId;
  if (typeof identityKey !== "string")
    throw new Error("Hub did not provide a verified identity");
  const existing = sameAccount.find(
    (login) => login.identity.key === identityKey,
  );
  const login: HubLogin = {
    id: existing?.id ?? crypto.randomUUID(),
    accountKey: existing?.accountKey ?? crypto.randomUUID(),
    origin,
    hubId: meta.hubId,
    name:
      hubs.find((hub: any) => hub.id === meta.hubId)?.name ??
      existing?.name ??
      new URL(origin).host,
    accountId: me.id,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    pushSession: crypto.randomUUID(),
    role:
      me.hubRole ??
      hubs.find((hub: any) => hub.id === meta.hubId)?.role ??
      null,
    identity: {
      name: me.name,
      method: me.context.method,
      key: identityKey,
      identities: me.identities,
    },
  };
  await vault.put(login);
  await vault.activate(login.id);
  if (existing)
    await fetch(origin + "/oauth/revoke", {
      method: "POST",
      credentials: "omit",
      redirect: "error",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + tokens.access_token,
      },
      body: JSON.stringify({ token: existing.refreshToken }),
    }).catch(() => {});
  return (await vault.get(login.id))!;
}

export function identitySettingsUrl(login: HubLogin) {
  const url = new URL("/login", login.origin);
  url.searchParams.set("account", login.accountId);
  url.searchParams.set(
    "theme",
    document.documentElement.dataset.theme ?? "clay",
  );
  url.searchParams.set(
    "mode",
    localStorage.getItem("codoxear.ui.theme.mode") ?? "system",
  );
  return url.href;
}
