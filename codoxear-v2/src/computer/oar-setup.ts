import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { computerPackagePaths, requireOarLoaderPath } from "./package-paths.js";

/** Read-only installation diagnostics. Never launch a runtime during doctor. */
export async function oarSetupIssues(
  permissionPolicy?: string,
  loaderPath = computerPackagePaths().oarLoader,
): Promise<string[]> {
  const issues: string[] = [];
  if (Number(process.versions.node.split(".")[0]) < 24)
    issues.push(
      "Managed OAR sessions require Node.js 24 or newer; the current Computer uses " +
        process.version,
    );
  if (permissionPolicy !== "locally-trusted")
    issues.push(
      "OAR's noninteractive permission policy has not been explicitly configured. Review local trust before enabling managed sessions.",
    );
  const root = dirname(requireOarLoaderPath(loaderPath));
  if (!existsSync(loaderPath) || !existsSync(join(root, "package.json")))
    return [
      ...issues,
      "Computer runtime/oar package is missing from this installation",
    ];
  try {
    const installed = JSON.parse(
      await readFile(
        join(root, "node_modules/@botiverse/oar/package.json"),
        "utf8",
      ),
    );
    if (installed.version !== "0.13.3")
      issues.push(
        "Install @botiverse/oar exactly 0.13.3; a different runtime version is present",
      );
  } catch {
    issues.push("Pinned OAR dependencies are not installed in runtime/oar");
  }
  if (!existsSync(join(root, "package-lock.json")))
    issues.push(
      "The OAR dependency lockfile is missing; reproducible installation is not release-ready",
    );
  return issues;
}
