import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Assets belong to the Computer package, independent of cwd or its parent
 * directory. Installed packages expose their manifest for self-resolution;
 * the two development layouts are explicit rather than an ancestor search. */
export function computerPackagePaths() {
  let root: string;
  const source = import.meta.url.endsWith(".ts");
  if (source) root = fileURLToPath(new URL("../../", import.meta.url));
  else {
    try {
      root = dirname(
        fileURLToPath(import.meta.resolve("@codoxear/computer/package.json")),
      );
    } catch {
      // The repository's coordinated build puts shared modules directly in
      // dist/server. It is retained as a development entry point only.
      const directory = dirname(fileURLToPath(import.meta.url));
      if (!directory.endsWith("/dist/server"))
        throw Error("Computer package manifest cannot be resolved");
      root = fileURLToPath(new URL("../../", import.meta.url));
    }
  }
  return {
    root,
    source,
    oarLoader: join(root, "runtime/oar/load.mjs"),
    entry: (name: string) =>
      join(
        root,
        source ? "src/computer" : "dist/server/computer",
        name + (source ? ".ts" : ".js"),
      ),
  };
}

export function requireOarLoaderPath(path: unknown): string {
  if (typeof path !== "string" || !isAbsolute(path))
    throw Error(
      "Managed runtime requires an absolute Computer OAR loader path",
    );
  return path;
}
