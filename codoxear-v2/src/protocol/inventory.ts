import { z } from "zod";
import { Agent, Hub, Id, Name, Policy, Role } from "../contracts/model.js";
import { AuthRequirement } from "../contracts/identity.js";
import { HubLoginMethodsRequest } from "../contracts/hub-organization.js";
import { InvitationRequest } from "../contracts/invitations.js";
import { Launch } from "../contracts/tunnel.js";
import { DelegationAuthorityRequest, DelegationChildContextRequest, DelegationReserveRequest, DelegationContextResponse,
  DelegationGrantRequest, DelegationSpawn, DelegationSend, DelegationReceipt, DelegationMessages } from "../contracts/delegation.js";
import { GrantPath } from "../contracts/workspaces.js";
import { WebPushRegistration } from "../contracts/web-push.js";
import { PAIRING_LIFETIME_SECONDS } from "../contracts/pairing.js";
import {
  hubRegisteredEndpoints,
  identityRegisteredEndpoints,
  type RegisteredEndpoint,
} from "./registered-routes.js";
import { relayEndpointInventory, type RouteAccess } from "./routes.js";
import { adminDetails } from "./admin-contracts.js";
import {
  nativeDetail,
  Catalog,
  BrowserCatalog,
  LaunchDefaults,
  Session,
  WorkspaceSnapshot,
  ResumeCandidates,
  SendAck,
  InterruptAck,
  Messages,
  AccessDecision,
  HubNotificationFeed,
  QueueSnapshot,
} from "./native-contracts.js";

export const HUB_PROTOCOL = { major: 1, minor: 0 } as const;
export const HUB_CAPABILITIES = [
  "agents",
  "invites",
  "retention",
  "rpc",
  "http-streams",
] as const;
export const DomainErrorResponse = z.object({
  code: z.string(),
  error: z.string(),
});
export const NativeErrorResponse = z.object({
  error: z.string(),
  code: z.string().optional(),
});
export const RouterErrorResponse = z.object({
  statusCode: z.number().int(),
  error: z.string(),
  message: z.string(),
});
export const ErrorResponse = z.union([
  DomainErrorResponse,
  RouterErrorResponse,
  NativeErrorResponse,
]);
export const HubMetadata = z.object({
  hubId: Id,
  issuer: z.url(),
  independent: z.boolean(),
  protocol: z.object({ major: z.literal(1), minor: z.literal(0) }),
  capabilities: z.array(z.enum(HUB_CAPABILITIES)),
});
export type EndpointAuth =
  | "public"
  | "account"
  | "computer"
  | "hub-service"
  | "hub-user"
  | "download-ticket"
  | "delegated";
export type Endpoint = {
  method: string;
  path: string;
  auth: EndpointAuth;
  summary: string;
  body?: z.ZodType | undefined;
  query?: z.ZodType;
  response?: z.ZodType;
  statuses: number[];
  contentType?: string;
  requestContentType?: string;
  requestContents?: Record<string, z.ZodType>;
  responseContents?: Record<string, z.ZodType>;
  events?: Record<string, z.ZodType>;
  responseHeaders?: Record<
    string,
    { schema: Record<string, unknown>; description: string }
  >;
  action?: RouteAccess;
  websocket?: boolean;
  registeredPath?: string;
  conditional?: string;
};
type Detail = Partial<Omit<Endpoint, "method" | "path">>;
const details: Record<string, Detail> = {};
const ok = z.object({ ok: z.literal(true) }),
  binding = z.number().int().positive(),
  timestamp = z.number().nonnegative();
const delegationStatus = z.object({ installed: z.boolean(), authorized: z.boolean(),
  authorizationUnknown: z.boolean().optional(), connectionUnknown: z.boolean().optional(),
  expiresAt: timestamp.optional(), targetComputerIds: z.array(Id).optional(), parentId: Id.optional(),
  sourceComputerId: Id.optional(), confirmedAt: timestamp.optional(), revoked: z.boolean().optional() });
for (const method of ["GET", "POST", "DELETE"]) define(method, "/api/agents/:id/delegation-grants", {
  auth: "account", ...(method === "POST" ? { body: DelegationGrantRequest } : {}), response: delegationStatus,
  conditional: "Hub configured with durable delegation store", summary: "Manage same-Hub parent delegation access without exposing grants",
  statuses: [200, 400, 401, 403, 404, 409, 500, 503] });
const delegationBase = "/connect/v1/computers/:computerId/agents/:parentId/delegations";
for (const [method, suffix, body, response] of [
  ["POST", "", DelegationSpawn, DelegationReceipt],
  ["GET", "", undefined, z.object({ children: z.array(DelegationReceipt) })],
  ["GET", "/targets", undefined, z.object({ computers: z.array(z.object({ id: Id, name: Name })) })],
  ["GET", "/:childId", undefined, DelegationReceipt],
  ["GET", "/:childId/messages", undefined, DelegationMessages],
  ["POST", "/:childId/send", DelegationSend, SendAck],
  ["POST", "/:childId/interrupt", z.object({}).strict(), InterruptAck],
] as const) define(method, delegationBase + suffix, { auth: "delegated", body, response,
  conditional: "Hub configured with durable delegation store", summary: "Binding-fenced Computer and parent grant; same-Hub principal permissions rechecked",
  statuses: [200, 400, 401, 403, 404, 409, 500, 503] });
const authTokens = z.object({
  access_token: z.string(),
  token_type: z.literal("Bearer"),
  expires_in: z.number(),
  refresh_token: z.string(),
});
const pairing = z.object({
  code: z.string(),
  computerId: Id,
  hubId: Id,
  expiresIn: z.literal(PAIRING_LIFETIME_SECONDS),
  expiresAt: timestamp,
});
const transferCode = z.object({ code: z.string().trim().min(8).max(100) });
const transferRedeem = transferCode.extend({
  transferId: Id,
  credential: z
    .string()
    .min(32)
    .max(200)
    .regex(/^[A-Za-z0-9_-]+$/),
});
const detach = z.object({
  detached: z.literal(true),
  transferId: Id,
  computerId: Id,
  hubId: Id,
  priorBinding: binding,
  binding,
});
const harmony = z
  .object({
    provider: z.literal("harmony"),
    computerId: Id,
    installationId: Id,
    token: z.string().min(1).max(4096),
  })
  .strict();
const pushAuthorization = z
  .object({
    computerId: Id,
    installationId: Id,
    clientId: Id,
    agentId: Id,
    binding,
    subscriptionTag: z.string().regex(/^[a-f0-9]{64}$/),
  })
  .strict();
const workspaceGrant = z
  .object({
    access: z.enum(["read", "write"]).nullable(),
    workspaceId: Id.optional(),
    paths: z.array(GrantPath.max(2000)).min(1).max(100).optional(),
    git: z.boolean().optional(),
    uploads: z.boolean().optional(),
    transcode: z.boolean().optional(),
  })
  .strict();
const notificationSubscription = z.object({
  installationId: Id,
  computerId: Id,
  createdAt: timestamp,
  provider: z.enum(["harmony", "web-push"]),
  clientId: Id.optional(),
  binding: binding.optional(),
});
const publicConfig = z.object({
  configured: z.boolean(),
  vapid_public_key: z.string(),
  subscriptions: z.array(notificationSubscription),
});
const actorWorkspaceGrant = z.object({
  workspaceId: Id,
  access: z.enum(["read", "write"]),
  paths: z.array(GrantPath),
  git: z.boolean(),
  uploads: z.boolean(),
  transcode: z.boolean(),
  grantRevision: z.string(),
});
const queueSnapshot = QueueSnapshot;

function define(method: string, path: string, detail: Detail) {
  const key = method + " " + path;
  details[key] = { ...details[key], ...detail };
}
define("GET", "/health", {
  auth: "public",
  summary: "Anonymous liveness metadata",
  response: z.object({
    ok: z.literal(true),
    service: z.string(),
    hubId: Id.optional(),
  }),
  statuses: [200, 500],
});
define("GET", "/api/v1/meta", {
  auth: "public",
  summary:
    "Exact independent Hub identity and advertised protocol capabilities",
  response: HubMetadata,
  statuses: [200, 500],
});
define("GET", "/api/auth/options", {
  auth: "public",
  summary: "Independent or explicitly configured compatibility login mode",
  response: z.object({
    central: z.boolean(),
    independent: z.boolean(),
    identityUrl: z.url(),
    loginUrl: z.string(),
    development: z.boolean(),
  }),
  statuses: [200, 500],
});
define("GET", "/api/agent-directory", {
  summary: "Current account's authorized agents and Computer placements",
  response: z.object({
    agents: z.array(
      Agent.extend({
        computerName: z.string(),
        hubName: z.string(),
        origin: z.url(),
        access: AccessDecision.shape.mode,
        actions: AccessDecision.shape.actions,
        workspaceGrants: z.array(
          z.object({
            workspaceId: Id,
            access: z.enum(["read", "write"]),
            paths: z.array(GrantPath),
            git: z.boolean(),
            uploads: z.boolean(),
            transcode: z.boolean(),
            grantRevision: z.string(),
          }),
        ),
      }),
    ),
    placements: z.array(
      z.object({
        computerId: Id,
        computerName: z.string(),
        hubId: Id,
        hubName: z.string(),
        origin: z.url(),
      }),
    ),
  }),
  statuses: [200, 401, 403, 500],
});
define("GET", "/api/v1/me/agents", { ...details["GET /api/agent-directory"] });
define("GET", "/api/computers/:id/agents", {
  summary:
    "Current published Computer agents and authorized actions/workspace capabilities",
  response: z.array(
    Agent.extend({
      access: AccessDecision,
      workspaceGrants: z.array(actorWorkspaceGrant),
    }),
  ),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("GET", "/workspace/api/me", {
  summary: "Authenticated optional browser workspace account",
  response: z.object({ ok: z.literal(true), user: z.object({ id: Id }) }),
  statuses: [200, 401, 403, 500],
});
define("GET", "/workspace/api/sessions", {
  summary:
    "Optional browser workspace current-native catalog using published agent IDs; unreachable Computers are explicit catalog_errors",
  response: BrowserCatalog,
  statuses: [200, 401, 403, 500, 503],
});
define("GET", "/api/agents/:id/access", {
  summary: "Current authorized agent and action decision",
  response: z.object({
    agent: Agent,
    access: AccessDecision,
    actorId: Id,
    revision: z.number().int().nonnegative(),
    leaseExpiresAt: z.number(),
  }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("GET", "/.well-known/jwks.json", {
  auth: "public",
  summary: "Public verification keys; no private signing material",
  response: z.object({ keys: z.array(z.record(z.string(), z.unknown())) }),
  statuses: [200, 500],
});
for (const path of [
  "/auth/start",
  "/auth/callback",
  "/auth/:connection/start",
  "/auth/:connection/callback",
])
  define("GET", path, {
    auth: "public",
    summary: "Validated OAuth/browser sign-in redirect",
    contentType: "text/html",
    statuses: [200, 302, 400, 401, 403, 404, 500],
  });
for (const path of ["/workspace/", "/api/v1/computers/:computerId/"])
  define("GET", path, {
    summary: "Authenticated workspace presentation document",
    contentType: "text/html",
    statuses: [200, 400, 401, 403, 404, 500],
  });
for (const path of [
  "/api/auth/logout",
  "/workspace/api/logout",
  "/api/v1/computers/:computerId/api/logout",
  "/api/v1/auth/logout",
])
  define("POST", path, {
    summary: "Remove the optional browser-cookie session",
    body: z.object({}).optional(),
    response: ok,
    statuses: [200, 400, 403, 500],
  });
define("POST", "/api/computers/:id/pairing", {
  summary: "Owner issues a single-use 15-minute Computer enrollment code",
  response: pairing,
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/api/hubs/:id/computers", {
  summary: "Owner creates a Computer and returns its enrollment code",
  body: z.object({ name: Name }),
  statuses: [200, 400, 401, 403, 404, 500],
});
for (const path of ["/api/computers/:id/agents", "/api/v1/me/agents"])
  define("POST", path, {
    summary:
      "Create an agent on an authorized online Computer; never retry mutations automatically",
    body: z
      .object({
        name: Name,
        backend: Agent.shape.backend,
        launch: Launch.strict().optional(),
      })
      .strict(),
    response: Agent,
    statuses: [200, 400, 401, 403, 404, 409, 500, 503],
  });
define("POST", "/api/computers/:id/import", {
  summary: "Owner publishes a discovered local session",
  body: z.object({ localId: z.string().min(1).max(200), name: Name }),
  response: Agent,
  statuses: [200, 400, 401, 403, 404, 500, 503],
});
define("GET", "/api/computers/:id/resume-candidates", {
  summary:
    "Owner reads producer-backed saved sessions for an explicit backend and working directory",
  query: z.object({
    backend: z.enum(["codex", "pi", "cc"]),
    cwd: z.string().min(1).max(4096),
  }),
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
define("POST", "/api/agents/:id/reconcile", {
  summary: "Read an existing durable launch receipt without dispatching work",
  response: z.union([
    z.object({ state: z.literal("unknown") }),
    z.object({
      state: z.literal("ready"),
      localId: z.string().nullable(),
      brokerPid: z.number().int().positive().optional(),
    }),
  ]),
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
for (const path of ["/api/agents/:id/send", "/api/agents/:id/interrupt"])
  define("POST", path, {
    summary: path.endsWith("send")
      ? "Dispatch one authorized prompt; uncertain outcomes are not replayed"
      : "Interrupt an authorized agent",
    body: path.endsWith("send")
      ? z.object({ text: z.string().min(1).max(200000) })
      : z.object({}),
    statuses: [200, 400, 401, 403, 404, 409, 500, 503],
  });
define("GET", "/api/agents/:id/live", {
  summary:
    "SSE snapshot/access/online/offline/access_lost events; access loss ends the stream",
  contentType: "text/event-stream",
  statuses: [200, 400, 401, 403, 404, 500, 503],
});
define("POST", "/api/agents/:id/send", {
  body: z.object({ text: z.string().trim().min(1).max(200000) }),
  response: SendAck,
});
define("POST", "/api/agents/:id/interrupt", {
  body: z.object({}),
  response: InterruptAck,
});
define("GET", "/api/agents/:id/messages", {
  response: Messages,
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
define("GET", "/api/agents/:id/live", {
  summary:
    "SSE JSON events; access_lost ends the stream and snapshot replaces the previous messages",
  contentType: "text/event-stream",
  events: {
    snapshot: Messages,
    access: AccessDecision,
    online: z.object({}).strict(),
    offline: z.object({ error: z.string() }),
    access_lost: DomainErrorResponse,
  },
  statuses: [200, 400, 401, 403, 404, 500, 503],
});
define("PUT", "/api/agents/:id/shares/:userId", {
  summary: "Owner grants or revokes explicit agent access",
  body: z.object({ role: Role.nullable() }).strict(),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/api/resources/:kind/:id/invitations", {
  summary: "Issue recipient-bound Computer access; Hub invitations require a Member invitation link",
  body: InvitationRequest,
  response: z.object({ id: Id, token: z.string() }),
  statuses: [200, 400, 401, 403, 404, 409, 500],
});
for (const path of ["/api/invitations/accept", "/api/v1/invitations/accept"])
  define("POST", path, {
    summary: "Accept a single-use invitation with a matching verified identity",
    body: z.object({ token: z.string().min(32).max(256) }),
    statuses: [200, 400, 401, 403, 404, 409, 500],
  });
define("PUT", "/api/resources/:kind/:id/policy", {
  summary: "Owner changes retention policy",
  body: z.object({ policy: Policy.nullable() }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/api/resources/:kind/:id/owner", {
  summary: "Transfer a resource to an eligible current member",
  body: z.object({ ownerId: Id }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("GET", "/api/computers/:id/workspace", {
  summary:
    "Computer owner inspects approved workspace roots without credentials",
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
define("PUT", "/api/computers/:id/workspace", {
  summary: "Owner edits a root after native canonical-path checks",
  body: z
    .object({
      id: Id.optional(),
      name: Name.optional(),
      path: z.string().min(1).max(4000).optional(),
      remove: z.boolean().optional(),
    })
    .strict(),
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
for (const method of ["GET", "PUT"])
  details[method + " /api/computers/:id/workspace"]!.response =
    WorkspaceSnapshot;
define("GET", "/api/computers/:id/launch-defaults", {
  summary: "Current native producer launch choices; credentials are excluded",
  response: z.object({
    new_session_defaults: LaunchDefaults,
    recent_cwds: z.array(z.string()),
    tmux_available: z.literal(false),
  }),
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
define("GET", "/api/computers/:id/discovered", {
  summary: "Owner inspects native sessions not yet published on this Hub",
  response: z.array(Session),
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
details["GET /api/computers/:id/resume-candidates"]!.response =
  ResumeCandidates;
define("GET", "/api/v1/computers/:computerId/api/sessions", {
  summary:
    "Authorized current-native session catalog; defaults are empty when no agents are visible",
  response: Catalog,
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
define("PUT", "/api/computers/:id/workspace-access/:userId", {
  summary:
    "Owner grants approved paths and explicit Git/upload/transcode capabilities to an active member",
  body: workspaceGrant,
  response: ok,
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
define("POST", "/api/v1/computers/:computerId/api/sessions", {
  summary:
    "Create a native Pi, Codex or Claude session using explicit launch settings",
  body: Launch.extend({
    agent_backend: Agent.shape.backend,
    name: Name.optional(),
  }).strict(),
  statuses: [200, 400, 401, 403, 404, 409, 500, 503],
});
details["POST /api/v1/computers/:computerId/api/sessions"]!.response = z.object(
  {
    ok: z.literal(true),
    session_id: z.string().nullable(),
    agent_id: Id,
    broker_pid: z.number().int().positive().optional(),
  },
);
define("GET", "/api/v1/computers/:computerId/api/notifications/feed", {
  summary:
    "Authorized native completions, rechecked against current published agents",
  query: z.object({
    since: z.coerce.number().finite().nonnegative().default(0),
  }),
  response: HubNotificationFeed,
  statuses: [200, 400, 401, 403, 404, 500, 502, 503],
});
define("POST", "/api/v1/computers/:computerId/api/sessions/:localId/delete", {
  summary:
    "Owner deletes the local session; catalog removal follows confirmed deletion",
  body: z.object({}),
  response: ok,
  statuses: [200, 400, 401, 403, 404, 500, 503],
});
define("GET", "/api/v1/push/subscriptions", {
  summary:
    "Public VAPID configuration and account-scoped subscription metadata; capabilities stay private",
  response: publicConfig,
  statuses: [200, 401, 403, 500],
});
define("POST", "/api/v1/push/subscriptions", {
  summary:
    "Register Harmony or encrypted Web Push for the current account, session and Computer binding",
  body: z.union([harmony, WebPushRegistration]),
  response: z.object({ ok: z.literal(true), registered: z.literal(true) }),
  statuses: [200, 400, 401, 403, 404, 429, 500, 503],
});
define("DELETE", "/api/v1/push/subscriptions", {
  summary:
    "Remove all notification leases for the current authenticated session",
  response: ok,
  statuses: [200, 401, 403, 500],
});
define("DELETE", "/api/v1/push/subscriptions/:installationId/:computerId", {
  summary: "Remove one account-scoped Computer installation",
  response: ok,
  statuses: [200, 400, 401, 403, 500],
});
define("POST", "/api/v1/push/authorize", {
  summary:
    "Recheck current identity, binding, agent access and subscription generation before browser show/click",
  body: pushAuthorization,
  response: ok,
  statuses: [200, 400, 401, 403, 404, 500],
});
define("GET", "/api/v1/computers/:computerId/api/notifications/subscription", {
  summary:
    "Compatibility snapshot; Web Push uses the Hub-owned /api/v1/push routes",
  response: z.object({
    ok: z.literal(true),
    subscriptions: z.array(z.unknown()),
    vapid_public_key: z.literal(""),
    web_push_configured: z.literal(false),
  }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("GET", "/api/v1/computers/:computerId/api/notifications/harmony", {
  summary: "Configured Harmony provider capability",
  response: z.object({
    ok: z.literal(true),
    configured: z.boolean(),
    test_message: z.boolean(),
    reason: z.string(),
  }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/api/v1/computers/:computerId/api/notifications/harmony", {
  summary:
    "Compatibility installation register/remove; Hub derives account scope",
  body: z.object({
    device_id: Id,
    token: z.string().max(4096).default(""),
    enabled: z.boolean(),
    server: z.string().max(2000).optional(),
  }),
  response: z.object({ ok: z.literal(true), registered: z.boolean() }),
  statuses: [200, 400, 401, 403, 404, 500, 503],
});
define("POST", "/api/v1/downloads/prepare", {
  summary:
    "Mint a two-minute one-use download ticket for the current identity, binding and file grant",
  body: z.object({ agentId: Id, query: z.string().max(7000) }).strict(),
  response: z.object({
    action: z.url(),
    ticket: z.string().min(32),
    expiresIn: z.literal(120),
  }),
  statuses: [200, 400, 401, 403, 404, 409, 429, 500, 503],
});
define("POST", "/api/v1/downloads/consume", {
  auth: "download-ticket",
  summary:
    "Consume a one-use ticket in a form POST; Origin:null from the no-referrer form is accepted only with this ticket. No URL credential, cookie requirement or buffered file",
  body: z.object({ ticket: z.string().min(32).max(200) }).strict(),
  requestContentType: "application/x-www-form-urlencoded",
  contentType: "*/*",
  statuses: [200, 206, 400, 403, 404, 409, 410, 413, 416, 500, 503],
});
define("GET", "/connect/v1/computers/:id", {
  auth: "computer",
  summary:
    "Computer-authenticated WebSocket; exact Hub and protocol-major headers are required",
  websocket: true,
  statuses: [101, 400, 401, 403, 404, 426, 500],
});
define("POST", "/connect/v1/computers/:id/authorize-queue", {
  auth: "computer",
  summary:
    "Computer rechecks a current queue permit before atomic idle-only dispatch",
  body: z.object({ permit: z.string().max(200), localId: z.string().max(200) }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/connect/v1/computers/:id/detach", {
  auth: "computer",
  summary: "Commit credential/binding invalidation before cross-Hub enrollment",
  body: z.object({ transferId: Id }),
  response: detach,
  statuses: [200, 400, 401, 403, 404, 500],
});
define("GET", "/api/v1/auth/options", {
  auth: "public",
  summary: "This authority's configured authentication methods",
  statuses: [200, 500],
});
define("GET", "/api/v1/me", {
  summary: "Current independent account and linked identities",
  response: z.object({
    id: Id,
    name: Name,
    email: z.email(),
    context: z.unknown(),
    identities: z.array(z.unknown()),
  }),
  statuses: [200, 401, 403, 404, 500],
});
define("GET", "/initialize", {
  auth: "public", summary: "Bind a private one-time initialization link to provider sign-in",
  contentType: "text/html",
  query: z.object({ token: z.string().min(32).max(256), continue: z.string().max(4096).optional() }),
  statuses: [302, 400, 403, 429, 500],
});

define("POST", "/api/v1/hub-token", {
  summary: "Issue a five-minute token whose audience is exactly one Hub",
  body: z.object({ hubId: Id }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/api/v1/hubs", {
  summary:
    "Shared-authority compatibility only; independent Hubs reject creating another Hub",
  body: z.object({ name: Name }),
  response: Hub,
  statuses: [200, 400, 401, 403, 500],
});
define("POST", "/api/v1/hubs/:id/computers", {
  summary: "Owner creates a Computer and an enrollment code",
  body: z.object({ name: Name }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/api/v1/hubs/:id/register", {
  summary: "Shared-authority compatibility only; owner registers a Hub origin",
  body: z.object({ origin: z.url() }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("PUT", "/api/v1/hubs/:id/auth-requirement", {
  summary:
    "Owner changes authentication policy after proving its required context",
  body: z.object({ rule: AuthRequirement.nullable() }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("GET", "/api/v1/hubs/:id/login-methods", {
  summary: "Hub owner reads configured and allowed account types",
  statuses: [200, 400, 401, 403, 404, 500],
});
define("PUT", "/api/v1/hubs/:id/login-methods", {
  summary: "Hub owner selects allowed account types while retaining the acting proof type",
  body: HubLoginMethodsRequest,
  statuses: [200, 400, 401, 403, 404, 409, 500],
});
define("POST", "/api/v1/hubs/:id/admissions", {
  summary:
    "Target Hub owner issues a five-minute one-use shared-authority admission",
  body: z.object({ computerId: Id }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/api/v1/computers/:id/transfer", {
  summary:
    "Shared-authority compatibility transfer; independent transfer uses two-phase detach/redeem",
  body: z.object({
    targetHubId: Id,
    exposeHistory: z.boolean(),
    admissionToken: z.string().optional(),
  }),
  statuses: [200, 400, 401, 403, 404, 409, 500],
});
define("POST", "/api/v1/pairing/redeem", {
  auth: "public",
  summary:
    "Redeem a current owner-issued single-use enrollment code; rate limit 30/min/IP",
  body: transferCode,
  statuses: [200, 400, 403, 404, 429, 500],
});
define("POST", "/api/v1/pairing/inspect-transfer", {
  auth: "public",
  summary:
    "Read target attachment metadata for a valid 15-minute pairing code; rate limit 30/min/IP shared with redeem",
  body: transferCode,
  response: z.object({
    hubUrl: z.url(),
    hubId: Id,
    computerId: Id,
    binding,
    expiresAt: timestamp,
  }),
  statuses: [200, 400, 403, 404, 429, 500],
});
define("POST", "/api/v1/pairing/redeem-transfer", {
  auth: "public",
  summary:
    "Consume target admission with pre-generated credential and nonce; exact replay returns the current receipt without returning a credential",
  body: transferRedeem,
  response: z.object({
    version: z.literal(1),
    hubUrl: z.url(),
    hubId: Id,
    computerId: Id,
    binding,
    transferId: Id,
  }),
  statuses: [200, 400, 403, 404, 429, 500],
});
define("GET", "/oauth/authorize", {
  auth: "public",
  summary:
    "Registered exact redirect URI, state and S256 PKCE; unauthenticated users see login",
  query: z.object({
    client_id: Id,
    redirect_uri: z.url(),
    state: z.string().min(16).max(256),
    code_challenge: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
    code_challenge_method: z.literal("S256"),
    response_type: z.literal("code"),
  }),
  contentType: "text/html",
  statuses: [200, 302, 400, 401, 403, 500],
});
define("POST", "/oauth/token", {
  auth: "public",
  summary: "PKCE code exchange or rotating refresh credential",
  body: z.union([
    z.object({
      grant_type: z.literal("authorization_code"),
      client_id: Id,
      redirect_uri: z.url(),
      code: z.string(),
      code_verifier: z.string().min(43).max(128),
      installation_id: Id.optional(),
    }),
    z.object({
      grant_type: z.literal("refresh_token"),
      refresh_token: z.string().min(32),
    }),
  ]),
  response: authTokens,
  statuses: [200, 400, 401, 403, 429, 500],
});
define("POST", "/oauth/revoke", {
  auth: "public",
  summary:
    "Revoke an installation using its refresh credential even after access expiry",
  body: z.object({ token: z.string().min(32).max(256) }),
  response: ok,
  statuses: [200, 400, 429, 500],
});
define("POST", "/internal/device", {
  auth: "hub-service",
  summary: "Hub service validates a current Computer credential",
  body: z.object({ hubId: Id, computerId: Id, credential: z.string() }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/internal/computer-detach", {
  auth: "hub-service",
  summary: "Hub service commits a nonce-bound Computer detachment",
  body: z.object({
    hubId: Id,
    computerId: Id,
    credential: z.string(),
    transferId: Id,
  }),
  response: detach,
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/internal/notification-authorize", {
  auth: "hub-service",
  summary:
    "Recheck current notification identity, binding and agent read access",
  body: z.object({
    hubId: Id,
    sessionId: Id,
    agentId: Id,
    computerId: Id,
    binding: z.number().int().nonnegative(),
  }),
  response: ok,
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/internal/download-authorize", {
  auth: "hub-service",
  summary:
    "Recheck the original download identity, binding and workspace grant",
  body: z
    .object({
      hubId: Id,
      sessionId: Id,
      agentId: Id,
      computerId: Id,
      binding,
      path: z.string().min(1).max(8000),
    })
    .strict(),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/internal/notification-target", {
  auth: "hub-service",
  summary:
    "Resolve a Computer-local completion to a published agent in its current binding",
  body: z.object({
    hubId: Id,
    computerId: Id,
    credential: z.string(),
    localId: z.string().min(1).max(200),
  }),
  statuses: [200, 400, 401, 403, 404, 500],
});
define("POST", "/internal/queue-authorize", {
  auth: "hub-service",
  summary: "Validate Computer credential and a persisted account queue permit",
  body: z.object({
    hubId: Id,
    computerId: Id,
    credential: z.string(),
    permit: z.string(),
    localId: z.string(),
  }),
  statuses: [200, 400, 401, 403, 404, 500],
});
for (const [path, body, response] of [
  ["/internal/delegation-authorize", DelegationAuthorityRequest, DelegationContextResponse],
  ["/internal/delegation-child-context", DelegationChildContextRequest, DelegationContextResponse],
  ["/internal/delegation-reserve", DelegationReserveRequest, Agent],
] as const) define("POST", path, { auth: "hub-service", body, response,
  summary: "Recheck initiating principal, same-Hub lineage and current Computer binding before delegated actions",
  statuses: [200, 400, 401, 403, 404, 409, 500] });
define("POST", "/internal/call", {
  auth: "hub-user",
  summary:
    "Authenticated Hub command dispatcher; requires service credential and user bearer together",
  body: z.object({
    op: z.string(),
    args: z.record(z.string(), z.unknown()).default({}),
  }),
  statuses: [200, 400, 401, 403, 404, 409, 500],
});
define("POST", "/internal/agent-result", {
  auth: "hub-service",
  summary:
    "Record an authorized launch outcome without erasing a recovered receipt",
  body: z.object({
    hubId: Id,
    agentId: Id,
    state: Agent.shape.state,
    localId: z.string().nullable(),
  }),
  response: ok,
  statuses: [200, 400, 401, 403, 404, 409, 500],
});
for (const method of ["GET", "HEAD"])
  define(method, "/api/sessions/{localId}/queue", {
    summary:
      "Account-fenced native and remote durable queue; permits and binding scope remain private",
    response: queueSnapshot,
    statuses: [200, 400, 401, 403, 404, 409, 500, 503],
  });
const queueText = z.string().trim().min(1).max(200000),
  version = z.number().int().nonnegative().optional();
for (const [operation, body] of Object.entries({
  enqueue: z.object({ text: queueText }),
  "queue/update": z.object({ id: z.string(), text: queueText, version }),
  "queue/delete": z.object({
    id: z.string(),
    version,
    allow_commit_unknown: z.boolean().optional(),
  }),
  "queue/move": z.object({
    id: z.string(),
    to_index: z.number().int().nonnegative(),
    version,
  }),
}))
  define("POST", "/api/sessions/{localId}/" + operation, {
    summary:
      "Mutate the displayed queue version; uncertain dispatch is a barrier and explicit removal needs allow_commit_unknown",
    body,
    response: queueSnapshot,
    statuses: [200, 400, 401, 403, 404, 405, 409, 413, 429, 500, 503],
  });

const publicPaths = new Set([
  "/health",
  "/api/v1/meta",
  "/api/auth/options",
  "/api/v1/auth/options",
  "/.well-known/jwks.json",
  "/auth/start",
  "/auth/callback",
  "/login",
  "/register",
  "/hub-login.js",
  "/account.js",
  "/cache-design",
  "/",
]);
function entry(method: string, path: string, websocket = false): Endpoint {
  const asset =
    path.startsWith("/appearance/") ||
    path.endsWith(".js") ||
    ["/", "/*", "/login", "/register", "/cache-design"].includes(path);
  const auth: EndpointAuth = path.startsWith("/internal/")
    ? "hub-service"
    : path.startsWith("/connect/")
      ? "computer"
      : publicPaths.has(path) || asset
        ? "public"
        : path.includes("*")
          ? "delegated"
          : "account";
  const key = method + " " + path;
  const detail = { ...details[key], ...adminDetails[key] };
  return {
    method,
    path,
    auth,
    summary: path.includes("*")
      ? "Registered forwarding or asset pattern; the inner router still enforces its exact method allowlist"
      : asset
        ? "Static presentation asset"
        : "Authenticated API; producer-specific response fields are described by its runtime",
    statuses:
      auth === "public" ? [200, 400, 404, 500] : [200, 400, 401, 403, 404, 500],
    ...(asset
      ? { contentType: path.endsWith(".js") ? "text/javascript" : "text/html" }
      : {}),
    ...(websocket ? { websocket: true } : {}),
    ...detail,
  };
}
export function registeredContract(component: "hub" | "identity"): Endpoint[] {
  const registered =
    component === "hub" ? hubRegisteredEndpoints : identityRegisteredEndpoints;
  return registered.flatMap((route) =>
    route.methods.map((method) => entry(method, route.path, route.websocket)),
  );
}
const forwarded = [
  "/initialize",
  "/api/v1/computers/:id/allowlist",
  "/api/v1/auth/",
  "/api/v1/me",
  "/api/v1/hub-token",
  "/api/v1/invitations/accept",
  "/api/v1/hubs",
  "/api/v1/pairing/",
  "/api/v1/computers/:id/transfer",
  "/oauth/",
  "/auth/:connection/",
  "/.well-known/jwks.json",
  "/account.js",
  "/appearance/",
];
const forwardedPath = (path: string) =>
  forwarded.some(
    (prefix) =>
      path === prefix ||
      path.startsWith(prefix.endsWith("/") ? prefix : prefix + "/"),
  );
export function publicContract(component: "hub" | "identity"): Endpoint[] {
  const base = registeredContract(component).filter(
    (e) => !e.path.startsWith("/internal/") && !e.path.includes("*"),
  );
  if (component === "hub")
    for (const e of registeredContract("identity"))
      if (
        forwardedPath(e.path) &&
        !e.path.includes("*") &&
        !base.some((b) => b.method === e.method && b.path === e.path)
      )
        base.push({
          ...e,
          conditional: "Independent Hub local identity routes",
        });
  // Remove the outer forwarding router's permissive registration methods. The
  // actual authority supports only its registered leaf methods at these paths.
  if (component === "hub")
    return base.filter(
      (e) =>
        !forwardedPath(e.path) ||
        registeredContract("identity").some(
          (i) => i.path === e.path && i.method === e.method,
        ),
    );
  return base;
}
export function relayContract(): Endpoint[] {
  return relayEndpointInventory().map((e) => ({
    method: e.method,
    path: e.path,
    auth: "account",
    summary: "Current-native Computer relay: " + e.action,
    action: e.action,
    statuses: [200, 400, 401, 403, 404, 409, 413, 429, 500, 502, 503],
    ...nativeDetail(e.method, e.path),
    ...(details[e.method + " " + e.path] ?? {}),
  }));
}
export const registeredInventory = {
  hub: hubRegisteredEndpoints,
  identity: identityRegisteredEndpoints,
};
