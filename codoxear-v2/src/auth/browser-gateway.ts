import type { FastifyInstance, FastifyRequest } from "fastify";
import { Readable } from "node:stream";
import { Id, DomainError } from "../contracts/model.js";
import type { Authority } from "./authority.js";
import type { IdentitySession } from "./model.js";
import { filterHeaders } from "../protocol/routes.js";

// Browser management requests carry only an authenticated account cookie and a
// hub ID. The authority resolves the origin and issues the scoped credential.
export async function registerBrowserGateway(
  app: FastifyInstance,
  authority: Authority,
  session: (r: FastifyRequest) => Promise<IdentitySession>,
) {
  app.route({
    method: ["GET", "POST", "PUT", "DELETE"],
    url: "/gateway/hubs/:hubId/api/*",
    handler: async (r, reply) => {
      const hubId = Id.parse((r.params as { hubId: string }).hubId);
      const s = await session(r);
      const suffix = (r.params as { "*": string })["*"];
      // Only the management API is exposed here. Workspace binary transfers use
      // the streaming workspace gateway; OAuth, device and internal routes do not.
      if (
        !/^(?:me|auth\/options|agent-directory|hubs(?:\/[A-Za-z0-9_-]+\/computers)?|computers\/[A-Za-z0-9_-]+\/(?:agents|launch-defaults|discovered|import|pairing|workspace|workspace-access\/[A-Za-z0-9_-]+)|agents\/[A-Za-z0-9_-]+\/(?:access|messages|send|interrupt|shares(?:\/[A-Za-z0-9_-]+)?)|resources\/(?:hub|computer)\/[A-Za-z0-9_-]+\/(?:members(?:\/[A-Za-z0-9_-]+)?|invitations|policy|owner)|invitations\/accept)$/.test(
          suffix,
        )
      )
        throw new DomainError(
          403,
          "route_denied",
          "Unsupported hub management route",
        );
      const grant = await authority.hubToken(s, hubId);
      if (suffix === "agent-directory") return authority.agentDirectory(s);
      if (suffix === "auth/options")
        return {
          central: true,
          identityUrl: authority.tokens.issuer,
          development: false,
        };
      const controller = new AbortController();
      r.raw.once("aborted", () => controller.abort());
      reply.raw.once("close", () => controller.abort());
      const init: RequestInit = {
        method: r.method,
        redirect: "error",
        signal: controller.signal,
        headers: {
          Authorization: "Bearer " + grant.accessToken,
          "Accept-Encoding": "identity",
        },
      };
      if (r.body !== undefined) {
        init.body = JSON.stringify(r.body);
        (init.headers as Record<string, string>)["Content-Type"] =
          "application/json";
      }
      const response = await fetch(
        new URL(
          "/api/" + suffix + new URL(r.url, authority.tokens.issuer).search,
          grant.origin,
        ),
        init,
      );
      reply.code(response.status);
      for (const [key, value] of Object.entries(
        filterHeaders(Object.fromEntries(response.headers), "response"),
      ))
        reply.header(key, value);
      return response.body
        ? reply.send(
            Readable.fromWeb(
              response.body as import("node:stream/web").ReadableStream,
            ),
          )
        : reply.send();
    },
  });
}
