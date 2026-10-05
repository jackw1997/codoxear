import { InvitationRequest } from "../src/contracts/invitations.js";
import { mkdir, writeFile } from "node:fs/promises";
import { z } from "zod";
import {
  HttpFrame,
  CHUNK_BYTES,
  STREAM_WINDOW,
  COMPUTER_WINDOW,
  MAX_STREAMS,
} from "../src/protocol/http-frames.js";
import {
  RequestFrame,
  ResultFrame,
  WelcomeFrame,
  Operation,
  Launch,
} from "../src/contracts/tunnel.js";
import {
  NotificationFrame,
  NotificationAck,
} from "../src/protocol/notifications.js";
import { AuthRequirement } from "../src/identity/model.js";
import { Hub, Agent, Id, Name, DomainError } from "../src/contracts/model.js";
const json = (schema: z.ZodType) =>
  z.toJSONSchema(schema, { target: "draft-2020-12", unrepresentable: "any" });
const error = z.object({ code: z.string(), error: z.string() });
const schemas = {
  Hub: json(Hub),
  Agent: json(Agent),
  Error: json(error),
  Operation: json(Operation),
};
const paths: Record<string, unknown> = {};
function route(
  method: string,
  path: string,
  description: string,
  body?: z.ZodType,
  response?: z.ZodType,
  anonymous = false,
) {
  const parameters = [...path.matchAll(/\{([^}]+)\}/g)].map((m) => ({
    name: m[1],
    in: "path",
    required: true,
    schema: json(
      m[1] === "localId"
        ? z.string().regex(/^[A-Za-z0-9_.:-]{1,200}$/)
        : m[1] === "kind"
          ? z.enum(["hub", "computer"])
          : Id,
    ),
  }));
  paths[path] ??= {} as any;
  (paths[path] as Record<string, unknown>)[method] = {
    summary: description,
    security: anonymous ? [] : [{ Bearer: [] }, { BrowserCookie: [] }],
    ...(parameters.length ? { parameters } : {}),
    ...(body
      ? {
          requestBody: {
            required: true,
            content: { "application/json": { schema: json(body) } },
          },
        }
      : {}),
    responses: {
      "200": {
        description: "Success",
        ...(response
          ? { content: { "application/json": { schema: json(response) } } }
          : {}),
      },
      ...Object.fromEntries(
        [400, 401, 403, 404, 409, 429, 503].map((code) => [
          code,
          {
            description:
              code === 503
                ? "Unavailable; respect structured not_dispatched versus outcome_unknown"
                : "Structured error",
            content: {
              "application/json": {
                schema: { $ref: "#/components/schemas/Error" },
              },
            },
          },
        ]),
      ),
    },
  };
}
route(
  "post",
  "/api/resources/{kind}/{id}/invitations",
  "Owner creates an invitation addressed to an email, verified phone or exact provider identity",
  InvitationRequest,
  z.object({ id: Id, token: z.string() }),
);
route(
  "post",
  "/api/v1/invitations/accept",
  "Accept a single-use invitation with a matching verified identity",
  z.object({ token: z.string().min(32).max(100) }),
);
route(
  "get",
  "/api/agents/{id}/shares",
  "Computer owner lists hub members and explicit shares for this agent",
);
route(
  "put",
  "/api/agents/{id}/shares/{userId}",
  "Computer owner grants viewer/operator access to one agent or revokes its explicit and historical rights",
  z.object({ role: z.enum(["viewer", "operator"]).nullable() }).strict(),
  z.object({
    ok: z.literal(true),
    access: z.object({
      actions: z.array(z.enum(["read", "send", "interrupt"])),
      mode: z.enum(["member", "shared", "retained", "read_only", "denied"]),
      source: z.enum(["hub", "computer", "default", "membership", "agent"]),
      reason: z.string(),
    }),
  }),
);
route(
  "get",
  "/api/computers/{id}/workspace",
  "Computer owner reviews the configured workspace root",
);
route(
  "put",
  "/api/computers/{id}/workspace-access/{userId}",
  "Computer owner grants or revokes workspace files for an active hub and computer member",
  z.object({ access: z.enum(["read", "write"]).nullable() }),
  z.object({ ok: z.literal(true) }),
);
for (const operation of ["inspect", "inspect-batch"])
  route(
    "post",
    `/api/v1/computers/{computerId}/api/sessions/{localId}/file/${operation}`,
    "Session-scoped file inspection; delegated workspace boundary enforced on Computer",
    operation === "inspect"
      ? z.object({
          path: z.string(),
          session_id: z.string().optional(),
          git_path: z.boolean().optional(),
          path_token: z.string().optional(),
        })
      : z.object({
          paths: z.array(z.string()).max(50),
          session_id: z.string().optional(),
        }),
  );
route(
  "post",
  "/api/v1/computers/{computerId}/api/sessions/{localId}/delete",
  "Computer-owner deletion; catalog is removed only after confirmed local deletion",
  z.object({}),
  z.object({ ok: z.literal(true) }),
);
route(
  "post",
  "/api/agents/{id}/reconcile",
  "Recover an existing Computer launch receipt without dispatching work",
  z.object({}),
);
route(
  "get",
  "/api/v1/meta",
  "Hub identity, protocol version and advertised capabilities",
  undefined,
  z.object({
    hubId: Id,
    issuer: z.url(),
    protocol: z.object({ major: z.literal(1), minor: z.number() }),
    capabilities: z.array(z.string()),
  }),
  true,
);
route(
  "get",
  "/api/v1/computers",
  "Authorized computers, active creation capability and tunnel availability",
);
route(
  "get",
  "/api/computers/{id}/agents",
  "Agents authorized by current membership or prior retained grants",
);
route(
  "post",
  "/api/computers/{id}/agents",
  "Create on an online computer; no mutation retry",
  z
    .object({
      name: Name,
      backend: Agent.shape.backend,
      launch: Launch.strict().optional(),
    })
    .strict(),
  Agent,
);
route(
  "get",
  "/api/computers/{id}/launch-defaults",
  "Computer owner inspects runtime/provider/model choices without credentials",
);
route(
  "post",
  "/api/v1/computers/{computerId}/api/sessions",
  "Computer owner launches a native runtime with per-agent provider settings; no mutation retry",
  Launch.extend({
    agent_backend: Agent.shape.backend,
    name: Name.optional(),
  }).strict(),
);
route(
  "get",
  "/api/computers/{id}/resume-candidates",
  "Computer owner lists saved native sessions for the explicit backend and cwd query; requires resume-candidates capability; returns labels and IDs without log paths",
  undefined,
  z.object({
    sessions: z.array(
      z.object({
        session_id: z.string(),
        alias: z.string().optional(),
        first_user_message: z.string().optional(),
      }),
    ),
  }),
);
route(
  "get",
  "/api/computers/{id}/discovered",
  "Computer owner discovers unpublished local sessions",
);
route(
  "post",
  "/api/computers/{id}/import",
  "Computer owner explicitly publishes an existing session and history",
  z.object({ localId: z.string(), name: Name }),
  Agent,
);
route("get", "/api/agents/{id}/messages", "Simplified conversation snapshot");
route(
  "get",
  "/api/agents/{id}/live",
  "SSE: access, snapshot, online, offline, access_lost; terminate on revoked policy",
);
route(
  "post",
  "/api/agents/{id}/send",
  "Confirmed or uncertain prompt dispatch; never replay",
  z.object({ text: z.string().min(1).max(200000) }),
);
route(
  "post",
  "/api/agents/{id}/interrupt",
  "Interrupt an authorized agent",
  z.object({}),
);
route(
  "post",
  "/api/computers/{id}/pairing",
  "Computer owner issues a five-minute, single-use enrollment code",
);
route(
  "get",
  "/api/v1/push/subscriptions",
  "List this account’s installation/computer subscriptions without provider tokens",
);
route(
  "post",
  "/api/v1/push/subscriptions",
  "Subscribe one installation to a computer; scope is derived from verified account and hub",
  z
    .object({
      computerId: Id,
      installationId: Id,
      provider: z.literal("harmony"),
      token: z.string().min(1).max(4096),
    })
    .strict(),
);
route(
  "delete",
  "/api/v1/push/subscriptions/{installationId}/{computerId}",
  "Remove only this account’s selected subscription",
);
route(
  "get",
  "/api/v1/computers/{computerId}/api/notifications/harmony",
  "Harmony compatibility: provider capability",
);
route(
  "post",
  "/api/v1/computers/{computerId}/api/notifications/harmony",
  "Harmony compatibility: register or remove a scoped installation",
  z.object({
    device_id: Id,
    token: z.string().max(4096).default(""),
    enabled: z.boolean(),
    server: z.string().max(2000).optional(),
  }),
  z.object({ ok: z.literal(true), registered: z.boolean() }),
);
const hub = {
  openapi: "3.1.0",
  info: {
    title: "Codoxear Hub API",
    version: "1.0.0",
    description:
      "Computers dial outbound WSS. Browser credentials remain in the BFF. Native clients use an exact-hub-audience bearer token. No automatic direct fallback.",
  },
  paths: { ...paths },
  components: {
    securitySchemes: {
      Bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      BrowserCookie: {
        type: "apiKey",
        in: "cookie",
        name: "codoxear_hub_{hubId}",
        description:
          "Cookie name includes the configured hub ID; HTTPOnly, Secure, SameSite=Strict.",
      },
    },
    schemas,
  },
};
for (const key of Object.keys(paths)) delete paths[key];
route(
  "get",
  "/api/v1/auth/options",
  "Configured login methods",
  undefined,
  undefined,
  true,
);
route(
  "post",
  "/api/v1/auth/password",
  "Operator-provisioned password login",
  z.object({
    email: z.email(),
    password: z.string(),
    installationId: Id.optional(),
  }),
  undefined,
  true,
);
route(
  "post",
  "/api/v1/auth/code",
  "Deliver a transaction-bound email or SMS code; linking requires fresh existing authentication",
  z.object({
    method: z.enum(["email", "phone"]),
    target: z.string(),
    link: z.boolean().optional(),
  }),
  undefined,
  true,
);
route(
  "post",
  "/api/v1/auth/code/verify",
  "Verify one unused code; never merge accounts merely because emails match",
  z.object({
    challengeId: Id,
    transaction: z.string(),
    code: z.string().regex(/^\d{6}$/),
    installationId: Id.optional(),
  }),
  undefined,
  true,
);
route("get", "/api/v1/me", "Authenticated account and linked identities");
route(
  "get",
  "/api/v1/me/hubs",
  "Authorized hubs and provider reauthentication requirements",
);
route(
  "post",
  "/api/v1/hub-token",
  "Issue a five-minute token for exactly one hub",
  z.object({ hubId: Id }),
);
route(
  "post",
  "/oauth/token",
  "PKCE authorization-code exchange or rotating refresh token",
  z.union([
    z.object({
      grant_type: z.literal("authorization_code"),
      client_id: Id,
      redirect_uri: z.url(),
      code: z.string(),
      code_verifier: z.string(),
      installation_id: Id.optional(),
    }),
    z.object({
      grant_type: z.literal("refresh_token"),
      refresh_token: z.string(),
    }),
  ]),
  undefined,
  true,
);
route(
  "post",
  "/api/v1/pairing/redeem",
  "Single-use owner-issued computer enrollment",
  z.object({ code: z.string() }),
  undefined,
  true,
);
route(
  "post",
  "/api/v1/computers/{id}/transfer",
  "Fence the old binding before explicit target-hub enrollment",
  z.object({
    targetHubId: Id,
    exposeHistory: z.boolean(),
    admissionToken: z.string().optional(),
  }),
);
route(
  "post",
  "/api/v1/hubs/{id}/admissions",
  "Target owner issues a scoped, five-minute, single-use computer admission",
  z.object({ computerId: Id }),
);
route(
  "post",
  "/oauth/revoke",
  "Revoke an installation using its refresh credential even after access expiry",
  z.object({ token: z.string() }),
  undefined,
  true,
);
route(
  "get",
  "/api/v1/me/computers",
  "Metadata for computers personally owned by this account",
);
route(
  "post",
  "/api/v1/hubs",
  "Create a hub with the current account as its only owner",
  z.object({ name: Name }),
);
route(
  "post",
  "/api/v1/hubs/{id}/register",
  "Owner registers exact public origin and rotates service credential",
  z.object({ origin: z.url() }),
);
route(
  "put",
  "/api/v1/hubs/{id}/auth-requirement",
  "Owner changes hub login rule only after proving the proposed authentication context",
  z.object({ rule: AuthRequirement.nullable() }),
);
const identity = {
  openapi: "3.1.0",
  info: {
    title: "Codoxear Identity API",
    version: "1.0.0",
    description:
      "Native authorization begins at /oauth/authorize with response_type=code, registered exact redirect_uri, state and S256 PKCE. Provider callbacks and internal service APIs are intentionally separate from this public client contract.",
  },
  paths: { ...paths },
  components: {
    securitySchemes: {
      Bearer: { type: "http", scheme: "bearer", bearerFormat: "JWT" },
      BrowserCookie: {
        type: "apiKey",
        in: "cookie",
        name: "codoxear_identity",
      },
    },
    schemas,
  },
};
await mkdir("protocol", { recursive: true });
for (const [file, value] of Object.entries({
  "hub.openapi.json": hub,
  "identity.openapi.json": identity,
  "http-frame.schema.json": json(HttpFrame),
  "rpc-frame.schema.json": json(
    z.union([
      RequestFrame,
      ResultFrame,
      WelcomeFrame,
      NotificationFrame,
      NotificationAck,
    ]),
  ),
  "limits.json": {
    version: { major: 1, minor: 0 },
    chunkBytes: CHUNK_BYTES,
    streamQueuedBytes: STREAM_WINDOW,
    computerQueuedBytes: COMPUTER_WINDOW,
    maxConcurrentStreams: MAX_STREAMS,
    maxUploadBytes: 256 * 1024 * 1024,
    mutationRetry: false,
    notifications: {
      ttlSeconds: 86400,
      acknowledgement: "after durable hub acceptance",
      maxOutboxEvents: 10000,
      maxHubEvents: 10000,
      maxDeliveries: 100000,
      providerSemantics: "at-least-once hint; delivery is not guaranteed",
    },
    maxPolicyLeaseSeconds: 30,
  },
}))
  await writeFile("protocol/" + file, JSON.stringify(value, null, 2) + "\n");
