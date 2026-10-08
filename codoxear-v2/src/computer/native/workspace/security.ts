import { AsyncLocalStorage } from "node:async_hooks";
import { relative, resolve, sep } from "node:path";
import type { FileHandle } from "node:fs/promises";
import { DomainError } from "../../../contracts/model.js";
import type { WorkspaceContext } from "../../../contracts/workspaces.js";
import type { WorkspaceRoot } from "./registry.js";
export const workspaceSecurity = new AsyncLocalStorage<{ root: WorkspaceRoot; grant: WorkspaceContext }>();
export function allowedPath(path: string) {
  const context = workspaceSecurity.getStore();
  if (!context) return true;
  const rel = relative(context.root.path, resolve(path));
  if (rel.split(sep).includes(".git")) return false;
  if (rel === ".." || rel.startsWith(".." + sep) || rel.startsWith(sep)) return false;
  return (context.grant.paths ?? ["."]).some((p) => p === "." || rel === p || rel.startsWith(p + sep));
}
export function requireAllowedPath(path: string) {
  if (!allowedPath(path)) throw new DomainError(403, "workspace_path", "This path is outside the approved file or directory grants");
}
export async function validateRootHandle(path: string, handle: FileHandle) {
  const context = workspaceSecurity.getStore();
  if (context && resolve(path) === context.root.path) {
    const stat = await handle.stat({ bigint: true });
    if (String(stat.dev) !== context.root.device || String(stat.ino) !== context.root.inode)
      throw new DomainError(403, "workspace_replaced", "The approved workspace directory was replaced");
  }
}
export async function requireSingleLink(handle: FileHandle) {
  if (workspaceSecurity.getStore()) {
    const stat = await handle.stat();
    if (stat.isFile() && stat.nlink !== 1) throw new DomainError(403, "workspace_hardlink", "Delegated access does not allow multiply linked files");
  }
}
