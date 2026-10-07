/// <reference lib="webworker" />
import { vault, selectionId, hubScope, type HubLogin } from "./vault.js";
import { SessionSignInError, refreshSession } from "./oauth-session.js";
import { transportVersion } from "./transport-version.js";
import {
  disconnectPush,
  installPushEvents,
  notificationSubscription,
} from "./push.js";
declare const self: ServiceWorkerGlobalScope;
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    },
  });
class IdentitySelectionError extends Error {
  readonly status = 403;
  constructor() {
    super("This Hub credential was removed or replaced");
  }
}
async function assertSelected(
  login: HubLogin,
  generation = selectionId(login),
) {
  if (!(await vault.isSelectionActive(login.id, generation)))
    throw new IdentitySelectionError();
}
async function verifySnapshot(snapshot: HubLogin[], failed: boolean[]) {
  const active = await vault.activeList();
  for (let index = 0; index < snapshot.length; index++) {
    const original = snapshot[index]!;
    const current = active.find((row) => row.id === original.id);
    if (
      current?.id === original.id &&
      selectionId(current) === selectionId(original)
    )
      continue;
    // Removing or replacing a proof invalidates its in-flight response. Other
    // saved identities remain concurrently available.
    if (!current && failed[index] && !(await vault.get(original.id))) continue;
    throw new IdentitySelectionError();
  }
}
const ongoing = new Set<{
  login: HubLogin;
  generation: string;
  controller: AbortController;
}>();
const flights = new Map<string, Promise<HubLogin>>();
async function fresh(login: HubLogin): Promise<HubLogin> {
  const generation = selectionId(login);
  await assertSelected(login, generation);
  if (login.expiresAt > Date.now() + 30000) return login;
  const flightKey = login.id + ":" + generation;
  let work = flights.get(flightKey);
  if (!work) {
    work = navigator.locks
      .request("codoxear-hub-refresh:" + login.id, async () => {
        const latest = await vault.get(login.id);
        if (!latest) throw new Error("Sign in to this hub again");
        await assertSelected(latest, generation);
        if (latest.expiresAt > Date.now() + 30000) return latest;
        let tokens;
        try {
          tokens = await refreshSession(latest.origin, latest.refreshToken);
        } catch (error) {
          if (error instanceof SessionSignInError && error.status === 401)
            await vault.removeIfSelection(login.id, generation);
          throw error;
        }
        const next = {
          ...latest,
          accessToken: tokens.access_token,
          refreshToken: tokens.refresh_token,
          expiresAt: Date.now() + tokens.expires_in * 1000,
        };
        if ((await vault.get(login.id))?.refreshToken !== latest.refreshToken)
          throw new Error("Hub login changed during refresh");
        if (!(await vault.updateTokens(next, generation)))
          throw new IdentitySelectionError();
        return (await vault.get(login.id))!;
      })
      .then(async (value) => await value)
      .finally(() => flights.delete(flightKey));
    flights.set(flightKey, work);
  }
  return work;
}
async function hub(login: HubLogin, path: string, init: RequestInit = {}) {
  const cleanup =
    init.method === "DELETE" &&
    /^\/api\/v1\/push\/subscriptions(?:\/|$)/.test(path);
  const generation = selectionId(login);
  if (!cleanup) {
    await assertSelected(login, generation);
    login = await fresh(login);
    await assertSelected(login, generation);
  }
  if (!path.startsWith("/") || path.startsWith("//") || /[\\\r\n]/.test(path))
    throw new Error("Invalid hub path");
  const controller = new AbortController(),
    entry = { login, generation, controller };
  if (!cleanup) ongoing.add(entry);
  const release = () => ongoing.delete(entry);
  try {
    const response = await fetch(login.origin + path, {
      ...init,
      signal: init.signal
        ? AbortSignal.any([init.signal, controller.signal])
        : controller.signal,
      credentials: "omit",
      redirect: "error",
      headers: {
        ...Object.fromEntries(new Headers(init.headers)),
        Authorization: "Bearer " + login.accessToken,
      },
    });
    if (!cleanup) await assertSelected(login, generation);
    if (!response.body) {
      release();
      return response;
    }
    const reader = response.body.getReader();
    let streamTarget: ReadableStreamDefaultController<Uint8Array>;
    controller.signal.addEventListener(
      "abort",
      () => {
        release();
        void reader.cancel().catch(() => {});
        try {
          streamTarget.error(controller.signal.reason);
        } catch {}
      },
      { once: true },
    );
    const stream = new ReadableStream<Uint8Array>({
      start(target) {
        streamTarget = target;
      },
      async pull(target) {
        try {
          if (!cleanup) await assertSelected(login, generation);
          const chunk = await reader.read();
          if (!cleanup) await assertSelected(login, generation);
          if (chunk.done) {
            release();
            target.close();
          } else target.enqueue(chunk.value);
        } catch (error) {
          release();
          controller.abort();
          void reader.cancel().catch(() => {});
          target.error(error);
        }
      },
      cancel(reason) {
        release();
        controller.abort();
        return reader.cancel(reason);
      },
    });
    return new Response(stream, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  } catch (error) {
    release();
    controller.abort();
    throw error;
  }
}
// Public resource IDs belong to a Hub, independent of which local credential
// currently authorizes them. A request still uses exactly one actual principal.
const scope = hubScope;
const key = (login: HubLogin, id: string) => scope(login) + "~" + id;
const sameHub = (left: HubLogin, right: HubLogin) =>
  left.origin === right.origin && left.hubId === right.hubId;
const mergeResources = (rows: any[], identity: (row: any) => string) => {
  const result = new Map<string, any>();
  for (const row of rows) {
    const id = identity(row),
      previous = result.get(id);
    if (!previous)
      result.set(id, { ...row, loginIds: [row.loginId ?? row.codoxear_login] });
    else {
      const loginIds = [
        ...new Set([...previous.loginIds, row.loginId ?? row.codoxear_login]),
      ];
      const score = (value: any) =>
        (value.actions ?? value.codoxear_actions ?? []).length;
      if (score(row) > score(previous)) result.set(id, { ...row, loginIds });
      else previous.loginIds = loginIds;
    }
  }
  return [...result.values()];
};
async function checkedJson(login: HubLogin, path: string) {
  const response = await hub(login, path, {
    signal: AbortSignal.timeout(5000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    return undefined;
  }
  return response.json();
}
async function createPrincipal(anchor: HubLogin, computerId: string) {
  for (const candidate of (await vault.list()).filter((row) =>
    sameHub(row, anchor),
  )) {
    try {
      const directory = await checkedJson(candidate, "/api/agent-directory");
      if (
        directory?.placements.some(
          (placement: any) => placement.computerId === computerId,
        )
      )
        return candidate;
    } catch {}
  }
  return undefined;
}
async function agentPrincipal(
  candidates: HubLogin[],
  agentId: string,
  request: Request,
  url: URL,
) {
  const interrupt = /\/(?:interrupt|cancel|kill)(?:$|\/)/.test(url.pathname);
  const workspace =
    /\/(?:file|git)(?:\/|$)/.test(url.pathname) ||
    /\/(?:attachments|pending_attachment)(?:\/|$)/.test(url.pathname);
  const read =
    ["GET", "HEAD"].includes(request.method) ||
    /\/notifications\//.test(url.pathname);
  const action = interrupt ? "interrupt" : read || workspace ? "read" : "send";
  const matches: Array<{ login: HubLogin; computerId: string; rank: number }> =
    [];
  for (const candidate of candidates) {
    try {
      const proof = await checkedJson(
        candidate,
        "/api/agents/" + encodeURIComponent(agentId) + "/access",
      );
      if (!proof?.access?.actions?.includes(action)) continue;
      if (workspace) {
        const directory = await checkedJson(candidate, "/api/agent-directory");
        const agent = directory?.agents.find((row: any) => row.id === agentId);
        const workspaceId = url.searchParams.get("workspace_id");
        if (
          workspaceId &&
          !(agent?.workspaceGrants ?? []).some(
            (grant: any) =>
              grant.workspaceId === workspaceId &&
              (read || grant.access === "write") &&
              (!/\/git\//.test(url.pathname) || grant.git) &&
              (!/\/(?:upload|attachments|pending_attachment)(?:\/|$)/.test(
                url.pathname,
              ) ||
                read ||
                grant.uploads),
          )
        )
          continue;
      }
      matches.push({
        login: candidate,
        computerId: proof.agent.computerId,
        rank: proof.access.actions.length,
      });
    } catch {}
  }
  return matches.sort((left, right) => right.rank - left.rank)[0];
}
async function directory() {
  const snapshot = await vault.activeList();
  const groups = await Promise.all(
    snapshot.map(async (login) => {
      let status = 0,
        blocked = false;
      try {
        const res = await hub(login, "/api/agent-directory", {
          signal: AbortSignal.timeout(5000),
        });
        status = res.status;
        if (!res.ok) {
          blocked =
            (await res.json().catch(() => null))?.code ===
            "login_method_not_allowed";
          throw new Error("Directory unavailable");
        }
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
        blocked ||=
          e instanceof SessionSignInError &&
          e.code === "login_method_not_allowed";
        return {
          agents: [],
          placements: [],
          error: {
            loginId: login.id,
            name: login.name,
            message: blocked
              ? "This account type is blocked by the Hub owner. It remains saved for later access."
              : status === 401 || !(await vault.get(login.id))
                ? "Sign in to this hub again."
                : "Hub directory unavailable. Check your connection and retry.",
          },
        };
      }
    }),
  );
  await verifySnapshot(
    snapshot,
    groups.map((group) => !!group.error),
  );
  return {
    agents: mergeResources(
      groups.flatMap((g) => g.agents),
      (a: any) => a.id,
    ),
    placements: mergeResources(
      groups.flatMap((g) => g.placements),
      (p: any) => JSON.stringify([p.origin, p.hubId, p.computerId]),
    ),
    errors: groups.flatMap((g) => (g.error ? [g.error] : [])),
  };
}
async function catalog(placement: string | null) {
  const logins = await vault.activeList();
  const groups = await Promise.all(
    logins.map(async (login) => {
      let status = 0,
        blocked = false;
      try {
        const r = await hub(login, "/workspace/api/sessions", {
          signal: AbortSignal.timeout(7000),
        });
        status = r.status;
        if (!r.ok) {
          blocked =
            (await r.json().catch(() => null))?.code ===
            "login_method_not_allowed";
          throw new Error("Catalog unavailable");
        }
        const value = await r.json();
        const dr = await hub(login, "/api/agent-directory", {
          signal: AbortSignal.timeout(5000),
        });
        status = dr.status;
        if (!dr.ok) {
          blocked =
            (await dr.json().catch(() => null))?.code ===
            "login_method_not_allowed";
          throw new Error("Directory unavailable");
        }
        const d = await dr.json();
        const failures = value.catalog_errors ?? [];
        return {
          sessions: (value.sessions ?? [])
            .filter((s: any) =>
              d.agents.some((a: any) => a.id === s.session_id),
            )
            .map((s: any) => ({
              ...s,
              session_id: key(login, s.session_id),
              dependency_session_id: s.dependency_session_id
                ? key(login, s.dependency_session_id)
                : null,
              codoxear_hub: login.name,
              codoxear_computer: d.agents.find(
                (a: any) => a.id === s.session_id,
              )?.computerName,
              codoxear_login: login.id,
              codoxear_actions: d.agents.find((a: any) => a.id === s.session_id)
                ?.actions ?? ["read"],
            })),
          retainedIds: d.agents
            .filter((a: any) =>
              failures.some((f: any) => f.computerId === a.computerId),
            )
            .map((a: any) => key(login, a.id)),
          errors: failures.map((f: any) => ({
            loginId: login.id,
            name: f.computerName,
            kind: "computer",
            message: "Computer is unreachable. Reconnect it and retry.",
          })),
          ok: true,
        };
      } catch (error) {
        blocked ||=
          error instanceof SessionSignInError &&
          error.code === "login_method_not_allowed";
        const signedOut = status === 401 || !(await vault.get(login.id));
        return {
          sessions: [],
          retainedIds: [],
          ok: false,
          errors: [
            {
              loginId: login.id,
              name: login.name,
              kind: blocked ? "policy" : signedOut ? "signed_out" : "hub",
              message: blocked
                ? "This account type is blocked by the Hub owner. It remains saved for later access."
                : signedOut
                  ? "Sign in to this hub again."
                  : "Hub catalog unavailable. Check your connection and retry.",
            },
          ],
        };
      }
    }),
  );
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
        else await r.body?.cancel();
      } catch {}
  }
  await verifySnapshot(
    logins,
    groups.map((group) => !group.ok),
  );
  return {
    sessions: mergeResources(
      groups.flatMap((g) => g.sessions),
      (s: any) => s.session_id,
    ),
    catalog_status: {
      state: !logins.length
        ? "signed_out"
        : groups.some((g) => g.errors.length)
          ? groups.some((g) => g.ok)
            ? "partial"
            : "unavailable"
          : "ready",
      authenticated_hubs: new Set(logins.map(scope)).size,
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
        const dependency = String(b.dependency_session_id),
          separator = dependency.indexOf("~");
        const prefix = dependency.slice(0, separator);
        const dependencyLogin = (await vault.list()).find(
          (row) => scope(row) === prefix || row.accountKey === prefix,
        );
        if (
          separator < 0 ||
          !dependencyLogin ||
          !sameHub(dependencyLogin, login)
        )
          return json({ error: "Dependency must belong to the same Hub" }, 403);
        b.dependency_session_id = dependency.slice(separator + 1);
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
    await assertSelected(login);
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
  if (response.headers.get("content-type")?.includes("mpegurl")) {
    const playlist = await response.text();
    await assertSelected(login);
    return new Response(rewrite(playlist), {
      status: response.status,
      headers: output,
    });
  }
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
    const anchor = id ? await vault.get(id) : undefined;
    const login =
      anchor && computerId
        ? await createPrincipal(anchor, computerId)
        : undefined;
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
    await assertSelected(login);
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
          headers: {
            "Content-Type": "application/json",
            Authorization: "Bearer " + login.accessToken,
          },
          body: JSON.stringify({ token: login.refreshToken }),
        }).catch(() => {});
      }),
    );
    await Promise.all(
      (await vault.list()).map((login) => vault.remove(login.id)),
    );
    return json({ ok: true });
  }
  const disconnect = /^\/api\/client\/push\/disconnect\/([^/]+)$/.exec(path);
  if (disconnect && request.method === "POST") {
    const login = await vault.get(decodeURIComponent(disconnect[1]!));
    if (!login) return json({ ok: true });
    await disconnectPush(login, hub, self);
    await fetch(login.origin + "/oauth/revoke", {
      method: "POST",
      credentials: "omit",
      signal: AbortSignal.timeout(5000),
      headers: {
        "Content-Type": "application/json",
        Authorization: "Bearer " + login.accessToken,
      },
      body: JSON.stringify({ token: login.refreshToken }),
    }).catch(() => {});
    await vault.remove(login.id);
    return json({ ok: true });
  }
  const management = /^\/api\/client\/hubs\/([^/]+)(\/.*)$/.exec(path);
  if (management) {
    const login = await vault.get(management[1]!);
    if (!login) return json({ error: "Hub login unavailable" }, 401);
    if (!(await vault.isActive(login.id)))
      return json({ error: "This Hub identity is no longer saved" }, 403);
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
  const resourcePrefix = scoped.slice(0, split),
    agentId = scoped.slice(split + 1);
  const saved = await vault.list();
  const anchor = saved.find(
    (row) => scope(row) === resourcePrefix || row.accountKey === resourcePrefix,
  );
  const chosen = anchor
    ? await agentPrincipal(
        saved.filter((row) => sameHub(row, anchor)),
        agentId,
        request,
        url,
      )
    : undefined;
  const login = chosen?.login,
    computerId = chosen?.computerId;
  if (!login)
    return json(
      { error: "No saved identity currently has access to this agent" },
      403,
    );
  if (
    (path === "/api/notifications/subscription" ||
      path === "/api/notifications/subscription/toggle") &&
    computerId
  )
    return notificationSubscription(
      request,
      login,
      computerId,
      hub,
      self.location.origin,
    );
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
  if (event.data?.type === "codoxear-identity-changed")
    event.waitUntil(
      (async () => {
        await Promise.all(
          [...ongoing].map(async (entry) => {
            if (
              !(await vault.isSelectionActive(entry.login.id, entry.generation))
            )
              entry.controller.abort();
          }),
        );
        const sourceId =
          event.source && "id" in event.source ? event.source.id : undefined;
        for (const client of await self.clients.matchAll({
          type: "window",
          includeUncontrolled: true,
        }))
          if (
            client.id !== sourceId &&
            new URL(client.url).pathname !== "/auth-callback"
          )
            client.postMessage({ type: "codoxear-identity-changed" });
      })(),
    );
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
      handle(event.request).catch((e) =>
        json(
          { error: String(e) },
          e instanceof IdentitySelectionError ? 403 : 503,
        ),
      ),
    );
});
