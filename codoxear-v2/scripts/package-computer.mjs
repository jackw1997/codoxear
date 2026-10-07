import { spawnSync } from "node:child_process";
import { cp, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

// The legacy download command uses the reviewed Computer-only exporter.
const project = fileURLToPath(new URL("../", import.meta.url));
const output = resolve(project, "frontend/dist/client/downloads");
const child = spawnSync(process.execPath, [
  "--import", "tsx", resolve(project, "scripts/package-component.ts"),
  "computer", process.argv[2] ?? "HEAD", output,
], { cwd: project, stdio: "inherit" });
if (child.status !== 0) process.exit(child.status ?? 1);
await mkdir(resolve(project, "dist/client/downloads"), { recursive: true });
for (const file of ["codoxear-computer-source.tar.gz", "release.json"])
  await cp(resolve(output, file), resolve(project, "dist/client/downloads", file));
