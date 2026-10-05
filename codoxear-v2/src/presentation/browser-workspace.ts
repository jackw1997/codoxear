import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { DomainError, Id } from "../contracts/model.js";
import { filterHeaders } from "../protocol/routes.js";
import { workspaceAsset } from "./workspace-assets.js";

type Entry = {
  id: string;
  hubId: string;
  computerId: string;
  computerName?: string;
  localId: string | null;
  name: string;
  origin: string;
  state: string;
};
type Directory = { agents: Entry[] };
// A browser workspace uses global agent IDs. Only this server translates them
// into the owning hub/computer namespace; credentials never reach JavaScript.
export async function browserWorkspace(
  app: FastifyInstance,
  authority: { origin: string; request<T>(path: string, body: unknown, token?: string): Promise<T> },
  identity: (
    r: FastifyRequest,
  ) => Promise<{ token: string; accountId: string; scopeId: string }>,
) {
  const directory = async (r: FastifyRequest) => {
    const principal = await identity(r);
    const data = await authority.request<Directory>(
      "/api/v1/me/agents",
      {},
      principal.token,
    );
    return { ...principal, ...data };
  };
  async function upstream(
    token: string,
    agent: Entry,
    path: string,
    init: RequestInit = {},
  ) {
    const grant = await authority.request<{
      accessToken: string;
      origin: string;
    }>("/api/v1/hub-token", { hubId: agent.hubId }, token);
    // The authority's registered origin is authoritative, never a browser URL.
    return fetch(new URL(path, grant.origin), {
      ...init,
      redirect: "error",
      headers: {
        ...init.headers,
        "Accept-Encoding": "identity",
        Authorization: "Bearer " + grant.accessToken,
      },
    });
  }
  app.get("/workspace/api/me", async (r) => ({
    ok: true,
    user: { id: (await identity(r)).accountId },
  }));
  app.get("/workspace/api/sessions", async (r) => {
    const d = await directory(r);
    const computers = [
      ...new Map(
        d.agents.filter((a) => a.localId).map((a) => [a.computerId, a]),
      ).values(),
    ];
    const catalogErrors: Array<{computerId: string; computerName: string; message: string}> = [];
    const catalogs = await Promise.all(
      computers.map(async (agent) => {
        try {
          const response = await upstream(
            d.token,
            agent,
            `/api/v1/computers/${agent.computerId}/api/sessions`,
            { signal: AbortSignal.timeout(5000) },
          );
          if (!response.ok) throw new Error("Computer catalog unavailable");
          const catalog = (await response.json()) as {
            sessions: Array<Record<string, unknown>>;
            new_session_defaults?: Record<string, unknown>;
          };
          return catalog.sessions.flatMap((s) => {
            const a = d.agents.find(
              (a) =>
                a.computerId === agent.computerId && a.localId === s.session_id,
            );
            return a
              ? [
                  {
                    ...s,
                    codoxear_launch_defaults: catalog.new_session_defaults ?? {},
                    session_id: a.id,
                    alias: s.alias || a.name,
                    codoxear_computer_id: a.computerId,
                    dependency_session_id:
                      d.agents.find(
                        (dependency) =>
                          dependency.computerId === a.computerId &&
                          dependency.localId === s.dependency_session_id,
                      )?.id ?? null,
                  },
                ]
              : [];
          });
        } catch {
          catalogErrors.push({ computerId: agent.computerId, computerName: agent.computerName ?? "Computer", message: "Computer is unreachable. Reconnect it and retry." });
          return [];
        }
      }),
    );
    // Revalidate the directory after discovery so removals cannot race a result.
    const current = await directory(r);
    return {
      sessions: catalogs
        .flat()
        .filter((s) => current.agents.some((a) => a.id === s.session_id)),
      catalog_errors: catalogErrors.filter((error) => current.agents.some((a) => a.computerId === error.computerId)),
      catalog_authorized_agents: current.agents.map((a) => ({ session_id: a.id, computer_id: a.computerId })),
      recent_cwds: [],
      new_session_defaults: {},
      tmux_available: false,
    };
  });
  await app.register(async (scoped) => {
    scoped.removeAllContentTypeParsers();
    scoped.addContentTypeParser("*", (_request, payload, done) =>
      done(null, payload),
    );
    scoped.route({
      method: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE"],
      url: "/workspace/api/*",
      handler: async (r, reply) => {
        const url = new URL(r.url, "http://workspace.invalid");
        const path = url.pathname.slice("/workspace".length);
        const match = /^\/api\/sessions\/([^/]+)(\/.*)$/.exec(path);
        const agentId = Id.parse(match?.[1] ?? url.searchParams.get("__agent"));
        url.searchParams.delete("__agent");
        const d = await directory(r),
          agent = d.agents.find((a) => a.id === agentId && a.localId);
        if (!agent)
          throw new DomainError(
            404,
            "not_found",
            "Agent is no longer accessible",
          );
        const remotePath =
          match?.[2] === "/access"
            ? `/api/agents/${agent.id}/access`
            : `/api/v1/computers/${agent.computerId}` +
              (match
                ? `/api/sessions/${encodeURIComponent(agent.localId!)}${match[2]}`
                : path);
        const controller = new AbortController();
        const cancel = () => controller.abort();
        r.raw.once("aborted", cancel);
        reply.raw.once("close", cancel);
        const headers = filterHeaders(r.headers, "request");
        const init: RequestInit & { duplex?: string } = {
          method: r.method,
          headers,
          signal: controller.signal,
        };
        if (!["GET", "HEAD"].includes(r.method)) {
          if (
            match &&
            (/^\/file\/inspect(?:-batch)?$/.test(match[2]!) ||
              match[2] === "/edit")
          ) {
            const chunks: Buffer[] = [];
            let size = 0;
            for await (const chunk of r.body as AsyncIterable<Buffer>) {
              size += chunk.length;
              if (size > 256 * 1024)
                throw new DomainError(
                  413,
                  "too_large",
                  "Inspection request is too large",
                );
              chunks.push(chunk);
            }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (body.session_id && body.session_id !== agent.id)
              throw new DomainError(
                403,
                "wrong_agent",
                "Inspection belongs to another agent",
              );
            if (match[2] === "/edit") {
              if (body.dependency_session_id) {
                const dependency = d.agents.find(
                  (a) =>
                    a.id === body.dependency_session_id &&
                    a.localId &&
                    a.computerId === agent.computerId,
                );
                if (!dependency)
                  throw new DomainError(
                    403,
                    "wrong_agent",
                    "Dependency must be an accessible agent on the same Computer",
                  );
                body.dependency_session_id = dependency.localId;
              }
            } else body.session_id = agent.localId;
            init.body = JSON.stringify(body);
            delete headers["content-length"];
          } else {
            init.body = r.body as BodyInit;
            init.duplex = "half";
          }
        }
        let response: Response;
        try {
          response = await upstream(
            d.token,
            agent,
            remotePath + url.search,
            init,
          );
        } catch (e) {
          cancel();
          throw e;
        }
        reply.code(response.status);
        for (const [key, value] of Object.entries(
          filterHeaders(Object.fromEntries(response.headers), "response"),
        ))
          reply.header(key, value);
        reply.header("Content-Security-Policy", "sandbox; default-src 'none'");
        if (!response.body) {
          cancel();
          return reply.send();
        }
        if (response.headers.get("content-type")?.includes("mpegurl")) {
          const chunks: Buffer[] = [];
          let size = 0;
          for await (const chunk of Readable.fromWeb(
            response.body as import("node:stream/web").ReadableStream,
          )) {
            size += chunk.length;
            if (size > 1024 * 1024) {
              cancel();
              throw new DomainError(
                413,
                "too_large",
                "Media playlist is too large",
              );
            }
            chunks.push(chunk);
          }
          const prefix = `/api/v1/computers/${agent.computerId}`;
          const playlist = Buffer.concat(chunks)
            .toString()
            .replace(
              /\/api\/(?:v1\/computers\/[A-Za-z0-9_-]+\/api\/)?[^\s"']+/g,
              (uri) => {
                const parsed = new URL(uri, "http://workspace.invalid");
                if (parsed.pathname.startsWith(prefix + "/api/"))
                  parsed.pathname = parsed.pathname.slice(prefix.length);
                parsed.pathname =
                  "/workspace" +
                  parsed.pathname.replace(
                    `/api/sessions/${agent.localId}/`,
                    `/api/sessions/${agent.id}/`,
                  );
                parsed.searchParams.set("__agent", agent.id);
                return parsed.pathname + parsed.search;
              },
            );
          reply.removeHeader("content-length");
          return reply.send(playlist);
        }
        if (
          match?.[2] === "/file/read" &&
          response.ok &&
          response.headers.get("content-type")?.includes("application/json")
        ) {
          const chunks: Uint8Array[] = [];
          let size = 0;
          for await (const chunk of Readable.fromWeb(
            response.body as import("node:stream/web").ReadableStream,
          )) {
            size += chunk.length;
            if (size > 8 * 1024 * 1024) {
              cancel();
              throw new DomainError(
                413,
                "too_large",
                "File preview is too large; download the file instead",
              );
            }
            chunks.push(chunk);
          }
          const value = JSON.parse(Buffer.concat(chunks).toString());
          for (const key of [
            "image_url",
            "pdf_url",
            "video_url",
            "preview_url",
          ])
            if (typeof value[key] === "string")
              value[key] = value[key].replace(
                `/api/sessions/${agent.localId}/`,
                `/api/sessions/${agent.id}/`,
              );
          reply.removeHeader("content-length");
          return reply.send(value);
        }
        return reply.send(
          Readable.fromWeb(
            response.body as import("node:stream/web").ReadableStream,
          ),
        );
      },
    });
  });
  const asset = async (
    r: FastifyRequest,
    reply: import("fastify").FastifyReply,
  ) => {
    const p = await identity(r);
    const path = (r.params as { "*"?: string })["*"] ?? "";
    if (path.startsWith("api/"))
      throw new DomainError(404, "not_found", "Unknown workspace API");
    const data = await workspaceAsset("dist/workspace", path, {
      issuer: authority.origin,
      accountId: p.accountId,
      scopeId: p.scopeId,
      hubId: "workspace",
      computerId: "workspace",
    });
    if (
      path &&
      path !== "index.html" &&
      new URL(r.url, "http://workspace.invalid").searchParams.has("v")
    )
      reply.header("Cache-Control", "private, max-age=31536000, immutable");
    return reply.type(data.type).send(data.body);
  };
  app.get("/workspace/", asset);
  app.get("/workspace/*", asset);
}
