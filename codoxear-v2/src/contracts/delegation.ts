import { z } from "zod";
import { Id, Name, type Agent } from "./model.js";
import { Launch, Message } from "./tunnel.js";

/** Delegation names an approved Computer in the parent's Hub, never a URL. */
export const DelegationGrantRequest = z
  .object({
    targetComputerIds: z.array(Id).min(1).max(32),
    ttlSeconds: z.number().int().min(30).max(3600).default(900),
  })
  .strict();
export const DelegationSpawn = z
  .object({
    requestId: Id,
    targetComputerId: Id,
    name: Name,
    backend: z.enum(["codex", "pi", "cc"]),
    launch: Launch.strict().optional(),
  })
  .strict();
export type DelegationSpawn = z.infer<typeof DelegationSpawn>;
export const DelegationSend = z
  .object({
    text: z.string().min(1).max(200_000),
  })
  .strict();
export const DelegationReceipt = z.object({
  requestId: Id,
  parentId: Id,
  childId: Id,
  targetComputerId: Id,
  depth: z.number().int().min(1).max(16),
  state: z.enum(["reserved", "dispatching", "unknown", "ready", "failed"]),
  localId: z.string().nullable(),
  error: z.string().optional(),
  delegationState: z
    .enum(["pending", "installed", "unavailable", "unknown"])
    .optional(),
  delegationError: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type DelegationReceipt = z.infer<typeof DelegationReceipt>;
export const DelegationMessages = z.object({
  messages: z.array(Message).max(512),
  truncated: z.boolean(),
});
export interface DelegationGrant {
  id: string;
  actorId: string;
  identitySessionId: string;
  parentId: string;
  hubId: string;
  sourceComputerId: string;
  sourceBinding: number;
  targetComputerIds: string[];
  expiresAt: number;
  depth: number;
  ancestorParentIds: string[];
  installedAt?: number;
}
export interface DelegationContext {
  actorId: string;
  identitySessionId: string;
  parent: Agent;
  target: { id: string; hubId: string; name?: string };
  sourceBinding: number;
}
export type DelegationParentContext = Omit<DelegationContext, "target">;
export interface DelegationAuthorization {
  identitySessionId: string;
  actorId: string;
  parentId: string;
  targetComputerId: string;
  sourceComputerId: string;
  sourceBinding: number;
  action: "create" | "read" | "send" | "interrupt";
  childId?: string | undefined;
  launch?: DelegationSpawn["launch"];
}
