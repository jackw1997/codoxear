import { z } from "zod";

// Provider adapters define available types; the policy does not hardcode them.
export const HubLoginMethod = z.string().regex(/^[a-z][a-z0-9_-]{0,79}$/);
export const HubLoginMethodsRequest = z.object({
  allowedMethods: z.array(HubLoginMethod).min(1).max(80)
    .refine((methods) => new Set(methods).size === methods.length, "Duplicate login method"),
}).strict();
export const HubLoginMethodsSummary = z.object({
  availableMethods: z.array(HubLoginMethod),
  allowedMethods: z.array(HubLoginMethod),
}).strict();

export const HubOrganization = z.object({
  hubId: z.string().regex(/^[A-Za-z0-9_-]{1,100}$/),
  feishuConnection: z.string().min(1).max(80).nullable(),
  feishuTenant: z.string().trim().min(1).max(200).nullable(),
  // null means the owner has not narrowed the configured provider types.
  allowedMethods: z.array(HubLoginMethod).min(1).max(80).nullable().default(null),
});
export const HubOrganizationSummary = z.object({
  feishuTenant: z.string().nullable(), tenantBindingRequired: z.boolean(),
}).strict();
