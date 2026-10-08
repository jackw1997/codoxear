import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { z } from "zod";
import { DomainError, Id, type Agent } from "../contracts/model.js";
import { digest, secret } from "../domain/commands.js";
import { emptyBody, type WorkspaceContext } from "../protocol/http-frames.js";
import { filterHeaders } from "../protocol/routes.js";
import type { Tunnels } from "../protocol/tunnels.js";

type Decision = { actorId: string; actorIsOwner?: boolean; workspace?: WorkspaceContext };
type Subject = { userId: string; sessionId: string; binding: number };
type Ticket = Subject & {
  agentId: string;
  computerId: string;
  path: string;
  origin: string;
  expiresAt: number;
  decision: Decision;
};
export interface DownloadOptions {
  origin: string;
  call: <T>(
    r: FastifyRequest,
    op: string,
    args?: Record<string, unknown>,
  ) => Promise<T>;
  authorize: (ticket: Ticket) => Promise<Decision>;
  tunnels: Tunnels;
  now?: () => number;
}

/** A single-use form POST hands the download manager an authenticated stream
 * without URL credentials, page navigation or a whole-file Blob. Every stream
 * interval checks the original identity session, binding and workspace grant. */
export async function registerDownloads(
  app: FastifyInstance,
  options: DownloadOptions,
) {
  const pending = new Map<string, Ticket>();
  const active = new Set<AbortController>();
  const now = options.now ?? Date.now;
  const consumePath = "/api/v1/downloads/consume";
  const fingerprint = (d: Decision) =>
    JSON.stringify([d.actorId, d.actorIsOwner ?? null, d.workspace ?? null]);
  function prune() {
    for (const [id, ticket] of pending)
      if (ticket.expiresAt <= now()) pending.delete(id);
  }
  app.post("/api/v1/downloads/prepare", async (r) => {
    prune();
    const input = z
      .object({ agentId: Id, query: z.string().max(7000) })
      .strict()
      .parse(r.body);
    const query = new URLSearchParams(input.query);
    if (
      !query.get("path") ||
      [...query.keys()].some((key) =>
        !["path", "path_token", "git_path", "workspace_id"].includes(key) ||
        query.getAll(key).length !== 1 || !query.get(key)) ||
      (query.has("git_path") && query.get("git_path") !== "1")
    )
      throw new DomainError(
        400,
        "invalid_download",
        "Choose a file in the current workspace",
      );
    const { agent } = await options.call<{ agent: Agent }>(r, "authorize", {
      agentId: input.agentId,
      action: "read",
    });
    if (!agent.localId)
      throw new DomainError(
        409,
        "agent_not_ready",
        "The agent has no local session",
      );
    const subject = await options.call<Subject>(r, "notification-subject", {
      computerId: agent.computerId,
    });
    const path = `/api/sessions/${agent.localId}/file/download?${query}`;
    const decision = await options.call<Decision>(r, "relay", {
      computerId: agent.computerId,
      method: "GET",
      path,
    });
    if (decision.actorId !== subject.userId)
      throw new DomainError(
        403,
        "download_identity_changed",
        "Account changed during download preparation",
      );
    if (
      decision.workspace &&
      !options.tunnels.supports(agent.computerId, "workspace-files")
    )
      throw new DomainError(
        409,
        "capability_required",
        "Update the Computer to download delegated workspace files",
      );
    if (
      pending.size >= 1024 ||
      [...pending.values()].filter((t) => t.sessionId === subject.sessionId)
        .length >= 16
    )
      throw new DomainError(
        429,
        "downloads_busy",
        "Too many prepared downloads; try again shortly",
      );
    const ticket = secret();
    pending.set(digest(ticket), {
      ...subject,
      agentId: agent.id,
      computerId: agent.computerId,
      path,
      origin: r.headers.origin ?? options.origin,
      decision,
      expiresAt: now() + 120_000,
    });
    return { action: options.origin + consumePath, ticket, expiresIn: 120 };
  });
  await app.register(async (scoped) => {
    scoped.addContentTypeParser(
      "application/x-www-form-urlencoded",
      { parseAs: "string" },
      (_r, body, done) => {
        const fields = new URLSearchParams(String(body));
        if (
          [...fields.keys()].some((key) => key !== "ticket") ||
          fields.getAll("ticket").length !== 1
        )
          return done(
            new DomainError(400, "invalid_download", "Invalid download form"),
          );
        done(null, { ticket: fields.get("ticket") });
      },
    );
    scoped.post(consumePath, { bodyLimit: 4096 }, async (r, reply) => {
      prune();
      const { ticket } = z
        .object({ ticket: z.string().min(32).max(200) })
        .strict()
        .parse(r.body);
      const id = digest(ticket),
        prepared = pending.get(id);
      if (!prepared)
        throw new DomainError(
          410,
          "download_expired",
          "Prepare the download again; this handoff expired or was used",
        );
      if (r.headers.origin !== prepared.origin && r.headers.origin !== "null")
        throw new DomainError(
          403,
          "bad_origin",
          "The download belongs to another client origin",
        );
      // Consume before awaiting policy or transport: parallel POSTs cannot replay it.
      pending.delete(id);
      const controller = new AbortController(),
        deadline = now() + 24 * 60 * 60 * 1000;
      active.add(controller);
      let checking: Promise<void> | undefined;
      const check = () =>
        (checking ??= (async () => {
          if (now() >= deadline)
            throw new DomainError(
              410,
              "download_expired",
              "Download lease expired",
            );
          const current = await options.authorize(prepared);
          if (fingerprint(current) !== fingerprint(prepared.decision))
            throw new DomainError(
              403,
              "download_access_changed",
              "Account or workspace access changed during download",
            );
        })().finally(() => {
          checking = undefined;
        }));
      const timer = setInterval(
        () => void check().catch((e) => controller.abort(e)),
        1000,
      );
      const cleanup = () => {
        clearInterval(timer);
        active.delete(controller);
        controller.abort();
      };
      r.raw.once("aborted", cleanup);
      reply.raw.once("close", cleanup);
      try {
        await check();
        const response = await options.tunnels.http(
          prepared.computerId,
          {
            method: "GET",
            path: prepared.path,
            headers: {},
            actorId: prepared.userId,
            ...(prepared.decision.actorIsOwner === undefined ? {} : {actorIsOwner: prepared.decision.actorIsOwner}),
            ...(prepared.decision.workspace
              ? { workspace: prepared.decision.workspace }
              : {}),
          },
          emptyBody,
          controller.signal,
        );
        await check();
        reply.code(response.status);
        for (const [name, value] of Object.entries(
          filterHeaders(response.headers, "response"),
        ))
          reply.header(name, value);
        reply
          .header("Cache-Control", "no-store")
          .header("Referrer-Policy", "no-referrer")
          .header(
            "Content-Security-Policy",
            "sandbox allow-downloads; default-src 'none'",
          );
        if (response.status === 200)
          reply.header(
            "Content-Disposition",
            response.headers["content-disposition"] ?? "attachment",
          );
        return reply.send(
          Readable.from(
            (async function* () {
              try {
                for await (const chunk of response.body) {
                  if (controller.signal.aborted) throw controller.signal.reason;
                  yield chunk;
                }
              } finally {
                cleanup();
              }
            })(),
          ),
        );
      } catch (error) {
        cleanup();
        throw error;
      }
    });
  });
  app.addHook("preClose", async () => {
    pending.clear();
    for (const controller of active) controller.abort();
    active.clear();
  });
}
