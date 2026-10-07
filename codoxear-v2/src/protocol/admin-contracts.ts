/** Exact administrative/account successes. Dispatcher results are unwrapped;
 * clients select the corresponding response schema by their request's op. */
import { z } from "zod";
import { Agent, Action, Computer, Hub, Id, Invitation, Membership, Name, Policy, Role } from "../contracts/model.js";
import { AuthRequirement, ExternalIdentity, LoginContext } from "../contracts/identity.js";
import { InvitationRequest } from "../contracts/invitations.js";
import { GrantPath, WorkspaceContext, WorkspaceOptions } from "../contracts/workspaces.js";
import { PAIRING_LIFETIME_SECONDS } from "../contracts/pairing.js";
import { AccessDecision } from "./native-contracts.js";
import type { Endpoint } from "./inventory.js";
const positive = z.number().int().positive(), count = z.number().int().nonnegative(), timestamp = z.number().nonnegative();
const secret = z.string().min(32), text = z.string();
export const AdminOk = z.object({ ok: z.literal(true) }).strict();
export const AdminHealth = z.union([z.object({ ok: z.literal(true), service: z.literal("identity"), protocol: z.literal(1) }).strict(), z.object({ ok: z.literal(true), service: z.literal("hub"), hubId: Id }).strict()]);
export const AccountSummary = z.object({ id: Id, name: text, email: z.email() }).strict();
export const AccountProfile = AccountSummary.extend({
  context: LoginContext,
  identities: z.array(ExternalIdentity.pick({ id: true, connection: true, method: true, subject: true, tenant: true }).strict()),
}).strict();
export const AuthOptions = z.object({
  providers: z.array(z.object({ id: Id, method: z.enum(["google", "feishu"]) }).strict()),
  registration: z.object({ enabled: z.boolean(), method: z.literal("provider") }).strict(),
  deviceKeys: z.object({ enabled: z.literal(true), algorithm: z.literal("ES256") }).strict(),
  setupRequired: z.boolean(),
}).strict();
export const AuthChallenge = z.object({ challengeId: Id, transaction: secret, expiresAt: timestamp }).strict();
export const HubDirectory = z.array(Hub.extend({ origin: z.url().nullable(), access: z.enum(["allowed", "reauthentication_required"]), loginRequirement: AuthRequirement.nullable() }).strict());
export const ComputerDirectoryEntry = z.object({
  id: Id, name: text, hubId: Id, ownerId: Id, ownerName: text.optional(), policy: Policy.nullable(), binding: positive,
  canCreate: z.boolean(), membership: Role.nullable(), effectivePolicy: z.object({ policy: Policy, source: z.enum(["hub", "computer", "default"]) }).strict(),
}).strict();
export const ComputerDirectory = z.array(ComputerDirectoryEntry);
export const OnlineComputers = z.array(ComputerDirectoryEntry.extend({ online: z.boolean() }).strict());
export const AccountComputers = z.array(z.object({ id: Id, hubId: Id, name: text, binding: positive, ownerId: Id, hubName: text }).strict());
export const ActorWorkspaceGrant = z.object({
  workspaceId: Id, access: z.enum(["read", "write"]), paths: z.array(GrantPath), git: z.boolean(), uploads: z.boolean(), transcode: z.boolean(), grantRevision: Id,
}).strict();
export const MemberWorkspaceGrant = ActorWorkspaceGrant.extend({ computerId: Id, userId: Id, binding: positive, ownerRevision: count }).strict();
export const ResourceMembers = z.array(Membership.extend({
  name: text.optional(), email: z.email().optional(), workspaceAccess: z.enum(["read", "write"]).nullable(), workspaceGrants: z.array(MemberWorkspaceGrant),
}).strict());
export const AgentShares = z.object({ members: z.array(z.object({ userId: Id, name: text, computerRole: Role.nullable(), access: AccessDecision, role: Role.nullable() }).strict()) }).strict();
export const AgentShareResult = AdminOk.extend({ access: AccessDecision }).strict();
export const AuthorizedAgent = z.object({ agent: Agent, access: AccessDecision, actorId: Id, revision: count, leaseExpiresAt: timestamp }).strict();
export const AuthorizedAgents = z.array(Agent.extend({ access: AccessDecision, workspaceGrants: z.array(ActorWorkspaceGrant) }).strict());
export const AgentDirectory = z.object({
  agents: z.array(Agent.extend({ computerName: text, hubName: text, origin: z.url(), access: AccessDecision.shape.mode, workspaceGrants: z.array(ActorWorkspaceGrant) }).strict()),
  placements: z.array(z.object({ computerId: Id, computerName: text, hubId: Id, hubName: text, origin: z.url() }).strict()),
}).strict();
export const PairingReceipt = z.object({ code: text.min(8), computerId: Id, hubId: Id, expiresIn: z.literal(PAIRING_LIFETIME_SECONDS), expiresAt: timestamp }).strict();
export const ComputerCreated = z.object({ computer: z.object({ id: Id, name: text, hubId: Id, ownerId: Id }).strict(), pairing: PairingReceipt.nullable() }).strict();
export const ComputerEnrollment = z.object({ computer: z.object({ id: Id, name: text, hubId: Id }).strict(), enrollment: z.object({ identityUrl: z.url(), code: text.min(8) }).strict() }).strict();
export const HubToken = z.object({ accessToken: text.min(1), expiresIn: z.literal(300), hubId: Id, origin: z.url() }).strict();
export const RegisteredHub = z.object({ hubId: Id, origin: z.url(), credential: secret }).strict();
export const Admission = z.object({ token: secret, computerId: Id, targetHubId: Id, expiresIn: z.literal(300) }).strict();
export const SharedTransfer = z.object({ computerId: Id, oldHubId: Id, hubId: Id, binding: positive }).strict();
export const DeviceBinding = z.object({ computerId: Id, hubId: Id, binding: positive }).strict();
export const EnrolledComputer = DeviceBinding.extend({ version: z.literal(1), hubUrl: z.url(), credential: secret }).strict();
export const NotificationTarget = DeviceBinding.extend({ agentId: Id.nullable() }).strict();
const routeAction = z.enum(["read", "send", "interrupt", "files.read", "files.write", "session.delete"]);
export const RelayAuthorization = z.union([
  AuthorizedAgent.extend({ action: routeAction, actorIsOwner: z.boolean(), workspace: WorkspaceContext.optional() }).strict(),
  z.object({ actorId: Id, actorIsOwner: z.literal(true), action: z.literal("computer.admin"), revision: count, leaseExpiresAt: timestamp }).strict(),
]);
export const QueuePermit = z.object({ actorId: Id, queuePermit: secret }).strict();
export const PublicSigningKeys = z.object({ keys: z.array(z.object({ kty: z.literal("OKP"), crv: z.literal("Ed25519"), x: text.min(1), kid: text.min(1), alg: z.literal("EdDSA"), use: z.literal("sig") }).strict()) }).strict();
const resourceArgs = z.object({ kind: z.enum(["hub", "computer"]), id: Id });
const empty = z.object({}).describe("No operation arguments are used.");
const operation = (request: z.ZodType, response: z.ZodType) => ({ request, response });
export const adminOperationSchemas: Record<string, { request: z.ZodType; response: z.ZodType }> = {
  "notification-session": operation(empty, z.object({ id: Id, sessionId: Id }).strict()),
  "notification-subject": operation(z.object({ computerId: Id }), z.object({ userId: Id, sessionId: Id, binding: positive }).strict()),
  "queue-permit": operation(z.object({ computerId: Id, path: text }), QueuePermit),
  relay: operation(z.object({ computerId: Id, method: text, path: text }), RelayAuthorization),
  me: operation(empty, AccountSummary), hub: operation(empty, Hub), computers: operation(empty, ComputerDirectory),
  "computer-owner": operation(z.object({ computerId: Id }), Computer),
  "import-agent": operation(z.object({ computerId: Id, localId: text.min(1).max(200), name: Name, backend: Agent.shape.backend }), Agent),
  agents: operation(z.object({ computerId: Id }), AuthorizedAgents),
  authorize: operation(z.object({ agentId: Id, action: Action }), AuthorizedAgent),
  "create-agent": operation(z.object({ computerId: Id, name: Name, backend: Agent.shape.backend }), Agent),
  "forget-deleted-agent": operation(z.object({ computerId: Id, localId: text.regex(/^[A-Za-z0-9_.:-]{1,200}$/) }), AdminOk),
  "create-computer": operation(z.object({ name: Name, ownerId: Id.optional() }), ComputerCreated),
  pair: operation(z.object({ computerId: Id }), PairingReceipt),
  accept: operation(z.object({ token: text }), Invitation),
  members: operation(resourceArgs, ResourceMembers),
  "agent-shares": operation(z.object({ agentId: Id }), AgentShares),
  "agent-share": operation(z.object({ agentId: Id, userId: Id, role: Role.nullable() }).strict(), AgentShareResult),
  "workspace-access": operation(z.object({ computerId: Id, userId: Id, access: z.enum(["read", "write"]).nullable(), ...WorkspaceOptions.shape }), AdminOk),
  invite: operation(z.union(InvitationRequest.options.map(schema => schema.extend(resourceArgs.shape))), z.object({ token: secret, id: Id }).strict()),
  remove: operation(resourceArgs.extend({ memberId: Id }), AdminOk),
  policy: operation(resourceArgs.extend({ policy: Policy.nullable() }), AdminOk),
  owner: operation(resourceArgs.extend({ ownerId: Id }), z.union([Hub, Computer])),
};
const noArguments = new Set(["notification-session", "me", "hub", "computers"]);
export const InternalCallRequest = z.union(Object.entries(adminOperationSchemas).map(([op, schemas]) => z.object({ op: z.literal(op), args: noArguments.has(op) ? schemas.request.optional() : schemas.request })));
export const InternalCallSuccess = z.union(Object.values(adminOperationSchemas).map(schemas => schemas.response)).describe("Unwrapped dispatcher result. Select the exact response by the request op using x-dispatch-operation-schemas; authentication and operation failures use the documented error status schemas.");
export const adminSchemas: Record<string, z.ZodType> = {
  AdminOk, AdminHealth, AccountSummary, AccountProfile, AuthOptions, AuthChallenge, HubDirectory, ComputerDirectoryEntry, ComputerDirectory, OnlineComputers, AccountComputers,
  ActorWorkspaceGrant, MemberWorkspaceGrant, ResourceMembers, AgentShares, AgentShareResult, AuthorizedAgent, AuthorizedAgents, AgentDirectory,
  PairingReceipt, ComputerCreated, ComputerEnrollment, HubToken, RegisteredHub, Admission, SharedTransfer, DeviceBinding, EnrolledComputer, NotificationTarget, RelayAuthorization, QueuePermit, PublicSigningKeys, InternalCallRequest, InternalCallSuccess,
};
export const adminDetails: Record<string, Partial<Omit<Endpoint, "method" | "path">>> = {
  "GET /health": { response: AdminHealth },
  "GET /oauth/authorize": { statuses: [302, 400, 401, 403, 500] },
  "GET /api/v1/auth/options": { response: AuthOptions },
  "GET /api/v1/me": { response: AccountProfile },
  "DELETE /api/v1/me/identities/:id": { response: AdminOk },
  "POST /api/v1/me/agents": { body: undefined, response: AgentDirectory, summary: "Read the current account's authorized agent directory; this POST does not create an agent." },
  "GET /api/v1/me/hubs": { response: HubDirectory },
  "GET /api/v1/me/computers": { response: AccountComputers },
  "POST /api/v1/hub-token": { response: HubToken },
  "POST /api/v1/hubs/:id/computers": { response: ComputerEnrollment },
  "POST /api/v1/hubs/:id/register": { response: RegisteredHub },
  "PUT /api/v1/hubs/:id/auth-requirement": { response: AdminOk },
  "POST /api/v1/hubs/:id/admissions": { response: Admission },
  "POST /api/v1/computers/:id/transfer": { response: SharedTransfer },
  "POST /api/v1/pairing/redeem": { response: EnrolledComputer },
  "POST /api/v1/invitations/accept": { response: Invitation },
  "GET /api/me": { response: AccountSummary },
  "GET /api/hubs": { response: z.array(Hub) },
  "GET /api/hubs/:id/computers": { response: OnlineComputers },
  "GET /api/v1/computers": { response: OnlineComputers },
  "POST /api/hubs/:id/computers": { response: ComputerCreated.extend({ identityUrl: z.url() }).strict() },
  "GET /api/v1/computers/:computerId/api/me": { response: z.object({ ok: z.literal(true), user: AccountSummary, hub_id: Id, computer_id: Id }).strict() },
  "GET /api/agents/:id/shares": { response: AgentShares },
  "PUT /api/agents/:id/shares/:userId": { response: AgentShareResult },
  "GET /api/resources/:kind/:id/members": { response: ResourceMembers },
  "DELETE /api/resources/:kind/:id/members/:memberId": { response: AdminOk },
  "PUT /api/resources/:kind/:id/policy": { response: AdminOk },
  "POST /api/resources/:kind/:id/owner": { response: z.union([Hub, Computer]) },
  "POST /api/invitations/accept": { response: Invitation },
  "POST /internal/device": { response: DeviceBinding },
  "POST /internal/notification-target": { response: NotificationTarget },
  "POST /internal/download-authorize": { response: RelayAuthorization },
  "POST /internal/queue-authorize": { response: RelayAuthorization },
  "POST /connect/v1/computers/:id/authorize-queue": { response: RelayAuthorization },
  "POST /internal/call": { body: InternalCallRequest, response: InternalCallSuccess },
  "GET /.well-known/jwks.json": { response: PublicSigningKeys },
  "GET /agent-settings/": { query: z.object({ settings: Id }), contentType: "text/html", response: text },
  "GET /management-assets/:file": { auth: "public", responseContents: { "text/css": text, "text/javascript": text } },
};
for (const path of ["/appearance/app.css", "/appearance/connections.css", "/appearance/shell.css", "/appearance/themes/clay.css", "/appearance/themes/paper.css", "/appearance/themes/slate.css"]) adminDetails["GET " + path] = { contentType: "text/css", response: text };
adminDetails["GET /appearance/favicon.svg"] = { contentType: "image/svg+xml", response: text };
adminDetails["GET /appearance/app_theme.js"] = { contentType: "text/javascript", response: text };
