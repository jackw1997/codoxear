import { readFile, realpath } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";
import { DomainError } from "../contracts/model.js";

export type FrontendModule = "web" | "workspace" | "identity" | "client";

// An optional, externally built release artifact. Backends never locate or build
// frontend source, and their API services do not require an artifact to start.
export function frontendAssetsRoot(configured?: string): string | undefined {
  const root = configured ?? process.env.CODOXEAR_FRONTEND_ASSETS_ROOT;
  if (root === undefined) return undefined;
  return absoluteAssetRoot(root);
}

export function absoluteAssetRoot(root: string): string {
  if (!isAbsolute(root))
    throw new Error("Frontend asset roots must be absolute paths");
  return resolve(root);
}

export function frontendModuleRoot(
  root: string | undefined,
  module: FrontendModule,
): string {
  if (!root)
    throw new DomainError(
      404,
      "ui_unavailable",
      "Frontend artifact is not attached",
    );
  return join(root, module);
}

export async function frontendAsset(
  root: string | undefined,
  module: FrontendModule,
  path: string,
): Promise<Buffer> {
  const base = frontendModuleRoot(root, module);
  if (
    path.includes("\\") ||
    path.split("/").some((part) => part === "." || part === "..")
  )
    throw new DomainError(400, "invalid_path", "Invalid asset path");
  const file = resolve(base, path);
  if (!file.startsWith(base + sep))
    throw new DomainError(400, "invalid_path", "Invalid asset path");
  try {
    const [actualBase, actualFile] = await Promise.all([
      realpath(base),
      realpath(file),
    ]);
    if (!actualFile.startsWith(actualBase + sep))
      throw new DomainError(403, "invalid_path", "Invalid asset path");
    return await readFile(actualFile);
  } catch (error) {
    if (error instanceof DomainError) throw error;
    throw new DomainError(404, "not_found", "Frontend asset not found");
  }
}
