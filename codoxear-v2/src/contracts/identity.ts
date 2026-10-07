import { z } from "zod";
import { WorkspaceOptions } from "./workspaces.js";
import { HubOrganization } from "./hub-organization.js";
const Identifier = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const LoginMethod = z.enum([
  "password",
  "email",
  "phone",
  "feishu",
  "google",
  "wechat",
  "oidc",
]);
export const LoginContext = z.object({
  method: LoginMethod,
  identityId: Identifier.nullable(),
  tenant: z.string().nullable(),
  authenticatedAt: z.number(),
});
export type LoginContext = z.infer<typeof LoginContext>;
export const ExternalIdentity = z.object({
  id: Identifier,
  userId: Identifier,
  connection: z.string().min(1),
  method: LoginMethod,
  subject: z.string().min(1),
  tenant: z.string().nullable(),
  email: z.email().nullable(),
  verifiedAt: z.number(),
});
export type ExternalIdentity = z.infer<typeof ExternalIdentity>;
export const IdentitySession = z.object({
  id: Identifier,
  userId: Identifier,
  credentialHash: z.string(),
  context: LoginContext,
  expiresAt: z.number(),
  revoked: z.boolean(),
  installationId: Identifier,
  parentId: Identifier.optional(),
});
export type IdentitySession = z.infer<typeof IdentitySession>;
export const OtpChallenge = z.object({
  id: Identifier,
  transactionHash: z.string(),
  method: z.enum(["email", "phone"]),
  target: z.string(),
  codeHash: z.string(),
  expiresAt: z.number(),
  attempts: z.number(),
  used: z.boolean(),
  linkUserId: Identifier.nullable(),
  linkSessionId: Identifier.nullable(),
});
export const ProviderFlow = z.object({
  continuePath: z.string().optional(),
  initializationId: Identifier.optional(),
  id: Identifier,
  stateHash: z.string(),
  browserHash: z.string(),
  connection: z.string(),
  verifier: z.string(),
  expiresAt: z.number(),
  used: z.boolean(),
  linkUserId: Identifier.nullable(),
  linkSessionId: Identifier.nullable(),
});
export const Refresh = z.object({
  tokenHash: z.string(),
  familyId: Identifier,
  sessionId: Identifier,
  used: z.boolean(),
  expiresAt: z.number(),
});
export const AuthorizationCode = z.object({
  hash: z.string(),
  sessionId: Identifier,
  clientId: Identifier,
  redirectUri: z.string(),
  challenge: z.string(),
  expiresAt: z.number(),
  used: z.boolean(),
});
export const Pairing = z.object({
  codeHash: z.string(),
  computerId: Identifier,
  hubId: Identifier,
  ownerId: Identifier,
  issuerId: Identifier.optional(),
  binding: z.number(),
  expiresAt: z.number(),
  used: z.boolean(),
});
export const HubRegistration = z.object({
  hubId: Identifier,
  origin: z.url(),
  credentialHash: z.string(),
  enabled: z.boolean(),
});
export const AuthRequirement = z.object({
  method: LoginMethod,
  connection: z.string().optional(),
  tenant: z.string().optional(),
  maxAgeSeconds: z.number().int().min(60).max(86400).default(3600),
});
export type AuthRequirement = z.infer<typeof AuthRequirement>;
export const IdentityState = z.object({
  hubOrganizations: z.array(HubOrganization).default([]),
  initializations: z.array(z.object({
    id: Identifier, hubId: Identifier, tokenHash: z.string(), expiresAt: z.number(), consumedAt: z.number().nullable(),
  })).default([]),
  workspaceGrants: z.array(z.object({
    computerId: Identifier, userId: Identifier, ...WorkspaceOptions.shape,
    access: z.enum(["read", "write"]), binding: z.number().int().positive(), ownerRevision: z.number().int().nonnegative(),
    grantRevision: Identifier.default("legacy"),
  })).default([]),
  queuePermits: z
    .array(
      z.object({
        tokenHash: z.string(),
        sessionId: Identifier,
        hubId: Identifier,
        computerId: Identifier,
        localId: z.string(),
        binding: z.number(),
        expiresAt: z.number(),
      }),
    )
    .default([]),
  admissions: z
    .array(
      z.object({
        tokenHash: z.string(),
        computerId: Identifier,
        computerOwnerId: Identifier,
        targetHubId: Identifier,
        issuerId: Identifier,
        ownerRevision: z.number(),
        binding: z.number(),
        expiresAt: z.number(),
      }),
    )
    .default([]),
  computerDetachReceipts: z.array(z.object({
    computerId: Identifier, hubId: Identifier, transferId: Identifier,
    credentialHash: z.string(), fenceHash: z.string(), priorBinding: z.number().int().positive(),
    binding: z.number().int().positive(),
  })).default([]),
  transferEnrollments: z.array(z.object({
    codeHash: z.string(), transferId: Identifier, credentialHash: z.string(),
    computerId: Identifier, hubId: Identifier, binding: z.number().int().positive(),
  })).default([]),
  identities: z.array(ExternalIdentity).default([]),
  sessions: z.array(IdentitySession).default([]),
  refresh: z.array(Refresh).default([]),
  codes: z.array(AuthorizationCode).default([]),
  challenges: z.array(OtpChallenge).default([]),
  flows: z.array(ProviderFlow).default([]),
  pairings: z.array(Pairing).default([]),
  hubs: z.array(HubRegistration).default([]),
  requirements: z
    .array(z.object({ hubId: Identifier, rule: AuthRequirement }))
    .default([]),
  limits: z
    .array(z.object({ key: z.string(), count: z.number(), until: z.number() }))
    .default([]),
});
export type IdentityState = z.infer<typeof IdentityState>;
