import { z } from "zod";
// Keep this leaf contract independent of model, which embeds identity grants.
const Id = z.string().regex(/^[a-zA-Z0-9_-]{1,100}$/);
export const GrantPath = z.string().min(1).max(4096).refine((path) =>
  path === "." || (!path.startsWith("/") && !path.includes("\\") && !path.includes("\0") && path.split("/").every((p) => p !== ".." && p !== "." && p !== "")),
  "Use a relative file or directory path without traversal");
export const WorkspaceOptions = z.object({
  workspaceId: Id.default("default"),
  paths: z.array(GrantPath).min(1).max(100).default(["."]),
  git: z.boolean().default(false),
  uploads: z.boolean().default(false),
  transcode: z.boolean().default(false),
});
export const WorkspaceContext = z.object({
  id: Id,
  access: z.enum(["read", "write"]),
  paths: z.array(GrantPath).min(1).max(100).optional(),
  git: z.boolean().optional(),
  uploads: z.boolean().optional(),
  transcode: z.boolean().optional(),
  binding: z.number().int().positive().optional(),
  ownerRevision: z.number().int().nonnegative().optional(),
  grantRevision: Id.optional(),
});
export type WorkspaceContext = z.infer<typeof WorkspaceContext>;
export const WorkspaceEdit = z.object({
  id: Id.optional(), name: z.string().min(1).max(120).optional(),
  path: z.string().min(1).max(4096).optional(), remove: z.boolean().optional(),
});
