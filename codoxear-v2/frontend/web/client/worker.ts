/// <reference lib="webworker" />
import { vault, type HubLogin } from "./vault.js";
import { transportVersion } from "./transport-version.js";
import { disconnectPush, installPushEvents, notificationSubscription } from "./push.js";
declare const self: ServiceWorkerGlobalScope;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
const flights = new Map<string, Promise<HubLogin>>();
async function fresh(login: HubLogin): Promise<HubLogin> {
  if (login.expiresAt > Date.now() + 30000) return login;
  let work = flights.get(login.id);
  if (!work) {
    work = navigator.locks
      .request("codoxear-hub-refresh:" + login.id, async () => {
        const latest = await vault.get(login.id);
        if (!latest) throw new Error("Sign in to this hub again");
        if (latest.expiresAt > Date.now() + 30000) return latest;
        const res = await fetch(login.origin + "/oauth/token", {
          signal: AbortSignal.timeout(8000),
          method: "POST",
          credentials: "omit",
          redirect: "error",
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + latest.accessToken },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: latest.refreshToken,
          }),
        });
        if (!res.ok) {
          if ([400, 401].includes(res.status)) await vault.remove(login.id);
          throw new Error("Hub login expired");
        }
        const tokens = await res.json();
        const next = {
          ...latest,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        };
        if ((await vault.get(login.id))?.refreshToken !== latest.refreshToken)
          throw new Error("Hub login changed during refresh");
        await vault.put(next);
        return next;
      })
      .then(async (value) => await value)
      .finally(() => flights.delete(login.id));
    flights.set(login.id, work);
  }
  return work;
}
async function hub(login: HubLogin, path: string, init: RequestInit = {}) {
  login = await fresh(login);
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
    throw new Error("Invalid hub path");
  return fetch(login.origin + path, {
    ...init,
    credentials: "omit",
    redirect: "error",
    headers: {
      ...Object.fromEntries(new Headers(init.headers)),
      Authorization: "Bearer " + login.accessToken,
    },
  });
}
// IDs are scoped to an authenticated hub account, never a global identity registry.
const key = (login: HubLogin, id: string) => login.accountKey + "~" + id;
const unique = <T>(items: T[], id: (item: T) => string) => [
  ...new Map(items.map((item) => [id(item), item])).values(),
];
async function directory() {
  const groups = await Promise.all(
    (await vault.list()).map(async (login) => {
      let status = 0;
      try {
        const res = await hub(login, "/api/agent-directory", {
          signal: AbortSignal.timeout(5000),
        });
        status = res.status;
        if (!res.ok) throw new Error("Directory unavailable");
        const d = await res.json();
        return {
          agents: d.agents.map((a: any) => ({
            ...a,
            id: key(login, a.id),
            agentId: a.id,
            loginId: login.id,
            origin: login.origin,
          })),
          placements: d.placements.map((p: any) => ({
            ...p,
            loginId: login.id,
          })),
          error: null,
        };
      } catch (e) {
        return {
          agents: [],
          placements: [],
          error: { loginId: login.id, name: login.name, message: [401, 403].includes(status) || !(await vault.get(login.id)) ? "Sign in to this hub again." : "Hub directory unavailable. Check your connection and retry." },
        };
      }
    }),
  );
  return {
    agents: unique(
      groups.flatMap((g) => g.agents),
      (a: any) => a.id,
    ),
    placements: unique(
      groups.flatMap((g) => g.placements),
      (p: any) => p.origin + ":" + p.computerId,
    ),
    errors: groups.flatMap((g) => (g.error ? [g.error] : [])),
  };
}
async function catalog(placement: string | null) {
  const logins = await vault.list();
  const groups = await Promise.all(logins.map(async (login) => {
    let status = 0;
    try {
      const r = await hub(login, "/workspace/api/sessions", {
        signal: AbortSignal.timeout(7000),
      });
      status = r.status;
      if (!r.ok) throw new Error("Catalog unavailable");
      const value = await r.json();
      const dr = await hub(login, "/api/agent-directory", { signal: AbortSignal.timeout(5000) });
      status = dr.status;
      if (!dr.ok) throw new Error("Directory unavailable");
      const d = await dr.json();
      const failures = value.catalog_errors ?? [];
      return {
        sessions: (value.sessions ?? []).filter((s: any) => d.agents.some((a: any) => a.id === s.session_id)).map((s: any) => ({
          ...s,
          session_id: key(login, s.session_id),
          dependency_session_id: s.dependency_session_id ? key(login, s.dependency_session_id) : null,
          codoxear_hub: login.name,
          codoxear_computer: d.agents.find((a: any) => a.id === s.session_id)?.computerName,
          codoxear_login: login.id,
        })),
        retainedIds: d.agents.filter((a: any) => failures.some((f: any) => f.computerId === a.computerId)).map((a: any) => key(login, a.id)),
        errors: failures.map((f: any) => ({ loginId: login.id, name: f.computerName, kind: "computer", message: "Computer is unreachable. Reconnect it and retry." })),
        ok: true,
      };
    } catch {
      const signedOut = [401, 403].includes(status) || !(await vault.get(login.id));
      return { sessions: [], retainedIds: [], ok: false, errors: [{ loginId: login.id, name: login.name, kind: signedOut ? "signed_out" : "hub", message: signedOut ? "Sign in to this hub again." : "Hub catalog unavailable. Check your connection and retry." }] };
    }
  }));
  let defaults: any = {};
  if (placement) {
    const [id, computerId] = placement.split("~"),
      login = await vault.get(id!);
    if (login)
      try {
        const r = await hub(
          login,
          "/api/computers/" + computerId + "/launch-defaults",
          { signal: AbortSignal.timeout(5000) },
        );
        if (r.ok) defaults = await r.json();
      } catch {}
  }
  return {
    sessions: unique(groups.flatMap((g) => g.sessions), (s: any) => s.session_id),
    catalog_status: {
      state: !logins.length ? "signed_out" : groups.some((g) => g.errors.length) ? (groups.some((g) => g.ok) ? "partial" : "unavailable") : "ready",
      authenticated_hubs: logins.length,
      errors: groups.flatMap((g) => g.errors),
      retained_session_ids: groups.flatMap((g) => g.retainedIds),
    },
    recent_cwds: defaults.recent_cwds ?? [],
    new_session_defaults: defaults.new_session_defaults ?? {},
    tmux_available: false,
  };
}
async function relay(
  request: Request,
  url: URL,
  login: HubLogin,
  path: string,
  agentId?: string,
) {
  const headers = new Headers(request.headers);
  for (const k of ["cookie", "authorization", "host", "origin", "referer"])
    headers.delete(k);
  const init: RequestInit = {
    method: request.method,
    headers,
    signal: request.signal,
  };
  if (!["GET", "HEAD"].includes(request.method)) {
    // Browser fetch does not support streaming request uploads with all target
    // engines. Keep the existing attachment limit, never persist the buffer.
    if (Number(request.headers.get("content-length")) > 256 * 1024 * 1024)
      return json({ error: "Upload exceeds 256 MiB" }, 413);
    init.body = await request.arrayBuffer();
    if (init.body.byteLength > 256 * 1024 * 1024)
      return json({ error: "Upload exceeds 256 MiB" }, 413);
    if (
      headers.get("content-type")?.includes("application/json") &&
      init.body.byteLength
    ) {
      const b = JSON.parse(new TextDecoder().decode(init.body));
      if (agentId && b.session_id) b.session_id = agentId;
      if (agentId && /\/edit(?:\?|$)/.test(path) && b.dependency_session_id) {
        const prefix = login.accountKey + "~";
        if (!String(b.dependency_session_id).startsWith(prefix))
          return json(
            { error: "Dependency must belong to the same hub account" },
            403,
          );
        b.dependency_session_id = String(b.dependency_session_id).slice(
          prefix.length,
        );
      }
      init.body = JSON.stringify(b);
    }
  }
  const downloading = /\/file\/download(?:\?|$)/.test(path);
  if (downloading) delete init.signal; // Chromium hands downloads to its download manager.
  const response = await hub(login, path, init);
  const output = new Headers(response.headers);
  output.set("Cache-Control", "no-store");
  output.delete("content-length");
  output.delete("content-encoding");
  if (downloading) {
    output.set(
      "Content-Security-Policy",
      "sandbox allow-downloads; default-src 'none'",
    );
    if (!output.has("Content-Disposition"))
      output.set("Content-Disposition", "attachment");
  }
  const rewrite = (value: string) =>
    value
      .replaceAll("/workspace/api/", "/api/")
      .replace(
        /\/api\/sessions\/([^/?"\s]+)/g,
        (_all, id) => "/api/sessions/" + key(login, id),
      )
      .replace(
        /([?&]__agent=)([^&"\s]+)/g,
        (_all, p, id) =>
          p + encodeURIComponent(key(login, decodeURIComponent(id))),
      );
  if (response.headers.get("content-type")?.includes("application/json")) {
    const value = await response.json();
    const walk = (v: any): any =>
      typeof v === "string" &&
      (v.startsWith("/workspace/api/") || v.startsWith("/api/"))
        ? rewrite(v)
        : Array.isArray(v)
          ? v.map(walk)
          : v && typeof v === "object"
            ? Object.fromEntries(
                Object.entries(v).map(([k, x]) => [k, walk(x)]),
              )
            : v;
    if (path === "/workspace/api/sessions" && value.session_id)
      value.session_id = key(login, value.session_id);
    return new Response(JSON.stringify(walk(value)), {
      status: response.status,
      headers: output,
    });
  }
  if (response.headers.get("content-type")?.includes("mpegurl"))
    return new Response(rewrite(await response.text()), {
      status: response.status,
      headers: output,
    });
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: output,
  });
}
async function handle(request: Request) {
  const url = new URL(request.url),
    path = url.pathname;
  if (path === "/api/me")
    return json({ ok: true, user: { id: "local-client" } });
  if (path === "/api/client/directory") return json(await directory());
  if (path === "/api/sessions" && request.method === "GET")
    return json(await catalog(url.searchParams.get("__placement")));
  if (path === "/api/sessions" && request.method === "POST") {
    const [id, computerId] = (url.searchParams.get("__placement") ?? "").split(
      "~",
    );
    const login = id ? await vault.get(id) : undefined;
    if (!login || !computerId)
      return json({ error: "Choose a computer in New session" }, 400);
    const response = await hub(
      login,
      "/api/v1/computers/" + encodeURIComponent(computerId) + "/api/sessions",
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: await request.text(),
      },
    );
    const value = await response.json();
    if (response.ok) value.session_id = key(login, value.agent_id);
    return json(value, response.status);
  }
  if (path === "/api/logout") {
    await Promise.all(
      (await vault.list()).map(async (login) => {
        await disconnectPush(login, hub, self);
        await fetch(login.origin + "/oauth/revoke", {
          method: "POST",
          credentials: "omit",
          signal: AbortSignal.timeout(5000),
          headers: { "Content-Type": "application/json", Authorization: "Bearer " + login.accessToken },
          body: JSON.stringify({ token: login.refreshToken }),
        }).catch(() => {});
      }),
    );
    return json({ ok: true });
  }
  const disconnect = /^\/api\/client\/push\/disconnect\/([^/]+)$/.exec(path);
  if (disconnect && request.method === "POST") {
    const login = await vault.get(decodeURIComponent(disconnect[1]!));
    if (!login) return json({ ok: true });
    await disconnectPush(login, hub, self);
    await fetch(login.origin + "/oauth/revoke", { method: "POST", credentials: "omit", signal: AbortSignal.timeout(5000), headers: { "Content-Type": "application/json", Authorization: "Bearer " + login.accessToken }, body: JSON.stringify({ token: login.refreshToken }) }).catch(() => {});
    return json({ ok: true });
  }
  const management = /^\/api\/client\/hubs\/([^/]+)(\/.*)$/.exec(path);
  if (management) {
    const login = await vault.get(management[1]!);
    if (!login) return json({ error: "Hub login unavailable" }, 401);
    return relay(request, url, login, management[2]! + url.search);
  }
  const match = /^\/api\/sessions\/([^/]+)(\/.*)$/.exec(path);
  const scoped = decodeURIComponent(
    match?.[1] ?? url.searchParams.get("__agent") ?? "",
  );
  const split = scoped.indexOf("~");
  if (split < 0) {
    if (path === "/api/notifications/feed")
      return json({ items: [], cursor: null });
    return json({ error: "Select an agent or connect a hub first" }, 409);
  }
  const accountKey = scoped.slice(0, split),
    agentId = scoped.slice(split + 1);
  let login: HubLogin | undefined;
  let computerId: string | undefined;
  for (const candidate of (await vault.list()).filter(
    (l) => l.accountKey === accountKey,
  )) {
    try {
      const r = await hub(candidate, "/api/agent-directory", {
        signal: AbortSignal.timeout(5000),
      });
      const agent = r.ok ? (await r.json()).agents.find((a: any) => a.id === agentId) : undefined;
      if (agent) {
        login = candidate;
        computerId = agent.computerId;
        break;
      }
    } catch {}
  }
  if (!login)
    return json(
      { error: "No saved identity currently has access to this agent" },
      403,
    );
  if ((path === "/api/notifications/subscription" || path === "/api/notifications/subscription/toggle") && computerId)
    return notificationSubscription(request, login, computerId, hub, self.location.origin);
  url.searchParams.delete("__agent");
  if (!match) url.searchParams.set("__agent", agentId);
  return relay(
    request,
    url,
    login,
    "/workspace" +
      (match
        ? "/api/sessions/" + encodeURIComponent(agentId) + match[2]
        : path) +
      url.search,
    agentId,
  );
}
// Transport updates keep the same API contract. Activate before the new UI starts.
installPushEvents(self, hub);
self.addEventListener("install", (event) =>
  event.waitUntil(self.skipWaiting()),
);
self.addEventListener("message", (event) => {
  if (event.data?.type === "codoxear-transport-check")
    event.ports[0]?.postMessage({
      type: "codoxear-transport-ready",
      version: transportVersion,
    });
  if (event.data?.type === "codoxear-transport-activate")
    event.waitUntil(self.skipWaiting());
});
self.addEventListener("activate", (event) =>
  event.waitUntil(self.clients.claim()),
);
self.addEventListener("fetch", (event) => {
  const u = new URL(event.request.url);
  if (u.origin === self.location.origin && u.pathname.startsWith("/api/"))
    event.respondWith(
      handle(event.request).catch((e) => json({ error: String(e) }, 503)),
    );
});
