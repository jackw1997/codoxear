// Compatibility deployment layout. Frontend compilation belongs to its own package.
import { cp, mkdir, access } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
const root = fileURLToPath(new URL("../", import.meta.url));
for (const name of ["web", "workspace", "identity", "client"]) {
  await cp(resolve(root, "frontend/dist", name), resolve(root, "dist", name), {
    recursive: true,
  });
}
// Public reports are optional deployment assets, never frontend build inputs.
for (const name of ["progress.html", "oar-cutover.html"]) {
  const source = resolve(root, "docs", name);
  try { await access(source); } catch (error) {
    if (error.code === "ENOENT") continue;
    throw error;
  }
  await mkdir(resolve(root, "dist/client"), { recursive: true });
  await cp(source, resolve(root, "dist/client", name));
  await cp(source, resolve(root, "frontend/dist/client", name));
}
// Optional full-release guide; standalone frontend compilation has no docs dependency.
for (const destination of ["dist/client", "frontend/dist/client"])
  await cp(resolve(root, "docs/independent-hubs.html"), resolve(root, destination, "guide.html"));
