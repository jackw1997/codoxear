import { z } from "zod";
import { Id } from "./model.js";
import { WorkspaceEdit } from "./workspaces.js";
export const Message = z.object({
  id: z.string(),
  role: z.enum(["user", "assistant", "system"]),
  text: z.string(),
  at: z.number(),
});
export type Message = z.infer<typeof Message>;
export const LaunchResult = z.object({
  localId: z.string().min(1).max(200),
  brokerPid: z.number().int().positive().optional(),
});
export const LaunchReceipt = z.discriminatedUnion("state", [
  z.object({ state: z.literal("unknown") }),
  z.object({ state: z.literal("ready"), result: LaunchResult }),
]);
export const ProviderConfig = z
  .object({
    base_url: z.string().url().max(4096).optional(),
    api_key: z.string().min(1).max(8192).meta({ writeOnly: true }),
    api: z
      .enum(["openai-completions", "openai-responses", "anthropic-messages"])
      .optional(),
    image_support: z.boolean().optional(),
  })
  .strict();
export const ProviderCatalogRequest = z
  .object({
    backend: z.enum(["pi", "codex", "cc"]),
    api: ProviderConfig.shape.api,
    provider: z.string().min(1).max(200).optional(),
    base_url: z.string().url().max(4096).optional(),
    api_key: z.string().min(1).max(8192).meta({ writeOnly: true }).optional(),
  })
  .strict()
  .refine(
    (x) =>
      x.provider ? !x.base_url && !x.api_key : !!x.base_url && !!x.api_key,
    "Choose a configured provider or supply an endpoint and key",
  );
export const ProviderCatalog = z
  .object({
    models: z
      .array(
        z
          .object({
            id: z.string().min(1).max(200),
            supports_reasoning: z.boolean().nullable(),
            runtime_reasoning_efforts: z
              .array(z.string().min(1).max(100))
              .max(32)
              .optional(),
            supported_reasoning_efforts: z
              .array(z.string().min(1).max(100))
              .max(32)
              .nullable(),
          })
          .strict(),
      )
      .max(1000),
    metadata_available: z.boolean(),
  })
  .strict();
export const Launch = z.object({
  provider_catalog: z.literal(true).optional(),
  provider_config: ProviderConfig.optional(),
  env_vars: z
    .record(
      z
        .string()
        .regex(/^[A-Za-z_][A-Za-z0-9_]*$/)
        .max(200),
      z.string().max(8192),
    )
    .refine((v) => Object.keys(v).length <= 64)
    .optional(),
  command: z.string().min(1).max(4096).optional(),
  cwd: z.string().min(1).max(4096).optional(),
  model: z.string().max(200).optional(),
  model_provider: z.string().max(200).optional(),
  preferred_auth_method: z.string().max(100).optional(),
  service_tier: z.string().max(100).optional(),
  reasoning_effort: z.string().max(100).optional(),
  resume_session_id: z.string().max(200).nullable().optional(),
  worktree_branch: z.string().max(200).nullable().optional(),
  create_in_tmux: z.literal(false).optional(),
});
export const Operation = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("provider-catalog"),
    input: ProviderCatalogRequest,
  }),
  z.object({
    op: z.literal("delegation-install"),
    parentId: Id,
    localId: z.string().min(1).max(200),
    grant: z.string().min(32).max(200),
    expiresAt: z.number().int().positive(),
  }),
  z.object({
    op: z.literal("delegation-status"),
    parentId: Id,
    localId: z.string().min(1).max(200),
  }),
  z.object({
    op: z.literal("delegation-revoke"),
    parentId: Id,
    localId: z.string().min(1).max(200),
  }),
  z.object({ op: z.literal("discover"), actorId: Id.optional() }),
  z.object({ op: z.literal("workspace"), ...WorkspaceEdit.shape }),
  z.object({
    op: z.literal("resume-candidates"),
    backend: z.enum(["codex", "pi", "cc"]),
    cwd: z.string().min(1).max(4096),
  }),
  z.object({ op: z.literal("launch-status"), agentId: Id }),
  z.object({
    op: z.literal("create"),
    agentId: Id,
    backend: z.enum(["codex", "pi", "cc", "fixture"]),
    name: z.string().max(120),
    launch: Launch.optional(),
  }),
  z.object({
    op: z.literal("messages"),
    agentId: Id,
    localId: z.string().max(200),
  }),
  z.object({
    op: z.literal("send"),
    agentId: Id,
    localId: z.string().max(200),
    text: z.string().min(1).max(200_000),
  }),
  z.object({
    op: z.literal("interrupt"),
    agentId: Id,
    localId: z.string().max(200),
  }),
]);
export type Operation = z.infer<typeof Operation>;
export const RequestFrame = z.object({
  type: z.literal("request"),
  id: Id,
  epoch: Id,
  operation: Operation,
});
export const ResultFrame = z.object({
  type: z.literal("result"),
  id: Id,
  epoch: Id,
  ok: z.boolean(),
  value: z.unknown().optional(),
  error: z.string().max(1000).optional(),
  errorCode: z.enum(["not_dispatched", "setup_required"]).optional(),
});
export const WelcomeFrame = z.object({
  type: z.literal("welcome"),
  epoch: Id,
  protocol: z.literal(1),
  capabilities: z.array(z.string()).max(32).optional(),
});
export const MAX_FRAME_BYTES = 1024 * 1024;
